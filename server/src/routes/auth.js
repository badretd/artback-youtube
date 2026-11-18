import { Router } from 'express';
import rateLimit from 'express-rate-limit';
import { randomUUID } from 'node:crypto';
import { config, publicConfig } from '../config.js';
import { query } from '../db.js';
import {
  attachUser,
  createSession,
  destroySession,
  hashPassword,
  requireAuth,
  verifiedCount,
  verifyPassword,
} from '../auth.js';
import { linkVerifiedChannel } from '../membership.js';
import { getMyChannel } from '../youtube.js';
import {
  asyncRoute,
  audit,
  cleanText,
  httpError,
  isValidEmail,
  mapUser,
  normalizeEmail,
  randomToken,
} from '../util.js';

export const authRouter = Router();

const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 40,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  message: { error: 'Слишком много попыток. Попробуйте позже.' },
});

const GOOGLE_STATE_COOKIE = 'artback_oauth_state';

function oauthCookieOptions() {
  return {
    httpOnly: true,
    sameSite: 'lax',
    secure: config.secureCookies,
    path: '/api/auth/google',
    maxAge: 10 * 60 * 1000,
  };
}

function googleRedirectError(res, code) {
  res.redirect(`/?auth_error=${encodeURIComponent(code)}`);
}

authRouter.get('/config', asyncRoute(async (_req, res) => {
  const taken = await verifiedCount();
  res.json(publicConfig(taken));
}));

authRouter.get('/me', requireAuth, asyncRoute(async (req, res) => {
  const [taken, keyResult, earliestResult, initializedResult] = await Promise.all([
    verifiedCount(),
    query('SELECT epoch FROM group_keys WHERE user_id = $1', [req.user.id]),
    query("SELECT MIN(member_number)::int AS number FROM users WHERE status = 'verified'"),
    query(
      `SELECT (
         EXISTS (SELECT 1 FROM group_keys) OR
         EXISTS (SELECT 1 FROM messages WHERE deleted_at IS NULL)
       ) AS initialized`,
    ),
  ]);
  const user = mapUser(req.user, { self: true });
  const pending = req.user.status === 'pending' && req.user.verification_code;
  const earliestMember = earliestResult.rows[0]?.number;
  const groupInitialized = initializedResult.rows[0]?.initialized === true;

  res.json({
    user,
    slots: { total: config.maxMembers, taken },
    config: publicConfig(taken),
    hasKey: Boolean(keyResult.rows[0]),
    keyEpoch: keyResult.rows[0]?.epoch ?? null,
    groupInitialized,
    canBootstrapKey:
      req.user.status === 'verified' &&
      user.memberNumber != null &&
      user.memberNumber === earliestMember &&
      !groupInitialized,
    verification: pending
      ? {
          code: req.user.verification_code,
          channel: req.user.verification_channel,
          startedAt: req.user.verification_started_at,
        }
      : null,
  });
}));

authRouter.post('/register', authLimiter, asyncRoute(async (req, res) => {
  const email = normalizeEmail(req.body?.email);
  const password = typeof req.body?.password === 'string' ? req.body.password : '';
  const displayName = cleanText(req.body?.displayName, 40);

  if (!isValidEmail(email)) throw httpError(400, 'Укажите корректный email', 'BAD_EMAIL');
  if (password.length < 8 || password.length > 200) {
    throw httpError(400, 'Пароль должен быть от 8 до 200 символов', 'BAD_PASSWORD');
  }
  if (displayName.length < 2) {
    throw httpError(400, 'Имя должно содержать хотя бы 2 символа', 'BAD_NAME');
  }

  const taken = await verifiedCount();
  if (taken >= config.maxMembers) {
    throw httpError(
      409,
      `Все ${config.maxMembers} мест заняты. Новые аккаунты не регистрируются.`,
      'SLOTS_FULL',
    );
  }

  const existing = await query('SELECT id FROM users WHERE email = $1', [email]);
  if (existing.rows[0]) throw httpError(409, 'Аккаунт с таким email уже существует', 'EMAIL_TAKEN');

  const passwordHash = await hashPassword(password);
  const id = randomUUID();
  await query(
    'INSERT INTO users (id, email, password_hash, display_name) VALUES ($1, $2, $3, $4)',
    [id, email, passwordHash, displayName],
  );

  await createSession(id, req, res);
  await audit(query, id, 'registered', { method: 'email' });

  res.status(201).json({ ok: true });
}));

authRouter.post('/login', authLimiter, asyncRoute(async (req, res) => {
  const email = normalizeEmail(req.body?.email);
  const password = typeof req.body?.password === 'string' ? req.body.password : '';
  if (!isValidEmail(email) || !password) {
    throw httpError(400, 'Укажите email и пароль', 'BAD_CREDENTIALS');
  }

  const { rows } = await query('SELECT * FROM users WHERE email = $1', [email]);
  const user = rows[0];
  const valid = user ? await verifyPassword(password, user.password_hash) : false;
  if (!user || !valid) {
    throw httpError(401, 'Неверный email или пароль', 'INVALID_LOGIN');
  }
  if (user.status === 'banned') {
    throw httpError(403, 'Аккаунт заблокирован администратором', 'BANNED');
  }

  await createSession(user.id, req, res);
  await query('UPDATE users SET last_seen_at = now() WHERE id = $1', [user.id]);
  res.json({ ok: true });
}));

authRouter.post('/logout', asyncRoute(async (req, res) => {
  await destroySession(req, res);
  res.json({ ok: true });
}));

// ---- Google OAuth ----

authRouter.get('/google', (req, res) => {
  if (!config.google.enabled) {
    return res.status(503).json({
      error: 'Google OAuth не настроен. Используйте вход по email и подтверждение канала кодом.',
      code: 'GOOGLE_DISABLED',
    });
  }

  const state = randomToken(24);
  res.cookie(GOOGLE_STATE_COOKIE, state, oauthCookieOptions());

  const url = new URL('https://accounts.google.com/o/oauth2/v2/auth');
  url.searchParams.set('client_id', config.google.clientId);
  url.searchParams.set('redirect_uri', config.google.redirectUri);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('scope', 'openid email profile https://www.googleapis.com/auth/youtube.readonly');
  url.searchParams.set('state', state);
  url.searchParams.set('include_granted_scopes', 'true');
  url.searchParams.set('prompt', 'select_account');
  res.redirect(url.toString());
});

authRouter.get('/google/callback', asyncRoute(async (req, res) => {
  const stateCookie = req.cookies?.[GOOGLE_STATE_COOKIE];
  res.clearCookie(GOOGLE_STATE_COOKIE, oauthCookieOptions());

  if (req.query.error) return googleRedirectError(res, 'google_cancelled');
  if (!config.google.enabled) return googleRedirectError(res, 'google_disabled');
  if (!stateCookie || !req.query.state || String(req.query.state) !== stateCookie) {
    return googleRedirectError(res, 'oauth_state');
  }
  if (!req.query.code) return googleRedirectError(res, 'google_failed');

  let profile;
  let accessToken;
  try {
    const tokenResponse = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        code: String(req.query.code),
        client_id: config.google.clientId,
        client_secret: config.google.clientSecret,
        redirect_uri: config.google.redirectUri,
        grant_type: 'authorization_code',
      }),
    });
    const tokenData = await tokenResponse.json();
    if (!tokenResponse.ok) throw new Error(tokenData.error_description || tokenData.error);
    accessToken = tokenData.access_token;

    const profileResponse = await fetch('https://openidconnect.googleapis.com/v1/userinfo', {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    profile = await profileResponse.json();
    if (!profileResponse.ok || !profile.email) throw new Error('Не удалось получить профиль Google');
  } catch (error) {
    console.error('[google] OAuth error:', error.message);
    return googleRedirectError(res, 'google_failed');
  }

  const email = normalizeEmail(profile.email);
  let { rows } = await query('SELECT * FROM users WHERE google_id = $1', [profile.sub]);
  let user = rows[0];

  if (!user) {
    const byEmail = await query('SELECT * FROM users WHERE email = $1', [email]);
    user = byEmail.rows[0];
    if (user) {
      if (user.status === 'banned') return googleRedirectError(res, 'banned');
      await query('UPDATE users SET google_id = $1 WHERE id = $2', [profile.sub, user.id]);
    }
  }

  if (user?.status === 'banned') return googleRedirectError(res, 'banned');

  if (!user) {
    const taken = await verifiedCount();
    if (taken >= config.maxMembers) return googleRedirectError(res, 'full');

    const displayName =
      cleanText(profile.name, 40) || cleanText(email.split('@')[0], 40) || 'YouTube автор';
    const id = randomUUID();
    const inserted = await query(
      `INSERT INTO users (id, email, google_id, display_name)
       VALUES ($1, $2, $3, $4) RETURNING *`,
      [id, email, profile.sub, displayName],
    );
    user = inserted.rows[0];
    await audit(query, id, 'registered', { method: 'google' });
  }

  await createSession(user.id, req, res);

  if (user.status !== 'verified') {
    try {
      const channel = await getMyChannel(accessToken);
      if (channel) {
        await linkVerifiedChannel(user.id, channel, 'google_oauth');
        await audit(query, user.id, 'google_linked', { channelId: channel.id });
      }
    } catch (error) {
      console.error('[google] Не удалось привязать канал:', error.message);
      const code =
        error.code === 'SLOTS_FULL'
          ? 'full'
          : error.code === 'CHANNEL_TAKEN'
            ? 'channel_taken'
            : 'link_failed';
      return googleRedirectError(res, code);
    }
  }

  return res.redirect('/?auth_ok=1');
}));
