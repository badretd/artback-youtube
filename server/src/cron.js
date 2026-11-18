import cron from 'node-cron';
import { config } from './config.js';
import { query } from './db.js';
import { deleteObject } from './s3.js';
import { maybeRunStaleSync, syncSubscribers } from './sync.js';

export function startJobs() {
  if (cron.validate(config.syncCron)) {
    cron.schedule(
      config.syncCron,
      () => {
        console.log('[cron] Ежедневное обновление подписчиков...');
        syncSubscribers('cron').catch((error) => {
          console.error('[cron] Ошибка синхронизации:', error.message);
        });
      },
      { timezone: 'UTC' },
    );
    console.log(`[cron] Синхронизация подписчиков запланирована: ${config.syncCron} UTC`);
  } else {
    console.error(`[cron] Некорректное расписание SYNC_CRON: ${config.syncCron}`);
  }

  cron.schedule(
    '23 */6 * * *',
    () => {
      cleanupOrphanMedia().catch((error) => {
        console.error('[cron] Ошибка очистки медиа:', error.message);
      });
    },
    { timezone: 'UTC' },
  );

  cron.schedule(
    '41 4 * * *',
    () => {
      query('DELETE FROM sessions WHERE expires_at < now()').catch((error) => {
        console.error('[cron] Ошибка очистки сессий:', error.message);
      });
    },
    { timezone: 'UTC' },
  );

  setTimeout(() => {
    maybeRunStaleSync().catch((error) => {
      console.error('[cron] Ошибка проверки устаревших данных:', error.message);
    });
  }, 15_000);
}

async function cleanupOrphanMedia() {
  const { rows } = await query(
    `SELECT key FROM media_objects
     WHERE message_id IS NULL AND created_at < now() - interval '24 hours'
     LIMIT 200`,
  );
  if (rows.length === 0) return;

  for (const row of rows) {
    await deleteObject(`media/${row.key}`);
    await query('DELETE FROM media_objects WHERE key = $1', [row.key]);
  }
  console.log(`[cron] Удалено неиспользованных медиафайлов: ${rows.length}`);
}
