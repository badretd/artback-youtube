import { Router } from 'express';
import rateLimit from 'express-rate-limit';
import { requireAuth, requireVerified } from '../auth.js';
import { createMessage, deleteMessage, getMessages } from '../messages.js';
import { asyncRoute, parsePositiveInt } from '../util.js';

export const messagesRouter = Router();

const messageLimiter = rateLimit({
  windowMs: 60 * 1000,
  limit: 40,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  keyGenerator: (req) => req.user?.id || req.ip,
  message: { error: 'Слишком много сообщений. Подождите минуту.' },
});

messagesRouter.get('/', requireVerified, asyncRoute(async (req, res) => {
  const before = parsePositiveInt(req.query.before, null);
  const limit = parsePositiveInt(req.query.limit, 30);
  const messages = await getMessages({ before, limit });
  res.json({ messages });
}));

messagesRouter.post('/', requireVerified, messageLimiter, asyncRoute(async (req, res) => {
  const message = await createMessage(req.user.id, req.body || {});
  res.status(201).json({ message });
}));

messagesRouter.delete('/:id', requireAuth, requireVerified, asyncRoute(async (req, res) => {
  const result = await deleteMessage(req.params.id, req.user);
  res.json(result);
}));
