import { config } from './config.js';
import { withTransaction } from './db.js';
import { emitToMembers } from './realtime.js';
import { audit, httpError } from './util.js';

const VERIFICATION_LOCK = 781234561;

function memberEvent(row) {
  return {
    id: row.id,
    displayName: row.display_name,
    channelTitle: row.channel_title,
    avatarUrl: row.avatar_url,
    publicKey: row.public_key || null,
    memberNumber: row.member_number,
    isAdmin: Boolean(row.is_admin),
    hasKey: false,
  };
}

/**
 * Atomically verifies a channel and turns a pending account into a member.
 * Enforces: unique channel, max member capacity, member numbering, first member = admin.
 */
export async function linkVerifiedChannel(userId, channel, source = 'description') {
  const result = await withTransaction(async (client) => {
    await client.query('SELECT pg_advisory_xact_lock($1)', [VERIFICATION_LOCK]);

    const existing = await client.query(
      'SELECT id FROM users WHERE channel_id = $1 AND id <> $2 LIMIT 1',
      [channel.id, userId],
    );
    if (existing.rows[0]) {
      throw httpError(409, 'Этот YouTube-канал уже привязан к другому аккаунту.', 'CHANNEL_TAKEN');
    }

    const countResult = await client.query(
      "SELECT COUNT(*)::int AS taken FROM users WHERE status = 'verified'",
    );
    const taken = countResult.rows[0].taken;
    if (taken >= config.maxMembers) {
      throw httpError(
        409,
        `Все ${config.maxMembers} мест заняты. Регистрация закрыта.`,
        'SLOTS_FULL',
      );
    }

    const numberResult = await client.query(
      'SELECT COALESCE(MAX(member_number), 0)::int AS max_number FROM users',
    );
    const memberNumber = numberResult.rows[0].max_number + 1;
    const isFirstAdmin = taken === 0;

    const updated = await client.query(
      `UPDATE users SET
         status = 'verified',
         is_admin = (is_admin OR $3),
         channel_id = $2,
         channel_title = $4,
         channel_handle = $5,
         channel_url = $6,
         avatar_url = $7,
         subscriber_count = $8,
         hidden_subscribers = $9,
         member_number = $10,
         verified_at = COALESCE(verified_at, now()),
         verification_code = NULL,
         verification_channel = NULL,
         verification_started_at = NULL,
         banned_at = NULL,
         ban_reason = NULL
       WHERE id = $1
       RETURNING *`,
      [
        userId,
        channel.id,
        isFirstAdmin,
        channel.title,
        channel.handle,
        channel.channelUrl,
        channel.avatarUrl,
        channel.subscriberCount,
        channel.hiddenSubscribers,
        memberNumber,
      ],
    );

    const row = updated.rows[0];
    if (!row) throw httpError(404, 'Аккаунт не найден', 'USER_NOT_FOUND');

    await audit(client, userId, 'channel_verified', {
      channelId: channel.id,
      channelTitle: channel.title,
      source,
      memberNumber,
      firstAdmin: isFirstAdmin,
    });

    return { user: row, isFirstAdmin, memberNumber };
  });

  emitToMembers('member:joined', memberEvent(result.user));
  if (result.isFirstAdmin) {
    emitToMembers('member:promoted', {
      id: result.user.id,
      message: 'Первый участник назначен администратором',
    });
  }

  return result;
}
