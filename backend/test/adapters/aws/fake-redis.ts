// 内存版 Redis 客户端（只实现 RedisCache 用到的命令）；broken=true 时所有命令立即失败（模拟断线 / 超时）。
import { EventEmitter } from 'node:events';
import type { RedisLike } from '../../../src/adapters/cache/redis.js';

export class FakeRedis extends EventEmitter {
  readonly store = new Map<string, { value: string; expiresAt?: number }>();
  broken = false;
  latencyMs = 0;
  infoText: Record<string, string> = {
    replication: '# Replication\r\nrole:master\r\nconnected_slaves:1\r\n',
    memory: '# Memory\r\nused_memory:1048576\r\nused_memory_human:1.00M\r\nmaxmemory:0\r\n',
    stats: '# Stats\r\nevicted_keys:0\r\n',
  };
  commands: string[] = [];

  private async op<T>(name: string, fn: () => T): Promise<T> {
    this.commands.push(name);
    if (this.latencyMs) await new Promise((r) => setTimeout(r, this.latencyMs));
    if (this.broken) throw new Error("Stream isn't writeable and enableOfflineQueue options is false");
    return fn();
  }

  private live(key: string): { value: string } | undefined {
    const e = this.store.get(key);
    if (!e) return undefined;
    if (e.expiresAt !== undefined && e.expiresAt <= Date.now()) {
      this.store.delete(key);
      return undefined;
    }
    return e;
  }

  get(key: string): Promise<string | null> {
    return this.op('get', () => this.live(key)?.value ?? null);
  }

  set(key: string, value: string, mode?: string, ttl?: number): Promise<'OK'> {
    return this.op('set', () => {
      this.store.set(key, { value, ...(mode === 'EX' && ttl ? { expiresAt: Date.now() + ttl * 1000 } : {}) });
      return 'OK' as const;
    });
  }

  del(...keys: string[]): Promise<number> {
    return this.op('del', () => keys.reduce((n, k) => n + (this.store.delete(k) ? 1 : 0), 0));
  }

  eval(_script: string, _numKeys: number, key: string, ttl: number): Promise<number> {
    return this.op('eval', () => {
      const cur = Number(this.live(key)?.value ?? 0) + 1;
      const prev = this.store.get(key);
      this.store.set(key, { value: String(cur), ...(cur === 1 ? { expiresAt: Date.now() + ttl * 1000 } : prev?.expiresAt ? { expiresAt: prev.expiresAt } : {}) });
      return cur;
    });
  }

  ping(): Promise<string> {
    return this.op('ping', () => 'PONG');
  }

  info(section: string): Promise<string> {
    return this.op('info', () => this.infoText[section] ?? '');
  }

  async quit(): Promise<'OK'> {
    return 'OK';
  }

  disconnect(): void {}

  async connect(): Promise<void> {}

  asClient(): RedisLike {
    return this as unknown as RedisLike;
  }
}
