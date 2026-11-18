import { Router } from 'express';
import rateLimit from 'express-rate-limit';
import { randomInt } from 'node:crypto';
import { config } from '../config.js';
import { query } from '../db.js';
import { requireAuth, verifiedCount } from '../auth.js';
import { linkVerifiedChannel } from '../membership.js';
import {
  channelDescriptionHasCode,
  fetchChannelById,
  resolveChannel,
} from '../youtube.js';
import { asyncRoute, cleanText, httpError } from '../util.js';

export const channelRouter = Router();

const CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';

function generateCode() {
  let code = '';
  for (let index = 0; index < 6; index += 1) {
    code += CODE_ALPHABET[randomInt(CODE_ALPHABET.length)];
  }
  return `ARTBACK-${code}`;
}

function channelPreview(channel) {
  return {
    id: channel.id,
    title: channel.title,
    handle: channel.handle,
    avatarUrl: channel.avatarUrl,
    subscriberCount: channel.subscriberCount,
    hiddenSubscribers: channel.hiddenSubscribers,
    channelUrl: channel.channelUrl,
  };
}

const userLimiter = rateLimit({
  windowMs: 10 * 60 * 1000,
  limit: 20,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  keyGenerator: (req) => req.user?.id || req.ip,
  message: { error: 'Слишком много попыток. Подождите несколько минут.' },
});

channelRouter.post('/start', requireAuth, userLimiter, asyncRoute(async (req, res) => {
  if (req.user.status === 'verified') {
    throw httpError(400, 'Канал уже привязан', 'ALREADY_VERIFIED');
  }
  if (!config.youtube.enabled) {
    throw httpError(503, 'YouTube API не настроен администратором сайта', 'YT_NOT_CONFIGURED');
  }

  const taken = await verifiedCount();
  if (taken >= config.maxMembers) {
    throw httpError(
      409,
      `Все ${config.maxMembers} мест заняты. Свободных мест сейчас нет.`,
      'SLOTS_FULL',
    );
  }

  const input = cleanText(req.body?.input, 300);
  if (!input) throw httpError(400, 'Укажите ссылку на канал или @ник', 'CHANNEL_INPUT');

  const channel = await resolveChannel(input);

  const existing = await query(
    'SELECT id FROM users WHERE channel_id = $1 AND id <> $2 LIMIT 1',
    [channel.id, req.user.id],
  );
  if (existing.rows[0]) {
    throw httpError(409, 'Этот канал уже привязан к другому участнику', 'CHANNEL_TAKEN');
  }

  const code = generateCode();
  const preview = channelPreview(channel);
  const updated = await query(
    `UPDATE users SET
       verification_code = $2,
       verification_channel = $3,
       verification_started_at = now()
     WHERE id = $1
     RETURNING verification_started_at`,
    [req.user.id, code, JSON.stringify(preview)],
  );

  res.json({
    ok: true,
    verification: {
      code,
      channel: preview,
      startedAt: updated.rows[0].verification_started_at,
    },
    slots: { total: config.maxMembers, taken },
  });
}));

channelRouter.post('/verify', requireAuth, userLimiter, asyncRoute(async (req, res) => {
  if (req.user.status === 'verified') {
    throw httpError(400, 'Канал уже привязан', 'ALREADY_VERIFIED');
  }
  if (!req.user.verification_code || !req.user.verification_channel?.id) {
    throw httpError(400, 'Сначала укажите канал и получите код', 'NO_VERIFICATION');
  }

  const startedAt = new Date(req.user.verification_started_at).getTime();
  if (Date.now() - startedAt > config.verificationTtlHours * 60 * 60 * 1000) {
    await query(
      `UPDATE users SET verification_code = NULL, verification_channel = NULL, verification_started_at = NULL WHERE id = $1`,
      [req.user.id],
    );
    throw httpError(400, 'Код подтверждения истёк. Начните привязку заново.', 'CODE_EXPIRED');
  }

  if (!config.youtube.enabled) {
    throw httpError(503, 'YouTube API не настроен администратором сайта', 'YT_NOT_CONFIGURED');
  }

  const channel = await fetchChannelById(req.user.verification_channel.id);
  if (!channel) {
    throw httpError(404, 'Канал больше не существует или скрыт', 'CHANNEL_NOT_FOUND');
  }

  if (!channelDescriptionHasCode(channel, req.user.verification_code)) {
    throw httpError(
      400,
      `Код ${req.user.verification_code} не найден в описании канала. Вставьте его в описание (Настройки → О канале) и подождите пару минут — YouTube обновляет данные не мгновенно.`,
      'CODE_NOT_FOUND',
    );
  }

  const result = await linkVerifiedChannel(req.user.id, channel, 'description');

  res.json({
    ok: true,
    user: {
      id: result.user.id,
      memberNumber: result.user.member_number,
      isAdmin: result.user.is_admin,
      channelTitle: result.user.channel_title,
    },
    isFirstAdmin: result.isFirstAdmin,
  });
}));

channelRouter.delete('/pending', requireAuth, asyncRoute(async (req, res) => {
  await query(
    `UPDATE users SET verification_code = NULL, verification_channel = NULL, verification_started_at = NULL
     WHERE id = $1 AND status = 'pending'`,
    [req.user.id],
  );
  res.json({ ok: true });
}));

channelRouter.get('/slots', asyncRoute(async (_req, res) => {
  const taken = await verifiedCount();
  res.json({ total: config.maxMembers, taken });
}));
