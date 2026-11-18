import express from 'express';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import cookieParser from 'cookie-parser';
import helmet from 'helmet';
import rateLimit from 'express-rate-limit';
import { config } from './config.js';
import { migrate, pool, query, waitForDb } from './db.js';
import { attachUser } from './auth.js';
import { ensureBucket } from './s3.js';
import { initSocket } from './socket.js';
import { startJobs } from './cron.js';
import { authRouter } from './routes/auth.js';
import { channelRouter } from './routes/channel.js';
import { membersRouter } from './routes/members.js';
import { messagesRouter } from './routes/messages.js';
import { keysRouter } from './routes/keys.js';
import { mediaRouter } from './routes/media.js';
import { adminRouter } from './routes/admin.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const publicDir = path.resolve(__dirname, '../public');

const app = express();
app.set('trust proxy', 1);
app.disable('x-powered-by');

app.use((_req, res, next) => {
  res.setHeader('X-Robots-Tag', 'noindex, nofollow');
  next();
});

app.use(
  helmet({
    contentSecurityPolicy: config.isProd
      ? {
          directives: {
            defaultSrc: ["'self'"],
            scriptSrc: ["'self'"],
            styleSrc: ["'self'", "'unsafe-inline'"],
            imgSrc: [
              "'self'",
              'data:',
              'blob:',
              'https://yt3.googleusercontent.com',
              'https://yt3.ggpht.com',
              'https://*.ggpht.com',
              'https://*.googleusercontent.com',
            ],
            mediaSrc: ["'self'", 'blob:'],
            connectSrc: ["'self'", 'ws:', 'wss:'],
            fontSrc: ["'self'", 'data:'],
            objectSrc: ["'none'"],
            baseUri: ["'self'"],
            frameAncestors: ["'none'"],
            formAction: ["'self'"],
            upgradeInsecureRequests: config.secureCookies ? [] : null,
          },
        }
      : false,
    strictTransportSecurity: config.secureCookies
      ? { maxAge: 31_536_000, includeSubDomains: true }
      : false,
    crossOriginEmbedderPolicy: false,
    crossOriginResourcePolicy: { policy: 'cross-origin' },
  }),
);

app.use(express.json({ limit: '256kb' }));
app.use(cookieParser());

// Basic CSRF protection: mutating API requests must come from our own origin.
app.use('/api', (req, res, next) => {
  if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return next();
  const origin = req.get('origin');
  if (!origin) return next();
  let appOrigin;
  try {
    appOrigin = new URL(config.appUrl).origin;
  } catch {
    appOrigin = null;
  }
  const requestOrigin = `${req.protocol}://${req.get('host')}`;
  if (!config.isProd && /^http:\/\/(localhost|127\.0\.0\.1):\d+$/.test(origin)) {
    return next();
  }
  if (origin !== appOrigin && origin !== requestOrigin) {
    return res.status(403).json({ error: 'Запрос с недопустимого источника', code: 'BAD_ORIGIN' });
  }
  return next();
});

const generalLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 1200,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  message: { error: 'Слишком много запросов. Попробуйте позже.' },
});

app.get('/api/health', async (_req, res) => {
  try {
    await query('SELECT 1');
    res.json({ ok: true, uptime: Math.round(process.uptime()) });
  } catch {
    res.status(503).json({ ok: false });
  }
});

app.use('/api', generalLimiter);
app.use('/api', attachUser);

// Auth API is available both at /api/me and /api/auth/me for convenience.
app.use('/api', authRouter);
app.use('/api/auth', authRouter);
app.use('/api/channel', channelRouter);
app.use('/api/members', membersRouter);
app.use('/api/messages', messagesRouter);
app.use('/api/keys', keysRouter);
app.use('/api/media', mediaRouter);
app.use('/api/admin', adminRouter);

app.use('/api', (_req, res) => {
  res.status(404).json({ error: 'API-метод не найден', code: 'NOT_FOUND' });
});

// Static SPA
app.use(
  '/assets',
  express.static(path.join(publicDir, 'assets'), {
    immutable: true,
    maxAge: '1y',
  }),
);
app.use(express.static(publicDir, { index: false, maxAge: '1h' }));
app.get('*', (req, res, next) => {
  if (req.path.startsWith('/api') || req.path.startsWith('/socket.io')) return next();
  return res.sendFile(path.join(publicDir, 'index.html'), (error) => {
    if (error) next(error);
  });
});

// eslint-disable-next-line no-unused-vars
app.use((error, req, res, _next) => {
  if (error?.type === 'entity.too.large' || error?.status === 413) {
    return res.status(413).json({ error: 'Файл или запрос слишком большой', code: 'TOO_LARGE' });
  }
  const status = Number.isInteger(error?.status) ? error.status : 500;
  if (status >= 500) {
    console.error(`[http] ${req.method} ${req.originalUrl}:`, error);
  }
  return res.status(status).json({
    error: status >= 500 && !error?.status ? 'Внутренняя ошибка сервера' : error.message,
    code: error?.code || 'ERROR',
  });
});

async function main() {
  await waitForDb();
  await migrate();
  await ensureBucket();

  const server = http.createServer(app);
  initSocket(server);
  startJobs();

  server.listen(config.port, '0.0.0.0', () => {
    console.log(`[server] ARTBACK запущен на порту ${config.port}`);
    console.log(`[server] Публичный адрес: ${config.appUrl}`);
    console.log(`[server] YouTube API: ${config.youtube.enabled ? 'да' : 'нет'}`);
    console.log(`[server] Google OAuth: ${config.google.enabled ? 'да' : 'нет'}`);
    console.log(`[server] S3 медиа: ${config.media.enabled ? 'да' : 'нет'}`);
  });

  const shutdown = async (signal) => {
    console.log(`[server] Получен ${signal}, останавливаемся...`);
    server.close(() => {});
    await pool.end().catch(() => {});
    process.exit(0);
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

main().catch((error) => {
  console.error('[server] Не удалось запустить приложение:', error);
  process.exit(1);
});
