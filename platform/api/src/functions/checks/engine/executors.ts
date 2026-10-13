/**
 * Execution of one planned check (04 §5.2–§5.6): `when` / `dependsOn` preconditions, the six check types, `pendingIf`,
 * assertions, corroborations, waiting / ownership windows, expected outages, pitfalls, redaction and the sealed evidence
 * envelope. The engine never decides on client-reported headers: platform probes use control-plane targets.
 */
import { SkPrefix, type CheckSource } from '@atl/shared';
import { Keys } from '../../../data/keys.js';
import { effectiveResult } from '../../../services/progress/model.js';
import {
  SOURCE_OF_TYPE,
  type AssertionOutcome,
  type AwsReadonlyCheck,
  type CapabilityCheck,
  type CheckErrorCode,
  type CheckResultItem,
  type CheckResultValue,
  type CorroborationOutcome,
  type Corroboration,
  type EvidenceEnvelope,
  type ExperimentCheck,
  type HttpHeaderCheck,
  type LocalCheck,
  type OwnershipOutcome,
  type Provenance,
  type Trust,
} from '../types.js';
import { evaluateAll, evaluateAssertion, isPending, type AssertContext } from './assert.js';
import { freshNonce, ipInRanges, tlsSan } from './builtins.js';
import { EngineError, type RunContext } from './context.js';
import { evidenceObjectKey, evidenceSize, INLINE_EVIDENCE_LIMIT, checkHash, sealEvidence } from './evidence.js';
import { experimentVerdict, type ExperimentRunRecord } from './experiments.js';
import { CLEANUP_STEP, FINAL_STEP, type PlannedCheck } from './facts.js';
import { checkOwnership } from './ownership.js';
import { AwsCallError, ProbeError, type HttpProbeResponse } from './ports.js';
import { redactEvidence } from './redact.js';
import type { RunCheckOutcome } from './runcheck.js';
import { resolveTarget } from './targets.js';
import { renderDeep, renderString, UnresolvedVarError, type TemplateScope } from './template.js';

/** Default and maximum timeouts per type (04 §5.6). */
export const TIMEOUTS = {
  local: { def: 30_000, max: 90_000 },
  capability: { def: 30_000, max: 90_000 },
  'http-header-lab': { def: 30_000, max: 90_000 },
  'http-header-platform': { def: 10_000, max: 30_000 },
  'aws-readonly': { def: 10_000, max: 30_000 },
  experiment: { def: 2_000, max: 2_000 },
  manual: { def: 2_000, max: 2_000 },
} as const;

const CDN_ONLY_HEADERS = /^(x-cache|x-amz-cf-id|x-amz-cf-pop|via|age)$/i;

interface ExecOutcome {
  observed: unknown;
  error?: { code: CheckErrorCode; message: string };
  /** Result decided by the executor (experiment, expectError, …). */
  forced?: CheckResultValue;
  trust: Trust;
  ownership?: OwnershipOutcome;
  instances?: { instanceId: string; az?: string }[];
  assertCtx?: AssertContext;
  /** Per-instance evidence for `instances: all`. */
  perInstance?: { instanceId: string; observed: unknown }[];
  /** Assertion results computed by the executor (experiment checks). */
  outcomes?: AssertionOutcome[];
  pendingCrosscheck?: boolean;
  simulated?: boolean;
  provenance?: Provenance;
  /** tls-domain targets imply a tls-san corroboration (04 §5.2.3). */
  impliedSan?: string;
}

function errOutcome(code: CheckErrorCode, message: string, trust: Trust = 'medium', observed: unknown = null): ExecOutcome {
  return { observed, error: { code, message }, trust };
}

/** Pass evidence of other checks, for `{{$check.<id>.…}}`. */
function passEvidence(rc: RunContext, ids: string[] | undefined): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const id of ids ?? []) {
    if (rc.runPasses.has(id)) {
      out[id] = rc.runPasses.get(id);
      continue;
    }
    for (const st of rc.facts.steps.values()) {
      const c = st.checks?.[id];
      if (c?.passEvidence !== undefined) out[id] = c.passEvidence;
    }
  }
  return out;
}

function depResult(rc: RunContext, id: string): string {
  const inRun = rc.runResults.get(id);
  if (inRun) return inRun;
  for (const st of rc.facts.steps.values()) {
    const c = st.checks?.[id];
    if (c) return effectiveResult(c);
  }
  return 'not_run';
}

function shapeHttp(responses: HttpProbeResponse[] | { status: number; headers: Record<string, string>; json?: unknown; pathSegments?: Record<string, string>; timingMs?: number; peer?: unknown; tls?: unknown; reconnected?: boolean }[]): Record<string, unknown> {
  const norm = responses.map((r) => ({
    status: r.status,
    headers: r.headers,
    ...(r.json !== undefined ? { json: r.json } : {}),
    pathSegments: r.pathSegments ?? {},
    timing: { totalMs: (r as { timingMs?: number }).timingMs ?? null },
    ...((r as { peer?: unknown }).peer ? { peer: (r as { peer?: unknown }).peer } : {}),
    ...((r as { tls?: unknown }).tls ? { tls: (r as { tls?: unknown }).tls } : {}),
    ...((r as { reconnected?: boolean }).reconnected ? { reconnected: true } : {}),
  }));
  const first = norm[0] ?? { status: 0, headers: {}, pathSegments: {} };
  if (norm.length === 1) return first;
  return { ...first, first, last: norm[norm.length - 1], responses: norm, ...(norm.some((n) => (n as { reconnected?: boolean }).reconnected) ? { reconnected: true } : {}) };
}

function remaining(rc: RunContext, deadlineMs: number): number {
  return Math.max(1000, deadlineMs - rc.nowMs());
}

// ---------------------------------------------------------------------------------------------------------------
// per type

async function execLocal(c: LocalCheck, rc: RunContext, scope: TemplateScope, timeoutMs: number): Promise<ExecOutcome> {
  const role = c.on === 'workstation' ? 'workstation' : 'lab-app';
  const d = role === 'lab-app' ? (c.instances === 'all' ? await rc.discover('lab-app') : await rc.labInstance()) : await rc.discover('workstation');
  if (!d.ok) return errOutcome(d.code === 'ACCESS_DENIED' ? 'ACCESS_DENIED' : d.code, d.message);
  const args = await renderDeep(c.args ?? {}, scope);
  const instances = d.instances.slice(0, c.instances === 'all' ? 4 : 1);
  const per: { instanceId: string; observed: unknown; out: RunCheckOutcome }[] = [];
  for (const inst of instances) {
    const [o] = await rc.runCheck(inst.instanceId, [{ key: 'c1', checkId: c.checkId, args }], timeoutMs);
    per.push({ instanceId: inst.instanceId, observed: o!.observed, out: o! });
  }
  const failed = per.find((p) => p.out.status !== 'ok');
  const inst = instances.map((i) => ({ instanceId: i.instanceId, ...(i.az ? { az: i.az } : {}) }));
  if (failed) return { ...errOutcome(failed.out.errorCode ?? 'INTERNAL', failed.out.message ?? 'check failed on the instance', 'medium', failed.observed), instances: inst };
  if (c.instances === 'all') return { observed: { instances: per.map((p) => ({ instanceId: p.instanceId, observed: p.observed })) }, perInstance: per.map((p) => ({ instanceId: p.instanceId, observed: p.observed })), trust: 'medium', instances: inst };
  return { observed: per[0]!.observed, trust: 'medium', instances: inst };
}

async function execCapability(c: CapabilityCheck, rc: RunContext, expected: string[]): Promise<ExecOutcome> {
  const d = await rc.labInstance();
  if (!d.ok) return errOutcome(d.code === 'ACCESS_DENIED' ? 'ACCESS_DENIED' : d.code, d.message);
  const inst = d.instances[0]!;
  const snap = await rc.capabilitySnapshot(inst.instanceId, c.view ?? 'public');
  if (snap.status !== 'ok') return { ...errOutcome(snap.errorCode ?? 'INTERNAL', snap.message ?? 'capability snapshot failed'), instances: [{ instanceId: inst.instanceId }] };
  const caps = snap.observed as { app?: unknown; modules?: Record<string, unknown>; validation?: { errors?: { rule: string; modules?: string[] }[]; warnings?: { rule: string; modules?: string[] }[] } };
  const entry = c.module === 'app' ? caps.app : caps.modules?.[c.module];
  const validation = {
    errors: (caps.validation?.errors ?? []).filter((e) => (e.modules ?? []).includes(c.module)),
    warnings: (caps.validation?.warnings ?? []).filter((w) => (w.modules ?? []).includes(c.module)),
  };
  const expectedHit = new Set<string>();
  return {
    observed: entry === undefined ? null : entry,
    trust: 'medium',
    instances: [{ instanceId: inst.instanceId, ...(inst.az ? { az: inst.az } : {}) }],
    assertCtx: { healthy: { moduleId: c.module, validation, expected: new Set(expected) }, expectedHit },
  };
}

async function probeTokens(rc: RunContext, count: number): Promise<string[]> {
  const d = await rc.labInstance();
  if (!d.ok) throw new EngineError(d.code === 'ACCESS_DENIED' ? 'ACCESS_DENIED' : d.code, d.message);
  const [o] = await rc.runCheck(d.instances[0]!.instanceId, [{ key: 'tok', checkId: 'probe-token', args: { ttlSec: 60, count } }]);
  const tokens = (o?.observed as { tokens?: string[] } | null)?.tokens;
  if (o?.status !== 'ok' || !Array.isArray(tokens) || tokens.length < count) throw new EngineError(o?.errorCode ?? 'RUNNER_UNAVAILABLE', o?.message ?? 'probe-token returned no tokens');
  return tokens;
}

const HEADER_ALLOW: Record<string, RegExp> = {
  Accept: /^[A-Za-z0-9*/.+;=, -]{1,128}$/,
  'Accept-Encoding': /^[a-z0-9*,; =.-]{1,64}$/,
  'X-Compare-Bypass': /^[A-Za-z0-9_-]{1,32}$/,
  Authorization: /^Bearer probe$/,
  Cookie: /^ca_probe=1$/,
};

async function execHttp(c: HttpHeaderCheck, rc: RunContext, scope: TemplateScope, timeoutMs: number): Promise<ExecOutcome> {
  if (c.from === 'browser') return { observed: null, forced: 'skipped', trust: 'low', error: { code: 'PRECONDITION', message: 'browser-side checks are display only (04 §5.2.3)' } };
  const path = String(await renderString(c.path, scope));
  if (!path.startsWith('/')) return errOutcome('NOT_FOUND_VAR', 'path must start with /');
  const headers: Record<string, string> = {};
  for (const [k, v] of Object.entries(c.headers ?? {})) {
    const val = String(await renderString(String(v), scope));
    if (!HEADER_ALLOW[k]?.test(val)) return errOutcome('NOT_ALLOWED', `header ${k} is not allowed`);
    headers[k] = val;
  }
  const repeat = Math.max(1, Math.min(5, c.repeat ?? 1));
  const intervalMs = Math.min(5000, c.intervalMs ?? 500);
  const isProbe = path.startsWith('/api/lab/probe/');

  if (c.from === 'lab') {
    const d = await rc.labInstance();
    if (!d.ok) return errOutcome(d.code === 'ACCESS_DENIED' ? 'ACCESS_DENIED' : d.code, d.message);
    const inst = d.instances[0]!;
    const args: Record<string, unknown> = { target: c.target, path, method: c.method ?? 'GET', repeat, intervalMs, nonce: rc.nonce, ...(Object.keys(headers).length ? { headers } : {}), ...(c.stripQuery ? { stripQuery: true } : {}) };
    let ownership: OwnershipOutcome | undefined;
    if (c.target === 'self' && inst.publicDns) args.hostHeader = inst.publicDns;
    if (!['self', 'origin-private', 'cdn-origin'].includes(c.target)) {
      const t = await resolveTarget(c, rc);
      ownership = t.ownership;
      if (t.pending) return { observed: null, error: { code: 'OWNERSHIP_PENDING', message: 'waiting for the distribution ownership' }, trust: 'medium', ...(ownership ? { ownership } : {}) };
      args.host = t.host;
      args.scheme = t.scheme;
      if (t.port) args.port = t.port;
    }
    const [o] = await rc.runCheck(inst.instanceId, [{ key: 'c1', checkId: 'http-probe', args }], timeoutMs);
    if (o!.status !== 'ok') return { ...errOutcome(o!.errorCode ?? 'INTERNAL', o!.message ?? 'http-probe failed'), instances: [{ instanceId: inst.instanceId }] };
    const obs = o!.observed as { responses?: HttpProbeResponse[]; unsigned?: HttpProbeResponse };
    const shaped = shapeHttp(obs.responses ?? []);
    return { observed: { ...shaped, ...(obs.unsigned ? { unsigned: shapeHttp([obs.unsigned]) } : {}), target: c.target }, trust: 'medium', instances: [{ instanceId: inst.instanceId, ...(inst.az ? { az: inst.az } : {}) }], ...(ownership ? { ownership } : {}) };
  }

  // from: platform
  const t = await resolveTarget(c, rc);
  if (t.pending) return { observed: null, error: { code: 'OWNERSHIP_PENDING', message: 'waiting for the distribution ownership' }, trust: 'medium', ...(t.ownership ? { ownership: t.ownership } : {}) };
  const tokens = isProbe ? await probeTokens(rc, repeat + (c.stripQuery ? 1 : 0)) : [];
  const fetchOnce = async (p: string, n: number, offset: number) =>
    rc.ports.http.fetch({
      url: `${t.base}${p}`,
      method: c.method ?? 'GET',
      headers: { ...headers, 'X-ATL-Probe-Nonce': rc.nonce },
      repeat: n,
      intervalMs,
      timeoutMs,
      ...(t.port ? { extraPorts: [t.port] } : {}),
      ...(isProbe ? { perRequestHeaders: (i: number) => ({ 'X-ATL-Probe-Token': tokens[i + offset]! }) } : {}),
    });
  const responses = await fetchOnce(path, repeat, 0);
  const observed: Record<string, unknown> = { ...shapeHttp(responses), target: c.target, url: `${t.scheme}://${t.host}${path}`, dns: responses[0]?.dns };
  if (c.stripQuery && path.includes('?')) observed.unsigned = shapeHttp(await fetchOnce(path.slice(0, path.indexOf('?')), 1, repeat));
  return { observed, trust: t.trust === 'high' ? 'medium' : 'low', ...(t.ownership ? { ownership: t.ownership } : {}), ...(t.impliedSan ? { impliedSan: t.impliedSan } : {}) } as ExecOutcome;
}

/** Merge paginated pages: concatenate top-level arrays, keep the first page's scalars. */
function mergePages(pages: Record<string, unknown>[]): Record<string, unknown> {
  const out: Record<string, unknown> = { ...pages[0] };
  for (const p of pages.slice(1)) for (const [k, v] of Object.entries(p)) if (Array.isArray(v) && Array.isArray(out[k])) out[k] = [...(out[k] as unknown[]), ...v];
  for (const k of ['NextToken', 'nextToken', 'NextMarker', 'Marker', 'PaginationToken', 'NextContinuationToken']) delete out[k];
  return out;
}

async function execAws(c: AwsReadonlyCheck, rc: RunContext, scope: TemplateScope, p: PlannedCheck): Promise<ExecOutcome> {
  if (c.region === 'dr-region' && !rc.facts.platform?.drRegion) return { observed: null, forced: 'skipped', trust: 'medium', error: { code: 'PRECONDITION', message: 'no DR region configured' } };
  const params = await renderDeep(c.params ?? {}, scope);
  const pages: Record<string, unknown>[] = [];
  let token: Record<string, unknown> = {};
  const maxPages = Math.max(1, Math.min(5, c.paginate?.maxPages ?? 1));
  try {
    for (let i = 0; i < maxPages; i++) {
      const page = await rc.aws(c.service, c.action, { ...params, ...token }, c.region);
      pages.push(page);
      const next = (['NextToken', 'nextToken', 'PaginationToken', 'NextContinuationToken'] as const).find((k) => typeof page[k] === 'string');
      if (next) token = { [next === 'NextContinuationToken' ? 'ContinuationToken' : next]: page[next] };
      else if (typeof page.NextMarker === 'string') token = { Marker: page.NextMarker };
      else break;
    }
  } catch (e) {
    if (e instanceof EngineError) return errOutcome(e.code, e.message);
    if (e instanceof AwsCallError) {
      if (e.kind === 'NOT_FOUND' || (c.expectError && e.awsName === c.expectError)) {
        if (c.expectError && (e.awsName === c.expectError || e.awsName.includes(c.expectError))) return { observed: { error: e.awsName }, forced: 'pass', trust: 'medium' };
        return { observed: { error: e.awsName }, forced: 'fail', trust: 'medium' };
      }
      if (e.kind === 'ACCESS_DENIED') return errOutcome('ACCESS_DENIED', `${c.service}:${c.action} denied for ATLVerifierRole (content and labs:policy disagree)`);
      if (e.kind === 'THROTTLED') return errOutcome('THROTTLED', e.message);
      if (e.kind === 'NETWORK') return errOutcome('NETWORK', e.message);
      return { observed: { error: e.awsName }, forced: 'fail', trust: 'medium' };
    }
    throw e;
  }
  const observed = mergePages(pages);
  if (c.expectError) return { observed, forced: 'fail', trust: 'medium', error: { code: 'PRECONDITION', message: `expected ${c.expectError} but the call succeeded` } };
  if (!c.ownership) return { observed, trust: 'medium' };
  let rule;
  try {
    rule = await renderDeep(c.ownership, { ...scope, self: observed });
  } catch (e) {
    if (e instanceof UnresolvedVarError) return { observed, error: { code: 'NOT_FOUND_VAR', message: e.message }, trust: 'medium' };
    throw e;
  }
  const stepStart = p.stepId ? (rc.facts.steps.get(p.stepId)?.startedAt ?? null) : null;
  const own = await checkOwnership(rule as AwsReadonlyCheck['ownership'] & { resource: string }, {
    aws: { call: (req) => rc.aws(req.service, req.action, req.params, req.region === 'us-east-1' ? 'us-east-1' : 'app') },
    store: rc.store,
    invoke: (fn, payload) => rc.deps.ports.invoker.invoke(fn, payload),
    facts: rc.facts,
    region: rc.region,
    nowMs: rc.nowMs(),
    stepStartedAt: stepStart,
    lookups: rc.lookups,
  });
  const ownership: OwnershipOutcome = {
    basis: own.basis,
    pending: own.pending,
    ...(own.resource ? { resource: own.resource } : {}),
    ...(own.lookups ? { lookups: own.lookups } : {}),
    ...(own.detail ? { detail: own.detail } : {}),
    ...(own.retryAfterSeconds ? { retryAfterSeconds: own.retryAfterSeconds } : {}),
    ...(own.provenance ? { provenance: own.provenance } : {}),
  };
  if (own.pending) return { observed, ownership, error: { code: 'OWNERSHIP_PENDING', message: own.detail ?? 'ownership not confirmed yet' }, trust: 'medium' };
  if (!own.ok) return { observed, ownership, forced: 'fail', error: { code: 'OWNERSHIP_MISMATCH', message: own.detail ?? 'resource not created in this session' }, trust: 'medium' };
  return { observed, ownership, trust: 'medium', ...(own.provenance ? { provenance: own.provenance } : {}) };
}

async function execExperiment(c: ExperimentCheck, rc: RunContext): Promise<ExecOutcome> {
  const runs = await rc.store.query<ExperimentRunRecord>(Keys.labSession(rc.sid).PK, { skPrefix: SkPrefix.experiment });
  const exp = (rc.facts.card.lab.experiments ?? []).find((e) => e.module === c.module && e.id === c.experiment);
  if (!exp) return errOutcome('NOT_ALLOWED', `experiment ${c.module}/${c.experiment} is not declared by this card`);
  const v = experimentVerdict(exp, runs, { label: c.label, pair: c.pair, accept: c.accept ?? ['valid', 'simulated'] });
  return {
    observed: v.observed,
    forced: v.ok ? 'pass' : 'fail',
    trust: v.ok ? 'high' : 'medium',
    outcomes: v.reasons.map((r) => ({ label: r.label, path: '$', op: 'eq' as const, expected: r.expected, actual: r.actual, ok: r.ok, severity: 'error' as const })),
    pendingCrosscheck: v.pendingCrosscheck,
    simulated: v.simulated,
  };
}

// ---------------------------------------------------------------------------------------------------------------
// corroborations (04 §5.4)

async function corroborate(list: Corroboration[] | undefined, rc: RunContext, observed: unknown, scope: TemplateScope, impliedSan?: string): Promise<CorroborationOutcome[]> {
  const out: CorroborationOutcome[] = [];
  const all: Corroboration[] = [...(list ?? [])];
  if (impliedSan && !all.some((x) => x.via === 'builtin' && x.name === 'tls-san')) all.push({ id: 'tls-domain-san', via: 'builtin', name: 'tls-san', args: { expect: impliedSan, san: '{{$.tls.subjectAltNames}}' } });
  for (const k of all) {
    const required = k.required ?? true;
    const s: TemplateScope = { ...scope, self: observed };
    try {
      if (k.via === 'builtin') {
        const args = await renderDeep(k.args ?? {}, s);
        let r: { ok: boolean; observed: unknown };
        if (k.name === 'ip-in-aws-ranges') r = ipInRanges(args.addresses, String(args.service ?? 'CLOUDFRONT'), await rc.ports.ipRanges.ranges());
        else if (k.name === 'tls-san') r = tlsSan(args.san, String(args.expect));
        else r = freshNonce(String(args.nonce ?? rc.nonce), otherEvidence(rc));
        const assertions = (k.assert ?? []).map((a) => evaluateAssertion(a, r.observed));
        out.push({ id: k.id, via: k.via, ok: r.ok && assertions.every((a) => a.ok || a.severity === 'warn'), required, observed: r.observed, ...(assertions.length ? { assertions } : {}) });
        continue;
      }
      if (k.via === 'aws-readonly') {
        const params = await renderDeep(k.params, s);
        const resp = await rc.aws(k.service, k.action, params, k.region);
        const rendered = await renderDeep(k.assert, s);
        const r = evaluateAll(rendered, undefined, resp);
        out.push({ id: k.id, via: k.via, ok: r.ok, required, observed: redactEvidence(resp).value, assertions: r.outcomes });
        continue;
      }
      const d = k.on === 'workstation' ? await rc.discover('workstation') : await rc.labInstance();
      if (!d.ok) {
        out.push({ id: k.id, via: k.via, ok: false, required, errorCode: d.code === 'ACCESS_DENIED' ? 'ACCESS_DENIED' : d.code });
        continue;
      }
      const args = await renderDeep(k.args ?? {}, s);
      if (k.checkId === 'http-probe' && (args as { target?: string }).target === 'self' && d.instances[0]!.publicDns) (args as Record<string, unknown>).hostHeader = d.instances[0]!.publicDns;
      const [o] = await rc.runCheck(d.instances[0]!.instanceId, [{ key: k.id.slice(0, 40), checkId: k.checkId, args }]);
      if (o!.status !== 'ok') {
        out.push({ id: k.id, via: k.via, ok: false, required, errorCode: o!.errorCode ?? 'INTERNAL', observed: o!.message ?? null });
        continue;
      }
      const rendered = await renderDeep(k.assert, s);
      const r = evaluateAll(rendered, undefined, o!.observed);
      out.push({ id: k.id, via: k.via, ok: r.ok, required, observed: redactEvidence(o!.observed).value, assertions: r.outcomes });
    } catch (e) {
      const code: CheckErrorCode = e instanceof UnresolvedVarError ? 'NOT_FOUND_VAR' : e instanceof EngineError ? e.code : e instanceof AwsCallError ? (e.kind === 'ACCESS_DENIED' ? 'ACCESS_DENIED' : 'NETWORK') : 'INTERNAL';
      out.push({ id: k.id, via: k.via, ok: false, required, errorCode: code, observed: e instanceof Error ? e.message : String(e) });
    }
  }
  return out;
}

function otherEvidence(rc: RunContext): unknown[] {
  const out: unknown[] = [];
  for (const st of rc.facts.steps.values()) for (const c of Object.values(st.checks ?? {})) if (c.passEvidence !== undefined) out.push(c.passEvidence);
  return out;
}

function looksLikeSpoof(k: CorroborationOutcome): boolean {
  return !!k.assertions?.some((a) => !a.ok && a.op === 'absent' && CDN_ONLY_HEADERS.test(a.path.split('.').pop() ?? ''));
}

// ---------------------------------------------------------------------------------------------------------------

export interface ExecuteOptions {
  deadlineMs: number;
}

function timeoutFor(p: PlannedCheck): number {
  const d = p.decl;
  const kind = d.type === 'http-header' ? (d.from === 'platform' ? 'http-header-platform' : 'http-header-lab') : d.type;
  const t = TIMEOUTS[kind];
  return Math.min(t.max, d.timeoutMs ?? t.def);
}

/** Start of the step (first view or first check run); a step never checked before starts now (04 §5.2.4, §5.6). */
function stepStartMs(rc: RunContext, p: PlannedCheck): number {
  const st = p.stepId ? rc.facts.steps.get(p.stepId) : undefined;
  const at = st?.firstViewedAt ?? st?.startedAt;
  return at ? Date.parse(at) : rc.nowMs();
}

function outageActive(rc: RunContext, onWorkstation: boolean): boolean {
  const w = rc.facts.session.outageWindow;
  if (!w || Date.parse(w.until) <= rc.nowMs()) return false;
  return w.channel === 'both' || (onWorkstation ? w.channel === 'workstation' : w.channel === 'lab');
}

export async function executeCheck(p: PlannedCheck, rc: RunContext, opts: ExecuteOptions): Promise<CheckResultItem> {
  const startedAt = rc.nowIso();
  const d = p.decl;
  const source: CheckSource = SOURCE_OF_TYPE[d.type];
  const scope: TemplateScope = { resolve: rc.resolve, checks: passEvidence(rc, d.dependsOn) };
  let ex: ExecOutcome | undefined;
  let skippedReason: string | null = null;

  try {
    if (!(await rc.when(d.when))) skippedReason = 'when is false';
    else {
      for (const dep of d.dependsOn ?? []) {
        const r = depResult(rc, dep);
        if (r !== 'pass') {
          skippedReason = `depends on ${dep} (${r})`;
          break;
        }
      }
    }
  } catch (e) {
    skippedReason = null;
    ex = errOutcome(e instanceof UnresolvedVarError ? 'NOT_FOUND_VAR' : 'INTERNAL', e instanceof Error ? e.message : String(e));
  }

  if (skippedReason) {
    ex = { observed: null, forced: 'skipped', error: { code: 'PRECONDITION', message: skippedReason }, trust: 'medium' };
  } else {
    const budget = Math.min(timeoutFor(p) * 3, remaining(rc, opts.deadlineMs));
    try {
      ex ??= await Promise.race([
        (async (): Promise<ExecOutcome> => {
          switch (d.type) {
            case 'local':
              return execLocal(d, rc, scope, timeoutFor(p));
            case 'capability':
              return execCapability(d, rc, p.expectedWarnings);
            case 'http-header':
              return execHttp(d, rc, scope, timeoutFor(p));
            case 'aws-readonly':
              return execAws(d, rc, scope, p);
            case 'experiment':
              return execExperiment(d, rc);
            case 'manual':
              return { observed: null, forced: 'not_run', trust: 'low' };
          }
        })(),
        new Promise<ExecOutcome>((resolve) => setTimeout(() => resolve(errOutcome('TIMEOUT', `check exceeded ${budget} ms`)), budget).unref?.()),
      ]);
    } catch (e) {
      if (e instanceof UnresolvedVarError) ex = errOutcome('NOT_FOUND_VAR', e.message);
      else if (e instanceof EngineError) ex = { ...errOutcome(e.code, e.message), ...((e as { ownership?: OwnershipOutcome }).ownership ? { ownership: (e as { ownership?: OwnershipOutcome }).ownership } : {}) };
      else if (e instanceof ProbeError) ex = errOutcome(e.code, e.message);
      else if (e instanceof AwsCallError) ex = errOutcome(e.kind === 'ACCESS_DENIED' ? 'ACCESS_DENIED' : e.kind === 'THROTTLED' ? 'THROTTLED' : 'NETWORK', e.message);
      else ex = errOutcome('INTERNAL', e instanceof Error ? e.message : String(e));
    }
  }
  if (!ex) ex = errOutcome('INTERNAL', 'no outcome');

  // ---- verdict
  let result: CheckResultValue = 'error';
  let errorCode: CheckErrorCode | null = null;
  let message: string | undefined;
  let assertions: AssertionOutcome[] = ex.outcomes ?? [];
  let corroboration: CorroborationOutcome[] = [];
  let trust: Trust = ex.trust;
  const expectedHit = ex.assertCtx?.expectedHit ?? new Set<string>();

  if (ex.error && ex.forced === undefined) {
    errorCode = ex.error.code;
    message = ex.error.message;
    result =
      errorCode === 'OWNERSHIP_PENDING'
        ? 'pending'
        : errorCode === 'OWNERSHIP_MISMATCH' || errorCode === 'CORROBORATION_FAILED' || errorCode === 'SPOOF_SUSPECTED'
          ? 'fail'
          : errorCode === 'PRECONDITION'
            ? 'skipped'
            : 'error';
    if (errorCode === 'CHANNEL_DOWN' && outageActive(rc, (d.type === 'local' && d.on === 'workstation') || false)) {
      result = 'unavailable';
      errorCode = 'EXPECTED_OUTAGE';
    }
  } else if (ex.forced) {
    result = ex.forced;
    if (ex.error) {
      errorCode = ex.error.code;
      message = ex.error.message;
    }
  } else if ('assert' in d || ('anyOf' in d && d.anyOf)) {
    const evidenceScope: TemplateScope = { ...scope, self: ex.observed };
    if (d.type !== 'experiment' && d.type !== 'manual' && isPending(await renderDeep(d.pendingIf ?? [], evidenceScope), ex.observed, ex.assertCtx ?? {})) {
      result = 'pending';
    } else {
      const assertList = 'assert' in d && d.assert ? d.assert : [];
      let rendered = assertList;
      let anyOf = d.anyOf;
      try {
        rendered = await renderDeep(assertList, evidenceScope);
        anyOf = d.anyOf ? await renderDeep(d.anyOf, evidenceScope) : undefined;
      } catch (e) {
        if (!(e instanceof UnresolvedVarError)) throw e;
        result = 'error';
        errorCode = 'NOT_FOUND_VAR';
        message = e.message;
      }
      if (!errorCode) {
        let ok: boolean;
        if (ex.perInstance) {
          ok = true;
          assertions = [];
          for (const pi of ex.perInstance) {
            const r = evaluateAll(rendered, anyOf, pi.observed, ex.assertCtx ?? {});
            assertions.push(...r.outcomes.map((o) => ({ ...o, note: `${pi.instanceId}${o.note ? `: ${o.note}` : ''}` })));
            if (!r.ok) ok = false;
          }
        } else {
          const r = evaluateAll(rendered, anyOf, ex.observed, ex.assertCtx ?? {});
          ok = r.ok;
          assertions = r.outcomes;
        }
        result = ok ? 'pass' : 'fail';
        if (ok && (d.corroborate?.length || ex.impliedSan)) {
          corroboration = await corroborate(d.corroborate, rc, ex.observed, scope, ex.impliedSan);
          const bad = corroboration.filter((k) => k.required && !k.ok);
          if (bad.length) {
            result = 'fail';
            errorCode = bad.some(looksLikeSpoof) ? 'SPOOF_SUSPECTED' : 'CORROBORATION_FAILED';
            message = `corroboration failed: ${bad.map((k) => k.id).join(', ')}`;
          } else trust = 'high';
        }
      }
    }
  } else {
    result = 'pass';
  }

  // ---- waiting checks (04 §5.6) and ownership windows (§5.2.4)
  const since = stepStartMs(rc, p);
  const maxWait = d.wait?.maxMinutes;
  const transient = errorCode === 'TIMEOUT' || errorCode === 'NETWORK' || errorCode === 'THROTTLED';
  if (maxWait !== undefined && (result === 'pending' || (result === 'error' && transient) || (result === 'fail' && errorCode === null && d.pendingIf))) {
    if (rc.nowMs() - since < maxWait * 60_000) {
      if (result !== 'fail') result = 'pending';
    } else if (result === 'pending') {
      result = 'fail';
      errorCode = errorCode === 'OWNERSHIP_PENDING' ? 'OWNERSHIP_MISMATCH' : 'WAIT_TIMEOUT';
      message = `still pending after ${maxWait} minutes`;
    }
  }
  if (errorCode === 'OWNERSHIP_PENDING' && d.type === 'aws-readonly') {
    const ownWait = Math.min(45, d.ownership?.maxWaitMinutes ?? 20);
    if (rc.nowMs() - since > ownWait * 60_000) {
      result = 'fail';
      errorCode = 'OWNERSHIP_MISMATCH';
      message = 'no record that this resource was created in this session (if it was just created, check again later)';
    }
  }
  if (d.type === 'http-header' && d.from === 'browser') trust = 'low';

  // ---- pitfalls
  const pitfalls = matchPitfalls(p, rc, { result, errorCode, assertions, corroboration });

  // ---- evidence
  const redacted = redactEvidence(ex.observed, { ...(d.evidence?.redact ? { redact: d.evidence.redact } : {}), ...(d.evidence?.keep && d.type === 'aws-readonly' ? { keepOnly: d.evidence.keep } : {}) });
  const assertionsRedacted = redactEvidence(assertions).value;
  const finishedAt = rc.nowIso();
  const envelope = sealEvidence({
    schema: 'atl.evidence/v1',
    checkKey: p.checkKey,
    checkHash: rc.facts.card.checkHashes?.[p.localId] ?? checkHash(d),
    content: {
      labId: rc.facts.card.lab.id,
      labVersion: rc.facts.card.lab.version,
      contentDigest: rc.facts.card.contentDigest ?? rc.facts.attempt?.contentDigest ?? 'unknown',
      origin: p.origin === 'card' ? 'lab' : p.origin === 'lab' ? 'card' : p.origin,
      variant: rc.facts.session.variant ?? 'default',
    },
    sessionId: rc.sid,
    checkRunId: rc.opts.runId,
    executor: { kind: 'lambda', function: 'atl-checks', role: 'ATLVerifierRole', ...(rc.ssmCalls.length && (d.type === 'local' || d.type === 'capability' || (d.type === 'http-header' && d.from === 'lab')) ? { ssm: [...rc.ssmCalls].slice(-3) } : {}) },
    startedAt,
    finishedAt,
    result,
    errorCode,
    trust,
    observed: redacted.value,
    assertions: assertionsRedacted,
    corroboration,
    pitfalls,
    redactions: redacted.redactions,
    ...(ex.ownership ? { ownership: ex.ownership } : {}),
    ...(expectedHit.size ? { expectedWarningsHit: [...expectedHit].sort() } : {}),
    ...(ex.instances ? { instances: ex.instances } : {}),
    nonce: rc.nonce,
  } as Omit<EvidenceEnvelope, 'digest'>);
  let inline: EvidenceEnvelope | null = envelope;
  let evidenceKey: string | undefined;
  if (evidenceSize(envelope) > INLINE_EVIDENCE_LIMIT) {
    evidenceKey = evidenceObjectKey(rc.sid, rc.opts.runId, p.checkKey);
    await rc.deps.ports.objects.put(rc.deps.env.buckets.data, evidenceKey, JSON.stringify(envelope), { contentType: 'application/json' });
    inline = null;
  }
  const provenance: Provenance | undefined = ex.provenance ?? ex.ownership?.provenance ?? (result === 'pass' ? 'this-session' : undefined);
  rc.runResults.set(p.localId, result);
  if (result === 'pass') rc.runPasses.set(p.localId, redacted.value);
  return {
    checkKey: p.checkKey,
    checkId: p.localId,
    stepId: p.stepId === FINAL_STEP || p.stepId === CLEANUP_STEP ? p.stepId : p.stepId,
    source,
    type: d.type,
    result,
    required: p.required,
    trust,
    error: errorCode ? { code: errorCode, ...(message ? { message: message.slice(0, 300) } : {}) } : null,
    evidence: inline,
    ...(evidenceKey ? { evidenceKey } : {}),
    evidenceDigest: envelope.digest,
    corroboration,
    ...(ex.ownership ? { ownership: ex.ownership } : {}),
    ...(provenance ? { provenance } : {}),
    ...(expectedHit.size ? { expectedWarningsHit: [...expectedHit].sort() } : {}),
    executor: envelope.executor,
    at: finishedAt,
    ...(ex.instances ? { instanceIds: ex.instances.map((i) => i.instanceId) } : {}),
    keyAssertions: assertionsRedacted.filter((a) => a.label).slice(0, 12).map((a) => ({ label: a.label!, expected: a.expected, actual: a.actual, ok: a.ok })),
    drift: p.drift,
    ...(pitfalls.length ? { pitfalls } : {}),
    ...(ex.pendingCrosscheck ? { pendingCrosscheck: true } : {}),
    ...(ex.simulated ? { simulated: true } : {}),
  } as CheckResultItem;
}

function matchPitfalls(p: PlannedCheck, rc: RunContext, r: { result: CheckResultValue; errorCode: CheckErrorCode | null; assertions: AssertionOutcome[]; corroboration: CorroborationOutcome[] }): string[] {
  const out: string[] = [];
  for (const id of p.decl.pitfalls ?? []) {
    const pf = rc.facts.card.pitfalls?.[id];
    const conds = pf?.match ?? [];
    if (conds.length === 0) {
      // without a machine-readable match, list the pitfall on failures only for the codes it is obviously about
      if (id === 'not-mine' && r.errorCode === 'OWNERSHIP_MISMATCH') out.push(id);
      else if (id === 'spoofed-headers' && r.errorCode === 'SPOOF_SUSPECTED') out.push(id);
      else if (id === 'still-deploying' && r.result === 'pending') out.push(id);
      continue;
    }
    const ok = conds.every((m) => {
      if (m.checkId && m.checkId !== p.localId) return false;
      if (m.result && m.result !== r.result) return false;
      if (m.errorCode && m.errorCode !== r.errorCode) return false;
      if (m.assertionLabel && !r.assertions.some((a) => a.label === m.assertionLabel && !a.ok) && !r.corroboration.some((k) => k.assertions?.some((a) => a.label === m.assertionLabel && !a.ok))) return false;
      return true;
    });
    if (ok) out.push(id);
  }
  return out;
}
