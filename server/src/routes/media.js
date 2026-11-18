import { Router } from 'express';
import express from 'express';
import rateLimit from 'express-rate-limit';
import { randomUUID } from 'node:crypto';
import { config } from '../config.js';
import { query } from '../db.js';
import { requireVerified } from '../auth.js';
import { getObjectStream, putEncryptedObject, s3Configured } from '../s3.js';
import { asyncRoute, httpError } from '../util.js';

export const mediaRouter = Router();

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const uploadLimiter = rateLimit({
  windowMs: 10 * 60 * 1000,
  limit: config.limits.uploadsPer10Min,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  keyGenerator: (req) => req.user?.id || req.ip,
  message: { error: 'Слишком много загрузок. Подождите немного.' },
});

const KIND_LIMITS = () => ({
  image: config.limits.imageBytes,
  video: config.limits.videoBytes,
  audio: config.limits.audioBytes,
  file: config.limits.fileBytes,
});

mediaRouter.post(
  '/upload',
  requireVerified,
  uploadLimiter,
  (req, res, next) => {
    const length = Number(req.get('content-length') || 0);
    if (!s3Configured()) {
      return next(httpError(503, 'S3-хранилище не настроено', 'S3_NOT_CONFIGURED'));
    }
    if (!Number.isFinite(length) || length <= 0) {
      return next(httpError(411, 'Не указан размер файла', 'LENGTH_REQUIRED'));
    }
    const maxTotal = config.limits.videoBytes + 1024 * 1024;
    if (length > maxTotal) {
      return next(httpError(413, 'Файл слишком большой', 'FILE_TOO_LARGE'));
    }
    return next();
  },
  express.raw({ type: 'application/octet-stream', limit: config.limits.videoBytes + 1024 * 1024 }),
  asyncRoute(async (req, res) => {
    const kind = String(req.query.kind || 'file');
    const plainSize = Number.parseInt(String(req.query.size || ''), 10);

    const limits = KIND_LIMITS();
    if (!Object.hasOwn(limits, kind)) {
      throw httpError(400, 'Неизвестный тип файла', 'BAD_KIND');
    }
    if (!Number.isSafeInteger(plainSize) || plainSize <= 0) {
      throw httpError(400, 'Некорректный размер файла', 'BAD_SIZE');
    }
    if (plainSize > limits[kind]) {
      throw httpError(
        413,
        `Лимит для этого типа файла — ${(limits[kind] / 1024 / 1024).toFixed(0)} МБ`,
        'FILE_TOO_LARGE',
      );
    }
    if (!Buffer.isBuffer(req.body)) {
      throw httpError(400, 'Тело файла не распознано', 'BAD_BODY');
    }
    // AES-256-GCM добавляет 16 байт тега аутентификации.
    if (req.body.length !== plainSize + 16) {
      throw httpError(400, 'Размер шифротекста не совпадает с заявленным', 'SIZE_MISMATCH');
    }

    const key = randomUUID();
    try {
      await putEncryptedObject(`media/${key}`, req.body);
    } catch (error) {
      console.error('[media] Ошибка загрузки в S3:', error.message);
      throw httpError(502, 'Не удалось сохранить файл в S3', 'S3_ERROR');
    }

    await query(
      `INSERT INTO media_objects (key, user_id, size, kind) VALUES ($1, $2, $3, $4)`,
      [key, req.user.id, plainSize, kind],
    );

    res.status(201).json({ key, size: plainSize, kind });
  }),
);

mediaRouter.get('/:key', requireVerified, asyncRoute(async (req, res) => {
  const key = String(req.params.key || '');
  if (!UUID_RE.test(key)) throw httpError(400, 'Некорректный ключ файла', 'BAD_KEY');

  const { rows } = await query('SELECT * FROM media_objects WHERE key = $1', [key]);
  if (!rows[0]) throw httpError(404, 'Файл не найден', 'FILE_NOT_FOUND');
  if (!s3Configured()) throw httpError(503, 'S3-хранилище не настроено', 'S3_NOT_CONFIGURED');

  let object;
  try {
    object = await getObjectStream(`media/${key}`);
  } catch (error) {
    console.error('[media] Ошибка чтения из S3:', error.message);
    throw httpError(404, 'Файл недоступен в хранилище', 'FILE_UNAVAILABLE');
  }

  if (object.ContentLength != null) res.setHeader('Content-Length', object.ContentLength);
  res.setHeader('Content-Type', 'application/octet-stream');
  res.setHeader('Cache-Control', 'private, max-age=86400');
  res.setHeader('X-Content-Type-Options', 'nosniff');

  const stream = object.Body;
  if (stream && typeof stream.pipe === 'function') {
    stream.on('error', (error) => {
      console.error('[media] Ошибка потока S3:', error.message);
      res.destroy(error);
    });
    stream.pipe(res);
  } else if (stream && typeof stream.transformToByteArray === 'function') {
    const bytes = await stream.transformToByteArray();
    res.end(Buffer.from(bytes));
  } else {
    throw httpError(502, 'Не удалось получить файл из S3', 'S3_ERROR');
  }
}));
