// modules/capabilities.ts：状态机（总纲 6.3）、规则对状态的约束、视图与 readiness
import { describe, expect, it } from 'vitest';
import type { CapabilityTransitionEvent } from '@cloudalbum/contracts';
import { CapabilityRegistry } from '../../src/modules/capabilities.js';
import type { ProbeResult } from '../../src/ports/common.js';
import { ENABLE, evaluate, type Env } from '../helpers/config.js';

function registryFor(env: Env) {
  const { parsed, verdict } = evaluate(env);
  if (!parsed.config || !verdict) throw new Error(JSON.stringify(parsed.errors));
  return new CapabilityRegistry({ cfg: parsed.config, env: parsed.effective, verdict, role: 'api', version: 'test' });
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
