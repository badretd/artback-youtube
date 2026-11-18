import { promisify } from 'node:util';
import { randomBytes, scrypt as scryptCallback, timingSafeEqual } from 'node:crypto';
import { config } from './config.js';
import { query } from './db.js';
import { clientIp, httpError, sha256, randomToken } from './util.js';

const scrypt = promisify(scryptCallback);

const SESSION_COOKIE_OPTS = {
  httpOnly: true,
  sameSite: 'lax',
  secure: config.secureCookies,
  path: '/',
};

export async function hashPassword(password) {
  const salt = randomBytes(16);
  const derived = await scrypt(password, salt, 64);
  return `scrypt$${salt.toString('base64')}$${derived.toString('base64')}`;
}

export async function verifyPassword(password, stored) {
  if (!stored) return false;
  const [scheme, saltB64, hashB64] = String(stored).split('$');
  if (scheme !== 'scrypt' || !saltB64 || !hashB64) return false;
  const salt = Buffer.from(saltB64, 'base64');
  const expected = Buffer.from(hashB64, 'base64');
  const actual = await scrypt(password, salt, expected.length);
  if (actual.length !== expected.length) return false;
  return timingSafeEqual(actual, expected);
}

export async function createSession(userId, req, res) {
  const token = randomToken(32);
  const expires = new Date(Date.now() + config.sessionDays * 24 * 60 * 60 * 1000);
  await query(
    'INSERT INTO sessions (token_hash, user_id, expires_at, ip) VALUES ($1, $2, $3, $4)',
    [sha256(token), userId, expires, clientIp(req)],
  );
  res.cookie(config.cookieName, token, { ...SESSION_COOKIE_OPTS, expires });
  return token;
}

export async function destroySession(req, res) {
  const token = req.cookies?.[config.cookieName];
  if (token) {
    await query('DELETE FROM sessions WHERE token_hash = $1', [sha256(token)]).catch(() => {});
  }
  res.clearCookie(config.cookieName, { ...SESSION_COOKIE_OPTS });
}

export async function attachUser(req, res, next) {
  try {
    const token = req.cookies?.[config.cookieName];
    if (!token) return next();

    const { rows } = await query(
      `SELECT u.*, s.expires_at AS session_expires_at
       FROM sessions s JOIN users u ON u.id = s.user_id
       WHERE s.token_hash = $1 AND s.expires_at > now()`,
      [sha256(token)],
    );

    const user = rows[0];
    if (!user) {
      res.clearCookie(config.cookieName, { ...SESSION_COOKIE_OPTS });
      return next();
    }
    if (user.status === 'banned') {
      await query('DELETE FROM sessions WHERE user_id = $1', [user.id]).catch(() => {});
      res.clearCookie(config.cookieName, { ...SESSION_COOKIE_OPTS });
      return next();
    }

    req.user = user;
    return next();
  } catch (error) {
    return next(error);
  }
}

export function requireAuth(req, _res, next) {
  if (!req.user) return next(httpError(401, 'Требуется вход в аккаунт', 'AUTH_REQUIRED'));
  return next();
}

export function requireVerified(req, _res, next) {
  if (!req.user) return next(httpError(401, 'Требуется вход в аккаунт', 'AUTH_REQUIRED'));
  if (req.user.status !== 'verified') {
    return next(httpError(403, 'Нужно привязать и подтвердить YouTube-канал', 'NOT_VERIFIED'));
  }
  return next();
}

export function requireAdmin(req, _res, next) {
  if (!req.user) return next(httpError(401, 'Требуется вход в аккаунт', 'AUTH_REQUIRED'));
  if (req.user.status !== 'verified' || !req.user.is_admin) {
    return next(httpError(403, 'Доступно только администраторам', 'ADMIN_REQUIRED'));
  }
  return next();
}

export async function touchLastSeen(userId) {
  await query('UPDATE users SET last_seen_at = now() WHERE id = $1', [userId]).catch(() => {});
}

export async function verifiedCount() {
  const { rows } = await query("SELECT COUNT(*)::int AS count FROM users WHERE status = 'verified'");
  return rows[0]?.count ?? 0;
}
