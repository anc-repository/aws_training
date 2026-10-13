// SecretsPort · env 驱动：契约 + 本驱动特有行为（*_FILE、缺失时的探针分级、分层 env 而不是 process.env）
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { EnvSecrets, SecretNotFoundError } from '../../src/adapters/secrets/env.js';
import { describeSecretsContract } from './secrets.contract.js';
import { makeLocalDeps, type LocalDeps } from './_local-deps.js';
import { l0Secrets } from '../helpers/identity-harness.js';

describeSecretsContract('env', async () => {
  const secrets = l0Secrets();
  const l = await makeLocalDeps({ secrets });
  const pem = readFileSync(path.join(l.envDir, 'keys', 'jwt-es256.pem'), 'utf8');
  return {
    port: new EnvSecrets(l.deps),
    present: { 'local-master-key': secrets.LOCAL_MASTER_KEY!, 'upload-hmac-key': secrets.UPLOAD_HMAC_KEY!, 'jwt-signing-key': pem },
    missing: 'redis-auth-token',
    cleanup: () => l.close(),
  };
});

describe('EnvSecrets（本地实现特有）', () => {
  let l: LocalDeps | undefined;
  afterEach(async () => {
    await l?.close();
    l = undefined;
  });

  it('从分层 env 读取，而不是 process.env', async () => {
    l = await makeLocalDeps();
    process.env.REDIS_AUTH_TOKEN = 'from-process-env';
    try {
      await expect(new EnvSecrets(l.deps).get('redis-auth-token')).rejects.toBeInstanceOf(SecretNotFoundError);
    } finally {
      delete process.env.REDIS_AUTH_TOKEN;
    }
  });

  it('全部 L0 机密齐全时探针 ok；缺少非关键机密 degraded；缺少主密钥或签名私钥 error', async () => {
    l = await makeLocalDeps();
    expect((await new EnvSecrets(l.deps).probe()).status).toBe('ok');
    await l.close();

    const partial = l0Secrets();
    delete partial.COOKIE_SECRET;
    l = await makeLocalDeps({ secrets: partial });
    const p1 = await new EnvSecrets(l.deps).probe();
    expect(p1.status).toBe('degraded');
    expect(p1.detail).toContain('COOKIE_SECRET');
    await l.close();

    l = await makeLocalDeps({ withKey: false });
    const p2 = await new EnvSecrets(l.deps).probe();
    expect(p2.status).toBe('error');
    expect(p2.detail).toContain('JWT_SIGNING_KEY_FILE');
  });

  it('describe() 报告 SECRETS_ORIGIN 与 PEM 文件的修改时间', async () => {
    l = await makeLocalDeps();
    const s = new EnvSecrets(l.deps);
    expect(await s.describe('local-master-key')).toEqual({ source: 'env', origin: 'instance' });
    expect((await s.describe('jwt-signing-key')).lastRotatedAt).toMatch(/^\d{4}-/);
  });
});
