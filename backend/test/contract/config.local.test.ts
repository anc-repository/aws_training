// ConfigPort · file 驱动：契约 + 目录监听热加载、非法值拒绝、未知键忽略（CFG-009）
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { FileConfig, parseRuntimeConfig } from '../../src/adapters/config/file.js';
import { DEFAULT_RUNTIME_CONFIG } from '../../src/ports/config.js';
import { writeRuntime } from '../helpers/identity-harness.js';
import { describeConfigContract } from './config.contract.js';
import { makeLocalDeps, type LocalDeps } from './_local-deps.js';

describeConfigContract('file', async () => {
  const l = await makeLocalDeps();
  return {
    port: new FileConfig(l.deps),
    setMaxUploadMb: async (mb) => writeRuntime(l.envDir, { maxUploadMb: mb }),
    cleanup: () => l.close(),
  };
});

describe('FileConfig（本地实现特有）', () => {
  let l: LocalDeps | undefined;
  let port: FileConfig | undefined;
  afterEach(async () => {
    await port?.close();
    await l?.close();
    port = undefined;
    l = undefined;
  });

  it('runtime.json 不存在时使用默认值，探针 ok', async () => {
    l = await makeLocalDeps();
    port = new FileConfig(l.deps);
    await port.init();
    expect(port.current()).toEqual(DEFAULT_RUNTIME_CONFIG);
    const p = await port.probe();
    expect(p.status).toBe('ok');
    expect(p.detail).toContain('不存在');
    expect(port.describeSource()).toMatchObject({ driver: 'file', location: path.join(l.envDir, 'runtime.json'), version: 'v1' });
  });

  it('“写临时文件再改名”也能被目录监听捕获并热加载', async () => {
    l = await makeLocalDeps({ runtime: { maxUploadMb: 10 } });
    port = new FileConfig(l.deps);
    await port.init();
    expect(port.current().maxUploadMb).toBe(10);
    const changed = new Promise<string[]>((resolve) => port!.onChange((_n, keys) => resolve(keys)));
    const { renameSync, writeFileSync } = await import('node:fs');
    const tmp = path.join(l.envDir, 'runtime.json.tmp');
    writeFileSync(tmp, JSON.stringify({ maxUploadMb: 11, banner: '维护预告' }));
    renameSync(tmp, path.join(l.envDir, 'runtime.json'));
    const keys = await Promise.race([changed, new Promise<string[]>((_r, rej) => setTimeout(() => rej(new Error('watch timeout')), 4000))]);
    expect(keys.sort()).toEqual(['banner', 'maxUploadMb']);
    expect(port.current()).toMatchObject({ maxUploadMb: 11, banner: '维护预告' });
    expect(port.describeSource().version).toBe('v2');
  });

  it('非法值：拒绝这次变更、沿用上一份快照，探针 degraded', async () => {
    l = await makeLocalDeps({ runtime: { maxUploadMb: 10 } });
    port = new FileConfig(l.deps);
    await port.init();
    writeRuntime(l.envDir, { maxUploadMb: -1 });
    expect((await port.refresh()).changedKeys).toEqual([]);
    expect(port.current().maxUploadMb).toBe(10);
    const p = await port.probe();
    expect(p.status).toBe('degraded');
    expect(p.detail).toContain('maxUploadMb');
  });

  it('未知键（例如有人写了 CACHE_DRIVER）被忽略并告警，其余合法键照常生效', async () => {
    l = await makeLocalDeps();
    port = new FileConfig(l.deps);
    await port.init();
    writeRuntime(l.envDir, { CACHE_DRIVER: 'redis', readOnly: true });
    await port.refresh();
    expect(port.current().readOnly).toBe(true);
    expect((port.current() as unknown as Record<string, unknown>).CACHE_DRIVER).toBeUndefined();
    const p = await port.probe();
    expect(p.status).toBe('degraded');
    expect(p.detail).toContain('CACHE_DRIVER');
  });

  it('parseRuntimeConfig：损坏的 JSON、非对象', () => {
    expect(parseRuntimeConfig('{').error).toMatch(/JSON/);
    expect(parseRuntimeConfig('[1]').error).toMatch(/对象/);
    expect(parseRuntimeConfig('{"allowedEmailDomains":["Example.COM"]}').config?.allowedEmailDomains).toEqual(['example.com']);
  });
});
