// jobs/：定时任务注册表与 handler、队列任务绑定、worker 的循环装配；services/report.ts 的日期换算
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { makeTestImage } from '@cloudalbum/image-core';
import { asLocalMultipart } from '../../src/adapters/storage/local.js';
import { Readable } from 'node:stream';
import { buildContainer, type Container } from '../../src/container.js';
import { nowIso } from '../../src/db/dialect.js';
import { bindJobs, totalConcurrency } from '../../src/jobs/index.js';
import {
  analyticsRetention, auditRetention, imageReconcile, labCompact, outboxRetention, SCHEDULE, scheduledJobs, shareCleanup,
} from '../../src/jobs/schedule.js';
import type { SecretName } from '../../src/ports/secrets.js';
import { getPhoto, insertPhoto } from '../../src/repositories/photos.js';
import { computeDailyStats, nextDay, previousDay, toCsv, zonedDate, zonedMidnightUtc } from '../../src/services/report.js';
import { startWorkerLoops } from '../../src/worker.js';
import { tempEnvDir } from '../helpers/config.js';
import { seedUser } from '../helpers/media-fixtures.js';

let c: Container;
let dataDir: string;

beforeAll(async () => {
  dataDir = mkdtempSync(path.join(os.tmpdir(), 'cloudalbum-jobs-'));
  const envDir = tempEnvDir({
    base: { APP_BASE_URL: 'http://localhost:3000', CLOUDALBUM_DATA_DIR: dataDir.replace(/\\/g, '/') },
    override: { STORAGE_LOCAL_MIN_FREE_PCT: '1' },
    modules: { scheduler: { SCHEDULER_COMPARE_HEARTBEAT: 'on' } },
  });
  c = await buildContainer('worker', { envDir, processEnv: { NODE_ENV: 'test' } });
  Object.defineProperty(c.secrets, 'get', { value: async (n: SecretName) => `jobs-test-${n}`, configurable: true, writable: true });
});
afterAll(async () => {
  await c?.close();
});

describe('定时任务注册表', () => {
  it('8 个 ScheduledJobName；lab.heartbeat 只在 SCHEDULER_COMPARE_HEARTBEAT=on 时注册；时区 Asia/Tokyo', () => {
    expect(SCHEDULE.map((e) => e.name).sort()).toEqual([
      'analytics.retention', 'audit.retention', 'image.reconcile', 'lab.compact', 'lab.heartbeat', 'outbox.retention', 'report.daily', 'share.cleanup',
    ]);
    const defs = scheduledJobs(c);
    expect(defs).toHaveLength(8);
    expect(defs.every((d) => d.timezone === 'Asia/Tokyo')).toBe(true);
    expect(defs.find((d) => d.name === 'lab.heartbeat')?.singleton).toBe(false);
    expect(defs.find((d) => d.name === 'report.daily')).toMatchObject({ cron: '0 9 * * *', singleton: true });
  });

  it('worker 启动：bind 队列任务，注册并启动调度器，triggerNow 写 job_runs', async () => {
    const abort = new AbortController();
    await startWorkerLoops(c, abort.signal);
    const run = await c.scheduler.triggerNow('lab.heartbeat');
    expect(run).toMatchObject({ name: 'lab.heartbeat', status: 'ok', trigger: 'manual' });
    expect((await c.scheduler.listRuns(5)).some((r) => r.runId === run.runId)).toBe(true);
    abort.abort();
  });

  it('bindJobs 幂等；总并发是各任务名上限之和', () => {
    bindJobs(c);
    bindJobs(c);
    expect(totalConcurrency(c)).toBe(1 + 2 + 4 + 2 + 1);
  });
});

describe('定时任务 handler', () => {
  it('image.reconcile：删除 UPLOADING 超过 1 小时的孤儿、清理 .incoming 残留、PROCESSING 超时的照片重新处理', async () => {
    const owner = await seedUser(c.db);
    const orphanId = randomUUID();
    await insertPhoto(c.db, { id: orphanId, ownerId: owner, albumId: null, rawKey: `raw/${owner}/${orphanId}.jpg`, filename: 'o.jpg', contentType: 'image/jpeg', sizeBytes: null, visibility: 'private' });
    await c.db('photos').where({ id: orphanId }).update({ created_at: '2020-01-01T00:00:00.000Z' });
    const stuckId = randomUUID();
    const rawKey = `raw/${owner}/${stuckId}.jpg`;
    await insertPhoto(c.db, { id: stuckId, ownerId: owner, albumId: null, rawKey, filename: 's.jpg', contentType: 'image/jpeg', sizeBytes: null, visibility: 'private' });
    await c.storage.putObject(rawKey, await makeTestImage(), { contentType: 'image/jpeg' });
    await c.db('photos').where({ id: stuckId }).update({ status: 'PROCESSING', processing_started_at: '2020-01-01T00:00:00.000Z', processing_attempts: 1 });
    await asLocalMultipart(c.storage)!.writePart('stale-upload-0001', 1, Readable.from([Buffer.from('x')]), { maxBytes: 10 });

    const r = await imageReconcile(c, new Date(Date.now() + 2 * 86_400_000));   // “两天后”：.incoming 残留超过 24 小时
    expect(r).toMatchObject({ orphans: 1, resubmitted: 1, failed: 0 });
    expect(r.incoming).toBeGreaterThanOrEqual(1);
    expect(await getPhoto(c.db, orphanId)).toBeUndefined();
    expect((await getPhoto(c.db, stuckId))!.status).toBe('READY');
  });

  it('share.cleanup / analytics.retention / audit.retention / outbox.retention / lab.compact', async () => {
    await c.db('share_links').insert({ token: 'old-share-token', photo_id: 'p', created_by: 'u', created_at: '2020-01-01T00:00:00.000Z', expires_at: '2020-01-02T00:00:00.000Z' });
    expect(await shareCleanup(c)).toBeGreaterThanOrEqual(1);

    await c.db('click_events').insert({ event_id: 'old-event-000001', ts: '2020-01-01T00:00:00.000Z', session_id: 's', type: 'page_view', path: '/', ip_hash: 'h' });
    await c.db('click_events').insert({ event_id: 'new-event-000001', ts: nowIso(), session_id: 's', type: 'page_view', path: '/', ip_hash: 'h' });
    expect(await analyticsRetention(c)).toBe(1);

    await c.db('audit_log').insert({ ts: '2020-01-01T00:00:00.000Z', actor_type: 'system', action: 'x', result: 'success', hash: 'h1' });
    await c.db('audit_log').insert({ ts: nowIso(), actor_type: 'system', action: 'y', result: 'success', hash: 'h2' });
    expect(await auditRetention(c)).toBe(1);
    expect(await c.db('audit_log').count({ n: '*' }).first()).toMatchObject({ n: 1 });

    const outboxDir = c.config.email.OUTBOX_DIR;
    const oldDir = path.join(outboxDir, '2020-01-01');
    mkdirSync(oldDir, { recursive: true });
    const eml = path.join(oldDir, 'm1.eml');
    writeFileSync(eml, 'Subject: hi\n\nbody');
    await c.db('outbox_emails').insert({
      id: randomUUID(), message_id: 'm1', to_addrs: JSON.stringify(['a@b']), subject: 'hi', category: 'system', transport: 'outbox',
      status: 'sent', user_id: null, eml_path: eml, created_at: '2020-01-01T00:00:00.000Z',
    });
    await c.db('processed_jobs').insert({ job_key: 'old-job', name: 'email.send', processed_at: '2020-01-01T00:00:00.000Z' });
    const r = await outboxRetention(c);
    expect(r).toMatchObject({ emails: 1, files: 1, processedJobs: 1 });
    expect(existsSync(oldDir)).toBe(false);

    expect(await labCompact(c)).toEqual({ skipped: false });   // repositories/lab.ts 已提供 compactRollups（integration）
  });
});

describe('日报的日期换算（services/report.ts）', () => {
  it('东京时区的“昨天”与 UTC 区间', () => {
    expect(zonedDate(new Date('2026-10-13T00:30:00Z'), 'Asia/Tokyo')).toBe('2026-10-13');
    expect(zonedDate(new Date('2026-10-12T14:30:00Z'), 'Asia/Tokyo')).toBe('2026-10-12');
    expect(zonedMidnightUtc('2026-10-12', 'Asia/Tokyo').toISOString()).toBe('2026-10-11T15:00:00.000Z');
    expect(zonedMidnightUtc('2026-03-08', 'America/New_York').toISOString()).toBe('2026-03-08T05:00:00.000Z');
    expect(previousDay('2026-03-01')).toBe('2026-02-28');
    expect(nextDay('2026-12-31')).toBe('2027-01-01');
  });

  it('统计与 CSV', async () => {
    const day = zonedDate(new Date(), 'Asia/Tokyo');
    const stats = await computeDailyStats({ cfg: c.config, db: c.db }, day);
    expect(stats).toMatchObject({ date: day, timezone: 'Asia/Tokyo' });
    const csv = toCsv(stats);
    expect(csv.split('\n')[0]).toBe('metric,value');
    expect(csv).toContain('active_users,');
  });
});
