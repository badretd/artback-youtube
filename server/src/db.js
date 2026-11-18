import pg from 'pg';
import { config } from './config.js';

const { Pool } = pg;

export const pool = new Pool({
  host: config.db.host,
  port: config.db.port,
  user: config.db.user,
  password: config.db.password,
  database: config.db.database,
  max: config.db.max,
  idleTimeoutMillis: 30_000,
  connectionTimeoutMillis: 5_000,
});

pool.on('error', (error) => {
  console.error('[db] Неожиданная ошибка пула:', error.message);
});

export function query(text, params) {
  return pool.query(text, params);
}

export async function withTransaction(fn) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    try {
      await client.query('ROLLBACK');
    } catch {
      /* ignore */
    }
    throw error;
  } finally {
    client.release();
  }
}

export async function waitForDb(attempts = 40) {
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      await pool.query('SELECT 1');
      return;
    } catch (error) {
      if (attempt === attempts) throw error;
      if (attempt === 1) console.log('[db] Ожидаем PostgreSQL...');
      await new Promise((resolve) => setTimeout(resolve, 1500));
    }
  }
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS users (
  id uuid PRIMARY KEY,
  email text NOT NULL UNIQUE,
  password_hash text,
  google_id text UNIQUE,
  display_name text NOT NULL,
  status text NOT NULL DEFAULT 'pending',
  is_admin boolean NOT NULL DEFAULT false,
  channel_id text UNIQUE,
  channel_title text,
  channel_handle text,
  channel_url text,
  avatar_url text,
  subscriber_count bigint,
  hidden_subscribers boolean NOT NULL DEFAULT false,
  verification_code text,
  verification_channel jsonb,
  verification_started_at timestamptz,
  verified_at timestamptz,
  member_number integer UNIQUE,
  public_key jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  last_seen_at timestamptz,
  banned_at timestamptz,
  ban_reason text
);

CREATE INDEX IF NOT EXISTS idx_users_status ON users(status);
CREATE INDEX IF NOT EXISTS idx_users_member_number ON users(member_number);

CREATE TABLE IF NOT EXISTS sessions (
  token_hash text PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  ip text
);

CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id);
CREATE INDEX IF NOT EXISTS idx_sessions_expires ON sessions(expires_at);

CREATE TABLE IF NOT EXISTS messages (
  id bigserial PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  ciphertext text NOT NULL,
  iv text NOT NULL,
  epoch integer NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(),
  deleted_at timestamptz,
  deleted_by uuid REFERENCES users(id) ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS idx_messages_created ON messages(id DESC);
CREATE INDEX IF NOT EXISTS idx_messages_user ON messages(user_id);

CREATE TABLE IF NOT EXISTS group_keys (
  user_id uuid PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  epoch integer NOT NULL DEFAULT 1,
  ephemeral_public_key jsonb NOT NULL,
  iv text NOT NULL,
  wrapped_key text NOT NULL,
  provided_by uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS media_objects (
  key text PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  message_id bigint REFERENCES messages(id) ON DELETE SET NULL,
  size bigint NOT NULL,
  kind text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_media_message ON media_objects(message_id);
CREATE INDEX IF NOT EXISTS idx_media_created ON media_objects(created_at);

CREATE TABLE IF NOT EXISTS audit_log (
  id bigserial PRIMARY KEY,
  actor_id uuid REFERENCES users(id) ON DELETE SET NULL,
  action text NOT NULL,
  details jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_audit_created ON audit_log(id DESC);

CREATE TABLE IF NOT EXISTS sync_runs (
  id bigserial PRIMARY KEY,
  trigger text NOT NULL DEFAULT 'cron',
  started_at timestamptz NOT NULL DEFAULT now(),
  finished_at timestamptz,
  channels integer NOT NULL DEFAULT 0,
  requests integer NOT NULL DEFAULT 0,
  updated integer NOT NULL DEFAULT 0,
  ok boolean,
  error text
);

CREATE INDEX IF NOT EXISTS idx_sync_started ON sync_runs(id DESC);
`;

export async function migrate() {
  await pool.query(SCHEMA);
}
