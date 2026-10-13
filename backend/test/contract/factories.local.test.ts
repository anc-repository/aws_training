// container 的工厂表能装配出 local-identity 负责的本地驱动（类名、构造参数、driver = 开关取值），且不加载 AWS SDK
import { describe, expect, it } from 'vitest';
import { awsSdkLoadReport } from '../../src/adapters/aws/clients.js';
import { FACTORIES } from '../../src/container.js';
import { makeLocalDeps } from './_local-deps.js';

const MINE = [
  ['auth:local', 'auth', 'local'], ['secrets:env', 'secrets', 'env'], ['config:file', 'config', 'file'], ['kms:local', 'kms', 'local'],
  ['email:outbox', 'email', 'outbox'], ['notification:db', 'notification', 'db'], ['logging:file', 'logging', 'file'],
  ['monitoring:local', 'monitoring', 'local'], ['tracing:none', 'tracing', 'none'],
] as const;

describe('container 工厂表 · 本地身份 / 运维驱动', () => {
  it.each(MINE)('%s', async (key, module, driver) => {
    const l = await makeLocalDeps();
    const adapter = await FACTORIES[key]!(l.deps);
    expect(adapter.meta).toMatchObject({ module, driver, awsService: null });
    expect(typeof adapter.probe).toBe('function');
    await adapter.close?.();
    await l.close();
  });

  it('装配本地驱动不会加载任何 @aws-sdk 模块', () => {
    expect(awsSdkLoadReport().viaFactory).toEqual([]);
  });
});
