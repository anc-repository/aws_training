/**
 * experiments/dns/lib.ts —— dns 实验共用：目标（域名、EIP）、公共解析器与权威名称服务器查询、换 IP 演练的状态文件、结果分析。
 *
 * 取值顺序（与 cdn/targets.ts 相同）：--param > capabilities（管理员视图：dns 感知器的 data、ec2 的 publicIpv4、app.entry）> 运行器目标。
 * 解析一律用 node:dns 的 Resolver 并显式指定服务器（默认 8.8.8.8，等价于 `dig @8.8.8.8`），避开本机缓存；没有 dig 也能跑。
 */
import { Resolver } from 'node:dns/promises';
import { existsSync, readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { timedGet } from '../_lib/probe.js';
import type { ScenarioContext } from '../_lib/scenario.js';
import { strParam } from '../_lib/scenario.js';

const IPV4 = /^\d{1,3}(\.\d{1,3}){3}$/;

function rec(v: unknown): Record<string, unknown> {
  return v && typeof v === 'object' ? (v as Record<string, unknown>) : {};
}

function hostOf(url: string | undefined): string {
  if (!url) return '';
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return '';
  }
}

/** 记录名：--param domain > dns 感知器的 recordName > app.entry（source=dns）> 运行器目标（是域名时） */
export function domainOf(ctx: Pick<ScenarioContext, 'params' | 'capabilities' | 'target'>): string {
  const p = strParam(ctx, 'domain', '');
  if (p) return p.toLowerCase();
  const data = rec(ctx.capabilities.modules?.dns?.data);
  if (typeof data.recordName === 'string' && data.recordName) return data.recordName;
  const entry = ctx.capabilities.app?.entry;
  if (entry?.source === 'dns') return hostOf(entry.baseUrl);
  const t = hostOf(ctx.target);
  return t && !IPV4.test(t) && t !== 'localhost' ? t : '';
}

/** 实例当前的 EIP：--param ip > ec2 感知器的 publicIpv4 > 运行器目标（是 IP 时） */
export function eipOf(ctx: Pick<ScenarioContext, 'params' | 'capabilities' | 'target'>): string {
  const p = strParam(ctx, 'ip', '');
  if (p) return p;
  const data = rec(ctx.capabilities.modules?.ec2?.data);
  if (typeof data.publicIpv4 === 'string' && IPV4.test(data.publicIpv4)) return data.publicIpv4;
  const t = hostOf(ctx.target);
  return IPV4.test(t) ? t : '';
}

export interface ResolveResult { answers: string[]; ttl?: number; error?: string; ms: number }

/** 指定解析器查询 A 记录（等价于 `dig +short <host> @<server>`） */
export async function resolveVia(host: string, servers: readonly string[], timeoutMs = 3000): Promise<ResolveResult> {
  const r = new Resolver({ timeout: timeoutMs, tries: 1 });
  if (servers.length) r.setServers([...servers]);
  const t0 = performance.now();
  try {
    const a = await r.resolve4(host, { ttl: true });
    return { answers: a.map((x) => x.address).sort(), ...(a.length ? { ttl: Math.min(...a.map((x) => x.ttl)) } : {}), ms: Math.round(performance.now() - t0) };
  } catch (e) {
    return { answers: [], error: String((e as { code?: string }).code ?? (e as Error).message), ms: Math.round(performance.now() - t0) };
  }
}

/** 托管区域的权威名称服务器（NS 记录 → IPv4），供 weighted-sample 绕开解析器缓存 */
export async function authoritativeServers(zone: string, timeoutMs = 3000): Promise<string[]> {
  const r = new Resolver({ timeout: timeoutMs, tries: 2 });
  r.setServers(['8.8.8.8', '1.1.1.1']);
  let labels = zone.split('.');
  for (; labels.length >= 2; labels = labels.slice(1)) {
    const name = labels.join('.');
    try {
      const ns = await r.resolveNs(name);
      const ips: string[] = [];
      for (const n of ns.slice(0, 4)) ips.push(...(await r.resolve4(n).catch(() => [] as string[])));
      if (ips.length) return [...new Set(ips)];
    } catch {
      /* 上一级域 */
    }
  }
  return [];
}

export interface HealthProbe { status: number; ms: number; error?: string; body?: string }

export async function probeHealth(url: string, timeoutMs = 4000): Promise<HealthProbe> {
  const r = await timedGet(url, {}, timeoutMs);
  return { status: r.status, ms: Math.round(r.totalMs), ...(r.error ? { error: r.error } : {}) };
}

/** faults/reassociate-eip.sh 写的状态文件（运行器以 --fault-via local 在同一台机器上执行它） */
export interface DrillState { instanceId?: string; oldIp?: string; newIp?: string; upserted?: boolean; record?: string; zoneId?: string; at?: string; restoredAt?: string }

export function drillStateFile(env: string): string {
  return path.join(process.env.TMPDIR || os.tmpdir(), `cloudalbum-dns-ip-drill-${env}.json`);
}

export function readDrillState(env: string): DrillState | undefined {
  const f = drillStateFile(env);
  if (!existsSync(f)) return undefined;
  try {
    return JSON.parse(readFileSync(f, 'utf8')) as DrillState;
  } catch {
    return undefined;
  }
}

export interface DrillSample {
  /** 相对测量开始的秒数 */
  t: number;
  oldLinkOk: boolean;
  domainOk?: boolean;
  answers?: string[];
  newIp?: string;
}

export interface DrillAnalysis {
  samples: number;
  oldLinkFailures: number;
  domainFailures: number;
  /** 演练开始（看到新 IP）的时刻 */
  swapAt?: number;
  /** 公共解析器第一次返回新 IP 的时刻相对 swapAt 的秒数 */
  resolverSwitchSec?: number;
  /** swapAt 之后域名链接第一次成功、且解析结果已是新 IP 的秒数 */
  domainRecoverySec?: number;
  /** 演练期间域名链接一直可用（解析与访问都已切到新 IP，或者从未失败） */
  domainNeverRecovered: boolean;
}

/** 换 IP 演练的结论：旧 IP 链接失效多少次，域名在 TTL 量级的时间内恢复 */
export function analyzeIpChange(samples: readonly DrillSample[]): DrillAnalysis {
  const swap = samples.find((s) => s.newIp);
  const newIp = swap?.newIp;
  const after = swap ? samples.filter((s) => s.t >= swap.t) : [];
  const switched = newIp ? after.find((s) => s.answers?.includes(newIp)) : undefined;
  const recovered = newIp ? after.find((s) => s.domainOk && s.answers?.includes(newIp)) : undefined;
  const withDomain = samples.filter((s) => s.domainOk !== undefined);
  return {
    samples: samples.length,
    oldLinkFailures: samples.filter((s) => !s.oldLinkOk).length,
    domainFailures: withDomain.filter((s) => !s.domainOk).length,
    ...(swap ? { swapAt: swap.t } : {}),
    ...(swap && switched ? { resolverSwitchSec: Math.round((switched.t - swap.t) * 10) / 10 } : {}),
    ...(swap && recovered ? { domainRecoverySec: Math.round((recovered.t - swap.t) * 10) / 10 } : {}),
    domainNeverRecovered: Boolean(swap && withDomain.length && !recovered),
  };
}

/** 加权路由：每个答案集合出现的比例 */
export function answerShares(answers: ReadonlyArray<readonly string[]>): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const a of answers) {
    const k = a.length ? [...a].sort().join(',') : '(empty)';
    counts[k] = (counts[k] ?? 0) + 1;
  }
  const total = answers.length || 1;
  return Object.fromEntries(Object.entries(counts).map(([k, n]) => [k, Math.round((n / total) * 1000) / 1000]));
}

/** 服务端证据：经域名请求 /api/lab/echo，服务端看到的 Host；以及 dns 感知器的解析结果与 Host 分布 */
export async function serverEvidence(ctx: ScenarioContext, domain: string): Promise<Record<string, unknown>> {
  const out: Record<string, unknown> = {};
  if (domain) {
    const r = await ctx.http(`http://${domain}`).get('/api/lab/echo', { record: false }).catch(() => undefined);
    if (r?.ok) {
      const j = r.json<{ host?: string; entry?: string }>();
      out.echoHost = j?.host ?? null;
      out.echoEntry = j?.entry ?? null;
    }
  }
  const caps = await ctx.client.get('/api/capabilities?deep=1', { record: false }).catch(() => undefined);
  if (caps?.ok) {
    const data = rec(rec(rec(caps.json<Record<string, unknown>>()?.modules).dns).data);
    if (Object.keys(data).length) {
      out.detector = { resolution: data.resolution ?? null, passive: data.passive ?? null, healthCheck: data.healthCheck ?? null };
    }
  }
  return out;
}
