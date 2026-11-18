import dotenv from 'dotenv';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes } from 'node:crypto';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// In development we read the repository .env. In Docker env vars are provided by compose.
dotenv.config({ path: process.env.DOTENV_CONFIG_PATH || path.resolve(__dirname, '../../.env') });

const env = process.env;

function int(value, fallback) {
  const parsed = Number.parseInt(value ?? '', 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function bool(value, fallback = false) {
  if (value == null || value === '') return fallback;
  return ['1', 'true', 'yes', 'on'].includes(String(value).toLowerCase());
}

function mbToBytes(value, fallbackMb) {
  return Math.floor((Number.isFinite(value) ? value : fallbackMb) * 1024 * 1024);
}

const isProd = env.NODE_ENV === 'production';

let sessionSecret = env.SESSION_SECRET || '';
if (!sessionSecret) {
  sessionSecret = randomBytes(48).toString('base64url');
  console.warn('[config] SESSION_SECRET не задан — сгенерирован временный. Сессии будут сброшены при перезапуске.');
}

const appUrl = (env.APP_URL || 'http://localhost:3000').replace(/\/+$/, '');
const imageMb = int(env.MAX_IMAGE_MB, 8);
const videoMb = int(env.MAX_VIDEO_MB, 50);
const audioMb = int(env.MAX_AUDIO_MB, 15);
const fileMb = int(env.MAX_FILE_MB, 10);

const s3Endpoint = (env.S3_ENDPOINT || '').trim();
const s3Bucket = (env.S3_BUCKET || '').trim();
const s3AccessKeyId = (env.S3_ACCESS_KEY_ID || '').trim();
const s3SecretAccessKey = (env.S3_SECRET_ACCESS_KEY || '').trim();

export const config = {
  appName: 'ARTBACK',
  isProd,
  port: int(env.PORT, 3000),
  appUrl,
  secureCookies: appUrl.startsWith('https://'),
  sessionSecret,
  cookieName: 'artback_session',
  sessionDays: 30,
  maxMembers: int(env.MAX_MEMBERS, 100),
  verificationTtlHours: int(env.VERIFICATION_TTL_HOURS, 168),
  youtubeApiKey: (env.YOUTUBE_API_KEY || '').trim(),
  youtube: {
    enabled: false,
  },
  media: {
    enabled: false,
  },
  google: {
    clientId: (env.GOOGLE_CLIENT_ID || '').trim(),
    clientSecret: (env.GOOGLE_CLIENT_SECRET || '').trim(),
    redirectUri:
      (env.GOOGLE_REDIRECT_URI || '').trim() ||
      `${appUrl}/api/auth/google/callback`,
  },
  db: {
    host: env.POSTGRES_HOST || '127.0.0.1',
    port: int(env.POSTGRES_PORT, 5432),
    user: env.POSTGRES_USER || 'artback',
    password: env.POSTGRES_PASSWORD || 'artback',
    database: env.POSTGRES_DB || 'artback',
    max: int(env.POSTGRES_POOL_MAX, 10),
  },
  s3: {
    endpoint: s3Endpoint || undefined,
    region: (env.S3_REGION || (s3Endpoint ? 'auto' : 'us-east-1')).trim(),
    bucket: s3Bucket,
    accessKeyId: s3AccessKeyId,
    secretAccessKey: s3SecretAccessKey,
    forcePathStyle: bool(env.S3_FORCE_PATH_STYLE, Boolean(s3Endpoint)),
  },
  limits: {
    imageMb,
    videoMb,
    audioMb,
    fileMb,
    imageBytes: mbToBytes(imageMb, 8),
    videoBytes: mbToBytes(videoMb, 50),
    audioBytes: mbToBytes(audioMb, 15),
    fileBytes: mbToBytes(fileMb, 10),
    maxMessageBytes: 96 * 1024,
    maxAttachments: 4,
    uploadsPer10Min: int(env.UPLOADS_PER_10_MIN, 30),
  },
  syncCron: env.SYNC_CRON || '17 3 * * *',
};

config.google.enabled = Boolean(config.google.clientId && config.google.clientSecret);
config.youtube.enabled = Boolean(config.youtubeApiKey);
config.media.enabled = Boolean(
  config.s3.bucket && config.s3.accessKeyId && config.s3.secretAccessKey,
);

export function publicConfig(taken = 0) {
  return {
    appName: config.appName,
    maxMembers: config.maxMembers,
    taken,
    googleEnabled: config.google.enabled,
    youtubeEnabled: config.youtube.enabled,
    mediaEnabled: config.media.enabled,
    e2ee: true,
    limits: {
      imageMb: config.limits.imageMb,
      videoMb: config.limits.videoMb,
      audioMb: config.limits.audioMb,
      fileMb: config.limits.fileMb,
      maxAttachments: config.limits.maxAttachments,
    },
  };
}
