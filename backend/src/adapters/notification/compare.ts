// backend/src/adapters/notification/compare.ts —— POST /api/lab/notification/compare 的功能对照（04#notification 第 5 节；wave1-sns-ses）
//
// 把同一个 report.ready 测试事件分别经 db 驱动（逐个调用 EmailPort，接收人 = 全部管理员）和 sns 驱动（一次 Publish）各发一次，
// 返回两边的耗时、调用次数与渠道。db 驱动在 sns 档下按需临时构造（本地驱动没有外部依赖）；测试事件不写站内信。
// 路由（仅管理员）由集成阶段在 http/routes 中登记：`res.json(await compareNotificationDrivers(deps, c.notifier))`。
import { performance } from 'node:perf_hooks';
import { ulid } from 'ulid';
import type { EmailPort } from '../../ports/email.js';
import type { NotificationEvent, NotifierPort } from '../../ports/notifier.js';
import { listAdmins } from '../../repositories/users.js';
import type { AdapterDeps } from '../types.js';
import { need } from '../types.js';
import { DbNotifier } from './db.js';

export interface DriverRun {
  ms: number;
  calls: number;
  channels: string[];
  deliveryId?: string;
  error?: string;
}

export interface NotificationCompareResult {
  type: 'report.ready';
  audience: 'admin';
  /** 管理员人数 = db 驱动逐个发信的次数上限 */
  recipients: number;
  db: DriverRun & { eventId: string; emailTransport: string };
  sns: (DriverRun & { eventId: string }) | { skipped: string };
  note: string;
}

function testEvent(tag: string): NotificationEvent {
  return {
    eventId: `cmp-${tag}-${ulid()}`, type: 'report.ready', audience: 'admin', origin: 'ec2', recipientUserId: '*',
    title: 'CloudAlbum 功能对照：测试事件', body: `这是 /api/lab/notification/compare 经 ${tag} 驱动发出的测试事件（不写站内信）。`,
    link: '/lab/m/notification', data: { compare: tag },
  };
}

async function timed(fn: () => Promise<{ deliveryId: string; channels: string[] }>, counter: () => number): Promise<DriverRun> {
  const t0 = performance.now();
  try {
    const r = await fn();
    return { ms: Math.round((performance.now() - t0) * 10) / 10, calls: counter(), channels: r.channels, deliveryId: r.deliveryId };
  } catch (e) {
    return { ms: Math.round((performance.now() - t0) * 10) / 10, calls: counter(), channels: [], error: (e as Error).message };
  }
}

/** current = 当前装配的 NotifierPort（c.notifier）；deps 需要 db 与 email */
export async function compareNotificationDrivers(deps: AdapterDeps, current: NotifierPort): Promise<NotificationCompareResult> {
  const db = need(deps, 'db', 'compareNotificationDrivers');
  const email = need(deps, 'email', 'compareNotificationDrivers');
  const recipients = (await listAdmins(db)).length;

  // db：包一层计数的 EmailPort，数一数逐个发了几封
  let emailCalls = 0;
  const counting: EmailPort = {
    meta: email.meta,
    probe: (o) => email.probe(o),
    send: (m) => { emailCalls += 1; return email.send(m); },
    listRecent: (n) => email.listRecent(n),
  };
  const dbEvent = testEvent('db');
  const dbRun = await timed(() => new DbNotifier({ ...deps, email: counting }).publish(dbEvent), () => emailCalls);

  let sns: NotificationCompareResult['sns'];
  if (current.meta.driver === 'sns') {
    const snsEvent = testEvent('sns');
    const run = await timed(() => current.publish(snsEvent), () => 1);
    sns = { ...run, eventId: snsEvent.eventId };
  } else {
    sns = { skipped: `NOTIFY_DRIVER=${current.meta.driver}：sns 驱动未启用（scripts/module enable notification）` };
  }
  return {
    type: 'report.ready', audience: 'admin', recipients,
    db: { ...dbRun, eventId: dbEvent.eventId, emailTransport: email.meta.driver },
    sns,
    note: 'db 驱动的耗时随管理员人数线性增长；sns 驱动只有一次 Publish，逐个投递由 SNS 完成（是否送达看邮箱与 CloudWatch 的 NumberOfNotificationsDelivered）',
  };
}
