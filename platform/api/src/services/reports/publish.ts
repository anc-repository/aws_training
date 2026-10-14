/**
 * Report generation, export and share links (04 §9.1, §9.4, §9.5), executed by atl-certs.
 *  - generate: a new revision when the content changed (finalize → v1; cleanup, late ownership, quiz, certificate → +1)
 *  - export: masked copy (account ID / public IP masked by default) in `atl-data/exports/`, one object per revision, format
 *    and masking variant, recorded on the Report item (`exports.<format><Variant>`); atl-api only signs those keys
 *  - share: forced masking (account, IPs, middle of resource IDs, entry hosts, session names), notes hidden, written to
 *    `atl-web/share/<shareId>/` (index.html + report.json), expiry by a one-time schedule in `atl-system`. The shareId
 *    and the expiry come from atl-api (the link it returned); the steps are idempotent per shareId (schedule → record →
 *    objects), so Lambda's async retries never publish a second copy
 */
import { DataKeys, DEFAULT_SHARE_EXPIRY_DAYS, isShareId, newShareId, ScheduleNames, SHARE_EXPIRY_DAYS, WebKeys } from '@atl/shared';
import { Keys } from '../../data/keys.js';
import type { FunctionDeps } from '../../runtime/deps.js';
import { loadCard } from '../../functions/checks/engine/facts.js';
import { maskText } from '../../functions/checks/engine/redact.js';
import type { PendingEvent } from '../progress/events.js';
import { ConflictError, mutate, type ItemStore } from '../progress/store.js';
import { renderReportHtml, reportTextsFromLab, type ReportLang, type ReportTexts } from './html.js';
import { loadReportInputs, storeReport, type Report } from './report.js';

export interface ReportsContext {
  deps: FunctionDeps;
  store: ItemStore;
  nowIso: string;
  invalidate: (paths: string[]) => Promise<void>;
}

/**
 * Card texts in ja / en for the report HTML (09 §1.8): the localized expanded lab `content/<v>/<lang>/labs/<id>.json`
 * written by labs:build. A missing or unreadable file only means the recorded zh-CN texts are shown with the marker.
 */
export async function loadReportTexts(deps: FunctionDeps, catalogVersion: string, labId: string): Promise<Partial<Record<ReportLang, ReportTexts | null>>> {
  const out: Partial<Record<ReportLang, ReportTexts | null>> = {};
  for (const lang of ['ja', 'en'] as const) {
    try {
      const raw = await deps.ports.objects.get(deps.env.buckets.web, `${WebKeys.content(catalogVersion)}${lang}/labs/${labId}.json`);
      out[lang] = raw ? reportTextsFromLab(JSON.parse(Buffer.from(raw).toString('utf8'))) : null;
    } catch {
      out[lang] = null;
    }
  }
  return out;
}

export async function generateReport(c: ReportsContext, sid: string, reason: string): Promise<{ revision: number; digest: string; created: boolean; events: PendingEvent[] }> {
  const session = await c.store.get<{ catalogVersion: string; labId: string }>(Keys.labSession(sid));
  if (!session) throw new Error(`session ${sid} not found`);
  const card = await loadCard(c.deps, session.catalogVersion, session.labId);
  const inputs = await loadReportInputs(c.store, card, sid, c.deps.env.accountId);
  const texts = await loadReportTexts(c.deps, session.catalogVersion, session.labId);
  const stored = await storeReport(c.store, c.deps.ports.objects, c.deps.env.buckets.data, inputs, (r) => renderReportHtml(r, { texts }), { nowIso: c.nowIso, reason });
  const events: PendingEvent[] = stored.created ? [{ type: 'report.generated', sessionId: sid, data: { revision: stored.revision, digest: stored.digest, reason } }] : [];
  return { revision: stored.revision, digest: stored.digest, created: stored.created, events };
}

async function loadStoredReport(c: ReportsContext, sid: string, revision?: number): Promise<{ report: Report; revision: number } | null> {
  const items = await c.store.query<{ version?: number; s3Keys?: { json: string } }>(Keys.labSession(sid).PK, { skPrefix: 'REPORT#' });
  const pick = revision ? items.find((i) => i.version === revision) : items.sort((a, b) => (b.version ?? 0) - (a.version ?? 0))[0];
  if (!pick?.s3Keys) return null;
  const raw = await c.deps.ports.objects.get(c.deps.env.buckets.data, pick.s3Keys.json);
  if (!raw) return null;
  return { report: JSON.parse(Buffer.from(raw).toString('utf8')) as Report, revision: pick.version ?? 1 };
}

export interface MaskOptions {
  accountId?: boolean;
  ip?: boolean;
  /** Share copies: middle of resource IDs, entry hosts, session names and refs. */
  resourceIds?: boolean;
  hideManualNotes?: boolean;
  includeHistory?: boolean;
}

const RESOURCE_PATTERNS: [RegExp, (m: string) => string][] = [
  [/\b(i|sg|vol|subnet|vpc|eni|ami|nat|igw|rtb|snap|vpce|lt)-[0-9a-f]{8,17}\b/g, (m) => `${m.slice(0, m.indexOf('-') + 3)}…${m.slice(-2)}`],
  [/\bE[A-Z0-9]{8,20}\b/g, (m) => `${m.slice(0, 3)}…${m.slice(-2)}`],
  [/\b[a-z0-9]{6,20}\.cloudfront\.net\b/g, () => '‹distribution›.cloudfront.net'],
  [/\b[\w.-]+\.elb\.amazonaws\.com\b/g, () => '‹load-balancer›.elb.amazonaws.com'],
  [/\bec2-[\d-]+\.[\w.-]+\.amazonaws\.com\b/g, () => '‹lab-instance-public-dns›'],
  [/\b[a-z0-9]{10}\.execute-api\.[\w.-]+\.amazonaws\.com\b/g, () => '‹API›.execute-api.amazonaws.com'],
  [/\batl-s[0-9a-z]{12}-[a-z-]+\b/g, () => 'atl-‹session›'],
  [/\bs[0-9a-hjkmnp-tv-z]{12}\b/g, () => '‹session›'],
];

export function maskString(s: string, o: MaskOptions): string {
  let out = maskText(s, { accountId: o.accountId !== false, ip: o.ip !== false });
  if (o.resourceIds) for (const [re, fn] of RESOURCE_PATTERNS) out = out.replace(re, fn);
  return out;
}

export function maskReport(r: Report, o: MaskOptions): Report {
  const walk = (v: unknown, key?: string): unknown => {
    if (typeof v === 'string') return key === 'svg' ? v : maskString(v, o);
    if (Array.isArray(v)) return v.map((x) => walk(x));
    if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, walk(x, k)]));
    return v;
  };
  const copy = walk(r) as Report;
  if (o.hideManualNotes) for (const s of copy.steps) for (const c of s.checks) if (c.manual) c.manual = { ...c.manual, note: '' };
  if (o.includeHistory === false) copy.checkHistory = [];
  if (o.resourceIds) copy.sessionId = '‹session›';
  return { ...copy, integrity: { canonicalization: 'RFC8785', digest: r.integrity.digest } };
}

export type ExportFormat = 'json' | 'html';

/** Masking variant of an export: `Masked` (default: account ID and public IPs), `Unmasked`, or a mixed form. */
export function exportVariant(m: Pick<MaskOptions, 'accountId' | 'ip'>): string {
  const acct = m.accountId !== false;
  const ip = m.ip !== false;
  if (acct && ip) return 'Masked';
  if (!acct && !ip) return 'Unmasked';
  return `${acct ? 'Acct' : 'NoAcct'}${ip ? 'Ip' : 'NoIp'}Masked`;
}

/** Slot of an export on the Report item: `exports.<format><Variant>`, e.g. `jsonMasked`, `htmlUnmasked`. */
export function exportSlot(format: ExportFormat, m: Pick<MaskOptions, 'accountId' | 'ip'>): string {
  return `${format}${exportVariant(m)}`;
}

/** `ExportReport`'s `mask` as sent by atl-api (`on` / `off`) or as an object `{ accountId, ip }`. */
export function exportMask(v: unknown): Pick<MaskOptions, 'accountId' | 'ip'> {
  if (v === 'off' || v === false) return { accountId: false, ip: false };
  if (v && typeof v === 'object') {
    const o = v as { accountId?: unknown; ip?: unknown };
    return { accountId: o.accountId !== false, ip: o.ip !== false };
  }
  return { accountId: true, ip: true };
}

export async function exportReport(
  c: ReportsContext,
  sid: string,
  opts: { format: ExportFormat; mask?: MaskOptions; revision?: number },
): Promise<{ url: string; key: string; slot: string; revision: number; expiresAt: string }> {
  const r = await loadStoredReport(c, sid, opts.revision);
  if (!r) throw new Error('no report has been generated for this session');
  const m: MaskOptions = { accountId: true, ip: true, includeHistory: true, ...(opts.mask ?? {}) };
  const masked = maskReport(r.report, m);
  const texts = opts.format === 'json' ? {} : await loadReportTexts(c.deps, r.report.lab.catalogVersion, r.report.lab.id);
  const body = opts.format === 'json' ? JSON.stringify({ ...masked, exportNote: m.accountId === false ? undefined : 'masked copy; integrity.digest refers to the unmasked report' }, null, 2) : renderReportHtml(masked, { hideManualNotes: m.hideManualNotes === true, includeHistory: m.includeHistory !== false, texts });
  const slot = exportSlot(opts.format, m);
  // deterministic per revision / format / variant: a retry or a repeated request rewrites the same object
  const key = `${DataKeys.exports}${sid}/report-v${r.revision}-${slot}.${opts.format}`;
  await c.deps.ports.objects.put(c.deps.env.buckets.data, key, body, { contentType: opts.format === 'json' ? 'application/json' : 'text/html; charset=utf-8' });
  await mutate<Record<string, unknown>>(
    c.store,
    Keys.report(sid, r.revision),
    (cur) => {
      if (!cur) return null;
      const exports = (cur.exports ?? {}) as Record<string, string>;
      return exports[slot] === key ? null : { ...cur, exports: { ...exports, [slot]: key } };
    },
    { now: () => c.nowIso },
  );
  const url = await c.deps.ports.objects.presign(c.deps.env.buckets.data, key, { method: 'GET', expiresInSeconds: 900 });
  return { url, key, slot, revision: r.revision, expiresAt: new Date(Date.parse(c.nowIso) + 900_000).toISOString() };
}

export const SHARE_DAYS = SHARE_EXPIRY_DAYS;
/** Longest accepted lifetime of an `expiresAt` handed over by atl-api (90 days + one day of clock slack). */
const MAX_SHARE_MS = (Math.max(...SHARE_EXPIRY_DAYS) + 1) * 86_400_000;

export type ShareStatus = 'publishing' | 'active' | 'revoked' | 'expired';

export interface ReportShareItem {
  shareId: string;
  sessionId: string;
  revision: number;
  expiresAt: string | null;
  revokedAt: string | null;
  revokeReason?: 'revoked' | 'expired';
  status?: ShareStatus;
  publishedAt?: string | null;
  objectKeys: string[];
  [k: string]: unknown;
}

function shareMarkerKey(shareId: string): string {
  return `reports/_shares/${shareId}.json`;
}

function shareObjectKeys(shareId: string): string[] {
  const prefix = WebKeys.share(shareId);
  return [`${prefix}index.html`, `${prefix}report.json`];
}

/** Status of a share record as the API lists it (an overdue expiry counts as expired before the schedule fired). */
export function shareStatus(r: Pick<ReportShareItem, 'revokedAt' | 'revokeReason' | 'status' | 'expiresAt'>, nowIso: string): ShareStatus {
  if (r.revokedAt) return r.revokeReason === 'expired' ? 'expired' : 'revoked';
  if (r.expiresAt && r.expiresAt <= nowIso) return 'expired';
  return r.status === 'active' ? 'active' : 'publishing';
}

/** Expiry of a new share: the `expiresAt` atl-api returned to the learner, else `expiresInDays` (default 30). */
export function shareExpiry(nowIso: string, opts: { expiresAt?: string | null; expiresInDays?: number | null }): string | null {
  const now = Date.parse(nowIso);
  if (opts.expiresAt === null) return null;
  if (typeof opts.expiresAt === 'string') {
    const t = Date.parse(opts.expiresAt);
    if (!Number.isFinite(t) || t <= now || t - now > MAX_SHARE_MS) throw new Error(`invalid share expiresAt ${opts.expiresAt}`);
    return new Date(t).toISOString();
  }
  if (opts.expiresInDays === null) return null;
  const want = opts.expiresInDays ?? DEFAULT_SHARE_EXPIRY_DAYS;
  const days = (SHARE_EXPIRY_DAYS as readonly number[]).includes(want) ? want : DEFAULT_SHARE_EXPIRY_DAYS;
  return new Date(now + days * 86_400_000).toISOString();
}

export interface CreateShareOptions {
  /** chosen by atl-api (the id of the link it returned); generated here when absent */
  shareId?: string;
  expiresAt?: string | null;
  expiresInDays?: number | null;
  revision?: number;
}

/**
 * Create (or finish creating) a share link. Order: expiry schedule → marker and `ReportShare` → public objects → active.
 * Idempotent per shareId: a retry reuses the schedule (Conflict → not created again), the record and the object keys; a
 * share revoked or expired in the meantime is never published again.
 */
export async function createShare(
  c: ReportsContext,
  sid: string,
  opts: CreateShareOptions = {},
): Promise<{ shareId: string; url: string; expiresAt: string | null; revision: number | null; status: ShareStatus; created: boolean; events: PendingEvent[] }> {
  const shareId = opts.shareId ?? newShareId();
  if (!isShareId(shareId)) throw new Error(`invalid shareId ${shareId}`);
  const pc = await c.store.get<{ platformUrl?: string }>(Keys.platformConfig());
  const url = `${pc?.platformUrl ?? ''}/share/${shareId}/index.html`;
  const key = Keys.reportShare(sid, shareId);
  const existing = await c.store.get<ReportShareItem>(key);
  if (existing?.revokedAt) {
    return { shareId, url, expiresAt: existing.expiresAt, revision: existing.revision, status: shareStatus(existing, c.nowIso), created: false, events: [] };
  }
  const r = await loadStoredReport(c, sid, existing?.revision ?? opts.revision);
  if (!r) throw new Error('no report has been generated for this session');
  const expiresAt = existing ? existing.expiresAt : shareExpiry(c.nowIso, opts);
  const objectKeys = shareObjectKeys(shareId);
  // 1. the expiry schedule first: whatever fails later, the copy cannot outlive its expiry
  if (expiresAt) {
    await c.deps.ports.scheduler.createOneTime({
      name: ScheduleNames.shareExpire(shareId),
      group: 'atl-system',
      at: new Date(Math.ceil(Date.parse(expiresAt) / 60_000) * 60_000),
      payload: { kind: 'SHARE_EXPIRE', shareId },
    });
  }
  // 2. marker (shareId → session, read by ExpireShare) and the record
  await c.deps.ports.objects.put(c.deps.env.buckets.data, shareMarkerKey(shareId), JSON.stringify({ sessionId: sid, revision: r.revision, expiresAt }), { contentType: 'application/json' });
  if (!existing) {
    try {
      await c.store.put(
        { ...key, type: 'ReportShare', shareId, sessionId: sid, revision: r.revision, expiresAt, revokedAt: null, status: 'publishing', publishedAt: null, objectKeys, ver: 1, createdAt: c.nowIso, updatedAt: c.nowIso },
        { expectVer: null },
      );
    } catch (e) {
      if (!(e instanceof ConflictError)) throw e; // a concurrent attempt of the same request wrote it
    }
  }
  // 3. the redacted copy (fixed keys: a retry overwrites instead of adding a copy)
  const masked = maskReport(r.report, { accountId: true, ip: true, resourceIds: true, hideManualNotes: true, includeHistory: true });
  const web = c.deps.env.buckets.web;
  const texts = await loadReportTexts(c.deps, r.report.lab.catalogVersion, r.report.lab.id);
  await c.deps.ports.objects.put(web, objectKeys[0]!, renderReportHtml(masked, { share: true, hideManualNotes: true, texts }), { contentType: 'text/html; charset=utf-8' });
  await c.deps.ports.objects.put(web, objectKeys[1]!, JSON.stringify({ ...masked, redactedCopy: true }, null, 2), { contentType: 'application/json' });
  // 4. active — unless the learner revoked it while it was being written (then take the copy down again)
  const after = await mutate<ReportShareItem>(c.store, key, (cur) => (cur && !cur.revokedAt && cur.status !== 'active' ? { ...cur, status: 'active', publishedAt: c.nowIso } : null), { now: () => c.nowIso });
  if (!after || after.revokedAt) {
    for (const k of objectKeys) await c.deps.ports.objects.delete(web, k);
    await c.invalidate([`/share/${shareId}/*`]);
    return { shareId, url, expiresAt, revision: r.revision, status: after ? shareStatus(after, c.nowIso) : 'revoked', created: false, events: [] };
  }
  return { shareId, url, expiresAt, revision: r.revision, status: 'active', created: !existing, events: [] };
}

/** Revoke (learner) or expire (schedule) a share: delete the objects, invalidate `/share/<shareId>/*`, mark the item. */
export async function removeShare(c: ReportsContext, shareId: string, opts: { sessionId?: string; reason: 'revoked' | 'expired' }): Promise<{ removed: boolean }> {
  if (!isShareId(shareId)) return { removed: false };
  let sid = opts.sessionId;
  if (!sid) {
    const marker = await c.deps.ports.objects.get(c.deps.env.buckets.data, shareMarkerKey(shareId));
    sid = marker ? (JSON.parse(Buffer.from(marker).toString('utf8')) as { sessionId: string }).sessionId : undefined;
  }
  const rec = sid ? await c.store.get<ReportShareItem>(Keys.reportShare(sid, shareId)) : null;
  // the record names the object keys (no ListBucket on atl-web needed); the fixed keys cover a missing record
  const web = c.deps.env.buckets.web;
  for (const k of new Set([...(rec?.objectKeys ?? []), ...shareObjectKeys(shareId)])) await c.deps.ports.objects.delete(web, k);
  await c.invalidate([`/share/${shareId}/*`]);
  if (sid) {
    await mutate<Record<string, unknown>>(
      c.store,
      Keys.reportShare(sid, shareId),
      (cur) => (cur && !cur.revokedAt ? { ...cur, revokedAt: c.nowIso, revokeReason: opts.reason, status: opts.reason } : null),
      { now: () => c.nowIso },
    );
  }
  if (opts.reason === 'revoked') await c.deps.ports.scheduler.delete(ScheduleNames.shareExpire(shareId), 'atl-system').catch(() => undefined);
  return { removed: true };
}
