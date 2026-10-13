// backend/src/adapters/types.ts —— 适配器构造参数（container 的工厂表统一传入）
//
// 每个驱动文件 `adapters/<module>/<driver>.ts` 导出一个类，构造函数签名为 `new X(deps: AdapterDeps)`
// （storage/local 另有第二个参数 LocalStorageOptions，供 shared-fs 的 efs 复用）。构造函数不得做 I/O，
// 建连与预热放在 init()；init 失败记为探针 error，不中断启动。
import type { Knex } from 'knex';
import type { AppConfig } from '../config/schema.js';
import type { LabMetricsStore, ProcessRole } from '../observability/lab-metrics.js';
import type { CachePort } from '../ports/cache.js';
import type { ConfigPort } from '../ports/config.js';
import type { CryptoPort } from '../ports/crypto.js';
import type { EmailPort } from '../ports/email.js';
import type { ImageProcessorPort } from '../ports/image-processor.js';
import type { LockPort } from '../ports/lock.js';
import type { Logger } from '../ports/logger.js';
import type { MetricsPort } from '../ports/metrics.js';
import type { NotifierPort } from '../ports/notifier.js';
import type { QueuePort } from '../ports/queue.js';
import type { SecretsPort } from '../ports/secrets.js';
import type { StoragePort } from '../ports/storage.js';
import type { TaggerPort } from '../ports/tagger.js';
import type { AwsClients } from './aws/clients.js';

export interface AdapterDeps {
  cfg: AppConfig;
  /** 分层加载的合并结果（含 secrets.env；不是 process.env） */
  env: Readonly<Record<string, string>>;
  /** SDK 客户端懒加载工厂；L0 下调用会被拒绝 */
  aws: AwsClients;
  role: ProcessRole;
  secrets?: SecretsPort;
  logger?: Logger;
  db?: Knex;
  dbRead?: Knex;
  lock?: LockPort;
  cache?: CachePort;
  queue?: QueuePort;
  storage?: StoragePort;
  images?: ImageProcessorPort;
  tagger?: TaggerPort;
  notifier?: NotifierPort;
  email?: EmailPort;
  crypto?: CryptoPort;
  metrics?: MetricsPort;
  runtime?: ConfigPort;
  labMetrics?: LabMetricsStore;
}

/** 断言某个构造期依赖已由 container 注入（缺失是装配顺序错误，属于编程错误） */
export function need<K extends keyof AdapterDeps>(deps: AdapterDeps, key: K, who: string): NonNullable<AdapterDeps[K]> {
  const v = deps[key];
  if (v === undefined || v === null) throw new Error(`${who}: 缺少依赖 ${String(key)}（container 装配顺序错误）`);
  return v as NonNullable<AdapterDeps[K]>;
}
