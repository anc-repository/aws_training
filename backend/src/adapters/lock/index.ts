// backend/src/adapters/lock/index.ts —— 内部 LockPort 的选择（总纲 §4.1：没有开关，按 “postgres > redis > 文件锁” 自动选择）
//
// scope 交给规则引擎检查（ASG-006：DEPLOY_MODE=asg、SCHEDULER_DRIVER=cron 且 scope=host 时拒绝启动）。
import type { LockPort } from '../../ports/lock.js';
import type { AdapterDeps } from '../types.js';
import { FileLock } from './file.js';
import { PgLock } from './pg.js';
import { RedisLock } from './redis.js';

export function pickLock(deps: AdapterDeps): LockPort {
  if (deps.cfg.db.DB_DRIVER === 'postgres') return new PgLock(deps);
  if (deps.cfg.cache.CACHE_DRIVER === 'redis') return new RedisLock(deps);
  return new FileLock(deps);
}
