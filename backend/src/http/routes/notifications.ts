// backend/src/http/routes/notifications.ts —— F10：站内信列表、未读数、已读、通知设置（04#notification 第 1 节）
//
//   GET  /api/notifications                ?cursor&limit&unread=1 → Page<NotificationItem>（另带 unread 计数）
//   GET  /api/notifications/unread-count   → {count}（前端铃铛每 30 秒轮询）
//   POST /api/notifications/:id/read       → 204
//   POST /api/notifications/read-all       → {updated}
//   GET  /api/notifications/prefs          → {emailEnabled, sns, driver}
//   PUT  /api/notifications/prefs          {emailEnabled} → 同上（db 档只改布尔值；sns 档建 / 删按 userId 过滤的邮件订阅）
// 站内信由核心服务写入（与驱动无关）；设置变更经 NotifierPort.subscribeEmail / unsubscribe。
import type { Express } from 'express';
import { z } from 'zod';
import type { Container } from '../../container.js';
import { HttpError } from '../../errors.js';
import { driverOf } from '../../modules/registry.js';
import {
  countUnread, getNotificationPrefs, listNotifications, markAllNotificationsRead, markNotificationRead,
} from '../../repositories/notifications.js';
import { toNotificationItem } from '../../services/notifications.js';
import { audit } from '../middleware/audit.js';
import { currentUser, requireAuth } from '../middleware/auth.js';
import { parseBody } from './auth.js';

const PrefsBody = z.object({ emailEnabled: z.boolean() });

export function register(app: Express, c: Container): void {
  const prefsView = async (userId: string) => {
    const p = await getNotificationPrefs(c.db, userId);
    return {
      emailEnabled: p.emailEnabled,
      driver: driverOf(c.env, 'notification'),
      sns: p.snsSubscriptionArn || p.snsStatus ? { status: p.snsStatus ?? 'none', ...(p.snsSubscriptionArn ? { endpoint: p.snsSubscriptionArn } : {}) } : null,
    };
  };

  app.get('/api/notifications', requireAuth, async (req, res) => {
    const me = currentUser();
    const limit = Math.min(Math.max(Number(req.query.limit ?? 20) || 20, 1), 100);
    const cursor = typeof req.query.cursor === 'string' ? req.query.cursor : undefined;
    const unreadOnly = req.query.unread === '1' || req.query.unread === 'true';
    const page = await listNotifications(c.dbRead, me.userId, { limit, unreadOnly, ...(cursor ? { cursor } : {}) });
    res.set('Cache-Control', 'private, no-store').json({
      items: page.items.map(toNotificationItem), nextCursor: page.nextCursor, unread: await countUnread(c.dbRead, me.userId),
    });
  });

  app.get('/api/notifications/unread-count', requireAuth, async (_req, res) => {
    const me = currentUser();
    res.set('Cache-Control', 'private, no-store').json({ count: await countUnread(c.dbRead, me.userId) });
  });

  app.post('/api/notifications/read-all', requireAuth, async (_req, res) => {
    const me = currentUser();
    res.json({ updated: await markAllNotificationsRead(c.db, me.userId) });
  });

  app.post('/api/notifications/:id/read', requireAuth, async (req, res) => {
    const me = currentUser();
    if (!(await markNotificationRead(c.db, me.userId, String(req.params.id)))) throw new HttpError(404, 'NOT_FOUND', '通知不存在');
    res.status(204).end();
  });

  app.get('/api/notifications/prefs', requireAuth, async (_req, res) => {
    const me = currentUser();
    res.set('Cache-Control', 'private, no-store').json(await prefsView(me.userId));
  });

  app.put('/api/notifications/prefs', requireAuth, async (req, res) => {
    const me = currentUser();
    const body = parseBody(PrefsBody, req.body);
    let pendingConfirmation = false;
    if (body.emailEnabled) pendingConfirmation = (await c.notifier.subscribeEmail(me.userId, me.email)).pendingConfirmation;
    else await c.notifier.unsubscribe(me.userId);
    await audit(c, { action: 'notification.prefs', targetType: 'user', targetId: me.userId, details: { emailEnabled: body.emailEnabled } });
    res.json({ ...(await prefsView(me.userId)), pendingConfirmation });
  });
}
