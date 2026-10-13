// backend/src/ports/lock.ts   （内部端口，无开关；总纲 §4.2，照录）
export interface Lease { readonly name: string; release(): Promise<void> }
export interface LockPort {
  readonly driver: 'file' | 'pg' | 'redis';
  readonly scope: 'host' | 'cluster';   // file(flock，目录 LOCK_FILE_DIR，默认 /run/cloudalbum) = host；pg advisory lock / redis SET NX PX = cluster
  tryAcquire(name: string, ttlSec: number): Promise<Lease | null>;
}
// container 按 “postgres > redis > 文件锁” 自动选择（adapters/lock/index.ts 的 pickLock），并把 scope 交给规则引擎检查（ASG-006）。
