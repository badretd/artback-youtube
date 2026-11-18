import { Router } from 'express';
import rateLimit from 'express-rate-limit';
import { query } from '../db.js';
import { requireVerified } from '../auth.js';
import { emitToMembers, emitToUser } from '../realtime.js';
import { asyncRoute, audit, httpError, isPlainObject } from '../util.js';

export const keysRouter = Router();

const shareLimiter = rateLimit({
  windowMs: 10 * 60 * 1000,
  limit: 200,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  keyGenerator: (req) => req.user?.id || req.ip,
  message: { error: 'Слишком много операций с ключами. Подождите.' },
});

function sanitizePublicKey(jwk) {
  if (!isPlainObject(jwk)) throw httpError(400, 'Некорректный публичный ключ', 'BAD_KEY');
  if (jwk.kty !== 'EC' || jwk.crv !== 'P-256') {
    throw httpError(400, 'Поддерживается только ECDH P-256', 'BAD_KEY');
  }
  if (
    typeof jwk.x !== 'string' ||
    typeof jwk.y !== 'string' ||
    !/^[A-Za-z0-9_-]{40,100}$/.test(jwk.x) ||
    !/^[A-Za-z0-9_-]{40,100}$/.test(jwk.y)
  ) {
    throw httpError(400, 'Некорректный публичный ключ', 'BAD_KEY');
  }
  return { kty: 'EC', crv: 'P-256', x: jwk.x, y: jwk.y };
}

function samePublicKey(a, b) {
  return Boolean(a && b && a.x === b.x && a.y === b.y);
}

function base64Bytes(value, expectedLength = null) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9+/]*={0,2}$/.test(value)) return null;
  const buffer = Buffer.from(value, 'base64');
  if (expectedLength != null && buffer.length !== expectedLength) return null;
  return buffer;
}

keysRouter.put('/public', requireVerified, asyncRoute(async (req, res) => {
  const publicKey = sanitizePublicKey(req.body?.publicKey);
  const replace = req.body?.replace === true;
  const current = req.user.public_key;

  if (current && !samePublicKey(current, publicKey) && !replace) {
    throw httpError(
      409,
      'На сервере уже есть другой ключ этого аккаунта. Восстановите его из бэкапа или подтвердите замену.',
      'KEY_EXISTS',
    );
  }

  if (!samePublicKey(current, publicKey)) {
    await query('UPDATE users SET public_key = $2 WHERE id = $1', [req.user.id, JSON.stringify(publicKey)]);
    // Старые обёртки ключа группы больше не подходят к новому приватному ключу.
    await query('DELETE FROM group_keys WHERE user_id = $1', [req.user.id]);
    if (current) await audit(query, req.user.id, 'identity_key_replaced', null);
    emitToMembers('member:updated', {
      id: req.user.id,
      publicKey,
      hasKey: false,
      keyReset: Boolean(current),
    });
  }

  res.json({ ok: true, publicKey });
}));

keysRouter.get('/me', requireVerified, asyncRoute(async (req, res) => {
  const { rows } = await query(
    `SELECT epoch, ephemeral_public_key, iv, wrapped_key, provided_by, created_at
     FROM group_keys WHERE user_id = $1`,
    [req.user.id],
  );
  const row = rows[0];
  res.json({
    key: row
      ? {
          epoch: row.epoch,
          ephemeralPublicKey: row.ephemeral_public_key,
          iv: row.iv,
          wrappedKey: row.wrapped_key,
          providedBy: row.provided_by,
          createdAt: row.created_at,
        }
      : null,
  });
}));

keysRouter.post('/share', requireVerified, shareLimiter, asyncRoute(async (req, res) => {
  const targetUserId = String(req.body?.targetUserId || '');
  const epoch = Number.parseInt(req.body?.epoch, 10);
  const ephemeralPublicKey = sanitizePublicKey(req.body?.ephemeralPublicKey);
  const iv = base64Bytes(req.body?.iv, 12);
  const wrapped = base64Bytes(req.body?.wrappedKey);

  if (!targetUserId) throw httpError(400, 'Не указан получатель', 'BAD_TARGET');
  if (targetUserId === req.user.id) throw httpError(400, 'Нельзя выдать ключ самому себе', 'BAD_TARGET');
  if (!Number.isInteger(epoch) || epoch < 1 || epoch > 1000) {
    throw httpError(400, 'Некорректная версия ключа', 'BAD_EPOCH');
  }
  if (!iv) throw httpError(400, 'Некорректный IV', 'BAD_IV');
  if (!wrapped || wrapped.length < 32 || wrapped.length > 512) {
    throw httpError(400, 'Некорректный зашифрованный ключ', 'BAD_WRAPPED_KEY');
  }

  const target = await query(
    "SELECT id, public_key FROM users WHERE id = $1 AND status = 'verified'",
    [targetUserId],
  );
  const recipient = target.rows[0];
  if (!recipient) throw httpError(404, 'Участник не найден', 'TARGET_NOT_FOUND');
  if (!recipient.public_key) {
    throw httpError(409, 'У участника ещё нет публичного ключа', 'NO_PUBLIC_KEY');
  }

  const inserted = await query(
    `INSERT INTO group_keys (user_id, epoch, ephemeral_public_key, iv, wrapped_key, provided_by)
     VALUES ($1, $2, $3, $4, $5, $6)
     ON CONFLICT (user_id) DO NOTHING
     RETURNING user_id`,
    [
      targetUserId,
      epoch,
      JSON.stringify(ephemeralPublicKey),
      req.body.iv,
      req.body.wrappedKey,
      req.user.id,
    ],
  );

  if (inserted.rows[0]) {
    emitToUser(targetUserId, 'key:shared', {
      epoch,
      from: req.user.id,
      at: new Date().toISOString(),
    });
  }

  res.json({ ok: true, alreadyShared: !inserted.rows[0] });
}));
