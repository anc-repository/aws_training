// AWS 适配器测试的公共辅助：用内存 env 解析出 AppConfig，组装 AdapterDeps（假凭证 + 懒加载客户端 + 假 SecretsPort）。
// 所有 AWS 调用都由 aws-sdk-client-mock 拦截，不发出任何网络请求。
import { mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { lazyAwsClients } from '../../../src/adapters/aws/clients.js';
import type { AdapterDeps } from '../../../src/adapters/types.js';
import { parseConfig, type AppConfig } from '../../../src/config/schema.js';
import type { Logger } from '../../../src/ports/logger.js';
import type { SecretName, SecretsPort } from '../../../src/ports/secrets.js';

export const fakeCredentials = async () => ({ accessKeyId: 'ASIAEXAMPLEEXAMPLE', secretAccessKey: 'secret', sessionToken: 'token', expiration: new Date(Date.now() + 3600_000) });

export function testConfig(env: Record<string, string>): { cfg: AppConfig; effective: Record<string, string>; dataDir: string } {
  const dataDir = mkdtempSync(path.join(os.tmpdir(), 'cloudalbum-aws-'));
  const parsed = parseConfig({
    CLOUDALBUM_ROLE: 'api', NODE_ENV: 'test', CLOUDALBUM_DATA_DIR: dataDir, CLOUDALBUM_ENV_DIR: path.join(dataDir, 'etc'),
    ...env,
  }, { checkImplemented: false });
  if (!parsed.config) throw new Error(`测试配置无效：${JSON.stringify(parsed.errors)}`);
  return { cfg: parsed.config, effective: parsed.effective, dataDir };
}

export function fakeSecrets(values: Partial<Record<SecretName, string>>): SecretsPort {
  return {
    meta: { module: 'secrets', driver: 'env', awsService: null, authoritative: true },
    async probe() {
      return { status: 'ok', detail: 'fake' };
    },
    async get(name) {
      const v = values[name];
      if (v === undefined) throw new Error(`secret ${name} 未配置`);
      return v;
    },
    async describe() {
      return { source: 'env', origin: 'instance' };
    },
    onRotate() {
      return () => undefined;
    },
  };
}

export const silentLogger: Logger = {
  log() {}, debug() {}, info() {}, warn() {}, error() {},
  child() {
    return silentLogger;
  },
};

export interface DepsOptions {
  credentials?: boolean;
  secrets?: Partial<Record<SecretName, string>>;
  extra?: Partial<AdapterDeps>;
}

export function makeDeps(env: Record<string, string>, opts: DepsOptions = {}): AdapterDeps & { dataDir: string } {
  const { cfg, effective, dataDir } = testConfig(env);
  return {
    cfg,
    env: effective,
    aws: lazyAwsClients({ region: cfg.core.AWS_REGION, credentials: opts.credentials === false ? null : fakeCredentials }),
    role: 'api',
    logger: silentLogger,
    ...(opts.secrets ? { secrets: fakeSecrets(opts.secrets) } : {}),
    ...(opts.extra ?? {}),
    dataDir,
  };
}

/** 模拟 AWS SDK v3 的服务端错误（name + $metadata.httpStatusCode） */
export function awsError(name: string, status: number, message = name): Error {
  return Object.assign(new Error(message), { name, $metadata: { httpStatusCode: status }, $fault: status >= 500 ? 'server' : 'client' });
}

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** 等待条件成立（轮询，默认 3 秒超时） */
export async function waitFor(cond: () => boolean | Promise<boolean>, timeoutMs = 3000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!(await cond())) {
    if (Date.now() > deadline) throw new Error('waitFor: 超时');
    await sleep(5);
  }
}
