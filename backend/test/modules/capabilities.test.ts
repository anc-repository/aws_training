// modules/capabilities.ts：状态机（总纲 6.3）、规则对状态的约束、视图与 readiness
import { describe, expect, it } from 'vitest';
import type { CapabilityTransitionEvent } from '@cloudalbum/contracts';
import { CapabilityRegistry, STARTUP_GRACE_MS } from '../../src/modules/capabilities.js';
import type { ProbeResult } from '../../src/ports/common.js';
import { ENABLE, evaluate, type Env } from '../helpers/config.js';

function registryFor(env: Env, now?: () => Date) {
  const { parsed, verdict } = evaluate(env);
  if (!parsed.config || !verdict) throw new Error(JSON.stringify(parsed.errors));
  return new CapabilityRegistry({ cfg: parsed.config, env: parsed.effective, verdict, role: 'api', version: 'test', ...(now ? { now } : {}) });
}

/** 可推进的时钟：registry 创建后推进到启动宽限期之外 */
function clock(start = Date.parse('2026-10-14T00:00:00Z')) {
  let t = start;
  return { now: () => new Date(t), advance: (ms: number) => { t += ms; } };
}

describe('CapabilityRegistry 状态机', () => {
  it('启用的模块：连续 3 次失败才进入 error；1 次成功回到 degraded；连续 2 次健康回到 ok', async () => {
    const caps = registryFor({ ...ENABLE.iamRole, ...ENABLE.s3 });
    const events: CapabilityTransitionEvent[] = [];
    caps.onTransition((e) => events.push(e));
    let next: ProbeResult = { status: 'ok', detail: 'HeadBucket 200' };
    caps.registerProbe('storage', async () => next);

    await caps.probeModule('storage');
    expect(caps.status('storage').status).toBe('ok');

    next = { status: 'error', detail: 'AccessDenied' };
    await caps.probeModule('storage');
    await caps.probeModule('storage');
    expect(caps.status('storage').status).toBe('ok');
    await caps.probeModule('storage');
    expect(caps.status('storage').status).toBe('error');

    next = { status: 'ok', detail: 'HeadBucket 200' };
    await caps.probeModule('storage');
    expect(caps.status('storage').status).toBe('degraded');
    await caps.probeModule('storage');
    expect(caps.status('storage').status).toBe('degraded');
    await caps.probeModule('storage');
    expect(caps.status('storage').status).toBe('ok');

    expect(events.map((e) => `${e.from}->${e.to}`)).toEqual(['ok->error', 'error->degraded', 'degraded->ok']);
  });

  it('启动宽限（wave1-prep）：首次探针超时或瞬时失败记为 degraded，连续 3 次才 error；确定性失败仍直接 error', async () => {
    const c = clock();
    const caps = registryFor({ ...ENABLE.iamRole, ...ENABLE.notification }, c.now);
    c.advance(STARTUP_GRACE_MS + 1);
    let next: () => Promise<ProbeResult> = () => new Promise<ProbeResult>(() => undefined);   // 永不返回 → 探针超时
    caps.registerProbe('notification', () => next());
    await caps.probeModule('notification', { timeoutMs: 5 });
    expect(caps.status('notification').status).toBe('degraded');
    next = async () => ({ status: 'error', detail: 'ThrottlingException', transient: true });
    await caps.probeModule('notification');
    expect(caps.status('notification').status).toBe('degraded');
    await caps.probeModule('notification');
    expect(caps.status('notification').status).toBe('error');
    next = async () => ({ status: 'ok', detail: 'GetTopicAttributes 200' });
    await caps.probeModule('notification');
    expect(caps.status('notification').status).toBe('degraded');

    const other = registryFor({ ...ENABLE.iamRole, ...ENABLE.email });
    other.registerProbe('email', async () => ({ status: 'error', detail: 'AccessDenied' }));
    await other.probeModule('email');
    expect(other.status('email').status).toBe('error');
  });

  it('连续 3 次 degraded + transient → error（wave1-fix：适配器把连不上 AWS 报成降级时也会升级）；管理员视图带 data.transient', async () => {
    const c = clock();
    const caps = registryFor({ ...ENABLE.iamRole, ...ENABLE.email }, c.now);
    c.advance(STARTUP_GRACE_MS + 1);
    const events: CapabilityTransitionEvent[] = [];
    caps.onTransition((e) => events.push(e));
    let next: ProbeResult = { status: 'degraded', transient: true, detail: 'SES 控制面暂时不可达：ENOTFOUND email.ap-northeast-1.amazonaws.com', data: { identity: 'a@example.com' } };
    caps.registerProbe('email', async () => next);
    await caps.probeModule('email');
    expect(caps.status('email').status).toBe('degraded');
    expect(caps.snapshot('admin').modules.email.data).toMatchObject({ identity: 'a@example.com', transient: true });
    await caps.probeModule('email');
    expect(caps.status('email').status).toBe('degraded');
    await caps.probeModule('email');
    expect(caps.status('email').status).toBe('error');
    // 非瞬时的 degraded（例如沙盒）不累计：恢复后先回到 degraded，data.transient 被清除
    next = { status: 'degraded', detail: '沙盒：只能发给已验证地址', data: { identity: 'a@example.com' } };
    await caps.probeModule('email');
    expect(caps.status('email').status).toBe('degraded');
    expect(caps.snapshot('admin').modules.email.data).not.toHaveProperty('transient');
    for (let i = 0; i < 5; i += 1) await caps.probeModule('email');
    expect(caps.status('email').status).toBe('degraded');
    expect(events.map((e) => `${e.from}->${e.to}`)).toEqual(['ok->degraded', 'degraded->error', 'error->degraded']);
  });

  it(`启动后的前 ${STARTUP_GRACE_MS / 1000} 秒：瞬时失败不累计（重启后 IMDS / SDK 首个请求慢不会把模块判为 error）；宽限期过后照常累计`, async () => {
    const c = clock();
    const caps = registryFor({ ...ENABLE.iamRole, ...ENABLE.notification }, c.now);
    caps.registerProbe('notification', async () => ({ status: 'error', transient: true, detail: 'AWS 调用超时（3000 ms）' }));
    for (let i = 0; i < 5; i += 1) {
      await caps.probeModule('notification');
      c.advance(20_000);
    }
    expect(caps.status('notification').status).toBe('degraded');
    expect(caps.snapshot('admin').modules.notification.data).toMatchObject({ transient: true });
    c.advance(STARTUP_GRACE_MS);
    await caps.probeModule('notification');
    await caps.probeModule('notification');
    expect(caps.status('notification').status).toBe('degraded');
    await caps.probeModule('notification');
    expect(caps.status('notification').status).toBe('error');
  });

  it('权威端口 30 秒内连续 5 次真实调用失败 → error（被动信号）', () => {
    const caps = registryFor({ ...ENABLE.iamRole, ...ENABLE.s3 });
    for (let i = 0; i < 5; i += 1) {
      caps.onCall({ module: 'storage', driver: 's3', method: 'putObject', ms: 1, ok: false, error: new Error('timeout'), inRequest: true });
    }
    expect(caps.status('storage').status).toBe('error');
  });

  it('未启用的模块：status 固定为 off，探针结果写入 localHealth；探针抛错（含未实现）记为 error', async () => {
    const caps = registryFor({});
    caps.registerProbe('database', async () => ({ status: 'ok', detail: 'select 1' }));
    caps.registerProbe('cache', async () => { throw new Error('boom'); });
    await caps.probeModule('database');
    await caps.probeModule('cache');
    expect(caps.status('database')).toMatchObject({ status: 'off', localHealth: 'ok' });
    expect(caps.status('cache')).toMatchObject({ status: 'off', localHealth: 'error' });
    expect(caps.readiness().ok).toBe(true);           // cache 非权威
    caps.registerProbe('storage', async () => ({ status: 'error', detail: 'not writable' }));
    await caps.probeModule('storage');
    expect(caps.readiness().failing.map((f) => f.module)).toContain('storage');
    expect(caps.readiness('instance').ok).toBe(true);
  });

  it('warn 规则使相关模块至少 degraded；被 CLOUDALBUM_ALLOW_UNSAFE 覆盖的规则使其最好也只是 degraded', async () => {
    const warnCaps = registryFor({ ...ENABLE.cdn });          // CRED-004：cdn（optional）无凭证
    warnCaps.registerProbe('cdn', async () => ({ status: 'ok', detail: 'GET /api/health/live 200' }));
    await warnCaps.probeModule('cdn');
    expect(warnCaps.status('cdn').status).toBe('degraded');
    expect(warnCaps.status('cdn').detail).toContain('CRED-004');

    const unsafe = registryFor({ ...ENABLE.asg, ...ENABLE.iamRole, ...ENABLE.s3, ...ENABLE.rds, SECRETS_ORIGIN: 'bundle',
      CACHE_DRIVER: 'memory', CLOUDALBUM_ALLOW_UNSAFE: 'ASG-004' });
    unsafe.registerProbe('cache', async () => ({ status: 'ok', detail: 'memory' }));
    await unsafe.probeModule('cache');
    expect(unsafe.status('cache')).toMatchObject({ status: 'off', localHealth: 'degraded' });
    expect(unsafe.snapshot().validation.overridden.map((f) => f.rule)).toEqual(['ASG-004']);
  });

  it('精简视图不含 data / probeHistory / 修复命令；管理员视图包含', async () => {
    const caps = registryFor({ ...ENABLE.iamRole, ...ENABLE.s3, MODULE_STORAGE_VERSION: '9' });
    caps.registerProbe('storage', async () => ({ status: 'ok', detail: 'ok', data: { bucket: 'raw' } }));
    await caps.probeModule('storage');
    const pub = caps.snapshot('public');
    const admin = caps.snapshot('admin');
    expect(pub.modules.storage.data).toBeUndefined();
    expect(pub.modules.storage.probeHistory).toBeUndefined();
    expect(pub.validation.warnings[0]?.fix).toBeUndefined();
    expect(admin.modules.storage.data).toEqual({ bucket: 'raw' });
    expect(admin.modules.storage.probeHistory).toHaveLength(1);
    expect(admin.validation.warnings[0]?.fix).toBeTruthy();
    expect(admin.modules.storage.switch).toEqual({ var: 'STORAGE_DRIVER', value: 's3', localValue: 'local' });
    expect(admin.modules.storage.deps).toEqual({ requires: [], credentials: 'required', satisfied: true });
  });
});
