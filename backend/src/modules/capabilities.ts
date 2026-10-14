// backend/src/modules/capabilities.ts —— 能力注册表 + 状态机 + 变化推送（总纲 §6）
//
// - status 是“这个模块（AWS 实现）”的状态：off = 模块未启用、正在使用本地实现（含本地档）；本地实现自身的健康放在 localHealth。
//   ec2 是 base，不会出现 off，也不输出 localHealth。
// - 状态机（6.3）：off 只由配置决定；ok → degraded（探针超阈值 / 命中 warn 规则）；连续 3 次探针失败或权威端口
//   30 秒内连续 5 次真实调用失败 → error；error → degraded 需要 1 次探针成功；degraded → ok 需要连续 2 次健康。
//   首次探针的确定性失败直接 error；瞬时失败（探针超时、ProbeResult.transient）先记 degraded，同样连续 3 次才 error（wave1-prep）。
// - CLOUDALBUM_ALLOW_UNSAFE 覆盖的规则使相关模块最好也只能是 degraded；warn 规则使相关模块至少为 degraded。
// - 每次状态变化：通知订阅者（SSE GET /api/capabilities/stream、capability_events 表、结构化日志）。
import { createHash } from 'node:crypto';
import { existsSync, accessSync, constants as fsConstants } from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import {
  BYPASS_KEYS, CAPABILITIES_SCHEMA_VERSION, MODULE_IDS, isModuleId, isParamSwitch,
  type CapabilitiesResponse, type CapabilityCheck, type CapabilityTransitionEvent, type FeatureState, type HealthStatus,
  type ModuleCapability, type ModuleId, type ModuleStatus, type ProbeHistoryEntry, type ValidationFinding,
} from '@cloudalbum/contracts';
import { effectiveEntry, hostKindOf, httpsState, type HttpsInfo } from '../config/base-url.js';
import { platformInfo, platformMode } from '../platform/mode.js';
import type { AppConfig } from '../config/schema.js';
import { isAllowedInSecretsFile, isSecretLikeKey } from '../config/load-env.js';
import { isNotImplemented } from '../errors.js';
import type { CallObserver, PortCallEvent } from '../observability/instrument.js';
import type { Adapter, ProbeResult } from '../ports/common.js';
import { DEFAULT_RUNTIME_CONFIG, type RuntimeConfig } from '../ports/config.js';
import type { Finding, Verdict } from '../rules/engine.js';
import type { Detector } from './detectors/types.js';
import { ProbeTimeoutError, startLoop, withTimeout, type LoopHandle } from './probe-loop.js';
import { REGISTRY, driverOf, isEnabled, localSwitchValue, type Registry } from './registry.js';

export type ProcessRole = 'api' | 'worker' | 'cli';
type ProbeFn = (opts: { deep?: boolean }) => Promise<ProbeResult>;

interface ModuleState {
  status: ModuleStatus;
  localHealth?: HealthStatus;
  detail: string;
  latencyMs?: number;
  confidence?: ProbeResult['confidence'];
  since: string;
  lastProbeAt?: string;
  history: ProbeHistoryEntry[];
  consecutiveFailures: number;
  consecutiveHealthy: number;
  /** 最近的真实调用失败时间戳（被动信号） */
  callFailures: number[];
  data?: Record<string, unknown>;
  checks?: CapabilityCheck[];
  public?: Record<string, unknown>;
  probed: boolean;
}

export interface CapabilityRegistryOptions {
  cfg: AppConfig;
  /** 有效 env（parseConfig().effective） */
  env: Readonly<Record<string, string>>;
  verdict: Verdict;
  role: ProcessRole;
  registry?: Registry;
  version?: string;
  now?: () => Date;
}

const HISTORY_LIMIT = 20;
const PASSIVE_WINDOW_MS = 30_000;
const PASSIVE_ERROR_THRESHOLD = 5;

function appVersion(): string {
  try {
    const require = createRequire(import.meta.url);
    return (require('../../package.json') as { version?: string }).version ?? '0.0.0';
  } catch {
    return '0.0.0';
  }
}

function toValidation(f: Finding, admin: boolean): ValidationFinding {
  return { rule: f.rule, modules: f.modules, message: f.message, ...(admin && f.fix ? { fix: f.fix } : {}) };
}

function severityRank(s: HealthStatus | ModuleStatus): number {
  return s === 'error' ? 3 : s === 'degraded' ? 2 : s === 'ok' ? 1 : 0;
}

export class CapabilityRegistry implements CallObserver {
  private readonly registry: Registry;
  private readonly states = new Map<ModuleId, ModuleState>();
  private readonly adapters = new Map<ModuleId, Adapter>();
  private readonly probes = new Map<ModuleId, ProbeFn>();
  private readonly detectors = new Map<ModuleId, Detector>();
  private readonly listeners = new Set<(e: CapabilityTransitionEvent) => void>();
  private readonly startedAt: string;
  private readonly version: string;
  private loop?: LoopHandle;
  private lockScope: 'host' | 'cluster' = 'host';
  private instance: { id: string; az: string; type: string } = { id: os.hostname(), az: 'unknown', type: 'unknown' };
  private runtimeProvider: () => RuntimeConfig = () => DEFAULT_RUNTIME_CONFIG;
  private httpsOverride?: HttpsInfo;
  private draining = false;
  private readonly verdict: Verdict;
  private runtimeWarnings: Finding[] = [];

  constructor(private readonly opts: CapabilityRegistryOptions) {
    this.registry = opts.registry ?? REGISTRY;
    this.verdict = opts.verdict;
    this.startedAt = this.now().toISOString();
    this.version = opts.version ?? appVersion();
    for (const id of MODULE_IDS) {
      const enabled = this.isEnabled(id);
      this.states.set(id, {
        status: enabled ? 'ok' : 'off',
        ...(enabled ? {} : { localHealth: 'ok' as const }),
        detail: enabled ? '启动探针尚未完成' : this.localDetail(id),
        since: this.startedAt,
        history: [],
        consecutiveFailures: 0,
        consecutiveHealthy: 0,
        callFailures: [],
        probed: false,
      });
    }
  }

  private now(): Date {
    return this.opts.now?.() ?? new Date();
  }

  private localDetail(id: ModuleId): string {
    const summary = this.registry[id].lab?.summary?.local;
    return summary ?? `本地实现（${driverOf(this.opts.env, id, this.registry)}）`;
  }

  isEnabled(id: ModuleId): boolean {
    return isEnabled(this.opts.env, id, this.registry);
  }

  // ------------------------------------------------------------------------------------------
  // 注册
  // ------------------------------------------------------------------------------------------
  registerAdapter(module: ModuleId, adapter: Adapter): void {
    this.adapters.set(module, adapter);
  }

  registerProbe(module: ModuleId, fn: ProbeFn): void {
    this.probes.set(module, fn);
  }

  registerDetector(det: Detector): void {
    this.detectors.set(det.module, det);
  }

  detectorsList(): Detector[] {
    return [...this.detectors.values()];
  }

  setLockScope(scope: 'host' | 'cluster'): void {
    this.lockScope = scope;
  }

  getLockScope(): 'host' | 'cluster' {
    return this.lockScope;
  }

  setInstance(i: Partial<{ id: string; az: string; type: string }>): void {
    this.instance = { ...this.instance, ...Object.fromEntries(Object.entries(i).filter(([, v]) => Boolean(v))) };
  }

  setRuntimeConfigProvider(fn: () => RuntimeConfig): void {
    this.runtimeProvider = fn;
  }

  setPublic(module: ModuleId, data: Record<string, unknown>): void {
    const s = this.states.get(module);
    if (s) s.public = { ...(s.public ?? {}), ...data };
  }

  setHttps(info: HttpsInfo): void {
    this.httpsOverride = info;
  }

  setDraining(v: boolean): void {
    this.draining = v;
  }

  /** 运行期规则（SEC-*、DEP-018）的结果并入 validation.warnings（每轮整体替换） */
  setRuntimeVerdict(runtimeWarnings: Finding[]): void {
    this.runtimeWarnings = runtimeWarnings.map((w) => ({ ...w, message: `[runtime] ${w.message}` }));
  }

  private warnings(): Finding[] {
    return [...this.verdict.warnings, ...this.runtimeWarnings];
  }

  onTransition(cb: (e: CapabilityTransitionEvent) => void): () => void {
    this.listeners.add(cb);
    return () => this.listeners.delete(cb);
  }

  /** 适配器 init() 失败：记为 error（不中断启动） */
  reportFailure(module: ModuleId, err: unknown): void {
    const detail = isNotImplemented(err) ? `未实现：${(err as Error).message}` : `初始化失败：${(err as Error)?.message ?? String(err)}`;
    this.applyResult(module, { status: 'error', detail }, { fromProbe: true });
  }

  // ------------------------------------------------------------------------------------------
  // 被动信号（instrument 代理）
  // ------------------------------------------------------------------------------------------
  onCall(e: PortCallEvent): void {
    const s = this.states.get(e.module);
    if (!s || e.ok || e.clientError) return;
    const nowMs = this.now().getTime();
    s.callFailures = s.callFailures.filter((t) => nowMs - t < PASSIVE_WINDOW_MS);
    s.callFailures.push(nowMs);
    if (s.callFailures.length < PASSIVE_ERROR_THRESHOLD) return;
    const authoritative = Boolean(this.registry[e.module]?.authoritative);
    const message = `最近 30 秒连续 ${s.callFailures.length} 次真实调用失败：${(e.error as Error)?.message ?? 'error'}`;
    this.applyResult(e.module, { status: authoritative ? 'error' : 'degraded', detail: message }, { fromProbe: false });
  }

  // ------------------------------------------------------------------------------------------
  // 探针
  // ------------------------------------------------------------------------------------------
  private sourceFor(module: ModuleId): ProbeFn | undefined {
    const enabled = module === 'ec2' || this.isEnabled(module);
    const adapter = this.adapters.get(module);
    const probe = this.probes.get(module);
    const detector = this.detectors.get(module);
    if (adapter) return (o) => adapter.probe(o);
    if (probe) return probe;
    if (detector && enabled) return (o) => detector.detect(o);
    return undefined;
  }

  async probeModule(module: ModuleId, opts: { deep?: boolean; timeoutMs?: number } = {}): Promise<void> {
    const source = this.sourceFor(module);
    if (!source) {
      const s = this.states.get(module)!;
      s.probed = true;
      s.lastProbeAt = this.now().toISOString();
      if (s.status !== 'off' && module !== 'ec2') {
        this.applyResult(module, { status: 'degraded', detail: '已启用，但尚未接入探针或感知器', confidence: 'inferred' }, { fromProbe: true });
      }
      return;
    }
    const t0 = Date.now();
    let result: ProbeResult;
    try {
      result = await withTimeout(source({ ...(opts.deep ? { deep: true } : {}) }), opts.timeoutMs ?? 2000);
    } catch (e) {
      result = {
        status: 'error',
        detail: isNotImplemented(e) ? `未实现：${(e as Error).message}` : `探针失败：${(e as Error)?.message ?? String(e)}`,
        // 探针整体超时是瞬时失败：首次探针不直接记为 error（wave1-prep，2026-10-14 实机验证的教训）
        ...(e instanceof ProbeTimeoutError ? { transient: true } : {}),
      };
    }
    if (result.latencyMs === undefined) result = { ...result, latencyMs: Date.now() - t0 };
    this.applyResult(module, result, { fromProbe: true });
  }

  async probeAll(opts: { timeoutMs?: number; deep?: boolean } = {}): Promise<void> {
    await Promise.all(MODULE_IDS.map((m) => this.probeModule(m, opts)));
  }

  startProbeLoop(opts: { intervalSec: number; jitterSec: number }): void {
    this.stopProbeLoop();
    this.loop = startLoop(() => this.probeAll({ timeoutMs: 2000 }), { ...opts });
  }

  stopProbeLoop(): void {
    this.loop?.stop();
    delete this.loop;
  }

  /** 规则对模块状态的约束：warn → 至少 degraded；被覆盖（不安全实验）→ 最好也只能是 degraded */
  private ruleFloor(module: ModuleId): { floor?: 'degraded'; cap?: 'degraded'; reason?: string } {
    const warn = this.warnings().find((w) => w.modules.includes(module));
    const over = this.verdict.overridden.find((w) => w.modules.includes(module));
    if (over) return { floor: 'degraded', cap: 'degraded', reason: `${over.rule}（CLOUDALBUM_ALLOW_UNSAFE）` };
    if (warn) return { floor: 'degraded', reason: warn.rule };
    return {};
  }

  private applyResult(module: ModuleId, r: ProbeResult, ctx: { fromProbe: boolean }): void {
    const s = this.states.get(module);
    if (!s) return;
    const at = this.now().toISOString();
    if (ctx.fromProbe) {
      s.lastProbeAt = at;
      s.history.unshift({ at, status: r.status, ...(r.latencyMs !== undefined ? { latencyMs: r.latencyMs } : {}), detail: r.detail });
      if (s.history.length > HISTORY_LIMIT) s.history.length = HISTORY_LIMIT;
    }
    if (r.latencyMs !== undefined) s.latencyMs = r.latencyMs;
    if (r.confidence) s.confidence = r.confidence;
    if (r.data) {
      s.data = r.data;
      const checks = (r.data as { checks?: unknown }).checks;
      if (Array.isArray(checks)) s.checks = checks as CapabilityCheck[];
    }

    const enabled = module === 'ec2' || this.isEnabled(module);
    const rules = this.ruleFloor(module);
    const detailWithRule = (d: string) => (rules.reason ? `${d}（${rules.reason}）` : d);

    if (!enabled) {
      // 本地实现：localHealth 直接取探针结果，warn 规则同样把它降为 degraded
      let next: HealthStatus = r.status;
      if (rules.floor && severityRank(next) < severityRank(rules.floor)) next = rules.floor;
      const prev = s.localHealth ?? 'ok';
      s.localHealth = next;
      s.detail = detailWithRule(r.detail);
      s.probed = s.probed || ctx.fromProbe;
      if (prev !== next) this.emit({ at, module, from: prev, to: next, field: 'localHealth', detail: s.detail });
      return;
    }

    const prev = s.status;
    let next: ModuleStatus;
    if (!ctx.fromProbe) {
      next = severityRank(r.status) > severityRank(prev) ? r.status : prev;
    } else if (r.status === 'error') {
      s.consecutiveFailures += 1;
      s.consecutiveHealthy = 0;
      // 首次探针：确定性的失败直接 error；瞬时失败（超时、限流、网络）先记 degraded，连续 3 次失败才进入 error
      if (s.consecutiveFailures >= 3 || prev === 'error') next = 'error';
      else if (!s.probed) next = r.transient ? 'degraded' : 'error';
      else next = prev;
    } else {
      s.consecutiveFailures = 0;
      s.consecutiveHealthy = r.status === 'ok' ? s.consecutiveHealthy + 1 : 0;
      if (!s.probed) next = r.status;
      else if (prev === 'error') {
        next = 'degraded';
        s.consecutiveHealthy = 0;          // 离开 error 之后，还要连续 2 次健康才回到 ok（滞回）
      }
      else if (prev === 'degraded') next = r.status === 'ok' && s.consecutiveHealthy >= 2 ? 'ok' : 'degraded';
      else next = r.status;
    }
    if (rules.floor && severityRank(next) < severityRank(rules.floor)) next = rules.floor;
    if (rules.cap && severityRank(next) > severityRank(rules.cap)) next = rules.cap;
    if (ctx.fromProbe) s.probed = true;
    s.status = next;
    s.detail = detailWithRule(r.detail);
    if (prev !== next) {
      s.since = at;
      this.emit({ at, module, from: prev, to: next, field: 'status', detail: s.detail });
    }
  }

  private emit(e: Omit<CapabilityTransitionEvent, 'instanceId'>): void {
    const event: CapabilityTransitionEvent = { ...e, instanceId: this.instance.id };
    for (const l of this.listeners) {
      try {
        l(event);
      } catch {
        /* ignore listener errors */
      }
    }
  }

  // ------------------------------------------------------------------------------------------
  // 查询
  // ------------------------------------------------------------------------------------------
  status(module: ModuleId): { status: ModuleStatus; localHealth?: HealthStatus; detail: string } {
    const s = this.states.get(module)!;
    return { status: s.status, ...(s.localHealth ? { localHealth: s.localHealth } : {}), detail: s.detail };
  }

  summary(): Record<string, string> {
    const out: Record<string, string> = {};
    for (const id of MODULE_IDS) {
      const s = this.states.get(id)!;
      out[id] = `${driverOf(this.opts.env, id, this.registry)}:${s.status === 'off' ? `off/${s.localHealth ?? 'ok'}` : s.status}`;
    }
    return out;
  }

  /**
   * /api/health/ready：所有权威端口不为 error（启用的看 status，未启用的看本地实现的 localHealth）。
   * scope=instance：只检查本实例条件（进程、配置、未处于 draining、本机数据目录可写）——ALB、ASG、Route 53 一律用它。
   */
  readiness(scope: 'all' | 'instance' = 'all'): { ok: boolean; failing: Array<{ module: ModuleId | 'instance'; detail: string }> } {
    const failing: Array<{ module: ModuleId | 'instance'; detail: string }> = [];
    if (this.draining) failing.push({ module: 'instance', detail: '实例正在 draining' });
    const dataDir = this.opts.cfg.core.CLOUDALBUM_DATA_DIR;
    if (existsSync(dataDir)) {
      try {
        accessSync(dataDir, fsConstants.W_OK);
      } catch {
        failing.push({ module: 'instance', detail: `数据目录不可写：${dataDir}` });
      }
    }
    if (scope === 'all') {
      for (const id of MODULE_IDS) {
        if (!this.registry[id].authoritative) continue;
        const s = this.states.get(id)!;
        const health = s.status === 'off' ? s.localHealth : s.status;
        if (health === 'error') failing.push({ module: id, detail: s.detail });
      }
    }
    return { ok: failing.length === 0, failing };
  }

  private features(): Record<string, FeatureState> {
    const env = this.opts.env;
    const cfg = this.opts.cfg;
    const storageDriver = cfg.storage.STORAGE_DRIVER;
    const storageModule = storageDriver === 'efs' ? 'shared-fs' : 'storage';
    const idp = driverOf(env, 'identity-pool', this.registry);
    const albAuth = this.isEnabled('load-balancer') && driverOf(env, 'auth', this.registry) === 'cognito' && cfg.infra.LB_HTTPS === 'true';
    return {
      'F6.upload': { enabled: true, via: [`${storageModule}:${storageDriver}`] },
      'F12.albAuth': albAuth
        ? { enabled: true, via: ['load-balancer:alb', 'auth:cognito'] }
        : { enabled: false, reason: '组合子功能：需要 load-balancer + auth(cognito) + HTTPS 监听器（DEP-011）' },
      'F14.directUpload': {
        enabled: true,
        via: [`identity-pool:${idp}`],
        detail: idp === 'none' ? '本地前缀令牌；启用 identity-pool 后改为 STS 临时凭证' : 'STS 临时凭证直传暂存桶',
      },
    };
  }

  private configHash(): string {
    const h = createHash('sha256');
    for (const k of Object.keys(this.opts.env).sort()) {
      if (isSecretLikeKey(k) || isAllowedInSecretsFile(k)) continue;   // 机密不参与（也不泄露到）配置哈希
      if (k.startsWith('ATL_')) continue;                              // 平台会话事实（platform.env）不是应用配置（06 PM-01）
      h.update(`${k}=${this.opts.env[k]}\n`);
    }
    return `sha256:${h.digest('hex').slice(0, 16)}`;
  }

  /** GET /api/capabilities 的响应体：view='public' 为精简视图；'admin' 带 data、probeHistory、checks 与修复命令 */
  snapshot(view: 'public' | 'admin' = 'public'): CapabilitiesResponse {
    const admin = view === 'admin';
    const cfg = this.opts.cfg;
    const env = this.opts.env;
    const modules = {} as Record<ModuleId, ModuleCapability>;
    for (const id of MODULE_IDS) {
      const reg = this.registry[id];
      const s = this.states.get(id)!;
      const sw = reg.switch;
      const requires = [...new Set((reg.requires ?? []).flatMap((r) => r.need.flatMap((n) => n.split('|').map((x) => x.trim())))
        .filter((x): x is ModuleId => isModuleId(x)))];
      const cap: ModuleCapability = {
        driver: driverOf(env, id, this.registry),
        awsService: reg.awsService,
        type: reg.type,
        status: s.status,
        ...(s.status === 'off' && id !== 'ec2' ? { localHealth: s.localHealth ?? 'ok' } : {}),
        detail: s.detail,
        ...(s.latencyMs !== undefined ? { latencyMs: s.latencyMs } : {}),
        ...(s.confidence ? { confidence: s.confidence } : {}),
        since: s.since,
        ...(s.lastProbeAt ? { lastProbeAt: s.lastProbeAt } : {}),
        ...(sw ? { switch: { var: sw.var, value: env[sw.var] ?? (isParamSwitch(sw) ? '' : localSwitchValue(id, this.registry)), localValue: localSwitchValue(id, this.registry) } } : {}),
        ...(id !== 'ec2' ? {
          deps: {
            requires,
            credentials: reg.credentials,
            satisfied: !this.verdict.errors.some((f) => f.modules.includes(id)),
          },
        } : {}),
        ...(reg.bypass?.length ? { bypass: [...reg.bypass] } : {}),
        ...(s.public ? { public: s.public } : {}),
        ...(admin && s.data ? { data: s.data } : {}),
        ...(admin ? { probeHistory: [...s.history] } : {}),
        ...(s.checks ? { checks: admin ? s.checks : s.checks.map((c) => ({ id: c.id, status: c.status, detail: c.detail })) } : {}),
      };
      modules[id] = cap;
    }
    if (!modules.cdn.public) modules.cdn.public = { baseUrl: cfg.core.CDN_BASE_URL };
    if (!modules['social-api'].public) modules['social-api'].public = { baseUrl: cfg.core.SOCIAL_API_BASE_URL };

    let runtime: RuntimeConfig;
    try {
      runtime = this.runtimeProvider();
    } catch {
      runtime = DEFAULT_RUNTIME_CONFIG;
    }
    const enabledCount = MODULE_IDS.filter((m) => m !== 'ec2' && this.isEnabled(m)).length;
    // ATL 平台模式（06 PM-03、PM-21）：app.platform、https.hostKind、ec2 也输出 localHealth；关闭时这些键都不出现
    const platform = platformInfo(admin);
    const entry = effectiveEntry(cfg);
    const https = this.httpsOverride ?? httpsState(cfg);
    if (platformMode()) {
      const ec2 = modules.ec2;
      if (ec2.localHealth === undefined) ec2.localHealth = ec2.status === 'off' ? 'ok' : (ec2.status as HealthStatus);
    }
    return {
      schemaVersion: CAPABILITIES_SCHEMA_VERSION,
      generatedAt: this.now().toISOString(),
      view,
      app: {
        version: this.version,
        profile: cfg.core.CLOUDALBUM_PROFILE || (enabledCount === 0 ? 'l0-ec2' : 'custom'),
        deployMode: cfg.core.DEPLOY_MODE,
        region: cfg.core.AWS_REGION,
        instance: { ...this.instance, role: this.opts.role },
        entry,
        configHash: this.configHash(),
        startedAt: this.startedAt,
        ...(platform ? { platform } : {}),
      },
      https: platformMode() ? { ...https, hostKind: hostKindOf(entry.baseUrl) } : https,
      validation: {
        errors: this.verdict.errors.map((f) => toValidation(f, admin)),
        warnings: this.warnings().map((f) => toValidation(f, admin)),
        overridden: this.verdict.overridden.map((f) => toValidation(f, admin)),
      },
      modules,
      features: this.features(),
      lab: { bypassEnabled: runtime.labBypassEnabled, bypassKeys: [...BYPASS_KEYS] },
    };
  }
}
