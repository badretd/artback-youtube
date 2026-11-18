import { Server } from 'socket.io';
import { config } from './config.js';
import { query } from './db.js';
import { touchLastSeen } from './auth.js';
import { createMessage } from './messages.js';
import {
  addOnline,
  broadcastPresence,
  onlineIds,
  removeOnline,
  setIO,
} from './realtime.js';
import { sha256 } from './util.js';

function parseCookies(header = '') {
  const cookies = {};
  for (const part of String(header).split(';')) {
    const index = part.indexOf('=');
    if (index === -1) continue;
    const name = part.slice(0, index).trim();
    const value = part.slice(index + 1).trim();
    if (name) cookies[name] = decodeURIComponent(value);
  }
  return cookies;
}

function originAllowed(origin, host) {
  if (!origin) return true;
  let appOrigin = null;
  try {
    appOrigin = new URL(config.appUrl).origin;
  } catch {
    appOrigin = null;
  }
  const allowed = new Set([appOrigin, host ? `https://${host}` : null, host ? `http://${host}` : null]);
  if (!config.isProd && /^http:\/\/(localhost|127\.0\.0\.1):\d+$/.test(origin)) return true;
  return allowed.has(origin);
}

export function initSocket(httpServer) {
  const io = new Server(httpServer, {
    serveClient: false,
    maxHttpBufferSize: 256 * 1024,
    pingInterval: 25_000,
    pingTimeout: 20_000,
    cors: { origin: false },
    allowRequest: (req, callback) => {
      callback(null, originAllowed(req.headers.origin, req.headers.host));
    },
  });

  io.use(async (socket, next) => {
    try {
      const cookies = parseCookies(socket.handshake.headers.cookie || '');
      const token = cookies[config.cookieName];
      if (!token) return next(new Error('unauthorized'));

      const { rows } = await query(
        `SELECT u.* FROM sessions s JOIN users u ON u.id = s.user_id
         WHERE s.token_hash = $1 AND s.expires_at > now()`,
        [sha256(token)],
      );
      const user = rows[0];
      if (!user) return next(new Error('unauthorized'));
      if (user.status === 'banned') return next(new Error('banned'));
      if (user.status !== 'verified') return next(new Error('not_verified'));

      socket.data.user = user;
      socket.data.userId = user.id;
      return next();
    } catch (error) {
      return next(error);
    }
  });

  io.on('connection', (socket) => {
    const user = socket.data.user;
    const userId = user.id;

    socket.join('members');
    socket.join(`user:${userId}`);
    addOnline(userId, socket.id);
    touchLastSeen(userId);

    socket.emit('presence', { count: onlineIds().length, ids: onlineIds() });
    broadcastPresence();

    const stamps = [];
    const canSend = () => {
      const now = Date.now();
      while (stamps.length && stamps[0] < now - 10_000) stamps.shift();
      if (stamps.length >= 8) return false;
      stamps.push(now);
      return true;
    };

    socket.on('message:send', async (payload, ack) => {
      const respond = typeof ack === 'function' ? ack : () => {};
      if (!canSend()) {
        return respond({ error: 'Слишком много сообщений. Подождите несколько секунд.', code: 'RATE_LIMIT' });
      }
      try {
        const message = await createMessage(userId, payload || {});
        return respond({ ok: true, message });
      } catch (error) {
        return respond({
          error: error.message || 'Не удалось отправить сообщение',
          code: error.code,
        });
      }
    });

    socket.on('disconnect', () => {
      removeOnline(userId, socket.id);
      broadcastPresence();
    });
  });

  setIO(io);
  return io;
}
