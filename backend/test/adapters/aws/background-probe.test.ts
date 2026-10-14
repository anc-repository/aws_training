// adapters/aws/background-probe.ts：探针的后台刷新（wave1-fix）——慢的控制面读取不占用能力注册表 2 秒的探针预算
import { describe, expect, it } from 'vitest';
import { BackgroundProbe, probeResultFromError } from '../../../src/adapters/aws/background-probe.js';
import type { ProbeResult } from '../../../src/ports/common.js';
import { awsError } from './helpers.js';

function deferred<T>() {
  let resolve!: (v: T) => void;
  const p = new Promise<T>((r) => { resolve = r; });
  return { p, resolve };
}

describe('BackgroundProbe', () => {
  it('预算内完成：原样返回；每次调用都重新读取（没有进行中的调用时）', async () => {
    const bg = new BackgroundProbe({ label: 'X 控制面', budgetMs: 50 });
    let n = 0;
    const fn = async (): Promise<ProbeResult> => ({ status: 'ok', detail: `call ${(n += 1)}` });
    expect((await bg.run(fn)).detail).toBe('call 1');
    expect((await bg.run(fn)).detail).toBe('call 2');
  });

  it('首次读取慢于预算：返回 degraded + transient 占位，读取在后台继续；晚到的结果成为“上一次结果”', async () => {
    let t = 1_000_000;
    const bg = new BackgroundProbe({ label: 'X 控制面', budgetMs: 20, now: () => t });
    const slow = deferred<ProbeResult>();
    const r1 = await bg.run(() => slow.p);
    expect(r1).toMatchObject({ status: 'degraded', transient: true });
    expect(r1.detail).toContain('正在查询 X 控制面');
    slow.resolve({ status: 'ok', detail: 'GetThing 200', data: { a: 1 } });
    await slow.p;
    await new Promise((r) => setImmediate(r));
    expect(bg.lastResult()?.detail).toBe('GetThing 200');

    // 下一轮仍然慢：返回上一次的结果并注明（状态不因为慢而改变）
    t += 30_000;
    const slow2 = deferred<ProbeResult>();
    const r2 = await bg.run(() => slow2.p);
    expect(r2).toMatchObject({ status: 'ok', data: { a: 1, staleMs: 30_000 } });
    expect(r2.detail).toContain('显示 30 秒前的结果');
    // 同一轮的并发调用共用进行中的读取
    const r3 = await bg.run(async () => ({ status: 'error', detail: 'should not run' }));
    expect(r3.status).toBe('ok');
    slow2.resolve({ status: 'ok', detail: 'later' });
  });

  it('上一次结果太旧（超过 maxStaleMs）时不再沿用，返回 transient 占位；挂起的调用超过 maxInflightMs 后另起一次', async () => {
    let t = 0;
    const bg = new BackgroundProbe({ label: 'X', budgetMs: 10, maxStaleMs: 60_000, maxInflightMs: 30_000, now: () => t });
    await bg.run(async () => ({ status: 'ok', detail: 'fresh' }));
    t += 61_000;
    const hung = deferred<ProbeResult>();
    expect(await bg.run(() => hung.p)).toMatchObject({ status: 'degraded', transient: true });
    t += 31_000;
    expect((await bg.run(async () => ({ status: 'ok', detail: 'again' }))).detail).toBe('again');
  });

  it('慢探针函数抛出的异常：瞬时错误 → degraded + transient；其他 → error', async () => {
    const bg = new BackgroundProbe({ label: 'X 控制面', budgetMs: 1000 });
    expect(await bg.run(async () => { throw awsError('ThrottlingException', 400, 'Rate exceeded'); })).toMatchObject({ status: 'degraded', transient: true });
    expect(await bg.run(async () => { throw awsError('AccessDeniedException', 403); })).toMatchObject({ status: 'error' });
    expect(probeResultFromError(Object.assign(new Error('getaddrinfo ENOTFOUND sns.example'), { code: 'ENOTFOUND' }), 'X').transient).toBe(true);
  });

  it('深度与常规探针各有自己的进行中调用与预算', async () => {
    const bg = new BackgroundProbe({ label: 'X', budgetMs: 10, deepBudgetMs: 200 });
    const slowNormal = deferred<ProbeResult>();
    expect((await bg.run(() => slowNormal.p)).transient).toBe(true);
    const deep = await bg.run(async () => {
      await new Promise((r) => setTimeout(r, 30));
      return { status: 'ok', detail: 'deep' };
    }, { deep: true });
    expect(deep.detail).toBe('deep');
    slowNormal.resolve({ status: 'ok', detail: 'normal' });
  });
});
