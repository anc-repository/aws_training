// backend/src/modules/detectors/ec2.ts —— ec2 基础模块的本机健康项（00-ec2-base.md 第 5、7 节）
//
// 只读本机：IMDSv2（实例 ID、类型、AZ / AZ ID、AMI、公网 IPv4、实例标签）、/proc/self/mountinfo、statfs、/proc/meminfo、
// /proc/swaps、security/snapshot.json（root 定时器每 2 分钟采集）、backup/last-run.json，以及可选注入的密钥指纹与进程心跳。
// credentials: none——任何情况下都不调用 AWS API，置信度最高为 observed（开发机上为 inferred）。
// checks[]：imdsv2、data-volume、key-fingerprint、nginx、processes、disk、memory、time-sync、timers、security-snapshot、
// fail2ban、manual-dropins；汇总规则：任一 error → error；否则任一 degraded → degraded；否则 ok。
// 非 EC2 主机（开发机 / CI）上只报告与平台无关的检查项（disk、memory 等），其余跳过，保证 L0 开发环境为 ok。
// 本文件同时导出 IMDSv2 小客户端（ImdsClient），供 iam 感知器、autoscaling(single).identity() 复用。
import { existsSync, accessSync, constants as fsConstants, lstatSync, mkdirSync, readFileSync, realpathSync, rmSync, statfsSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { CapabilityCheck } from '@cloudalbum/contracts';
import type { ProbeResult } from '../../ports/common.js';
import type { Detector, DetectorContext, DetectorFactory } from './types.js';

// ---------------------------------------------------------------------------------------------
// IMDSv2
// ---------------------------------------------------------------------------------------------
export interface ImdsOptions {
  baseUrl?: string;
  timeoutMs?: number;
  tokenTtlSec?: number;
  fetch?: typeof fetch;
  /** 不可达后多久内不再尝试（默认 60 秒；开发机上避免每次探针都等超时） */
  negativeCacheMs?: number;
}

export interface ImdsResponse { status: number; body: string }

export class ImdsClient {
  private readonly baseUrl: string;
  private readonly timeoutMs: number;
  private readonly tokenTtlSec: number;
  private readonly fetchImpl: typeof fetch;
  private readonly negativeCacheMs: number;
  private cachedToken?: { value: string; expiresAt: number };
  private unreachableUntil = 0;

  constructor(opts: ImdsOptions = {}) {
    this.baseUrl = (opts.baseUrl ?? 'http://169.254.169.254').replace(/\/$/, '');
    this.timeoutMs = opts.timeoutMs ?? 300;
    this.tokenTtlSec = opts.tokenTtlSec ?? 21_600;
    this.fetchImpl = opts.fetch ?? globalThis.fetch;
    this.negativeCacheMs = opts.negativeCacheMs ?? 60_000;
  }

  /** 最近一次请求是否不可达（负缓存期内直接返回 null） */
  get unreachable(): boolean {
    return Date.now() < this.unreachableUntil;
  }

  private async request(p: string, init: RequestInit = {}): Promise<ImdsResponse | null> {
    if (this.unreachable) return null;
    try {
      const res = await this.fetchImpl(`${this.baseUrl}${p}`, { ...init, signal: AbortSignal.timeout(this.timeoutMs) });
      return { status: res.status, body: await res.text() };
    } catch {
      this.unreachableUntil = Date.now() + this.negativeCacheMs;
      return null;
    }
  }

  /** PUT /latest/api/token；不可达返回 null */
  async token(): Promise<string | null> {
    const c = this.cachedToken;
    if (c && c.expiresAt - 60_000 > Date.now()) return c.value;
    const r = await this.request('/latest/api/token', { method: 'PUT', headers: { 'X-aws-ec2-metadata-token-ttl-seconds': String(this.tokenTtlSec) } });
    if (!r || r.status !== 200 || !r.body) return null;
    this.cachedToken = { value: r.body.trim(), expiresAt: Date.now() + this.tokenTtlSec * 1000 };
    return this.cachedToken.value;
  }

  /** 带令牌 GET；不可达返回 null，404 返回 { status: 404 } */
  async get(p: string): Promise<ImdsResponse | null> {
    const t = await this.token();
    if (!t) return null;
    return this.request(p, { headers: { 'X-aws-ec2-metadata-token': t } });
  }

  async text(p: string): Promise<string | undefined> {
    const r = await this.get(p);
    return r && r.status === 200 ? r.body.trim() : undefined;
  }

  /** 不带令牌 GET /latest/meta-data/：401 = IMDSv2 强制（HttpTokens=required），200 = optional；不可达返回 null */
  async unauthenticatedStatus(): Promise<number | null> {
    const r = await this.request('/latest/meta-data/');
    return r ? r.status : null;
  }
}

export interface InstanceFacts {
  instanceId?: string;
  instanceType?: string;
  az?: string;
  azId?: string;
  amiId?: string;
  publicIpv4?: string;
  region?: string;
  tagsReadable?: boolean;
}

export async function readInstanceFacts(imds: ImdsClient): Promise<InstanceFacts | null> {
  if (!(await imds.token())) return null;
  const [instanceId, instanceType, az, azId, amiId, publicIpv4, region, tags] = await Promise.all([
    imds.text('/latest/meta-data/instance-id'),
    imds.text('/latest/meta-data/instance-type'),
    imds.text('/latest/meta-data/placement/availability-zone'),
    imds.text('/latest/meta-data/placement/availability-zone-id'),
    imds.text('/latest/meta-data/ami-id'),
    imds.text('/latest/meta-data/public-ipv4'),
    imds.text('/latest/meta-data/placement/region'),
    imds.get('/latest/meta-data/tags/instance/'),
  ]);
  const out: InstanceFacts = { tagsReadable: Boolean(tags && tags.status === 200) };
  if (instanceId) out.instanceId = instanceId;
  if (instanceType) out.instanceType = instanceType;
  if (az) out.az = az;
  if (azId) out.azId = azId;
  if (amiId) out.amiId = amiId;
  if (publicIpv4) out.publicIpv4 = publicIpv4;
  if (region) out.region = region;
  return out;
}

// ---------------------------------------------------------------------------------------------
// 本机事实（/proc、/sys、snapshot.json）
// ---------------------------------------------------------------------------------------------
function readText(file: string): string | undefined {
  try {
    return readFileSync(file, 'utf8');
  } catch {
    return undefined;
  }
}

/** 是否在 EC2 上（只读 DMI / hypervisor 标识，不访问网络） */
export function detectEc2Host(sysRoot = '/sys', platform: NodeJS.Platform = process.platform): boolean {
  if (platform !== 'linux') return false;
  const asset = readText(path.join(sysRoot, 'devices/virtual/dmi/id/board_asset_tag'))?.trim() ?? '';
  if (/^i-[0-9a-f]+$/.test(asset)) return true;
  const vendor = readText(path.join(sysRoot, 'devices/virtual/dmi/id/sys_vendor'))?.trim() ?? '';
  if (/amazon ec2/i.test(vendor)) return true;
  return (readText(path.join(sysRoot, 'hypervisor/uuid'))?.trim().toLowerCase() ?? '').startsWith('ec2');
}

export interface MountEntry { majorMinor: string; mountPoint: string; options: string; fsType: string; source: string }

/** 解析 /proc/self/mountinfo（挂载点中的空格等以八进制转义） */
export function parseMountinfo(text: string): MountEntry[] {
  const unescape = (s: string) => s.replace(/\\([0-7]{3})/g, (_m, o: string) => String.fromCharCode(parseInt(o, 8)));
  const out: MountEntry[] = [];
  for (const line of text.split('\n')) {
    const parts = line.trim().split(' ');
    const sep = parts.indexOf('-');
    if (parts.length < 7 || sep < 6) continue;
    out.push({
      majorMinor: parts[2]!, mountPoint: unescape(parts[4]!), options: parts[5]!,
      fsType: parts[sep + 1] ?? '', source: unescape(parts[sep + 2] ?? ''),
    });
  }
  return out;
}

export interface SecuritySnapshot {
  schemaVersion?: number;
  generatedAt?: string;
  host?: {
    units?: Record<string, string>;
    time?: { synchronized?: boolean; source?: string; offsetMs?: number };
    listening?: string[];
    nginx?: { lastReloadAt?: string; lastReloadOk?: boolean; denylistRejectedLines?: number };
    manualDropins?: string[];
    release?: string;
  };
  sshd?: { listening?: boolean };
  fail2ban?: { available?: boolean; jails?: unknown[] };
}

function worst(checks: CapabilityCheck[]): ProbeResult['status'] {
  if (checks.some((c) => c.status === 'error')) return 'error';
  if (checks.some((c) => c.status === 'degraded')) return 'degraded';
  return 'ok';
}

function pct(n: number): number {
  return Math.round(n * 100);
}

// ---------------------------------------------------------------------------------------------
// 感知器
// ---------------------------------------------------------------------------------------------
export interface Ec2FactSources {
  /** 本地主密钥指纹与 system_meta 的比对（CFG-007 已在启动时拦截；此项供 self-check 与冒烟测试展示） */
  keyFingerprint?: () => Promise<{ ok: boolean; detail: string; fingerprint?: string }>;
  /** 各进程心跳（LabMetricsStore.heartbeatsSnapshot() 或共享存储中的心跳记录）：名称 → ISO 时间 */
  heartbeats?: () => Record<string, string> | Promise<Record<string, string>>;
}

export interface Ec2DetectorOptions {
  imds?: ImdsClient;
  procRoot?: string;
  sysRoot?: string;
  platform?: NodeJS.Platform;
  /** 覆盖 EC2 判定（测试） */
  isEc2?: boolean;
  nginxHealthUrl?: string;
  fetch?: typeof fetch;
  now?: () => number;
}

export class Ec2Detector implements Detector {
  readonly module = 'ec2' as const;
  private readonly imds: ImdsClient;
  private readonly procRoot: string;
  private readonly sysRoot: string;
  private readonly platform: NodeJS.Platform;
  private readonly fetchImpl: typeof fetch;
  private readonly now: () => number;
  private facts: Ec2FactSources = {};
  private onEc2?: boolean;
  private lastInstance?: InstanceFacts;

  constructor(private readonly ctx: DetectorContext, private readonly opts: Ec2DetectorOptions = {}) {
    this.imds = opts.imds ?? new ImdsClient({ ...(opts.fetch ? { fetch: opts.fetch } : {}) });
    this.procRoot = opts.procRoot ?? '/proc';
    this.sysRoot = opts.sysRoot ?? '/sys';
    this.platform = opts.platform ?? process.platform;
    this.fetchImpl = opts.fetch ?? globalThis.fetch;
    this.now = opts.now ?? (() => Date.now());
    if (opts.isEc2 !== undefined) this.onEc2 = opts.isEc2;
  }

  /** container 在数据库与 LabMetricsStore 就绪后注入（可选） */
  attach(sources: Ec2FactSources): void {
    this.facts = { ...this.facts, ...sources };
  }

  /** 最近一次读到的实例事实（路径头 inst / az 的备用来源） */
  get instance(): InstanceFacts | undefined {
    return this.lastInstance;
  }

  private isEc2(): boolean {
    this.onEc2 ??= detectEc2Host(this.sysRoot, this.platform);
    return this.onEc2;
  }

  private get dataDir(): string {
    return this.ctx.cfg.core.CLOUDALBUM_DATA_DIR;
  }

  private readSnapshot(): SecuritySnapshot | undefined {
    const text = readText(path.join(this.dataDir, 'security', 'snapshot.json'));
    if (!text) return undefined;
    try {
      return JSON.parse(text) as SecuritySnapshot;
    } catch {
      return undefined;
    }
  }

  async detect(opts: { deep?: boolean } = {}): Promise<ProbeResult> {
    const onEc2 = this.isEc2();
    const linux = this.platform === 'linux';
    const snapshot = this.readSnapshot();
    const snapshotFresh = Boolean(snapshot?.generatedAt && this.now() - Date.parse(snapshot.generatedAt) < 5 * 60_000);
    const [imdsCheck, nginxCheck, keyCheck, processCheck] = await Promise.all([
      onEc2 ? this.checkImds() : Promise.resolve(null),
      onEc2 || snapshot ? this.checkNginx(snapshot) : Promise.resolve(null),
      this.checkKeyFingerprint(),
      this.checkProcesses(snapshot),
    ]);
    const checks: CapabilityCheck[] = [];
    const data: Record<string, unknown> = { hostname: os.hostname(), platform: this.platform, arch: process.arch, node: process.version, onEc2 };

    if (imdsCheck) {
      checks.push(imdsCheck.check);
      Object.assign(data, imdsCheck.facts ?? {});
    }
    if (linux) {
      const dv = this.checkDataVolume(onEc2, opts.deep === true);
      checks.push(dv.check);
      if (dv.volumeId) data.dataVolume = `${dv.volumeId}（inferred）`;
    } else if (opts.deep) {
      checks.push(this.writeReadDelete());
    }
    if (keyCheck) {
      checks.push(keyCheck.check);
      if (keyCheck.fingerprint) data.keyFingerprint = keyCheck.fingerprint;
    }
    if (nginxCheck) checks.push(nginxCheck);
    if (processCheck) checks.push(processCheck);
    const disk = this.checkDisk();
    checks.push(disk.check);
    checks.push(this.checkMemory(onEc2, linux));
    if (snapshot) {
      checks.push(this.checkTimeSync(snapshot));
      checks.push(this.checkTimers(snapshot));
      checks.push(this.checkFail2ban(snapshot));
      if (snapshot.host?.release) data.release = snapshot.host.release;
    }
    if (snapshot || onEc2) {
      checks.push(snapshot
        ? { id: 'security-snapshot', status: snapshotFresh ? 'ok' : 'degraded', detail: snapshotFresh ? `快照生成于 ${snapshot.generatedAt}` : `快照已过期（${snapshot.generatedAt ?? '无 generatedAt'}），依赖快照的检查项只能推断` }
        : { id: 'security-snapshot', status: 'degraded', detail: 'security/snapshot.json 不存在（cloudalbum-security-snapshot.timer 未运行？）' });
    }
    const dropins = this.checkManualDropins(snapshot);
    if (dropins) checks.push(dropins);

    data.checks = checks;
    const status = worst(checks);
    const imdsv2 = checks.find((c) => c.id === 'imdsv2');
    const timeSync = checks.find((c) => c.id === 'time-sync');
    const inst = this.lastInstance;
    const detail = onEc2
      ? [
        inst?.instanceType ?? '实例类型未知', inst?.az ?? 'AZ 未知', disk.summary,
        imdsv2 ? (imdsv2.status === 'ok' ? 'IMDSv2 强制' : imdsv2.detail) : undefined,
        timeSync ? (timeSync.status === 'ok' ? '时间已同步' : timeSync.detail) : undefined,
      ].filter(Boolean).join(' · ')
      : `${os.hostname()} · ${this.platform}/${process.arch} · node ${process.version} · ${disk.summary} · 非 EC2 环境（开发机：IMDS / 数据卷检查跳过）`;
    const problems = checks.filter((c) => c.status !== 'ok').map((c) => `${c.id}: ${c.detail}`);
    return {
      status,
      detail: problems.length && onEc2 ? `${detail} · ${problems.join('；')}` : detail,
      confidence: onEc2 && snapshotFresh ? 'observed' : 'inferred',
      data,
    };
  }

  // —— imdsv2 ————————————————————————————————————————————————————————————————————————————
  private async checkImds(): Promise<{ check: CapabilityCheck; facts?: Record<string, unknown> }> {
    const unauth = await this.imds.unauthenticatedStatus();
    if (unauth === null) {
      return { check: { id: 'imdsv2', status: 'error', detail: 'IMDS 不可达（HttpEndpoint=disabled？inst / az 无法填写）' } };
    }
    const facts = await readInstanceFacts(this.imds);
    if (facts) this.lastInstance = facts;
    const notes: string[] = [];
    let status: CapabilityCheck['status'] = 'ok';
    if (unauth === 401) notes.push('无令牌请求返回 401');
    else {
      status = 'degraded';
      notes.push(`无令牌请求返回 ${unauth}（HttpTokens=optional，IMDSv1 仍可用）`);
    }
    if (!facts) {
      status = 'error';
      notes.push('取不到 IMDSv2 令牌');
    } else if (!facts.tagsReadable) {
      if (status === 'ok') status = 'degraded';
      notes.push('实例标签不可读（InstanceMetadataTags=disabled）');
    } else notes.push('实例标签可读');
    return {
      check: { id: 'imdsv2', status, detail: notes.join('；') },
      ...(facts ? { facts: { ...facts } } : {}),
    };
  }

  // —— data-volume ————————————————————————————————————————————————————————————————————————
  private checkDataVolume(onEc2: boolean, deep: boolean): { check: CapabilityCheck; volumeId?: string } {
    const dataDir = path.resolve(this.dataDir);
    const mounts = parseMountinfo(readText(path.join(this.procRoot, 'self/mountinfo')) ?? '');
    const own = mounts.filter((m) => m.mountPoint === dataDir).pop();
    const root = mounts.filter((m) => m.mountPoint === '/').pop();
    const notes: string[] = [];
    let status: CapabilityCheck['status'] = 'ok';
    let volumeId: string | undefined;
    if (!own) {
      if (onEc2) {
        return { check: { id: 'data-volume', status: 'error', detail: `${dataDir} 不是独立挂载点（数据会写到根卷上）` } };
      }
      notes.push(`${dataDir} 不是独立挂载点（开发机，忽略）`);
    } else {
      const ro = own.options.split(',').includes('ro');
      if (ro) return { check: { id: 'data-volume', status: 'error', detail: `${dataDir} 以只读方式挂载` } };
      if (root && root.majorMinor === own.majorMinor) {
        return { check: { id: 'data-volume', status: 'error', detail: `${dataDir} 与根卷是同一设备（${own.majorMinor}）` } };
      }
      const dev = path.basename(own.source).replace(/p\d+$/, '');
      const serial = readText(path.join(this.sysRoot, 'block', dev, 'device/serial'))?.trim();
      if (serial && /^vol[0-9a-f]+$/i.test(serial)) volumeId = `vol-${serial.slice(3)}`;
      notes.push(`${dataDir} ← ${path.basename(own.source)}${volumeId ? `（${volumeId}）` : ''} ${own.fsType} rw`);
      if (own.fsType !== 'xfs') notes.push(`文件系统为 ${own.fsType}（引导脚本使用 xfs）`);
    }
    const envDir = this.ctx.cfg.core.CLOUDALBUM_ENV_DIR;
    try {
      const st = lstatSync(envDir);
      if (st.isSymbolicLink() && realpathSync(envDir) === realpathSync(path.join(dataDir, 'etc'))) notes.push(`${envDir} → 数据卷`);
      else if (onEc2) {
        status = 'degraded';
        notes.push(`${envDir} 不是指向 ${path.join(dataDir, 'etc')} 的符号链接（single 模式下机密会随根卷丢失）`);
      }
    } catch {
      if (onEc2) {
        status = 'degraded';
        notes.push(`${envDir} 不存在`);
      }
    }
    if (deep) {
      const w = this.writeReadDelete();
      if (w.status !== 'ok') status = w.status;
      notes.push(w.detail);
    }
    return { check: { id: 'data-volume', status, detail: notes.join('；') }, ...(volumeId ? { volumeId } : {}) };
  }

  private writeReadDelete(): CapabilityCheck {
    const dir = path.join(this.dataDir, '.probe');
    const file = path.join(dir, `ec2-${process.pid}-${this.now()}`);
    try {
      mkdirSync(dir, { recursive: true });
      writeFileSync(file, 'cloudalbum');
      const back = readFileSync(file, 'utf8');
      rmSync(file, { force: true });
      if (back !== 'cloudalbum') throw new Error('读回内容不一致');
      return { id: 'data-volume', status: 'ok', detail: '写-读-删测试文件通过' };
    } catch (e) {
      return { id: 'data-volume', status: 'error', detail: `写-读-删失败：${(e as Error).message}` };
    }
  }

  // —— disk ——————————————————————————————————————————————————————————————————————————————
  private checkDisk(): { check: CapabilityCheck; summary: string } {
    const dataDir = this.dataDir;
    if (!existsSync(dataDir)) {
      return { check: { id: 'disk', status: 'degraded', detail: `数据目录 ${dataDir} 不存在` }, summary: '数据目录不存在' };
    }
    let status: CapabilityCheck['status'] = 'ok';
    const notes: string[] = [];
    let summary = '';
    try {
      const s = statfsSync(dataDir);
      const free = s.blocks > 0 ? s.bavail / s.blocks : 0;
      const inodeFree = s.files > 0 ? s.ffree / s.files : undefined;
      summary = `数据卷剩余 ${pct(free)}%`;
      notes.push(`${summary}${inodeFree !== undefined ? `（inode ${pct(inodeFree)}%）` : ''}`);
      const minFree = Math.min(free, inodeFree ?? 1);
      if (minFree < 0.05) status = 'error';
      else if (minFree < 0.15) status = 'degraded';
    } catch (e) {
      return { check: { id: 'disk', status: 'error', detail: `statfs 失败：${(e as Error).message}` }, summary: 'statfs 失败' };
    }
    try {
      accessSync(dataDir, fsConstants.W_OK);
    } catch {
      return { check: { id: 'disk', status: 'error', detail: `数据目录不可写：${dataDir}` }, summary };
    }
    if (this.platform === 'linux') {
      try {
        const r = statfsSync('/');
        const free = r.blocks > 0 ? r.bavail / r.blocks : 1;
        notes.push(`根卷剩余 ${pct(free)}%`);
        if (free < 0.15 && status === 'ok') status = 'degraded';
      } catch {
        /* 忽略 */
      }
    }
    return { check: { id: 'disk', status, detail: notes.join('；') }, summary };
  }

  // —— memory ————————————————————————————————————————————————————————————————————————————
  private checkMemory(onEc2: boolean, linux: boolean): CapabilityCheck {
    if (!linux) {
      const availPct = pct(os.freemem() / os.totalmem());
      return { id: 'memory', status: availPct < 10 ? 'degraded' : 'ok', detail: `可用内存 ${availPct}%` };
    }
    const info = readText(path.join(this.procRoot, 'meminfo')) ?? '';
    const kb = (name: string) => Number(new RegExp(`^${name}:\\s+(\\d+)`, 'm').exec(info)?.[1] ?? NaN);
    const total = kb('MemTotal');
    const avail = kb('MemAvailable');
    const availPct = Number.isFinite(total) && total > 0 && Number.isFinite(avail) ? pct(avail / total) : pct(os.freemem() / os.totalmem());
    const swapLines = (readText(path.join(this.procRoot, 'swaps')) ?? '').trim().split('\n').slice(1).filter((l) => l.trim());
    const notes = [`可用内存 ${availPct}%`, swapLines.length ? 'swap 已启用' : 'swap 未启用'];
    const status: CapabilityCheck['status'] = availPct < 10 || (onEc2 && !swapLines.length) ? 'degraded' : 'ok';
    return { id: 'memory', status, detail: notes.join('；') };
  }

  // —— nginx —————————————————————————————————————————————————————————————————————————————
  private async checkNginx(snapshot: SecuritySnapshot | undefined): Promise<CapabilityCheck> {
    const url = this.opts.nginxHealthUrl ?? 'http://127.0.0.1/_ca/nginx-health';
    let reachable = false;
    let httpStatus = 0;
    try {
      const res = await this.fetchImpl(url, { signal: AbortSignal.timeout(500) });
      httpStatus = res.status;
      reachable = res.status === 204 || res.status === 200;
    } catch {
      reachable = false;
    }
    if (!reachable) return { id: 'nginx', status: 'error', detail: httpStatus ? `${url} 返回 ${httpStatus}` : `Nginx 不可达（${url}）` };
    const n = snapshot?.host?.nginx;
    if (n?.lastReloadOk === false) return { id: 'nginx', status: 'degraded', detail: `最近一次 reload 失败（${n.lastReloadAt ?? '?'}），仍在使用上一版本配置` };
    if ((n?.denylistRejectedLines ?? 0) > 0) return { id: 'nginx', status: 'degraded', detail: `denylist 有 ${n!.denylistRejectedLines} 行校验失败被拒` };
    return { id: 'nginx', status: 'ok', detail: `${httpStatus}${n?.lastReloadAt ? ` · 最近 reload ${n.lastReloadAt} 成功` : ''}` };
  }

  // —— key-fingerprint ————————————————————————————————————————————————————————————————————
  private async checkKeyFingerprint(): Promise<{ check: CapabilityCheck; fingerprint?: string } | null> {
    if (!this.facts.keyFingerprint) return null;
    try {
      const r = await this.facts.keyFingerprint();
      return { check: { id: 'key-fingerprint', status: r.ok ? 'ok' : 'error', detail: r.detail }, ...(r.fingerprint ? { fingerprint: r.fingerprint } : {}) };
    } catch (e) {
      return { check: { id: 'key-fingerprint', status: 'error', detail: `比对失败：${(e as Error).message}` } };
    }
  }

  // —— processes —————————————————————————————————————————————————————————————————————————
  private async checkProcesses(snapshot: SecuritySnapshot | undefined): Promise<CapabilityCheck | null> {
    const units = snapshot?.host?.units;
    let heartbeats: Record<string, string> | undefined;
    try {
      heartbeats = await this.facts.heartbeats?.();
    } catch {
      heartbeats = undefined;
    }
    if (!units && !heartbeats) return null;
    const notes: string[] = [];
    let status: CapabilityCheck['status'] = 'ok';
    const ageSec = (name: string) => {
      const at = heartbeats?.[name];
      return at ? Math.round((this.now() - Date.parse(at)) / 1000) : undefined;
    };
    const workerAge = ageSec('worker');
    if (workerAge !== undefined) {
      notes.push(`worker 心跳 ${workerAge}s 前`);
      if (workerAge > 120) status = 'degraded';
    }
    const apiAge = ageSec('api');
    if (apiAge !== undefined) notes.push(`api 心跳 ${apiAge}s 前`);
    if (units) {
      for (const u of ['cloudalbum-api', 'cloudalbum-worker']) {
        const s = units[u];
        if (s && s !== 'active') {
          status = 'degraded';
          notes.push(`${u} ${s}`);
        }
      }
      if (this.ctx.cfg.core.LB_LOCAL_WORKERS === 2 && units['cloudalbum-api@3001'] !== 'active') {
        status = 'degraded';
        notes.push('LB_LOCAL_WORKERS=2 但 cloudalbum-api@3001 未运行');
      }
      if (!notes.length) notes.push('服务单元均为 active');
    }
    return { id: 'processes', status, detail: notes.join('；') };
  }

  // —— time-sync / timers / fail2ban / manual-dropins（来自快照）—————————————————————————————
  private checkTimeSync(snapshot: SecuritySnapshot): CapabilityCheck {
    const t = snapshot.host?.time;
    if (!t) return { id: 'time-sync', status: 'degraded', detail: '快照中没有时间同步信息' };
    const offset = Math.abs(t.offsetMs ?? 0);
    if (t.synchronized && offset < 1000) return { id: 'time-sync', status: 'ok', detail: `chrony 已同步 · 源 ${t.source ?? '?'} · 偏差 ${offset}ms` };
    return { id: 'time-sync', status: 'degraded', detail: t.synchronized ? `偏差 ${offset}ms ≥ 1s` : '时钟未同步（SigV4 签名、日志时间戳、证书校验都依赖时钟）' };
  }

  private checkTimers(snapshot: SecuritySnapshot): CapabilityCheck {
    const units = snapshot.host?.units ?? {};
    const notes: string[] = [];
    let status: CapabilityCheck['status'] = 'ok';
    for (const timer of ['cloudalbum-healthcheck.timer', 'cloudalbum-backup.timer']) {
      if (units[timer] !== undefined && units[timer] !== 'active') {
        status = 'degraded';
        notes.push(`${timer} ${units[timer]}`);
      }
    }
    const lastRun = readText(path.join(this.dataDir, 'backup', 'last-run.json'));
    if (lastRun) {
      try {
        const r = JSON.parse(lastRun) as { lastSuccessAt?: string; finishedAt?: string; ok?: boolean };
        const at = r.lastSuccessAt ?? (r.ok !== false ? r.finishedAt : undefined);
        const ageH = at ? (this.now() - Date.parse(at)) / 3_600_000 : Infinity;
        if (ageH > 26) {
          status = 'degraded';
          notes.push(at ? `本地备份 ${Math.round(ageH)} 小时未成功` : '本地备份没有成功记录');
        } else notes.push(`本地备份 ${Math.round(ageH)} 小时前成功`);
      } catch {
        status = 'degraded';
        notes.push('backup/last-run.json 无法解析');
      }
    } else if (os.uptime() > 26 * 3600) {
      status = 'degraded';
      notes.push('没有本地备份记录（backup/last-run.json）');
    }
    return { id: 'timers', status, detail: notes.length ? notes.join('；') : '定时器均已激活' };
  }

  private checkFail2ban(snapshot: SecuritySnapshot): CapabilityCheck {
    const f = snapshot.fail2ban;
    if (f?.available) return { id: 'fail2ban', status: 'ok', detail: `运行中 · jail ${f.jails?.length ?? 0} 个` };
    return { id: 'fail2ban', status: 'degraded', detail: 'fail2ban 未安装或未运行（旧 AMI？）' };
  }

  private checkManualDropins(snapshot: SecuritySnapshot | undefined): CapabilityCheck | null {
    const found = [...(snapshot?.host?.manualDropins ?? [])];
    const override = path.join(this.ctx.cfg.core.CLOUDALBUM_ENV_DIR, 'local.override.env');
    if (existsSync(override)) found.push(override);
    if (!snapshot && !found.length) return null;
    return found.length
      ? { id: 'manual-dropins', status: 'degraded', detail: `存在手工改动：${found.join(', ')}` }
      : { id: 'manual-dropins', status: 'ok', detail: '无手工 drop-in' };
  }
}

export const ec2Detector: DetectorFactory = { module: 'ec2', create: (ctx) => new Ec2Detector(ctx) };
