// SchedulerPort 契约测试：cron 驱动。job_runs 幂等键、singleton 锁、立即运行、失败回写、补跑；cron 表达式工具
import type { Knex } from 'knex';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { CronScheduler, cronMatches, previousOccurrence } from '../../src/adapters/scheduler/cron.js';
import { notImplemented } from '../../src/errors.js';
import { createRequestContext, runWithContext } from '../../src/observability/request-context.js';
import type { LockPort } from '../../src/ports/lock.js';
import type { ScheduledJobDef } from '../../src/ports/scheduler.js';
import { findScheduledRun } from '../../src/repositories/job-runs.js';
import { adapterDeps, memoryLock, testConfig, testDb } from '../helpers/media-fixtures.js';

let db: Knex;
beforeEach(async () => {
  db = await testDb();
});
afterEach(async () => {
  await db.destroy();
});

function def(name: ScheduledJobDef['name'], handler: ScheduledJobDef['handler'], singleton = true): ScheduledJobDef {
  return { name, cron: '0 9 * * *', timezone: 'Asia/Tokyo', singleton, handler };
}

describe('CronScheduler', () => {
  it('triggerNow：写 job_runs（trigger=manual，ok），listRuns 可读；路径头 scheduler=cron:manual', async () => {
    const s = new CronScheduler(adapterDeps(testConfig(), { db, lock: memoryLock() }));
    let ran = 0;
    s.register([def('lab.heartbeat', async () => { ran++; }, false)]);
    const ctx = createRequestContext();
    const run = await runWithContext(ctx, () => s.triggerNow('lab.heartbeat'));
    expect(run).toMatchObject({ name: 'lab.heartbeat', status: 'ok', trigger: 'manual' });
    expect(ran).toBe(1);
    expect(ctx.path.get('scheduler')).toBe('cron:manual');
    expect((await s.listRuns(10)).map((r) => r.runId)).toContain(run.runId);
    await expect(s.triggerNow('report.daily')).rejects.toMatchObject({ status: 404 });
  });

  it('幂等键 (name, scheduledAt)：同一计划时刻第二次记 skipped-duplicate；handler 失败记 failed', async () => {
    const s = new CronScheduler(adapterDeps(testConfig(), { db, lock: memoryLock() }));
    let ran = 0;
    const d = def('share.cleanup', async () => { ran++; });
    s.register([d]);
    const at = new Date('2026-10-13T00:00:00.000Z');
    const r1 = await s.runJob(d, { trigger: 'cron', scheduledAt: at });
    const r2 = await s.runJob(d, { trigger: 'cron', scheduledAt: at });
    expect(r1.status).toBe('ok');
    expect(r2.status).toBe('skipped-duplicate');
    expect(r2.scheduledAt).toBe(at.toISOString());
    expect(ran).toBe(1);
    const bad = def('audit.retention', async () => { throw new Error('boom'); });
    const r3 = await s.runJob(bad, { trigger: 'cron', scheduledAt: at });
    expect(r3.status).toBe('failed');
    expect((await findScheduledRun(db, 'audit.retention', at.toISOString()))?.error).toBe('boom');
    expect((await s.probe()).status).toBe('degraded');
  });

  it('singleton：锁被占用时记 skipped-locked，不执行 handler', async () => {
    const lock = memoryLock();
    const s = new CronScheduler(adapterDeps(testConfig(), { db, lock }));
    let ran = 0;
    const d = def('report.daily', async () => { ran++; });
    await lock.tryAcquire('job-report.daily', 60);
    const r = await s.runJob(d, { trigger: 'cron', scheduledAt: new Date('2026-10-13T00:00:00Z') });
    expect(r.status).toBe('skipped-locked');
    expect(ran).toBe(0);
  });

  it('LockPort 尚未实现时退回进程内互斥（并发的同名任务只执行一个）', async () => {
    const stub: LockPort = { driver: 'file', scope: 'host', tryAcquire: async () => { throw notImplemented('FileLock', 'tryAcquire'); } };
    const s = new CronScheduler(adapterDeps(testConfig(), { db, lock: stub }));
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    const d = def('image.reconcile', async () => { await gate; });
    const p1 = s.runJob(d, { trigger: 'cron', scheduledAt: new Date('2026-10-13T00:01:00Z') });
    const r2 = await s.runJob(d, { trigger: 'cron', scheduledAt: new Date('2026-10-13T00:02:00Z') });
    expect(r2.status).toBe('skipped-locked');
    release();
    expect((await p1).status).toBe('ok');
  });

  it('SCHEDULER_CATCHUP：上一个计划时刻没有运行记录的任务在 start() 时补跑（trigger=manual）', async () => {
    const s = new CronScheduler(adapterDeps(testConfig({ SCHEDULER_CATCHUP: 'report.daily' }), { db, lock: memoryLock(), role: 'worker' }));
    let ran = 0;
    s.register([def('report.daily', async () => { ran++; })]);
    const abort = new AbortController();
    await s.start(abort.signal);
    expect(ran).toBe(1);
    const prev = previousOccurrence('0 9 * * *', 'Asia/Tokyo', new Date())!;
    expect((await findScheduledRun(db, 'report.daily', prev.toISOString()))?.trigger).toBe('manual');
    abort.abort();
    // 第二次启动不再补跑
    const s2 = new CronScheduler(adapterDeps(testConfig({ SCHEDULER_CATCHUP: 'report.daily' }), { db, lock: memoryLock(), role: 'worker' }));
    s2.register([def('report.daily', async () => { ran++; })]);
    const abort2 = new AbortController();
    await s2.start(abort2.signal);
    abort2.abort();
    expect(ran).toBe(1);
  });

  it('register 拒绝无效表达式', () => {
    const s = new CronScheduler(adapterDeps(testConfig(), { db }));
    expect(() => s.register([{ ...def('lab.compact', async () => undefined), cron: 'not a cron' }])).toThrow(/表达式无效/);
  });
});

describe('cron 表达式工具（补跑用）', () => {
  it('cronMatches 按时区求值', () => {
    // 2026-10-13T00:00Z = 东京 09:00
    expect(cronMatches('0 9 * * *', new Date('2026-10-13T00:00:00Z'), 'Asia/Tokyo')).toBe(true);
    expect(cronMatches('0 9 * * *', new Date('2026-10-13T09:00:00Z'), 'Asia/Tokyo')).toBe(false);
    expect(cronMatches('*/5 * * * *', new Date('2026-10-13T00:10:00Z'), 'Asia/Tokyo')).toBe(true);
    expect(cronMatches('*/5 * * * *', new Date('2026-10-13T00:11:00Z'), 'Asia/Tokyo')).toBe(false);
    expect(cronMatches('30 3 * * 1-5', new Date('2026-10-12T18:30:00Z'), 'Asia/Tokyo')).toBe(true);   // 东京周二 03:30
  });

  it('previousOccurrence 回溯到上一个计划时刻', () => {
    expect(previousOccurrence('0 9 * * *', 'Asia/Tokyo', new Date('2026-10-13T05:00:00Z'))?.toISOString()).toBe('2026-10-13T00:00:00.000Z');
    expect(previousOccurrence('0 9 * * *', 'Asia/Tokyo', new Date('2026-10-12T23:59:00Z'))?.toISOString()).toBe('2026-10-12T00:00:00.000Z');
    expect(previousOccurrence('0 * * * *', 'Asia/Tokyo', new Date('2026-10-13T05:30:10Z'))?.toISOString()).toBe('2026-10-13T05:00:00.000Z');
  });
});
