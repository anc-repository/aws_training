/**
 * Attempt reports `atl.report/v1` (04 §9.2): one immutable snapshot per revision, built from the session partition
 * (LabSession, LabAttempt, StepResult, CheckRun, ExperimentRun, Report), the environment ledger (cleanup), the learner's
 * progress (badge) and quiz attempts. JSON is authoritative (RFC 8785 digest in `integrity`); the HTML rendering is in
 * `html.ts`. Values come only from records — no conclusions or prices are invented.
 */
import { canonicalJson, DataKeys, type EnvironmentItem, type LabSessionItem, type PlatformConfigItem } from '@atl/shared';
import { sha256Hex } from '@atl/shared/node';
import { Gsi1, Keys, SkPrefix } from '../../data/keys.js';
import { comparable, labelsOf, pairsOf, type ExperimentRunRecord } from '../../functions/checks/engine/experiments.js';
import type { CardBuild, CheckResultItem, CheckRunItem } from '../../functions/checks/types.js';
import { maskAccountId } from '../../functions/checks/engine/template.js';
import { refOf } from '../certificates/service.js';
import { mutate, type ItemStore } from '../progress/store.js';
import type { LabAttemptItem, LabProgressItem, StepResultItem } from '../progress/types.js';
import { barsSvg } from './charts.js';

export interface Report {
  schema: 'atl.report/v1';
  sessionId: string;
  revision: number;
  generatedAt: string;
  learner: { displayName: string; ref: string };
  lab: {
    id: string;
    kind: 'service' | 'scenario';
    version: string;
    title: string;
    catalogVersion: string;
    contentDigest: string;
    variant: string;
    startProfile: { name: string; planDigest: string; provisions: { item: string; kind: string; reason: string }[] };
  };
  session: {
    ref: string;
    region: string;
    accountIdMasked: string;
    readyAt: string;
    endedAt: string;
    endReason: string;
    submitted: boolean;
    extensionsUsed: number;
    keptHours?: number;
    environment: { envRef: string; reused: boolean; chain: string[] };
  };
  outcome: { attemptStatus: string; completedAt?: string; checks: { auto: number; manual: number; failed: number }; driftEvents: number; trustSummary: { high: number; medium: number; low: number } };
  timing: { totalMinutes: number; activeMinutes: number; steps: { stepId: string; title: string; firstViewedAt?: string; doneAt?: string; minutes?: number; state: string }[] };
  steps: {
    stepId: string;
    title: string;
    type: string;
    state: string;
    method?: string;
    checks: {
      checkKey: string;
      title: string;
      source: string;
      effective: string;
      trust?: string;
      provenance?: string;
      ownershipConfirmedLate?: boolean;
      lastPassedAt?: string;
      evidenceDigest?: string;
      keyAssertions: { label: string; expected: unknown; actual: unknown; ok: boolean }[];
      manual?: { observed: string; note: string; at: string };
    }[];
  }[];
  checkHistory: { at: string; checkKey: string; result: string; errorCode?: string; trigger: string }[];
  experiments: {
    module: string;
    experiment: string;
    variants: { label: string; role: 'baseline' | 'treatment' | 'single'; summary?: Record<string, unknown> }[];
    pairs: { a: string; b: string; comparable: boolean; across?: string[]; reasons: string[] }[];
    metrics: { id: string; label: string; unit: string; values: Record<string, number>; better: 'lower' | 'higher' | 'neutral'; source: 'server' | 'client' }[];
    charts: { kind: 'bars' | 'ladder'; svg: string }[];
  }[];
  cost: CostReport;
  quiz?: { bestScore: number; attempts: number; byDomain: Record<string, number>; wrong: { id: string; stem: string; relatesTo?: string }[] };
  badge?: { title: string; level: 'verified' | 'attested' | 'self-reported'; status: 'valid' | 'pending' | 'withdrawn'; evidenceScore: number };
  cleanup: { status: 'pending' | 'clean' | 'needs-review' | 'cleanup-failed' | 'kept'; reclaimed: number; pendingManual: { resourceType: string; id: string; severity: string; reason: string }[]; verify: { checkKey: string; result: string }[] };
  certificate?: { certId: string; verifyUrl: string };
  integrity: { canonicalization: 'RFC8785'; digest: string };
}

/**
 * Platform notes of the cost section, stored as keys and worded per language by the renderers (09 §1.8: reports keep
 * codes and ids, not platform sentences).
 */
export const COST_NOTE_KEYS = ['price-list-estimate', 'unpriced-hours-only'] as const;
export type CostNoteKey = (typeof COST_NOTE_KEYS)[number];

/** Why a report gives no badge (`Report.eligibility.reasons` in the report record); worded per language by the web UI. */
export const ELIGIBILITY_REASONS = ['ATTEMPT_INCOMPLETE'] as const;

export interface CostReport {
  /** The learner-confirmed quote (02 §3.2), as recorded. */
  quote: Record<string, unknown> | null;
  /** Billable resources and how long they existed in this session (prices come from atl-pricing; none invented). */
  resources: { resourceType: string; name: string; billing: string; hours: number }[];
  noteKeys?: CostNoteKey[];
  /** Reports generated before `noteKeys`: the notes as zh-CN sentences. */
  notes?: string[];
}

export function reportDigest(r: Omit<Report, 'integrity'> | Report): string {
  const { integrity: _i, ...rest } = r as Report;
  return `sha256:${sha256Hex(canonicalJson(rest))}`;
}

function minutesBetween(a?: string | null, b?: string | null): number {
  if (!a || !b) return 0;
  return Math.max(0, Math.round((Date.parse(b) - Date.parse(a)) / 60_000));
}

function sourceLabel(type: string): string {
  return type === 'capability' ? 'PROBE' : type === 'aws-readonly' ? 'AWS' : type === 'experiment' ? 'EXP' : type === 'manual' ? 'MANUAL' : 'LOCAL';
}

interface ReportInputs {
  session: LabSessionItem & Record<string, unknown>;
  env: (EnvironmentItem & Record<string, unknown>) | null;
  platform: (PlatformConfigItem & Record<string, unknown>) | null;
  card: CardBuild;
  attempt: LabAttemptItem | null;
  steps: StepResultItem[];
  runs: CheckRunItem[];
  experiments: ExperimentRunRecord[];
  progress: LabProgressItem | null;
  resources: Record<string, unknown>[];
  profile: { displayName?: string; certName?: string } | null;
  certificate?: { certId: string; verifyUrl: string } | null;
  quiz?: Report['quiz'];
  accountId: string;
}

const METRIC_DEFS: { id: string; label: string; unit: string; better: 'lower' | 'higher' | 'neutral'; pick: (r: ExperimentRunRecord) => number | undefined; source: 'server' | 'client' }[] = [
  { id: 'server.requests', label: '源站收到的请求数', unit: 'count', better: 'lower', source: 'server', pick: (r) => num((r.server as { app?: { requests?: number } } | undefined)?.app?.requests) },
  { id: 'server.origin', label: '经 Nginx 的源站请求', unit: 'count', better: 'lower', source: 'server', pick: (r) => num((r.server as { origin?: { requests?: number } } | undefined)?.origin?.requests) },
  { id: 'client.requests', label: '客户端请求数', unit: 'count', better: 'neutral', source: 'client', pick: (r) => num(((r.summary as { client?: { requests?: number } } | undefined)?.client)?.requests) },
  { id: 'client.errors', label: '客户端错误数', unit: 'count', better: 'lower', source: 'client', pick: (r) => num(((r.summary as { client?: { errors?: number } } | undefined)?.client)?.errors) },
  { id: 'client.cdnHitRatio', label: 'CDN 命中率', unit: 'ratio', better: 'higher', source: 'client', pick: (r) => num(((r.summary as { client?: { cdnHitRatio?: number } } | undefined)?.client)?.cdnHitRatio) },
];

function num(v: unknown): number | undefined {
  return typeof v === 'number' && Number.isFinite(v) ? v : undefined;
}

export function buildReport(i: ReportInputs, revision: number, generatedAt: string): Report {
  const lab = i.card.lab;
  const s = i.session;
  const salt = i.platform?.installationId ?? 'unknown';
  const stepMap = new Map(i.steps.map((x) => [x.stepId, x]));
  const titles = new Map<string, string>(Object.entries(i.card.checks).map(([id, d]) => [id, d.title]));
  const allResults: { r: CheckResultItem; run: CheckRunItem }[] = i.runs.flatMap((run) => (run.results ?? []).map((r) => ({ r, run })));
  const trust = { high: 0, medium: 0, low: 0 };
  const latestByKey = new Map<string, CheckResultItem>();
  for (const { r } of allResults.sort((a, b) => (a.r.at < b.r.at ? -1 : 1))) latestByKey.set(r.checkKey, r);
  for (const r of latestByKey.values()) if (r.result === 'pass') trust[r.trust] += 1;
  let auto = 0;
  let manual = 0;
  let failed = 0;
  let driftEvents = 0;
  const steps: Report['steps'] = lab.steps.map((st) => {
    const sr = stepMap.get(st.id);
    driftEvents += sr?.driftEvents?.length ?? 0;
    const checks = Object.entries(sr?.checks ?? {}).map(([id, c]) => {
      if (c.required) {
        if (c.effective === 'pass') auto++;
        else if (c.effective === 'manual' || c.effective === 'manual_evidence') manual++;
        else if (c.effective !== 'skipped') failed++;
      }
      const last = latestByKey.get(c.checkKey);
      return {
        checkKey: c.checkKey,
        title: titles.get(id) ?? id,
        source: sourceLabel(c.type ?? ''),
        effective: c.effective,
        ...(last?.trust ? { trust: last.trust } : {}),
        ...(c.lastPass?.provenance ? { provenance: c.lastPass.provenance } : {}),
        ...(i.attempt?.ownershipConfirmedLate && last?.ownership?.basis === 'lookup' ? { ownershipConfirmedLate: true } : {}),
        ...(c.lastPass?.at ? { lastPassedAt: c.lastPass.at } : {}),
        ...(c.lastPass?.evidenceDigest ? { evidenceDigest: c.lastPass.evidenceDigest } : {}),
        keyAssertions: (last?.keyAssertions ?? []).slice(0, 8),
        ...(c.lastManual ? { manual: { observed: c.lastManual.observed, note: c.lastManual.note, at: c.lastManual.at } } : {}),
      };
    });
    return { stepId: st.id, title: st.title, type: st.type, state: sr?.skipped ? 'skipped' : (sr?.state ?? 'available'), checks };
  });
  const checkHistory = allResults
    .filter(({ run }) => run.scope !== 'cleanup')
    .map(({ r, run }) => ({ at: r.at, checkKey: r.checkKey, result: r.result, ...(r.error?.code ? { errorCode: r.error.code } : {}), trigger: run.trigger }))
    .sort((a, b) => (a.at < b.at ? -1 : 1));
  const experiments: Report['experiments'] = (lab.experiments ?? []).map((e) => {
    const runs = i.experiments.filter((r) => r.module === e.module && r.experiment === e.id);
    const best = (label: string) =>
      runs
        .filter((r) => r.label === label && r.validity?.status !== 'invalid')
        .sort((a, b) => String(b.finishedAt ?? '').localeCompare(String(a.finishedAt ?? '')))[0];
    const variants = labelsOf(e).map((l) => {
      const r = best(l.id);
      return { label: l.id, role: l.role, ...(r ? { summary: { runId: r.runId, validity: r.validity?.status ?? 'unknown', finishedAt: r.finishedAt ?? null, reasons: r.validity?.reasons ?? [] } } : {}) };
    });
    const pairs = pairsOf(e).map(([a, b]) => {
      const ra = best(a);
      const rb = best(b);
      const c = ra && rb ? comparable(ra, rb, e.compareAcross ?? []) : { ok: false, reasons: ['missing run'] };
      return { a, b, comparable: c.ok, ...(e.compareAcross?.length ? { across: e.compareAcross } : {}), reasons: c.reasons };
    });
    const metrics = METRIC_DEFS.map((m) => {
      const values: Record<string, number> = {};
      for (const v of variants) {
        const r = best(v.label);
        const x = r ? m.pick(r) : undefined;
        if (x !== undefined) values[v.label] = x;
      }
      return { id: m.id, label: m.label, unit: m.unit, values, better: m.better, source: m.source };
    }).filter((m) => Object.keys(m.values).length > 0);
    // metric names are the zh-CN source here; the HTML renderer draws the chart again per language from `metrics` (by id)
    const charts = metrics.length ? [{ kind: 'bars' as const, svg: barsSvg(metrics.slice(0, 4), labelsOf(e).map((l) => l.id), '对比实验指标') }] : [];
    return { module: e.module, experiment: e.id, variants, pairs, metrics, charts };
  });
  const totalMinutes = minutesBetween(s.readyAt ?? s.createdAt, s.endedAt ?? generatedAt);
  const timingSteps = lab.steps.map((st) => {
    const sr = stepMap.get(st.id);
    const start = sr?.firstViewedAt ?? sr?.startedAt ?? undefined;
    const done = sr?.firstPassedAt ?? undefined;
    return { stepId: st.id, title: st.title, ...(start ? { firstViewedAt: start } : {}), ...(done ? { doneAt: done } : {}), ...(start && done ? { minutes: minutesBetween(start, done) } : {}), state: sr?.state ?? 'available' };
  });
  const activeMinutes = timingSteps.reduce((a, x) => a + (x.minutes ?? 0), 0);
  // cleanup (02 §6.7 conclusions; the reclaim report is authoritative)
  const pendingManual = i.resources
    .filter((r) => ['MANUAL_REQUIRED', 'REVIEW', 'FAILED'].includes(String(r.cleanupState)))
    .map((r) => ({ resourceType: String(r.resourceType ?? ''), id: String(r.name ?? r.arn ?? ''), severity: String(r.severity ?? 'INFO'), reason: String((r.lastError as string | undefined) ?? r.cleanupState) }));
  const reclaimed = i.resources.filter((r) => r.cleanupState === 'DELETED').length;
  const state = s.state;
  const cleanupStatus: Report['cleanup']['status'] =
    state === 'KEPT' ? 'kept' : state === 'CLEANUP_FAILED' || pendingManual.some((p) => p.severity === 'BLOCKING') ? 'cleanup-failed' : pendingManual.length ? 'needs-review' : state === 'ENDED' ? 'clean' : 'pending';
  const verify = i.runs.filter((r) => r.scope === 'cleanup').flatMap((r) => r.results.map((x) => ({ checkKey: x.checkKey, result: x.result })));
  const resources = i.resources
    .filter((r) => r.billing && r.billing !== 'none' && (r.sessionId === s.sid || !r.sessionId))
    .map((r) => ({
      resourceType: String(r.resourceType ?? ''),
      name: String(r.name ?? ''),
      billing: String(r.billing),
      hours: Math.round((minutesBetween(String(r.createdAt ?? s.createdAt), String(r.deletedAt ?? s.endedAt ?? generatedAt)) / 60) * 100) / 100,
    }));
  const badge = i.progress?.badge && i.progress.badge.attemptId === s.sid ? { title: lab.badge.title, level: i.progress.badge.level, status: i.progress.badge.status, evidenceScore: i.progress.badge.evidenceScore } : undefined;
  const body: Omit<Report, 'integrity'> = {
    schema: 'atl.report/v1',
    sessionId: s.sid,
    revision,
    generatedAt,
    // no display name: empty, each renderer shows its own word for “learner”
    learner: { displayName: i.profile?.displayName ?? '', ref: refOf(salt, s.sub) },
    lab: {
      id: lab.id,
      kind: lab.kind,
      version: lab.version,
      title: lab.title,
      catalogVersion: s.catalogVersion,
      contentDigest: i.card.contentDigest ?? i.attempt?.contentDigest ?? 'unknown',
      variant: s.variant ?? 'default',
      startProfile: {
        name: s.startProfileResolved?.name ?? s.startProfile ?? `atl/${lab.id}/default`,
        planDigest: s.startProfileResolved?.digest ?? s.startProfileDigest ?? '',
        provisions: lab.startProfile.provisions.map((p) => ({ item: p.item, kind: p.kind, reason: p.reason })),
      },
    },
    session: {
      ref: refOf(salt, s.sid),
      region: String(i.platform?.region ?? ''),
      accountIdMasked: maskAccountId(i.accountId),
      readyAt: s.readyAt ?? '',
      endedAt: s.endedAt ?? '',
      endReason: String(s.endReason ?? ''),
      submitted: !!i.attempt?.submittedAt,
      extensionsUsed: (s.extensions ?? []).length,
      ...(s.keep ? { keptHours: minutesBetween(s.keep.confirmedAt, s.keep.until) / 60 } : {}),
      environment: { envRef: refOf(salt, String(s.envId ?? '')), reused: !!s.reuseOfEnvId, chain: (i.env?.sessionChain ?? []).filter((x) => x !== s.sid).map((x) => refOf(salt, x)) },
    },
    outcome: {
      attemptStatus: i.attempt?.status ?? 'active',
      ...(i.attempt?.completedAt ? { completedAt: i.attempt.completedAt } : {}),
      checks: i.attempt?.checksSummary ?? { auto, manual, failed },
      driftEvents,
      trustSummary: trust,
    },
    timing: { totalMinutes, activeMinutes, steps: timingSteps },
    steps,
    checkHistory,
    experiments,
    cost: { quote: (s.costQuote as Record<string, unknown> | null | undefined) ?? null, resources, noteKeys: [...COST_NOTE_KEYS] },
    ...(i.quiz ? { quiz: i.quiz } : {}),
    ...(badge ? { badge } : {}),
    cleanup: { status: cleanupStatus, reclaimed, pendingManual, verify },
    ...(i.certificate ? { certificate: i.certificate } : {}),
  };
  return { ...body, integrity: { canonicalization: 'RFC8785', digest: reportDigest(body) } };
}

export async function loadReportInputs(store: ItemStore, card: CardBuild, sid: string, accountId: string): Promise<ReportInputs> {
  const pk = Keys.labSession(sid).PK;
  const all = await store.query<Record<string, unknown>>(pk);
  const session = all.find((x) => x.SK === 'META') as unknown as ReportInputs['session'];
  if (!session) throw new Error(`session ${sid} not found`);
  const steps = all.filter((x) => String(x.SK).startsWith(SkPrefix.step)) as unknown as StepResultItem[];
  const runs = all.filter((x) => String(x.SK).startsWith(SkPrefix.checkRun)) as unknown as CheckRunItem[];
  const experiments = all.filter((x) => String(x.SK).startsWith(SkPrefix.experiment)) as unknown as ExperimentRunRecord[];
  const attempt = (all.find((x) => x.SK === 'ATTEMPT') as unknown as LabAttemptItem | undefined) ?? null;
  const env = session.envId ? await store.get<EnvironmentItem & Record<string, unknown>>(Keys.environment(session.envId)) : null;
  const platform = await store.get<PlatformConfigItem & Record<string, unknown>>(Keys.platformConfig());
  const progress = await store.get<LabProgressItem>(Keys.labProgress(session.sub, session.labId));
  const profile = await store.get<{ displayName?: string }>(Keys.userProfile(session.sub));
  const resources = await store.query<Record<string, unknown>>(Gsi1.sessionResource(sid, 'x', '0'.repeat(32)).GSI1PK, { index: 'GSI1' }).catch(() => []);
  const quizItems = await store.query<{ score?: number; byDomain?: Record<string, number>; submittedAt?: string; wrong?: { id: string; stem: string; relatesTo?: string }[] }>(Keys.userProfile(session.sub).PK, { skPrefix: `QUIZ#${session.labId}#` }).catch(() => []);
  const graded = quizItems.filter((q) => typeof q.score === 'number');
  const bestQ = graded.sort((a, b) => (b.score ?? 0) - (a.score ?? 0))[0];
  const quiz = bestQ ? { bestScore: bestQ.score ?? 0, attempts: graded.length, byDomain: bestQ.byDomain ?? {}, wrong: (bestQ.wrong ?? []).slice(0, 10) } : undefined;
  const certs = await store.query<{ certId: string; sessionIds?: string[]; status?: string }>(Keys.userProfile(session.sub).PK, { index: 'GSI1', skPrefix: SkPrefix.gsi1Cert }).catch(() => []);
  const cert = certs.find((c) => c.status === 'valid' && (c.sessionIds ?? []).includes(sid));
  return {
    session,
    env,
    platform,
    card,
    attempt,
    steps,
    runs,
    experiments,
    progress,
    resources,
    profile,
    ...(quiz ? { quiz } : {}),
    certificate: cert ? { certId: cert.certId, verifyUrl: `${platform?.platformUrl ?? ''}/verify/${cert.certId}` } : null,
    accountId,
  };
}

export interface StoredReport {
  revision: number;
  digest: string;
  keys: { json: string; html: string };
  report: Report;
  created: boolean;
}

/** Store a new revision (`reports/<sid>/v<n>/report.json|html` + `Report` item). Identical content is not re-stored. */
export async function storeReport(
  store: ItemStore,
  objects: { put(bucket: string, key: string, body: string, opts?: { contentType?: string }): Promise<void> },
  bucket: string,
  inputs: ReportInputs,
  renderHtml: (r: Report) => string,
  opts: { nowIso: string; reason: string },
): Promise<StoredReport> {
  const sid = inputs.session.sid;
  const existing = await store.query<{ version?: number; digest?: string; s3Keys?: { json: string; html: string }; contentDigest?: string; reason?: string }>(Keys.labSession(sid).PK, { skPrefix: SkPrefix.report });
  const latest = existing.sort((a, b) => (b.version ?? 0) - (a.version ?? 0))[0];
  const revision = (latest?.version ?? 0) + 1;
  const report = buildReport(inputs, revision, opts.nowIso);
  // content digest ignoring revision / generatedAt: skip a new revision when nothing changed
  const { revision: _r, generatedAt: _g, integrity: _i, ...stable } = report;
  const contentDigest = `sha256:${sha256Hex(canonicalJson(stable))}`;
  if (latest && latest.contentDigest === contentDigest && latest.s3Keys) {
    return { revision: latest.version ?? 1, digest: latest.digest ?? '', keys: latest.s3Keys, report, created: false };
  }
  const prefix = `${DataKeys.report(sid)}v${revision}/`;
  const keys = { json: `${prefix}report.json`, html: `${prefix}report.html` };
  await objects.put(bucket, keys.json, JSON.stringify(report, null, 2), { contentType: 'application/json' });
  await objects.put(bucket, keys.html, renderHtml(report), { contentType: 'text/html; charset=utf-8' });
  const stepsTotal = report.steps.filter((x) => x.state !== 'skipped').length;
  const stepsDone = report.steps.filter((x) => ['done', 'done_manual', 'drifted'].includes(x.state)).length;
  await mutate<Record<string, unknown>>(
    store,
    Keys.report(sid, revision),
    (cur) =>
      cur
        ? null
        : {
            type: 'Report',
            sessionId: sid,
            version: revision,
            generatedAt: opts.nowIso,
            reason: opts.reason,
            status: 'ready',
            s3Keys: keys,
            digest: report.integrity.digest,
            contentDigest,
            summary: { stepsDone, stepsTotal, evidenceQuality: report.outcome.trustSummary, experiments: report.experiments.length, durationMinutes: report.timing.totalMinutes, attemptStatus: report.outcome.attemptStatus },
            eligibility: { badge: !!report.badge, reasons: report.badge ? [] : [...ELIGIBILITY_REASONS] },
            ...Gsi1.report(inputs.session.sub, opts.nowIso, sid),
          },
    { now: () => opts.nowIso },
  );
  return { revision, digest: report.integrity.digest, keys, report, created: true };
}
