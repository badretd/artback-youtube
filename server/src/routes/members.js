import { Router } from 'express';
import { query } from '../db.js';
import { requireVerified } from '../auth.js';
import { isOnline, onlineIds } from '../realtime.js';
import { asyncRoute, mapUser } from '../util.js';

export const membersRouter = Router();

membersRouter.get('/', requireVerified, asyncRoute(async (_req, res) => {
  const { rows } = await query(
    `SELECT u.*, (gk.user_id IS NOT NULL) AS has_key
     FROM users u
     LEFT JOIN group_keys gk ON gk.user_id = u.id
     WHERE u.status = 'verified'
     ORDER BY u.member_number ASC`,
  );

  const online = new Set(onlineIds());
  const members = rows.map((row) => {
    const user = mapUser(row);
    user.online = online.has(row.id) || isOnline(row.id);
    return user;
  });

  res.json({
    members,
    online: [...online],
    total: members.length,
  });
}));
