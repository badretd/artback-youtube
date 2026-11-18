import { Router } from 'express';
import { config } from '../config.js';
import { query } from '../db.js';
import { requireAdmin, verifiedCount } from '../auth.js';
import { disconnectUser, emitToMembers, isOnline, onlineIds } from '../realtime.js';
import { fetchChannelById } from '../youtube.js';
import { lastSync, syncSubscribers } from '../sync.js';
import { asyncRoute, audit, cleanText, httpError, mapUser } from '../util.js';

export const adminRouter = Router();

adminRouter.use(requireAdmin);

adminRouter.get('/overview', asyncRoute(async (_req, res) => {
  const { rows } = await query(`
    SELECT
      (SELECT COUNT(*)::int FROM users WHERE status = 'verified') AS verified,
      (SELECT COUNT(*)::int FROM users WHERE status = 'pending') AS pending,
      (SELECT COUNT(*)::int FROM users WHERE status = 'banned') AS banned,
      (SELECT COUNT(*)::int FROM users WHERE is_admin AND status = 'verified') AS admins,
      (SELECT COUNT(*)::int FROM messages WHERE deleted_at IS NULL) AS messages,
      (SELECT COUNT(*)::int FROM media_objects) AS media_files,
      (SELECT COALESCE(SUM(size), 0)::bigint FROM media_objects) AS media_bytes,
      (SELECT COUNT(*)::int FROM group_keys) AS keys_issued
  `);
  const stats = rows[0];
  const sync = await lastSync();

  res.json({
    stats: {
      ...stats,
      mediaBytes: Number(stats.media_bytes),
      media_bytes: undefined,
      totalAccounts:
        stats.verified + stats.pending + stats.banned,
    },
    slots: { total: config.maxMembers, taken: stats.verified },
    online: onlineIds().length,
    onlineIds: onlineIds(),
    sync: sync
      ? {
          id: sync.id,
          trigger: sync.trigger,
          startedAt: sync.started_at,
          finishedAt: sync.finished_at,
          channels: sync.channels,
          requests: sync.requests,
          updated: sync.updated,
          ok: sync.ok,
          error: sync.error,
        }
      : null,
    limits: {
      imageMb: config.limits.imageMb,
      videoMb: config.limits.videoMb,
      audioMb: config.limits.audioMb,
      fileMb: config.limits.fileMb,
    },
    mediaEnabled: config.media.enabled,
    youtubeEnabled: config.youtube.enabled,
  });
}));

adminRouter.get('/users', asyncRoute(async (_req, res) => {
  const { rows } = await query(
    `SELECT u.*, (gk.user_id IS NOT NULL) AS has_key
     FROM users u LEFT JOIN group_keys gk ON gk.user_id = u.id
     ORDER BY u.created_at DESC`,
  );
  const online = new Set(onlineIds());
  const users = rows.map((row) => {
    const user = mapUser(row, { includeEmail: true });
    user.online = online.has(row.id) || isOnline(row.id);
    user.banReason = row.ban_reason || null;
    user.verification =
      row.status === 'pending' && row.verification_code
        ? {
            code: row.verification_code,
            channel: row.verification_channel,
            startedAt: row.verification_started_at,
          }
        : null;
    return user;
  });
  res.json({ users, total: users.length });
}));

adminRouter.post('/users/:id/ban', asyncRoute(async (req, res) => {
  const target = await getUser(req.params.id);
  if (target.id === req.user.id) throw httpError(400, 'Нельзя заблокировать себя', 'SELF_BAN');

  if (target.is_admin && target.status === 'verified') {
    const admins = await countAdmins();
    if (admins <= 1) {
      throw httpError(
        400,
        'Нельзя заблокировать последнего администратора. Сначала назначьте другого.',
        'LAST_ADMIN',
      );
    }
  }

  const reason = cleanText(req.body?.reason, 300) || null;
  const updated = await query(
    `UPDATE users SET status = 'banned', banned_at = now(), ban_reason = $2
     WHERE id = $1 RETURNING *`,
    [target.id, reason],
  );

  await query('DELETE FROM sessions WHERE user_id = $1', [target.id]);
  await query('DELETE FROM group_keys WHERE user_id = $1', [target.id]);
  await audit(query, req.user.id, 'user_banned', { userId: target.id, reason });

  emitToMembers('member:removed', { id: target.id, reason });
  disconnectUser(target.id);

  res.json({ ok: true, user: mapUser(updated.rows[0], { includeEmail: true }) });
}));

adminRouter.post('/users/:id/unban', asyncRoute(async (req, res) => {
  const target = await getUser(req.params.id);
  if (target.status !== 'banned') throw httpError(400, 'Аккаунт не заблокирован', 'NOT_BANNED');

  let status = 'pending';
  let memberNumber = target.member_number;
  if (target.channel_id) {
    const taken = await verifiedCount();
    if (taken >= config.maxMembers) {
      throw httpError(
        409,
        `Нет свободных мест: ${taken}/${config.maxMembers}. Сначала освободите место.`,
        'SLOTS_FULL',
      );
    }
    status = 'verified';
    if (memberNumber == null) {
      const max = await query('SELECT COALESCE(MAX(member_number), 0)::int AS n FROM users');
      memberNumber = max.rows[0].n + 1;
    }
  }

  const updated = await query(
    `UPDATE users SET status = $2, banned_at = NULL, ban_reason = NULL,
       member_number = COALESCE(member_number, $3)
     WHERE id = $1 RETURNING *`,
    [target.id, status, memberNumber],
  );
  await query('DELETE FROM group_keys WHERE user_id = $1', [target.id]);
  await audit(query, req.user.id, 'user_unbanned', { userId: target.id, status });

  const row = updated.rows[0];
  if (status === 'verified') {
    emitToMembers('member:joined', {
      id: row.id,
      displayName: row.display_name,
      channelTitle: row.channel_title,
      avatarUrl: row.avatar_url,
      publicKey: row.public_key,
      memberNumber: row.member_number,
      isAdmin: row.is_admin,
      hasKey: false,
    });
  }

  res.json({ ok: true, user: mapUser(row, { includeEmail: true }) });
}));

adminRouter.post('/users/:id/admin', asyncRoute(async (req, res) => {
  const target = await getUser(req.params.id);
  const value = req.body?.value === true;
  if (target.status !== 'verified') {
    throw httpError(400, 'Администратором может быть только подтверждённый участник', 'NOT_VERIFIED');
  }
  if (!value && target.is_admin) {
    const admins = await countAdmins();
    if (admins <= 1) {
      throw httpError(400, 'Нельзя снять последнего администратора', 'LAST_ADMIN');
    }
  }

  const updated = await query(
    'UPDATE users SET is_admin = $2 WHERE id = $1 RETURNING id, is_admin',
    [target.id, value],
  );
  await audit(query, req.user.id, value ? 'admin_promoted' : 'admin_demoted', {
    userId: target.id,
  });
  emitToMembers('member:updated', {
    id: target.id,
    isAdmin: updated.rows[0].is_admin,
  });
  res.json({ ok: true, isAdmin: updated.rows[0].is_admin });
}));

adminRouter.post('/users/:id/refresh-channel', asyncRoute(async (req, res) => {
  const target = await getUser(req.params.id);
  if (!target.channel_id) throw httpError(400, 'У пользователя нет канала', 'NO_CHANNEL');
  if (!config.youtube.enabled) throw httpError(503, 'YouTube API не настроен', 'YT_NOT_CONFIGURED');

  const channel = await fetchChannelById(target.channel_id);
  if (!channel) throw httpError(404, 'Канал не найден в YouTube', 'CHANNEL_NOT_FOUND');

  const updated = await query(
    `UPDATE users SET channel_title = $2, channel_handle = $3, avatar_url = $4,
       subscriber_count = $5, hidden_subscribers = $6, channel_url = $7
     WHERE id = $1 RETURNING *`,
    [
      target.id,
      channel.title,
      channel.handle,
      channel.avatarUrl,
      channel.subscriberCount,
      channel.hiddenSubscribers,
      channel.channelUrl,
    ],
  );
  await audit(query, req.user.id, 'channel_refreshed', { userId: target.id });
  emitToMembers('members:synced', { channels: 1, updated: 1, at: new Date().toISOString() });
  res.json({ ok: true, user: mapUser(updated.rows[0], { includeEmail: true }) });
}));

adminRouter.post('/sync', asyncRoute(async (_req, res) => {
  const result = await syncSubscribers('manual');
  const sync = await lastSync();
  res.json({
    ok: true,
    result,
    sync: sync
      ? {
          startedAt: sync.started_at,
          finishedAt: sync.finished_at,
          channels: sync.channels,
          requests: sync.requests,
          updated: sync.updated,
          ok: sync.ok,
          error: sync.error,
        }
      : null,
  });
}));

adminRouter.get('/audit', asyncRoute(async (_req, res) => {
  const { rows } = await query(
    `SELECT a.*, u.display_name, u.channel_title
     FROM audit_log a LEFT JOIN users u ON u.id = a.actor_id
     ORDER BY a.id DESC LIMIT 100`,
  );
  res.json({
    entries: rows.map((row) => ({
      id: Number(row.id),
      action: row.action,
      details: row.details,
      createdAt: row.created_at,
      actor: row.actor_id
        ? {
            id: row.actor_id,
            displayName: row.display_name,
            channelTitle: row.channel_title,
          }
        : null,
    })),
  });
}));

async function getUser(id) {
  const { rows } = await query('SELECT * FROM users WHERE id = $1', [id]);
  if (!rows[0]) throw httpError(404, 'Пользователь не найден', 'USER_NOT_FOUND');
  return rows[0];
}

async function countAdmins() {
  const { rows } = await query(
    "SELECT COUNT(*)::int AS count FROM users WHERE is_admin AND status = 'verified'",
  );
  return rows[0].count;
}
