import { config } from './config.js';
import { query, withTransaction } from './db.js';
import { emitToMembers } from './realtime.js';
import { fetchChannelsByIds } from './youtube.js';

let syncing = false;

export function isSyncing() {
  return syncing;
}

export async function syncSubscribers(trigger = 'cron') {
  if (syncing) {
    const error = new Error('Синхронизация уже выполняется');
    error.status = 409;
    error.code = 'SYNC_IN_PROGRESS';
    throw error;
  }
  syncing = true;

  const run = await query(
    'INSERT INTO sync_runs (trigger) VALUES ($1) RETURNING id',
    [trigger],
  );
  const runId = run.rows[0].id;

  try {
    const { rows } = await query(
      "SELECT channel_id FROM users WHERE status = 'verified' AND channel_id IS NOT NULL ORDER BY member_number",
    );
    const channelIds = rows.map((row) => row.channel_id);

    if (channelIds.length === 0) {
      await query(
        `UPDATE sync_runs SET finished_at = now(), channels = 0, requests = 0, updated = 0, ok = true
         WHERE id = $1`,
        [runId],
      );
      return { channels: 0, requests: 0, updated: 0 };
    }

    const { channels, requests } = await fetchChannelsByIds(channelIds);

    const updated = await withTransaction(async (client) => {
      if (channels.length === 0) return 0;
      const result = await client.query(
        `UPDATE users AS u SET
           channel_title = v.title,
           channel_handle = v.handle,
           avatar_url = v.avatar,
           subscriber_count = v.subs,
           hidden_subscribers = v.hidden,
           channel_url = v.url
         FROM unnest(
           $1::text[], $2::text[], $3::text[], $4::text[], $5::bigint[], $6::boolean[], $7::text[]
         ) AS v(id, title, handle, avatar, subs, hidden, url)
         WHERE u.channel_id = v.id AND u.status = 'verified'`,
        [
          channels.map((channel) => channel.id),
          channels.map((channel) => channel.title),
          channels.map((channel) => channel.handle),
          channels.map((channel) => channel.avatarUrl),
          channels.map((channel) => channel.subscriberCount),
          channels.map((channel) => channel.hiddenSubscribers),
          channels.map((channel) => channel.channelUrl),
        ],
      );
      return result.rowCount;
    });

    await query(
      `UPDATE sync_runs SET finished_at = now(), channels = $2, requests = $3, updated = $4, ok = true
       WHERE id = $1`,
      [runId, channelIds.length, requests, updated],
    );

    emitToMembers('members:synced', {
      channels: channelIds.length,
      requests,
      updated,
      at: new Date().toISOString(),
    });

    console.log(
      `[sync] Обновлено ${updated} каналов (${channelIds.length} всего) за ${requests} запрос(а) к YouTube API.`,
    );

    return { channels: channelIds.length, requests, updated };
  } catch (error) {
    await query(
      `UPDATE sync_runs SET finished_at = now(), ok = false, error = $2 WHERE id = $1`,
      [runId, String(error.message).slice(0, 500)],
    ).catch(() => {});
    throw error;
  } finally {
    syncing = false;
  }
}

export async function lastSync() {
  const { rows } = await query(
    'SELECT * FROM sync_runs ORDER BY id DESC LIMIT 1',
  );
  return rows[0] || null;
}

export async function maybeRunStaleSync() {
  const last = await lastSync();
  const stale =
    !last?.ok ||
    !last?.finished_at ||
    Date.now() - new Date(last.finished_at).getTime() > 24 * 60 * 60 * 1000;
  if (!stale) return;

  const { rows } = await query(
    "SELECT COUNT(*)::int AS count FROM users WHERE status = 'verified' AND channel_id IS NOT NULL",
  );
  if (rows[0].count === 0) return;

  console.log('[sync] Данные о подписчиках устарели — запускаем обновление.');
  syncSubscribers('startup').catch((error) => {
    console.error('[sync] Ошибка стартовой синхронизации:', error.message);
  });
}

export function syncConfig() {
  return { cron: config.syncCron };
}
