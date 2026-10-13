// LoggerPort · file、MetricsPort · local、TracerPort · none、LockPort · file：契约 + 本地实现特有行为
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { FileConfig } from '../../src/adapters/config/file.js';
import { FileLock } from '../../src/adapters/lock/file.js';
import { pickLock } from '../../src/adapters/lock/index.js';
import { FileLogger } from '../../src/adapters/logging/file.js';
import { LocalMetrics, seriesKey } from '../../src/adapters/monitoring/local.js';
import { NoTracer } from '../../src/adapters/tracing/none.js';
import { createRequestContext, runWithContext } from '../../src/observability/request-context.js';
import { writeRuntime } from '../helpers/identity-harness.js';
import { describeLockContract, describeLoggerContract, describeMetricsContract, describeTracerContract } from './ops.contract.js';
import { makeLocalDeps, type LocalDeps } from './_local-deps.js';

describeLoggerContract('file', async () => {
  const l = await makeLocalDeps();
  return { port: new FileLogger(l.deps), cleanup: () => l.close() };
});
describeMetricsContract('local', async () => {
  const l = await makeLocalDeps();
  return { port: new LocalMetrics(l.deps), cleanup: () => l.close() };
});
describeTracerContract('none', async () => {
  const l = await makeLocalDeps();
  return { port: new NoTracer(l.deps), cleanup: () => l.close() };
});
describeLockContract('file', async () => {
  const l = await makeLocalDeps();
  return { port: new FileLock(l.deps), cleanup: () => l.close() };
});

async function readLines(file: string, logger: FileLogger, count: number): Promise<Array<Record<string, unknown>>> {
  for (let i = 0; i < 50; i += 1) {
    await logger.flush();
    let text = '';
    try {
      text = readFileSync(file, 'utf8');
    } catch {
      text = '';
    }
    const lines = text.split('\n').filter(Boolean);
    if (lines.length >= count) return lines.map((x) => JSON.parse(x) as Record<string, unknown>);
    await new Promise((r) => setTimeout(r, 20));
  }
  throw new Error('log lines not flushed');
}

describe('FileLogger（本地实现特有）', () => {
  let l: LocalDeps | undefined;
  afterEach(async () => {
    await l?.close();
    l = undefined;
  });

  it('JSON 行写入 LOG_DIR/<role>.log，自动附加 role、pid、requestId；Error 序列化', async () => {
    l = await makeLocalDeps({ role: 'worker' });
    const logger = new FileLogger(l.deps);
    await logger.init();
    expect(logger.file).toBe(path.join(l.deps.cfg.logging.LOG_DIR, 'worker.log'));
    const ctx = createRequestContext({ requestId: 'req-12345678' });
    runWithContext(ctx, () => logger.child({ component: 'jobs' }).error('job failed', { error: new Error('boom'), job: 'report.daily' }));
    const [line] = await readLines(logger.file, logger, 1);
    expect(line).toMatchObject({ level: 'error', msg: 'job failed', role: 'worker', requestId: 'req-12345678', component: 'jobs', job: 'report.daily' });
    expect((line!.error as { message: string }).message).toBe('boom');
    expect(typeof line!.time).toBe('string');
    expect((await logger.probe()).status).toBe('ok');
  });

  it('级别取运行时配置 logLevel（热键）', async () => {
    l = await makeLocalDeps({ runtime: { logLevel: 'warn' } });
    const runtime = new FileConfig(l.deps);
    await runtime.init();
    l.deps.runtime = runtime;
    const logger = new FileLogger(l.deps);
    logger.info('dropped by level');
    logger.warn('kept');
    writeRuntime(l.envDir, { logLevel: 'debug' });
    await runtime.refresh();
    logger.debug('kept after hot reload');
    const lines = await readLines(logger.file, logger, 2);
    expect(lines.map((x) => x.msg)).toEqual(['kept', 'kept after hot reload']);
    await runtime.close();
  });
});

describe('LocalMetrics（本地实现特有）', () => {
  it('进程内聚合；维度只取白名单', async () => {
    const l = await makeLocalDeps();
    const m = new LocalMetrics(l.deps);
    m.counter('auth.login', 1, { outcome: 'ok' });
    m.counter('auth.login', 2, { outcome: 'ok', userId: 'u-1' } as never);
    m.histogram('feed.ms', 10, 'ms');
    m.histogram('feed.ms', 30, 'ms');
    m.gauge('queue.depth', 5);
    const s = m.snapshot();
    expect(s.counters['auth.login{outcome=ok}']).toBe(3);
    expect(s.histograms['feed.ms']).toMatchObject({ count: 2, unit: 'ms' });
    expect(s.gauges['queue.depth']?.value).toBe(5);
    expect(seriesKey('x', { route: '/a', driver: 'local' })).toBe('x{route=/a,driver=local}');
    await l.close();
  });
});

describe('FileLock（本地实现特有）', () => {
  it('scope=host；持有进程已不存在的锁视为陈旧；pickLock 在 sqlite + 非 redis 时选文件锁', async () => {
    const l = await makeLocalDeps();
    const lock = new FileLock(l.deps);
    expect(lock.scope).toBe('host');
    expect(pickLock(l.deps)).toBeInstanceOf(FileLock);
    const dir = lock.lockDir();
    writeFileSync(path.join(dir, 'stale.lock'), JSON.stringify({ pid: 999_999_999, host: (await import('node:os')).hostname(), token: 't',
      acquiredAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 60_000).toISOString() }));
    const lease = await lock.tryAcquire('stale', 30);
    expect(lease).not.toBeNull();
    await lease!.release();
    writeFileSync(path.join(dir, 'garbage.lock'), 'not json');
    expect(await lock.tryAcquire('garbage', 30)).not.toBeNull();
    await l.close();
  });
});
