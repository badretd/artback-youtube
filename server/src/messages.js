import { config } from './config.js';
import { query, withTransaction } from './db.js';
import { emitToMembers } from './realtime.js';
import { deleteObject } from './s3.js';
import { audit, httpError } from './util.js';

const BASE64_RE = /^[A-Za-z0-9+/]*={0,2}$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function decodeBase64(value, fieldName) {
  if (typeof value !== 'string' || !value || !BASE64_RE.test(value)) {
    throw httpError(400, `Некорректное поле ${fieldName}`, 'BAD_MESSAGE');
  }
  const buffer = Buffer.from(value, 'base64');
  if (buffer.length === 0) throw httpError(400, 'Пустое сообщение', 'EMPTY_MESSAGE');
  return buffer;
}

export function messageUser(user) {
  return {
    id: user.id,
    displayName: user.display_name,
    channelTitle: user.channel_title,
    avatarUrl: user.avatar_url,
    isAdmin: Boolean(user.is_admin),
  };
}

export function serializeMessage(row, user) {
  return {
    id: Number(row.id),
    userId: row.user_id,
    ciphertext: row.ciphertext,
    iv: row.iv,
    epoch: row.epoch,
    createdAt: row.created_at,
    user: messageUser(user),
  };
}

export async function getMessages({ before = null, limit = 30 } = {}) {
  const safeLimit = Math.min(Math.max(Number(limit) || 30, 1), 100);
  const params = [];
  let beforeClause = '';
  if (before) {
    params.push(before);
    beforeClause = `AND m.id < $${params.length}`;
  }
  params.push(safeLimit);

  const { rows } = await query(
    `SELECT m.*, u.display_name, u.channel_title, u.avatar_url, u.is_admin
     FROM messages m JOIN users u ON u.id = m.user_id
     WHERE m.deleted_at IS NULL ${beforeClause}
     ORDER BY m.id DESC
     LIMIT $${params.length}`,
    params,
  );

  return rows
    .map((row) => serializeMessage(row, row))
    .sort((a, b) => a.id - b.id);
}

function normalizeMediaKeys(value) {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.filter((key) => typeof key === 'string' && UUID_RE.test(key)))].slice(
    0,
    config.limits.maxAttachments,
  );
}

export async function createMessage(userId, payload = {}) {
  const ciphertext = decodeBase64(payload.ciphertext, 'ciphertext');
  const iv = decodeBase64(payload.iv, 'iv');
  const epoch = Number.parseInt(payload.epoch, 10);

  if (iv.length !== 12) throw httpError(400, 'Некорректный IV', 'BAD_IV');
  if (!Number.isInteger(epoch) || epoch < 1 || epoch > 1000) {
    throw httpError(400, 'Некорректная версия ключа', 'BAD_EPOCH');
  }
  if (ciphertext.length > config.limits.maxMessageBytes) {
    throw httpError(413, 'Сообщение слишком большое', 'MESSAGE_TOO_LARGE');
  }

  const mediaKeys = normalizeMediaKeys(payload.mediaKeys);

  const message = await withTransaction(async (client) => {
    const inserted = await client.query(
      `INSERT INTO messages (user_id, ciphertext, iv, epoch)
       VALUES ($1, $2, $3, $4)
       RETURNING *`,
      [userId, ciphertext.toString('base64'), iv.toString('base64'), epoch],
    );
    const row = inserted.rows[0];

    if (mediaKeys.length > 0) {
      await client.query(
        `UPDATE media_objects SET message_id = $1
         WHERE key = ANY($2::text[]) AND user_id = $3 AND message_id IS NULL`,
        [row.id, mediaKeys, userId],
      );
    }

    const userResult = await client.query('SELECT * FROM users WHERE id = $1', [userId]);
    return serializeMessage(row, userResult.rows[0]);
  });

  emitToMembers('message:new', message);
  return message;
}

export async function deleteMessage(messageId, actor) {
  const id = Number(messageId);
  if (!Number.isSafeInteger(id) || id <= 0) {
    throw httpError(400, 'Некорректный идентификатор сообщения', 'BAD_ID');
  }

  const { rows } = await query('SELECT * FROM messages WHERE id = $1', [id]);
  const message = rows[0];
  if (!message) throw httpError(404, 'Сообщение не найдено', 'MESSAGE_NOT_FOUND');

  const isOwner = message.user_id === actor.id;
  const isAdmin = actor.is_admin && actor.status === 'verified';
  if (!isOwner && !isAdmin) {
    throw httpError(403, 'Можно удалять только свои сообщения', 'FORBIDDEN');
  }

  if (message.deleted_at) return { ok: true };

  const media = await query('SELECT key FROM media_objects WHERE message_id = $1', [id]);

  await query(
    `UPDATE messages SET ciphertext = '', iv = '', deleted_at = now(), deleted_by = $2 WHERE id = $1`,
    [id, actor.id],
  );
  await query('DELETE FROM media_objects WHERE message_id = $1', [id]);

  await Promise.allSettled(media.rows.map((row) => deleteObject(`media/${row.key}`)));

  emitToMembers('message:deleted', { id });

  if (isAdmin && !isOwner) {
    await audit(query, actor.id, 'message_deleted', { messageId: id, userId: message.user_id });
  }

  return { ok: true };
}
