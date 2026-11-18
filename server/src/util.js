import { createHash, randomBytes } from 'node:crypto';

export class HttpError extends Error {
  constructor(status, message, code = undefined) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

export function httpError(status, message, code) {
  return new HttpError(status, message, code);
}

export function asyncRoute(fn) {
  return function wrapped(req, res, next) {
    Promise.resolve(fn(req, res, next)).catch(next);
  };
}

export function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

export function randomToken(bytes = 32) {
  return randomBytes(bytes).toString('base64url');
}

export function normalizeEmail(value) {
  return typeof value === 'string' ? value.trim().toLowerCase() : '';
}

export function isValidEmail(value) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(value);
}

export function cleanText(value, maxLength) {
  if (typeof value !== 'string') return '';
  return value.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '').trim().slice(0, maxLength);
}

export function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

export function mapUser(row, options = {}) {
  const { self = false, includeEmail = false } = options;
  const user = {
    id: row.id,
    displayName: row.display_name,
    status: row.status,
    isAdmin: Boolean(row.is_admin),
    channelId: row.channel_id || null,
    channelTitle: row.channel_title || null,
    channelHandle: row.channel_handle || null,
    channelUrl: row.channel_url || null,
    avatarUrl: row.avatar_url || null,
    subscriberCount: row.subscriber_count == null ? null : Number(row.subscriber_count),
    hiddenSubscribers: Boolean(row.hidden_subscribers),
    memberNumber: row.member_number == null ? null : Number(row.member_number),
    verifiedAt: row.verified_at || null,
    createdAt: row.created_at || null,
    publicKey: row.public_key || null,
    hasKey: Boolean(row.has_key),
    online: Boolean(row.online),
  };
  if (self) {
    user.email = row.email;
    user.isGoogle = Boolean(row.google_id);
    user.hasPassword = Boolean(row.password_hash);
    user.banReason = row.ban_reason || null;
  }
  if (includeEmail) user.email = row.email;
  return user;
}

export async function audit(clientOrPool, actorId, action, details = null) {
  try {
    const run =
      typeof clientOrPool === 'function'
        ? clientOrPool
        : (text, params) => clientOrPool.query(text, params);
    await run(
      'INSERT INTO audit_log (actor_id, action, details) VALUES ($1, $2, $3)',
      [actorId || null, action, details ? JSON.stringify(details) : null],
    );
  } catch (error) {
    console.error('[audit] Не удалось записать событие:', error.message);
  }
}

export function clientIp(req) {
  return req.ip || req.socket?.remoteAddress || null;
}

export function parsePositiveInt(value, fallback = null) {
  if (value == null || value === '') return fallback;
  const parsed = Number.parseInt(value, 10);
  if (!Number.isSafeInteger(parsed) || parsed < 0) return fallback;
  return parsed;
}

export function isUrl(value) {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' || url.protocol === 'http:';
  } catch {
    return false;
  }
}
