// EmailPort 与 NotifierPort 的契约（outbox / ses、db / sns 都要满足）
import { describe, expect, it } from 'vitest';
import type { EmailPort } from '../../src/ports/email.js';
import type { NotificationEvent, NotifierPort } from '../../src/ports/notifier.js';

export function describeEmailContract(driver: string, make: () => Promise<{ port: EmailPort; cleanup?: () => Promise<void> }>): void {
  describe(`EmailPort 契约 · ${driver}`, () => {
    it('meta：module=email、非权威端口', async () => {
      const { port, cleanup } = await make();
      expect(port.meta).toMatchObject({ module: 'email', driver, authoritative: false });
      await cleanup?.();
    });

    it('send() 返回 messageId 与 transport；listRecent() 能看到这封邮件', async () => {
      const { port, cleanup } = await make();
      const r = await port.send({ to: ['someone@example.com'], subject: '测试主题', text: '正文', html: '<p>正文</p>', category: 'system' });
      expect(r.messageId).toBeTruthy();
      expect(['outbox', 'ses']).toContain(r.transport);
      expect(typeof r.delivered).toBe('boolean');
      const recent = await port.listRecent(10);
      expect(recent.find((m) => m.messageId === r.messageId)).toMatchObject({ to: ['someone@example.com'], subject: '测试主题', category: 'system' });
      await cleanup?.();
    });

    it('probe()', async () => {
      const { port, cleanup } = await make();
      expect(['ok', 'degraded']).toContain((await port.probe()).status);
      await cleanup?.();
    });
  });
}

export interface NotifierFixture {
  port: NotifierPort;
  userId: string;
  email: string;
  cleanup?: () => Promise<void>;
}

export function describeNotifierContract(driver: string, make: () => Promise<NotifierFixture>): void {
  const evt = (f: NotifierFixture, eventId: string): NotificationEvent => ({
    eventId, type: 'comment.created', audience: 'user', origin: 'ec2', recipientUserId: f.userId, title: '新评论', body: '有人评论了你的照片',
  });

  describe(`NotifierPort 契约 · ${driver}`, () => {
    it('meta：module=notification、非权威端口', async () => {
      const f = await make();
      expect(f.port.meta).toMatchObject({ module: 'notification', driver, authoritative: false });
      await f.cleanup?.();
    });

    it('publish() 返回 deliveryId 与站外渠道列表', async () => {
      const f = await make();
      const r = await f.port.publish(evt(f, 'c-1'));
      expect(r.deliveryId).toBeTruthy();
      expect(Array.isArray(r.channels)).toBe(true);
      await f.cleanup?.();
    });

    it('subscribeEmail() / unsubscribe()', async () => {
      const f = await make();
      const s = await f.port.subscribeEmail(f.userId, f.email);
      expect(typeof s.pendingConfirmation).toBe('boolean');
      await expect(f.port.unsubscribe(f.userId)).resolves.toBeUndefined();
      await f.cleanup?.();
    });
  });
}
