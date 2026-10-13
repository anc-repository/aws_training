/**
 * Per-invocation run context of the check engine: the verifier's AWS calls (allowlist, 30 s response cache, retries of
 * transient errors), instance discovery, stack outputs, capability snapshots, ATL-RunCheck, and the namespace resolver
 * of 04 §4.4 (`session.*`, `target.*`, `workstation.*`, `stack.*`, `cap.*`, `envfile.*`, `var.*`, `sample.*`,
 * `learner.*`, `platform.*`) plus the expression references (`runtime.*`, `done.*`, `driver.*`).
 */
import { canonicalJson, StackNames } from '@atl/shared';
import type { FunctionDeps } from '../../../runtime/deps.js';
import type { ItemStore } from '../../../services/progress/store.js';
import { isAchieved } from '../../../services/progress/model.js';
import type { AwsRegionSel, CheckErrorCode } from '../types.js';
import { BASE_ALLOWLIST, DR_REGION_SERVICES, GLOBAL_SERVICES, isAllowed } from '../verifier/allowlist.js';
import { discoverInstances, pickOne, type DiscoveryResult } from './discovery.js';
import { evaluateWhen } from './expr.js';
import type { SessionFacts } from './facts.js';
import { query } from './jsonpath.js';
import { AwsCallError, type CheckEnginePorts } from './ports.js';
import { newRunToken, RunCheckClient, type RunCheckItem, type RunCheckOutcome } from './runcheck.js';
import { renderString } from './template.js';

export class EngineError extends Error {
  constructor(
    readonly code: CheckErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'EngineError';
  }
}

/** Default retry of transient errors (04 §5.6): 2 retries, 1 s / 3 s, ±20 % jitter. */
export async function withRetry<T>(fn: () => Promise<T>, sleep: (ms: number) => Promise<void>, opts: { max?: number; backoffMs?: number[]; transient: (e: unknown) => boolean }): Promise<T> {
  const max = opts.max ?? 2;
  const backoff = opts.backoffMs ?? [1000, 3000];
  for (let i = 0; ; i++) {
    try {
      return await fn();
    } catch (e) {
      if (i >= max || !opts.transient(e)) throw e;
      const base = backoff[Math.min(i, backoff.length - 1)] ?? 1000;
      await sleep(Math.round(base * (0.8 + Math.random() * 0.4)));
    }
  }
}

export function isTransientAws(e: unknown): boolean {
  return e instanceof AwsCallError && (e.kind === 'THROTTLED' || e.kind === 'NETWORK');
}

export interface RunContextOptions {
  runId: string;
  force: boolean;
  nowMs: number;
}

const AWS_CACHE_MS = 30_000;
const awsCache = new Map<string, { at: number; value: Record<string, unknown> }>();

export class RunContext {
  readonly region: string;
  readonly nonce: string;
  readonly lookups: Record<string, { first: string; count: number; nextAt: string }>;
  private discovery = new Map<string, Promise<DiscoveryResult>>();
  private stacks = new Map<string, Promise<Record<string, string> | null>>();
  private caps = new Map<string, Promise<RunCheckOutcome>>();
  private envKeys = new Map<string, Promise<RunCheckOutcome>>();
  private samples = new Map<string, Promise<unknown>>();
  readonly ssmCalls: { commandId: string; instanceId: string; documentVersion?: string }[] = [];
  /** Evidence of passes in this run (by local check id) for `{{$check.…}}` and dependsOn. */
  readonly runPasses = new Map<string, unknown>();
  readonly runResults = new Map<string, string>();

  constructor(
    readonly deps: FunctionDeps,
    readonly ports: CheckEnginePorts,
    readonly store: ItemStore,
    readonly facts: SessionFacts,
    readonly opts: RunContextOptions,
  ) {
    this.region = (facts.platform?.region as string | undefined) ?? deps.env.region;
    this.nonce = newRunToken().slice(0, 22);
    this.lookups = { ...(facts.attempt?.ownershipLookups ?? {}) };
  }

  get sid(): string {
    return this.facts.session.sid;
  }

  get envId(): string {
    return this.facts.session.envId ?? '';
  }

  get envName(): string | null {
    return this.facts.env?.envName ?? null;
  }

  nowMs(): number {
    return this.deps.ports.clock.nowMs();
  }

  nowIso(): string {
    return new Date(this.nowMs()).toISOString();
  }

  // ---------------------------------------------------------------------------------------------------------------
  // AWS (verifier role)

  regionOf(sel: AwsRegionSel | undefined, service: string): string | null {
    if (sel === 'global' || (sel === undefined && (GLOBAL_SERVICES as readonly string[]).includes(service))) return 'us-east-1';
    if (sel === 'us-east-1') return 'us-east-1';
    if (sel === 'dr-region') return (this.facts.platform?.drRegion as string | null | undefined) ?? null;
    return this.region;
  }

  /** Allowlisted, cached (30 s unless `force`), retried read-only call. */
  async aws(service: string, action: string, params: Record<string, unknown>, sel?: AwsRegionSel): Promise<Record<string, unknown>> {
    if (!isAllowed(service, action, BASE_ALLOWLIST)) throw new EngineError('NOT_ALLOWED', `${service}:${action} is not in the read-only allowlist`);
    if (sel === 'dr-region' && !(DR_REGION_SERVICES as readonly string[]).includes(service)) throw new EngineError('NOT_ALLOWED', `${service} is not allowed in the DR region`);
    const region = this.regionOf(sel, service);
    if (!region) throw new EngineError('PRECONDITION', 'no DR region configured');
    const key = `${this.sid}|${region}|${service}|${action}|${canonicalJson(params)}`;
    const hit = awsCache.get(key);
    if (!this.opts.force && hit && this.nowMs() - hit.at < AWS_CACHE_MS) return hit.value;
    const value = await withRetry(
      () => this.ports.aws.call({ service, action, params, region, session: { sid: this.sid, envId: this.envId } }),
      (ms) => this.deps.ports.clock.sleep(ms),
      { transient: isTransientAws },
    );
    awsCache.set(key, { at: this.nowMs(), value });
    return value;
  }

  // ---------------------------------------------------------------------------------------------------------------
  // instances, stacks, capabilities

  discover(role: 'lab-app' | 'workstation'): Promise<DiscoveryResult> {
    let p = this.discovery.get(role);
    if (!p) {
      p = (async () => {
        if (!this.envName) return { ok: false as const, code: 'TARGET_UNRESOLVED' as const, message: 'session has no environment', instances: [] };
        try {
          return await discoverInstances(
            { call: (req) => this.aws(req.service, req.action, req.params) },
            { role, sid: this.sid, envId: this.envId, envName: this.envName, region: this.region },
          );
        } catch (e) {
          if (e instanceof AwsCallError && e.kind === 'ACCESS_DENIED') return { ok: false as const, code: 'ACCESS_DENIED' as const, message: e.message, instances: [] };
          throw e;
        }
      })();
      this.discovery.set(role, p);
    }
    return p;
  }

  async labInstance(): Promise<DiscoveryResult> {
    return pickOne(await this.discover('lab-app'));
  }

  async stackOutputs(module: string): Promise<Record<string, string> | null> {
    let p = this.stacks.get(module);
    if (!p) {
      p = (async () => {
        if (!this.envName) return null;
        const name = module.startsWith('x-') ? StackNames.cardStack(this.envName, module.slice(2)) : StackNames.module(this.envName, module);
        try {
          const r = await this.aws('cloudformation', 'DescribeStacks', { StackName: name });
          const outs = (((r.Stacks as { Outputs?: { OutputKey?: string; OutputValue?: string }[] }[] | undefined) ?? [])[0]?.Outputs ?? []) as { OutputKey?: string; OutputValue?: string }[];
          // only Env* / Info* outputs are exposed as variables (04 §4.4)
          return Object.fromEntries(outs.filter((o) => o.OutputKey && /^(Env|Info)/.test(o.OutputKey)).map((o) => [o.OutputKey!, o.OutputValue ?? '']));
        } catch (e) {
          if (e instanceof AwsCallError && (e.kind === 'NOT_FOUND' || e.kind === 'INVALID')) return null;
          throw e;
        }
      })();
      this.stacks.set(module, p);
    }
    return p;
  }

  runCheckClient(timeoutMs?: number): RunCheckClient {
    return new RunCheckClient({
      runCommand: this.deps.ports.runCommand,
      clock: this.deps.ports.clock,
      sessionId: this.sid,
      bundleDigest: this.ports.config.bundleDigest,
      ...(this.ports.config.runCheckDocumentVersion ? { documentVersion: this.ports.config.runCheckDocumentVersion } : {}),
      ...(this.ports.config.runCheckDocumentHash ? { documentHash: this.ports.config.runCheckDocumentHash } : {}),
      ...(timeoutMs ? { timeoutMs } : {}),
    });
  }

  async runCheck(instanceId: string, items: RunCheckItem[], timeoutMs?: number): Promise<RunCheckOutcome[]> {
    const out = await this.runCheckClient(timeoutMs).run(instanceId, items);
    for (const o of out) {
      if (o.commandId && !this.ssmCalls.some((c) => c.commandId === o.commandId && c.instanceId === o.instanceId)) {
        this.ssmCalls.push({ commandId: o.commandId, instanceId: o.instanceId, ...(this.ports.config.runCheckDocumentVersion ? { documentVersion: this.ports.config.runCheckDocumentVersion } : {}) });
      }
    }
    return out;
  }

  /** One capability snapshot per view and instance per run (04 §5.2.2). */
  capabilitySnapshot(instanceId: string, view: 'public' | 'admin'): Promise<RunCheckOutcome> {
    const k = `${instanceId}|${view}`;
    let p = this.caps.get(k);
    if (!p) {
      p = this.runCheck(instanceId, [{ key: 'caps', checkId: 'capability-snapshot', args: { view } }]).then((r) => r[0]!);
      this.caps.set(k, p);
    }
    return p;
  }

  envKey(instanceId: string, module: string, key: string): Promise<RunCheckOutcome> {
    const k = `${instanceId}|${module}|${key}`;
    let p = this.envKeys.get(k);
    if (!p) {
      p = this.runCheck(instanceId, [{ key: 'env', checkId: 'env-key', args: { module, key } }]).then((r) => r[0]!);
      this.envKeys.set(k, p);
    }
    return p;
  }

  // ---------------------------------------------------------------------------------------------------------------
  // namespaces (04 §4.4)

  /** Resolve one reference; `undefined` = unresolved (→ NOT_FOUND_VAR unless a `default` filter applies). */
  resolve = async (ref: string): Promise<unknown> => {
    const [ns, ...rest] = ref.split('.');
    const path = rest.join('.');
    const s = this.facts.session;
    switch (ns) {
      case 'session': {
        const m: Record<string, unknown> = {
          id: s.sid,
          sid: s.sid,
          region: this.region,
          accountId: this.deps.env.accountId,
          env: this.envName,
          envId: s.envId,
          deadlineAt: s.deadlineAt,
          readyAt: s.readyAt,
          variant: s.variant ?? 'default',
          labId: s.labId,
        };
        return m[path] ?? undefined;
      }
      case 'target': {
        const d = await this.labInstance();
        if (!d.ok) return undefined;
        const i = d.instances[0]!;
        if (path === 'appBaseUrl') {
          const endpoints = this.facts.env?.endpoints as { baseUrl?: string | null } | null | undefined;
          return endpoints?.baseUrl ?? (i.publicDns ? `http://${i.publicDns}` : undefined);
        }
        const m: Record<string, unknown> = { instanceId: i.instanceId, publicIp: i.publicIp, publicDns: i.publicDns, privateIp: i.privateIp, az: i.az, sgId: i.sgId };
        return m[path] ?? undefined;
      }
      case 'workstation': {
        const d = pickOne(await this.discover('workstation'));
        if (!d.ok) return undefined;
        const i = d.instances[0]!;
        const m: Record<string, unknown> = { instanceId: i.instanceId, privateIp: i.privateIp, publicIp: i.publicIp };
        return m[path] ?? undefined;
      }
      case 'stack': {
        const [module, key] = rest;
        if (!module || !key || !/^(Env|Info)/.test(key)) return undefined;
        return (await this.stackOutputs(module))?.[key] ?? undefined;
      }
      case 'cap': {
        const d = await this.labInstance();
        if (!d.ok) return undefined;
        const snap = await this.capabilitySnapshot(d.instances[0]!.instanceId, 'public');
        if (snap.status !== 'ok') return undefined;
        const [module, ...p] = rest;
        const base = module === 'app' ? (snap.observed as { app?: unknown })?.app : (snap.observed as { modules?: Record<string, unknown> })?.modules?.[module!];
        return p.length ? query(base, `$.${p.join('.')}`) : base;
      }
      case 'envfile': {
        const [module, key] = rest;
        if (!module || !key) return undefined;
        const d = await this.labInstance();
        if (!d.ok) return undefined;
        const r = await this.envKey(d.instances[0]!.instanceId, module, key);
        const o = r.observed as { present?: boolean; secret?: boolean; value?: string } | null;
        if (r.status !== 'ok' || !o?.present) return undefined;
        return o.secret ? '‹secret: 在实验机上读取›' : o.value;
      }
      case 'var':
        return this.variable(path);
      case 'sample':
        return this.sample(path);
      case 'learner': {
        if (rest[0] === 'inputs') return ((s as Record<string, unknown>).learnerInputs as Record<string, unknown> | undefined)?.[rest[1] ?? ''] ?? '';
        return undefined;
      }
      case 'platform': {
        if (path === 'origin') return this.facts.platform?.platformUrl ?? undefined;
        if (path === 'drRegion') return this.facts.platform?.drRegion ?? '';
        return undefined;
      }
      // expression-only namespaces
      case 'done': {
        const st = this.facts.steps.get(path);
        return st ? isAchieved(st.state) : false;
      }
      case 'runtime':
        return (this.facts.env?.enabledModules ?? []).includes(path);
      case 'driver': {
        const d = await this.labInstance();
        if (!d.ok) return undefined;
        const snap = await this.capabilitySnapshot(d.instances[0]!.instanceId, 'public');
        return (snap.observed as { modules?: Record<string, { driver?: string }> } | null)?.modules?.[path]?.driver;
      }
      case 'preflight':
        return (((s as Record<string, unknown>).preflight as Record<string, unknown> | undefined) ?? {})[path];
      default:
        return undefined;
    }
  };

  private async variable(name: string): Promise<unknown> {
    const decl = this.facts.card.lab.variables?.[name];
    if (!decl) return undefined;
    const stored = this.facts.attempt?.variables?.[name];
    if (decl.fillFrom) {
      try {
        const v = await renderString(`{{ ${decl.fillFrom} }}`, { resolve: this.resolve });
        if (v !== undefined && v !== null && v !== '') return v;
      } catch {
        /* unresolved fillFrom → fall back to the learner's input */
      }
    }
    if (decl.from === 'input' && typeof stored === 'string') {
      try {
        if (!new RegExp(decl.pattern).test(stored)) return undefined;
      } catch {
        return undefined;
      }
      return stored;
    }
    return undefined;
  }

  private sample(name: string): Promise<unknown> {
    let p = this.samples.get(name);
    if (!p) {
      p = (async () => {
        if (name === 'nonce') return this.nonce;
        if (name === 'assetPath') return this.sampleAssetPath();
        if (name === 'privateMediaPath') return this.samplePrivateMediaPath();
        return undefined;
      })();
      this.samples.set(name, p);
    }
    return p;
  }

  /** First hashed asset referenced by the app's index.html (04 §11.3 `'/assets/{{ sample.assetPath }}'`). */
  private async sampleAssetPath(): Promise<string | undefined> {
    const d = await this.labInstance();
    if (!d.ok) return undefined;
    // the platform's own GET of `/` (index.html is never cached, hashed assets are) through the public entry
    const pub = d.instances[0]!.publicDns ?? d.instances[0]!.publicIp;
    if (!pub) return undefined;
    try {
      const [res] = await this.ports.http.fetch({ url: `http://${pub}/`, method: 'GET', headers: {}, repeat: 1, intervalMs: 0, timeoutMs: 8000, keepBody: true });
      const m = /\/assets\/([A-Za-z0-9._-]+\.(?:js|css|svg|png|woff2?))/.exec(res?.bodyText ?? '');
      return m?.[1];
    } catch {
      return undefined;
    }
  }

  /** `/api/lab/probe/media-url` returns a private media path (06 PM-11). */
  private async samplePrivateMediaPath(): Promise<string | undefined> {
    const d = await this.labInstance();
    if (!d.ok) return undefined;
    const r = await this.runCheck(d.instances[0]!.instanceId, [{ key: 'm', checkId: 'http-probe', args: { target: 'self', path: '/api/lab/probe/media-url', method: 'GET' } }]);
    const j = (r[0]?.observed as { responses?: { json?: { path?: string; url?: string } }[] } | null)?.responses?.[0]?.json;
    if (j?.path) return j.path;
    if (j?.url) {
      try {
        const u = new URL(j.url);
        return `${u.pathname}${u.search}`;
      } catch {
        return undefined;
      }
    }
    return undefined;
  }

  async when(expr: string | undefined): Promise<boolean> {
    if (!expr) return true;
    return evaluateWhen(expr, (ref) => this.resolve(ref));
  }
}
