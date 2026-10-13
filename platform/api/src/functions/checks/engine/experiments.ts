/**
 * Comparative experiments (04 §3.2.10, §5.2.5, §7.4): label roles, validity, comparability of pairs, the completion
 * condition of a card experiment, and the server-side cross-check of one uploaded run (steps 3–9 of §7.4).
 */
import type { LabExperiment } from '@atl/shared';
import { deepEqual } from './assert.js';

export type LabelRole = 'baseline' | 'treatment' | 'single';

export interface LabelDecl {
  id: string;
  role: LabelRole;
  requires?: Record<string, string>;
}

export interface ExperimentRunRecord {
  runId: string;
  module: string;
  experiment: string;
  label: string;
  variant?: { label?: string; role?: LabelRole; cardVariant?: string; requires?: Record<string, string> };
  forced?: boolean;
  ab?: boolean;
  scenario?: string;
  params?: Record<string, unknown>;
  /** registration window (01 §7.3 `ExperimentRun.window`, written by atl-agent at registration) */
  window?: RunWindow;
  startedAt?: string;
  finishedAt?: string;
  environment?: { drivers?: Record<string, string>; instanceType?: string; arch?: string };
  validity?: { status: 'valid' | 'simulated' | 'invalid' | 'pending-crosscheck'; reasons?: string[] };
  /** Session the run belongs to (runs inherited from the same learner's chain, 04 §8.11 rule 4). */
  sessionId?: string;
  [k: string]: unknown;
}

/** `{ notBefore, notAfter }` as registered; `{ from, to }` is read for records of the first implementation. */
export interface RunWindow {
  notBefore?: string;
  notAfter?: string;
  from?: string;
  to?: string;
}

/** The registered window in ms, or null when the record has none (or it is unreadable). */
export function runWindowMs(w: RunWindow | null | undefined): { from: number; to: number } | null {
  if (!w) return null;
  const from = Date.parse(String(w.notBefore ?? w.from ?? ''));
  const to = Date.parse(String(w.notAfter ?? w.to ?? ''));
  return Number.isFinite(from) && Number.isFinite(to) ? { from, to } : null;
}

/** 04 §7.4 step 3: `startedAt` and `finishedAt` inside the registered window (unparseable times are outside). */
export function withinRunWindow(w: RunWindow | null | undefined, startedAt: unknown, finishedAt: unknown): boolean {
  const win = runWindowMs(w);
  if (!win) return true;
  const a = Date.parse(String(startedAt ?? ''));
  const b = Date.parse(String(finishedAt ?? ''));
  return Number.isFinite(a) && Number.isFinite(b) && a <= b && a >= win.from && b <= win.to;
}

const SHORTHAND: Record<string, LabelRole> = { before: 'baseline', after: 'treatment', run: 'single' };

export function labelsOf(exp: Pick<LabExperiment, 'labels'>): LabelDecl[] {
  return exp.labels.map((l) => (typeof l === 'string' ? { id: l, role: SHORTHAND[l] ?? 'single' } : { id: l.id, role: l.role, ...(l.requires ? { requires: l.requires } : {}) }));
}

export function pairsOf(exp: Pick<LabExperiment, 'labels' | 'pairs'>): [string, string][] {
  if (exp.pairs && exp.pairs.length) return exp.pairs;
  const labels = labelsOf(exp);
  const out: [string, string][] = [];
  for (const b of labels.filter((l) => l.role === 'baseline')) for (const t of labels.filter((l) => l.role === 'treatment')) out.push([b.id, t.id]);
  return out;
}

/** Usable run of a label: valid (or pending cross-check), or simulated for baseline labels when allowed. */
export function usableRuns(exp: LabExperiment, runs: ExperimentRunRecord[], label: string, accept: ('valid' | 'simulated')[] = ['valid', 'simulated']): ExperimentRunRecord[] {
  const decl = labelsOf(exp).find((l) => l.id === label);
  return runs
    .filter((r) => r.module === exp.module && r.experiment === exp.id && r.label === label)
    .filter((r) => {
      const st = r.validity?.status;
      if (st === 'valid' || st === 'pending-crosscheck') return accept.includes('valid');
      if (st === 'simulated') return decl?.role === 'baseline' && exp.allowSimulatedBaseline === true && accept.includes('simulated');
      return false;
    })
    .sort((a, b) => String(b.finishedAt ?? '').localeCompare(String(a.finishedAt ?? '')));
}

/** §7.4 step 8: same scenario, params, instance type (unless compareAcross), card variant; neither forced. */
export function comparable(a: ExperimentRunRecord, b: ExperimentRunRecord, across: string[] = []): { ok: boolean; reasons: string[] } {
  const reasons: string[] = [];
  if (a.forced || b.forced) reasons.push('forced run');
  if ((a.scenario ?? null) !== (b.scenario ?? null)) reasons.push('different scenario');
  if (!deepEqual(a.params ?? {}, b.params ?? {})) reasons.push('different parameters');
  if (!across.includes('instanceType') && (a.environment?.instanceType ?? null) !== (b.environment?.instanceType ?? null)) reasons.push('different instance type');
  if (!across.includes('arch') && (a.environment?.arch ?? null) !== (b.environment?.arch ?? null)) reasons.push('different architecture');
  if ((a.variant?.cardVariant ?? 'default') !== (b.variant?.cardVariant ?? 'default')) reasons.push('different start variant');
  return { ok: reasons.length === 0, reasons };
}

export interface ExperimentVerdict {
  ok: boolean;
  pendingCrosscheck: boolean;
  simulated: boolean;
  reasons: { label: string; expected: unknown; actual: unknown; ok: boolean }[];
  observed: Record<string, unknown>;
  validPairs: number;
}

/**
 * One experiment check (`label` or `pair`) — or, with neither, the card's completion condition for the experiment
 * (§3.2.10 `required`): every required label has a usable run and at least one declared pair is comparable.
 */
export function experimentVerdict(
  exp: LabExperiment,
  runs: ExperimentRunRecord[],
  q: { label?: string; pair?: [string, string] | 'any'; accept?: ('valid' | 'simulated')[] } = {},
): ExperimentVerdict {
  const accept = q.accept ?? ['valid', 'simulated'];
  const reasons: ExperimentVerdict['reasons'] = [];
  const labels = labelsOf(exp);
  const best = (label: string) => usableRuns(exp, runs, label, accept)[0];
  const status = (r: ExperimentRunRecord | undefined) => r?.validity?.status ?? 'none';
  const observed: Record<string, unknown> = {
    module: exp.module,
    experiment: exp.id,
    runs: runs
      .filter((r) => r.module === exp.module && r.experiment === exp.id)
      .slice(0, 20)
      .map((r) => ({ runId: r.runId, label: r.label, validity: r.validity?.status ?? 'unknown', reasons: r.validity?.reasons ?? [], finishedAt: r.finishedAt ?? null })),
  };
  let usedSimulated = false;
  let pending = false;
  const note = (r: ExperimentRunRecord | undefined) => {
    if (r?.validity?.status === 'simulated') usedSimulated = true;
    if (r?.validity?.status === 'pending-crosscheck') pending = true;
  };

  const checkPair = (a: string, b: string) => {
    const ra = best(a);
    const rb = best(b);
    note(ra);
    note(rb);
    const c = ra && rb ? comparable(ra, rb, exp.compareAcross ?? []) : { ok: false, reasons: ['missing run'] };
    return { ok: !!ra && !!rb && c.ok, reasons: c.reasons, a: ra?.runId ?? null, b: rb?.runId ?? null };
  };

  let validPairs = 0;
  for (const [a, b] of pairsOf(exp)) if (checkPair(a, b).ok) validPairs++;

  if (q.label) {
    const r = best(q.label);
    note(r);
    reasons.push({ label: `变体 ${q.label} 有有效结果`, expected: 'valid', actual: status(r), ok: !!r });
  } else if (q.pair) {
    if (q.pair === 'any') {
      reasons.push({ label: '至少一对可比', expected: '≥ 1', actual: validPairs, ok: validPairs > 0 });
    } else {
      const p = checkPair(q.pair[0], q.pair[1]);
      reasons.push({ label: `${q.pair[0]} / ${q.pair[1]} 可比`, expected: true, actual: p.ok ? true : p.reasons.join('; ') || false, ok: p.ok });
    }
  } else {
    const required = exp.requiredLabels ?? labels.map((l) => l.id);
    for (const l of required) {
      const r = best(l);
      note(r);
      reasons.push({ label: `变体 ${l} 有有效结果`, expected: 'valid', actual: status(r), ok: !!r });
    }
    const onlySingle = labels.every((l) => l.role === 'single');
    if (!onlySingle) reasons.push({ label: '至少一对可比', expected: '≥ 1', actual: validPairs, ok: validPairs > 0 });
  }
  const ok = reasons.every((r) => r.ok);
  return { ok, pendingCrosscheck: ok && pending, simulated: ok && usedSimulated, reasons, observed: { ...observed, validPairs }, validPairs };
}

// ---------------------------------------------------------------------------------------------------------------
// §7.4 server-side validation of one run

export interface LabMetrics {
  app?: { requests?: number; byTarget?: Record<string, number>; pathSignatures?: { signature: string; count: number }[] };
  origin?: { requests?: number; byPort?: Record<string, number>; viaCloudfront?: number };
  open?: boolean;
}

export interface ResultJson {
  startedAt?: string;
  finishedAt?: string;
  ab?: boolean;
  forced?: boolean;
  targets?: { kind: string; baseUrl?: string }[];
  client?: { requests?: number; byTarget?: Record<string, { requests?: number; misses?: number }>; cdnHitRatio?: number };
  [k: string]: unknown;
}

export interface ValidationInput {
  exp: LabExperiment;
  run: ExperimentRunRecord;
  result: ResultJson;
  /** Drivers observed by the platform's own capability snapshots (registration and upload). */
  driversAtRegistration?: Record<string, string> | null;
  driversAtUpload?: Record<string, string> | null;
  metrics?: LabMetrics | null;
  /** functional validity: check ids of `corroborateWith` that passed inside the window (+10 min). */
  functionalPasses?: string[];
  minSamples?: number;
}

export interface ValidationResult {
  status: 'valid' | 'simulated' | 'invalid' | 'pending-crosscheck';
  reasons: string[];
  server?: Record<string, unknown>;
}

function pathMatchesRequires(signature: string, requires: Record<string, string>): boolean {
  const seg: Record<string, string> = {};
  for (const part of signature.split(';')) {
    const i = part.indexOf('=');
    if (i > 0) seg[part.slice(0, i)] = part.slice(i + 1);
  }
  return Object.entries(requires).every(([module, driver]) => {
    if (module === 'cdn') {
      const entry = seg.entry ?? '';
      return driver === 'cloudfront' ? entry.startsWith('cloudfront') : !entry.startsWith('cloudfront');
    }
    const v = seg[module];
    return v === undefined ? true : v.split(/[@:]/)[0] === driver;
  });
}

export function validateRun(i: ValidationInput): ValidationResult {
  const reasons: string[] = [];
  const decl = labelsOf(i.exp).find((l) => l.id === i.run.label);
  if (!decl) return { status: 'invalid', reasons: ['LABEL_NOT_IN_LAB'] };
  const requires = decl.requires ?? i.run.variant?.requires ?? {};
  // 3 window (the registered `{ notBefore, notAfter }`; a result without times cannot be placed inside it)
  if (runWindowMs(i.run.window) && !withinRunWindow(i.run.window, i.result.startedAt, i.result.finishedAt)) return { status: 'invalid', reasons: ['OUT_OF_WINDOW'] };
  // 4 drivers (platform snapshots, not the client's)
  for (const drivers of [i.driversAtRegistration, i.driversAtUpload]) {
    if (!drivers) continue;
    for (const [m, want] of Object.entries(requires)) if (drivers[m] !== undefined && drivers[m] !== want) return { status: 'invalid', reasons: [`DRIVER_MISMATCH: ${m}=${drivers[m]} (expected ${want})`] };
  }
  const functional = i.exp.validity === 'functional';
  const server: Record<string, unknown> = {};
  if (functional) {
    const need = i.exp.corroborateWith ?? [];
    const missing = need.filter((c) => !(i.functionalPasses ?? []).includes(c));
    if (missing.length) return { status: 'invalid', reasons: [`NOT_CORROBORATED: ${missing.join(',')}`] };
  } else {
    if (!i.metrics) return { status: 'pending-crosscheck', reasons: ['server metrics not available yet'] };
    if (i.metrics.open) return { status: 'pending-crosscheck', reasons: ['run window still open'] };
    const ratio = i.exp.corroboration?.minServerRatio ?? 0.9;
    const app = i.metrics.app ?? {};
    const origin = i.metrics.origin ?? {};
    server.app = app;
    server.origin = origin;
    // 5 per-target corroboration
    for (const t of i.result.targets ?? []) {
      const c = i.result.client?.byTarget?.[t.kind];
      const clientCount = c?.requests ?? ((i.result.targets ?? []).length === 1 ? i.result.client?.requests : undefined);
      if (clientCount === undefined) continue;
      if (t.kind === 'cdn') {
        const misses = c?.misses ?? Math.round(clientCount * (1 - (i.result.client?.cdnHitRatio ?? 0)));
        const atOrigin = app.byTarget?.cdn ?? origin.viaCloudfront ?? 0;
        if (atOrigin < Math.floor(misses * ratio) || atOrigin > clientCount) reasons.push(`NOT_CORROBORATED: cdn origin saw ${atOrigin} (client misses ${misses}, total ${clientCount})`);
      } else {
        const seen = app.byTarget?.[t.kind] ?? (t.kind === 'direct' ? app.requests : undefined) ?? 0;
        if (seen < Math.floor(clientCount * ratio)) reasons.push(`NOT_CORROBORATED: ${t.kind} server saw ${seen} of ${clientCount}`);
      }
    }
    if (reasons.length) return { status: 'invalid', reasons, server };
    // 6 path ratio
    const sigs = app.pathSignatures ?? [];
    const total = sigs.reduce((a, s) => a + s.count, 0);
    if (total > 0 && Object.keys(requires).length) {
      const match = sigs.filter((s) => pathMatchesRequires(s.signature, requires)).reduce((a, s) => a + s.count, 0);
      server.pathRatio = Math.round((match / total) * 1000) / 1000;
      if (match / total < 0.95) return { status: 'invalid', reasons: [`PATH_RATIO: ${server.pathRatio}`], server };
    }
    // 7 samples (server side)
    const samples = app.requests ?? 0;
    if (samples < (i.minSamples ?? 5)) return { status: 'invalid', reasons: [`TOO_FEW_SAMPLES: ${samples}`], server };
  }
  // 9 simulated baseline
  if (i.result.ab === true && decl.role === 'baseline') {
    const bypass = (i.metrics?.app?.pathSignatures ?? []).some((s) => /(^|;)bypass=/.test(s.signature));
    if (bypass || functional) return { status: 'simulated', reasons: ['simulated baseline (bypass)'], server };
  }
  return { status: 'valid', reasons: [], server };
}
