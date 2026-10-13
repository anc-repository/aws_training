// LoggerPort、MetricsPort、TracerPort、LockPort 的契约（file / cloudwatch、local / cloudwatch、none / local / xray、file / pg / redis）
import { describe, expect, it } from 'vitest';
import type { LockPort } from '../../src/ports/lock.js';
import type { LoggerPort } from '../../src/ports/logger.js';
import type { MetricsPort } from '../../src/ports/metrics.js';
import type { TracerPort } from '../../src/ports/tracer.js';

type Make<T> = () => Promise<{ port: T; cleanup?: () => Promise<void> }>;

export function describeLoggerContract(driver: string, make: Make<LoggerPort>): void {
  describe(`LoggerPort 契约 · ${driver}`, () => {
    it('五个级别与 child() 都可调用且不抛出；flush() 完成；stats() 计数', async () => {
      const { port, cleanup } = await make();
      await port.init?.();
      for (const level of ['debug', 'info', 'warn', 'error'] as const) port[level](`msg-${level}`, { n: 1 });
      port.log('info', 'via log()', { err: new Error('boom') });
      const child = port.child({ component: 'test' });
      child.info('from child');
      child.child({ deeper: true }).warn('from grandchild');
      await port.flush();
      const s = port.stats();
      expect(s.written).toBeGreaterThan(0);
      expect(s.dropped).toBe(0);
      expect(port.meta).toMatchObject({ module: 'logging', driver, authoritative: false });
      await cleanup?.();
    });
  });
}

export function describeMetricsContract(driver: string, make: Make<MetricsPort>): void {
  describe(`MetricsPort 契约 · ${driver}`, () => {
    it('counter / histogram / gauge 不抛出（热路径）；flush() 完成；probe()', async () => {
      const { port, cleanup } = await make();
      port.counter('photos.uploaded');
      port.counter('photos.uploaded', 2, { driver: 'local' });
      port.histogram('upload.bytes', 1024, 'bytes', { route: '/api/photos' });
      port.gauge('queue.depth', 3, { module: 'queue' });
      await expect(port.flush()).resolves.toBeUndefined();
      expect(['ok', 'degraded']).toContain((await port.probe()).status);
      expect(port.meta).toMatchObject({ module: 'monitoring', driver });
      await cleanup?.();
    });
  });
}

export function describeTracerContract(driver: string, make: Make<TracerPort>): void {
  describe(`TracerPort 契约 · ${driver}`, () => {
    it('startSpan() 返回可结束的 span；withSpan() 透传返回值与异常；inject / extract 不抛出', async () => {
      const { port, cleanup } = await make();
      const span = port.startSpan('test', { kind: 'internal', attributes: { a: 1 } });
      span.setAttribute('k', 'v');
      span.recordError(new Error('x'));
      span.end();
      expect(await port.withSpan('ok', async () => 42)).toBe(42);
      await expect(port.withSpan('fail', async () => { throw new Error('inner'); })).rejects.toThrow('inner');
      const carrier: Record<string, string> = {};
      port.inject(carrier);
      port.extract(carrier);
      expect(port.meta).toMatchObject({ module: 'tracing', driver });
      await cleanup?.();
    });
  });
}

export function describeLockContract(driver: string, make: Make<LockPort>): void {
  describe(`LockPort 契约 · ${driver}`, () => {
    it('同名锁互斥；释放后可再次获得；不同名的锁互不影响；release 幂等', async () => {
      const { port, cleanup } = await make();
      expect(port.driver).toBe(driver);
      expect(['host', 'cluster']).toContain(port.scope);
      const a = await port.tryAcquire('report.daily', 30);
      expect(a?.name).toBe('report.daily');
      expect(await port.tryAcquire('report.daily', 30)).toBeNull();
      const other = await port.tryAcquire('share.cleanup', 30);
      expect(other).not.toBeNull();
      await a!.release();
      await a!.release();
      const again = await port.tryAcquire('report.daily', 30);
      expect(again).not.toBeNull();
      await again!.release();
      await other!.release();
      await cleanup?.();
    });

    it('持有者的 ttl 过期后，锁可以被别人获得', async () => {
      const { port, cleanup } = await make();
      const a = await port.tryAcquire('lab.compact', 1);
      expect(a).not.toBeNull();
      await new Promise((r) => setTimeout(r, 1200));
      const b = await port.tryAcquire('lab.compact', 30);
      expect(b).not.toBeNull();
      await a!.release();                                         // 过期持有者的 release 不能删掉别人的锁
      expect(await port.tryAcquire('lab.compact', 30)).toBeNull();
      await b!.release();
      await cleanup?.();
    });
  });
}
