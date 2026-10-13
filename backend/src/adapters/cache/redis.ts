// backend/src/adapters/cache/redis.ts —— CachePort 的 `redis` 驱动（Amazon ElastiCache；03#cache 第 2 节）
//
// - ElastiCache（Valkey / Redis OSS）与 EC2 自建 Valkey（REDIS_URL 为回环地址 = 本地档）共用本驱动；
//   路径头的主机类别：回环 → redis@local，*.cache.amazonaws.com → redis@elasticache，其他 → redis@remote。
// - REDIS_CLIENT_MODE=single：new Redis(…)；cluster（Serverless 走集群协议）：new Redis.Cluster(…, { dnsLookup: 原样返回 })。
// - 每条命令 REDIS_TIMEOUT_MS 超时；断线时不排队（enableOfflineQueue: false），立即失败。
// - fail-open：任何错误都按未命中处理（outcome = error-bypass），直接调用 loader；cache 是非权威端口，绝不让请求失败。
// - 所有键加前缀 REDIS_KEY_PREFIX，值为 JSON；wrap() 内置进程内 single-flight，并处理 X-Compare-Bypass: cache。
// - wrap 不经 instrument 计时（UNTIMED_METHODS），这里用 addTiming('cache', …) 记录内部的 get / set。
import { performance } from 'node:perf_hooks';
import type { Cluster, Redis, RedisOptions } from 'ioredis';
import { isLoopback, hostOf } from '../../config/net.js';
import { addTiming, isBypassed, markPath } from '../../observability/request-context.js';
import type { AdapterMeta, ProbeResult } from '../../ports/common.js';
import type { CacheOutcome, CachePort } from '../../ports/cache.js';
import { describeAwsError, isAwsNotFound, loadAwsPackage } from '../aws/clients.js';
import type { AdapterDeps } from '../types.js';

type RedisConfig = Extract<AdapterDeps['cfg']['cache'], { CACHE_DRIVER: 'redis' }>;
export type RedisLike = Redis | Cluster;
export type RedisHostClass = 'local' | 'elasticache' | 'remote';

export function redisHostClass(url: string): RedisHostClass {
  if (isLoopback(url)) return 'local';
  return /\.cache\.amazonaws\.com(\.cn)?$/i.test(hostOf(url)) ? 'elasticache' : 'remote';
}

/** 从 ElastiCache 端点推断资源：复制组 ID 或 Serverless 缓存名（推断不到返回 null） */
export function elasticacheResourceOf(url: string): { kind: 'replication-group' | 'serverless'; id: string } | null {
  const host = hostOf(url);
  if (!/\.cache\.amazonaws\.com(\.cn)?$/i.test(host)) return null;
  const labels = host.split('.');
  if (labels.includes('serverless')) {
    const first = labels[0] ?? '';
    const m = /^(.*)-[a-z0-9]{6}$/.exec(first);
    return { kind: 'serverless', id: m ? m[1]! : first };
  }
  if (['master', 'replica', 'clustercfg'].includes(labels[0] ?? '') && labels[1]) return { kind: 'replication-group', id: labels[1] };
  return labels[0] ? { kind: 'replication-group', id: labels[0] } : null;
}

/** 最近 1 分钟的滚动计数（6 个 10 秒桶） */
class RollingCounter {
  private readonly buckets = Array.from({ length: 6 }, () => ({ slot: -1, hit: 0, miss: 0, error: 0, bypass: 0 }));
  add(kind: 'hit' | 'miss' | 'error' | 'bypass', now = Date.now()): void {
    const slot = Math.floor(now / 10_000);
    const b = this.buckets[slot % 6]!;
    if (b.slot !== slot) Object.assign(b, { slot, hit: 0, miss: 0, error: 0, bypass: 0 });
    b[kind] += 1;
  }
  totals(now = Date.now()): { hit: number; miss: number; error: number; bypass: number } {
    const minSlot = Math.floor(now / 10_000) - 5;
    const t = { hit: 0, miss: 0, error: 0, bypass: 0 };
    for (const b of this.buckets) {
      if (b.slot < minSlot) continue;
      t.hit += b.hit;
      t.miss += b.miss;
      t.error += b.error;
      t.bypass += b.bypass;
    }
    return t;
  }
}

/** INCR 并在首次创建时设置 TTL（原子；兼容不支持 EXPIRE NX 的旧版本） */
const INCR_WITH_TTL = "local v = redis.call('INCR', KEYS[1]) if v == 1 then redis.call('EXPIRE', KEYS[1], ARGV[1]) end return v";

export interface RedisCacheOptions {
  /** 测试注入：现成的客户端（不再自行连接） */
  client?: RedisLike;
}

export class RedisCache implements CachePort {
  readonly meta: AdapterMeta = { module: 'cache', driver: 'redis', awsService: 'Amazon ElastiCache', authoritative: false };
  readonly hostClass: RedisHostClass;

  private readonly rc: RedisConfig;
  private client?: RedisLike;
  private connecting?: Promise<RedisLike>;
  private readonly inflight = new Map<string, Promise<unknown>>();
  private readonly window = new RollingCounter();
  private lastError?: { at: string; message: string };
  private readonly localCounters = new Map<string, { value: number; expiresAt: number }>();

  constructor(protected readonly deps: AdapterDeps, opts: RedisCacheOptions = {}) {
    const c = deps.cfg.cache;
    if (c.CACHE_DRIVER !== 'redis') throw new Error(`RedisCache 需要 CACHE_DRIVER=redis（当前 ${c.CACHE_DRIVER}）`);
    this.rc = c;
    this.hostClass = redisHostClass(c.REDIS_URL);
    if (opts.client) this.attach(opts.client);
  }

  get keyPrefix(): string {
    return this.rc.REDIS_KEY_PREFIX;
  }

  private pathValue(outcome: CacheOutcome | 'error-bypass'): string {
    return `redis@${this.hostClass}:${outcome}`;
  }

  private recordError(e: unknown): void {
    this.lastError = { at: new Date().toISOString(), message: (e as Error)?.message ?? String(e) };
  }

  private attach(client: RedisLike): void {
    this.client = client;
    // 没有 'error' 监听器时 ioredis 会把连接错误当作未处理事件打印；这里只记录最近一次错误
    client.on('error', (e: unknown) => this.recordError(e));
  }

  // ------------------------------------------------------------------------------------------
  // 连接
  // ------------------------------------------------------------------------------------------
  async init(): Promise<void> {
    await this.connect();
  }

  private async authToken(): Promise<string | undefined> {
    try {
      const v = await this.deps.secrets?.get('redis-auth-token');
      return v || undefined;
    } catch {
      return undefined;                                  // 未配置令牌（ElastiCache 未开 AuthToken、本机 Valkey）
    }
  }

  /** 建立连接（只在 init 与首次使用时调用）；连接失败也保留客户端对象，由 ioredis 按 retryStrategy 重连 */
  private connect(): Promise<RedisLike> {
    if (this.client) return Promise.resolve(this.client);
    this.connecting ??= (async () => {
      const mod = await import('ioredis');
      const RedisCtor = mod.Redis;
      const ClusterCtor = mod.Cluster;
      const url = new URL(this.rc.REDIS_URL);
      const host = url.hostname.replace(/^\[|\]$/g, '');
      const port = Number(url.port || 6379);
      const useTls = this.rc.REDIS_TLS === 'on' || url.protocol === 'rediss:';
      const password = url.password ? decodeURIComponent(url.password) : await this.authToken();
      const username = url.username ? decodeURIComponent(url.username) : undefined;
      const timeout = this.rc.REDIS_TIMEOUT_MS;
      const common: RedisOptions = {
        commandTimeout: timeout,
        connectTimeout: Math.max(1000, timeout * 10),
        maxRetriesPerRequest: 1,
        enableOfflineQueue: false,
        lazyConnect: true,
        retryStrategy: (times: number) => Math.min(times * 200, 5000),
        ...(useTls ? { tls: isLoopback(host) ? { rejectUnauthorized: false } : { servername: host } } : {}),
        ...(password ? { password } : {}),
        ...(username ? { username } : {}),
      };
      const client: RedisLike = this.rc.REDIS_CLIENT_MODE === 'cluster'
        ? new ClusterCtor([{ host, port }], {
          dnsLookup: (address, cb) => cb(null, address),       // ElastiCache 的 TLS 证书按主机名校验，不能先解析成 IP
          redisOptions: common,
          enableOfflineQueue: false,
          lazyConnect: true,
          clusterRetryStrategy: (times: number) => Math.min(times * 200, 5000),
        })
        : new RedisCtor({ host, port, db: Number(url.pathname.replace('/', '') || 0) || 0, ...common });
      this.attach(client);
      try {
        await client.connect();
      } catch (e) {
        this.recordError(e);
        throw new Error(`连接 ${this.hostClass === 'elasticache' ? 'ElastiCache' : 'Redis'} 失败：${(e as Error).message}（按未命中处理，后台重连中）`);
      }
      return client;
    })();
    return this.connecting;
  }

  /** 请求路径上取客户端：已有客户端直接用（断线时命令立即失败 → error-bypass），不在请求里等待建连 */
  private async ready(): Promise<RedisLike> {
    if (this.client) return this.client;
    return this.connect();
  }

  /** LockPort(redis) 等内部组件复用同一条连接（adapters/lock/redis.ts） */
  async redisClient(): Promise<RedisLike> {
    return this.ready();
  }

  // ------------------------------------------------------------------------------------------
  // CachePort
  // ------------------------------------------------------------------------------------------
  private async rawGet<T>(key: string): Promise<{ value?: T; outcome: CacheOutcome }> {
    try {
      const c = await this.ready();
      const s = await c.get(this.keyPrefix + key);
      if (s === null || s === undefined) {
        this.window.add('miss');
        return { outcome: 'miss' };
      }
      this.window.add('hit');
      return { value: JSON.parse(s) as T, outcome: 'hit' };
    } catch (e) {
      this.recordError(e);
      this.window.add('error');
      return { outcome: 'error-bypass' };
    }
  }

  private async rawSet<T>(key: string, value: T, ttlSec: number): Promise<void> {
    if (value === undefined) return;
    try {
      const c = await this.ready();
      const json = JSON.stringify(value);
      if (ttlSec > 0) await c.set(this.keyPrefix + key, json, 'EX', Math.ceil(ttlSec));
      else await c.set(this.keyPrefix + key, json);
    } catch (e) {
      this.recordError(e);
      this.window.add('error');
    }
  }

  async get<T>(key: string): Promise<{ value?: T; outcome: CacheOutcome }> {
    const r = await this.rawGet<T>(key);
    markPath('cache', this.pathValue(r.outcome));
    return r;
  }

  async set<T>(key: string, value: T, ttlSec: number): Promise<void> {
    await this.rawSet(key, value, ttlSec);
  }

  async del(keys: string[]): Promise<void> {
    if (!keys.length) return;
    try {
      const c = await this.ready();
      const full = keys.map((k) => this.keyPrefix + k);
      // 集群模式下多键命令必须落在同一槽位：逐键删除
      if (this.rc.REDIS_CLIENT_MODE === 'cluster') await Promise.all(full.map((k) => c.del(k)));
      else await c.del(...full);
    } catch (e) {
      this.recordError(e);
      this.window.add('error');
    }
  }

  async wrap<T>(key: string, ttlSec: number, loader: () => Promise<T>): Promise<T> {
    if (isBypassed('cache')) {
      this.window.add('bypass');
      markPath('cache', this.pathValue('bypass'));       // 既不读也不回填，不计入命中率
      return loader();
    }
    const t0 = performance.now();
    const r = await this.rawGet<T>(key);
    addTiming('cache', performance.now() - t0);
    markPath('cache', this.pathValue(r.outcome));
    if (r.outcome === 'hit') return r.value as T;

    const existing = this.inflight.get(key);
    if (existing) return existing as Promise<T>;
    const p = (async () => {
      const value = await loader();
      if (r.outcome === 'miss') {
        const t1 = performance.now();
        await this.rawSet(key, value, ttlSec);
        addTiming('cache', performance.now() - t1);
      }
      return value;
    })().finally(() => this.inflight.delete(key));
    this.inflight.set(key, p);
    return p;
  }

  async incr(key: string, ttlSec: number): Promise<number> {
    try {
      const c = await this.ready();
      const v = await c.eval(INCR_WITH_TTL, 1, this.keyPrefix + key, Math.max(1, Math.ceil(ttlSec)));
      return Number(v);
    } catch (e) {
      // fail-open：退回进程内计数（多实例下不准确，与 none / memory 驱动相同，ASG-013）
      this.recordError(e);
      this.window.add('error');
      const now = Date.now();
      const cur = this.localCounters.get(key);
      const next = cur && cur.expiresAt > now ? cur.value + 1 : 1;
      this.localCounters.set(key, { value: next, expiresAt: cur && cur.expiresAt > now ? cur.expiresAt : now + ttlSec * 1000 });
      if (this.localCounters.size > 10_000) {
        for (const [k, v] of this.localCounters) if (v.expiresAt <= now) this.localCounters.delete(k);
      }
      return next;
    }
  }

  // ------------------------------------------------------------------------------------------
  // 探针（03#cache 第 10 节）
  // ------------------------------------------------------------------------------------------
  stats1m(): { hitRatio1m: number | null; errors1m: number; ops1m: number; bypass1m: number } {
    const t = this.window.totals();
    const lookups = t.hit + t.miss;
    return {
      hitRatio1m: lookups ? Math.round((t.hit / lookups) * 1000) / 1000 : null,
      errors1m: t.error,
      ops1m: t.hit + t.miss + t.error,
      bypass1m: t.bypass,
    };
  }

  private label(): string {
    return this.hostClass === 'elasticache' ? 'ElastiCache' : this.hostClass === 'local' ? '自建 Valkey（本机）' : 'Redis';
  }

  async probe(opts: { deep?: boolean } = {}): Promise<ProbeResult> {
    const t0 = performance.now();
    let c: RedisLike;
    try {
      c = await this.ready();
      await c.ping();
    } catch (e) {
      this.recordError(e);
      return {
        status: 'error',
        detail: `PING 失败（${this.label()}）：${(e as Error).message}；请求按未命中处理（fail-open）`,
        confidence: 'confirmed',
        data: { hostClass: this.hostClass, ...this.stats1m(), ...(this.lastError ? { lastError: this.lastError } : {}) },
      };
    }
    const latencyMs = Math.round((performance.now() - t0) * 10) / 10;
    const s = this.stats1m();
    const errorRatio = s.ops1m ? s.errors1m / s.ops1m : 0;
    const problems: string[] = [];
    if (latencyMs > 50) problems.push(`PING ${latencyMs}ms > 50ms`);
    if (errorRatio > 0.01) problems.push(`最近 1 分钟 ${Math.round(errorRatio * 1000) / 10}% 的命令失败，已按未命中处理（最近一次：${this.lastError?.message ?? '?'}）`);
    const data: Record<string, unknown> = {
      hostClass: this.hostClass, endpoint: hostOf(this.rc.REDIS_URL), mode: this.rc.REDIS_CLIENT_MODE, tls: this.rc.REDIS_TLS, ...s,
      ...(this.lastError ? { lastError: this.lastError } : {}),
    };
    let status: ProbeResult['status'] = problems.length ? 'degraded' : 'ok';
    let detail = `PING ${latencyMs}ms · ${this.label()}${s.hitRatio1m !== null ? ` · 命中率 1m ${Math.round(s.hitRatio1m * 100)}%` : ''}`;
    if (opts.deep) {
      const deep = await this.deepProbe(c);
      Object.assign(data, deep.data);
      if (deep.detail) detail += ` · ${deep.detail}`;
      if (deep.status === 'error') status = 'error';
      else if (deep.status === 'degraded' && status === 'ok') status = 'degraded';
    }
    if (problems.length) detail += ` · ${problems.join('；')}`;
    return { status, detail, latencyMs, confidence: 'confirmed', data };
  }

  private async infoOf(c: RedisLike, section: string): Promise<Record<string, string>> {
    const node: Redis = 'nodes' in c && typeof c.nodes === 'function' ? (c as Cluster).nodes('master')[0]! : (c as Redis);
    const text = await node.info(section);
    const out: Record<string, string> = {};
    for (const line of String(text).split(/\r?\n/)) {
      const i = line.indexOf(':');
      if (i > 0 && !line.startsWith('#')) out[line.slice(0, i)] = line.slice(i + 1).trim();
    }
    return out;
  }

  private async deepProbe(c: RedisLike): Promise<{ status: ProbeResult['status']; detail: string; data: Record<string, unknown> }> {
    const data: Record<string, unknown> = {};
    const notes: string[] = [];
    let status: ProbeResult['status'] = 'ok';
    try {
      const [repl, mem, stats] = await Promise.all([this.infoOf(c, 'replication'), this.infoOf(c, 'memory'), this.infoOf(c, 'stats')]);
      const usedMemory = Number(mem.used_memory ?? 0);
      const maxMemory = Number(mem.maxmemory ?? 0);
      const evicted = Number(stats.evicted_keys ?? 0);
      Object.assign(data, {
        role: repl.role, connectedReplicas: Number(repl.connected_slaves ?? 0), usedMemory, maxMemory, evictedKeys: evicted,
      });
      notes.push(`${repl.role ?? '?'} · 副本 ${repl.connected_slaves ?? 0} · 内存 ${mem.used_memory_human ?? usedMemory}`);
      if (maxMemory > 0 && usedMemory / maxMemory > 0.9) {
        status = 'degraded';
        notes.push('内存使用接近上限');
      }
      if (evicted > 0) {
        status = 'degraded';
        notes.push(`已淘汰 ${evicted} 个键`);
      }
    } catch (e) {
      notes.push(`INFO 失败：${(e as Error).message}`);
    }
    if (this.hostClass !== 'elasticache') return { status, detail: notes.join(' · '), data };
    if (!this.deps.aws.enabled) {
      notes.push('无凭证：控制面感知不可用（CRED-004）');
      return { status, detail: notes.join(' · '), data };
    }
    const res = elasticacheResourceOf(this.rc.REDIS_URL);
    if (!res) return { status, detail: notes.join(' · '), data };
    try {
      const sdk = await loadAwsPackage('@aws-sdk/client-elasticache', () => import('@aws-sdk/client-elasticache'));
      const ec = await this.deps.aws.elasticache();
      if (res.kind === 'serverless') {
        const r = await ec.send(new sdk.DescribeServerlessCachesCommand({ ServerlessCacheName: res.id }));
        const sc = r.ServerlessCaches?.[0];
        if (!sc) return { status: 'error', detail: `${notes.join(' · ')} · Serverless 缓存 ${res.id} 不存在`, data };
        Object.assign(data, { serverlessCache: res.id, controlPlaneStatus: sc.Status, engine: sc.Engine, engineVersion: sc.FullEngineVersion });
        notes.push(`Serverless ${res.id} ${sc.Status ?? '?'}`);
        if (sc.Status !== 'available') status = 'degraded';
      } else {
        const r = await ec.send(new sdk.DescribeReplicationGroupsCommand({ ReplicationGroupId: res.id }));
        const g = r.ReplicationGroups?.[0];
        if (!g) return { status: 'error', detail: `${notes.join(' · ')} · 复制组 ${res.id} 不存在`, data };
        const members = g.MemberClusters?.length ?? 0;
        Object.assign(data, {
          replicationGroupId: res.id, controlPlaneStatus: g.Status, multiAz: g.MultiAZ, automaticFailover: g.AutomaticFailover,
          nodes: members, transitEncryption: g.TransitEncryptionEnabled, atRestEncryption: g.AtRestEncryptionEnabled,
        });
        notes.push(`复制组 ${res.id} ${g.Status ?? '?'} · 节点 ${members} · Multi-AZ ${g.MultiAZ ?? 'disabled'}`);
        if (g.Status !== 'available') status = 'degraded';
      }
    } catch (e) {
      if (isAwsNotFound(e)) return { status: 'error', detail: `${notes.join(' · ')} · 控制面确认资源不存在：${res.id}`, data };
      notes.push(`控制面查询失败：${describeAwsError(e)}`);
    }
    return { status, detail: notes.join(' · '), data };
  }

  async close(): Promise<void> {
    const c = this.client;
    this.client = undefined;
    this.connecting = undefined;
    if (!c) return;
    try {
      await c.quit();
    } catch {
      c.disconnect();
    }
  }
}
