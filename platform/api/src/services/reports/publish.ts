/**
 * Report generation, export and share links (04 §9.1, §9.4, §9.5), executed by atl-certs.
 *  - generate: a new revision when the content changed (finalize → v1; cleanup, late ownership, quiz, certificate → +1)
 *  - export: masked copy (account ID / public IP masked by default) in `atl-data/exports/`, pre-signed GET link
 *  - share: forced masking (account, IPs, middle of resource IDs, entry hosts, session names), notes hidden, written to
 *    `atl-web/share/<shareId>/` (index.html + report.json), expiry by a one-time schedule in `atl-system`
 */
import { bytesToBase64Url, DataKeys, ScheduleNames, WebKeys } from '@atl/shared';
import { Keys } from '../../data/keys.js';
import type { FunctionDeps } from '../../runtime/deps.js';
import { loadCard } from '../../functions/checks/engine/facts.js';
import { maskText } from '../../functions/checks/engine/redact.js';
import type { PendingEvent } from '../progress/events.js';
import { mutate, type ItemStore } from '../progress/store.js';
import { renderReportHtml } from './html.js';
import { loadReportInputs, storeReport, type Report } from './report.js';

export interface ReportsContext {
  deps: FunctionDeps;
  store: ItemStore;
  nowIso: string;
  invalidate: (paths: string[]) => Promise<void>;
}

export async function generateReport(c: ReportsContext, sid: string, reason: string): Promise<{ revision: number; digest: string; created: boolean; events: PendingEvent[] }> {
  const session = await c.store.get<{ catalogVersion: string; labId: string }>(Keys.labSession(sid));
  if (!session) throw new Error(`session ${sid} not found`);
  const card = await loadCard(c.deps, session.catalogVersion, session.labId);
  const inputs = await loadReportInputs(c.store, card, sid, c.deps.env.accountId);
  const stored = await storeReport(c.store, c.deps.ports.objects, c.deps.env.buckets.data, inputs, (r) => renderReportHtml(r), { nowIso: c.nowIso, reason });
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
  [/\b[a-z0-9]{6,20}\.cloudfront\.net\b/g, () => '‹分配域名›.cloudfront.net'],
  [/\b[\w.-]+\.elb\.amazonaws\.com\b/g, () => '‹负载均衡器›.elb.amazonaws.com'],
  [/\bec2-[\d-]+\.[\w.-]+\.amazonaws\.com\b/g, () => '‹实验机公网 DNS›'],
  [/\b[a-z0-9]{10}\.execute-api\.[\w.-]+\.amazonaws\.com\b/g, () => '‹API›.execute-api.amazonaws.com'],
  [/\batl-s[0-9a-z]{12}-[a-z-]+\b/g, () => 'atl-‹会话›'],
  [/\bs[0-9a-hjkmnp-tv-z]{12}\b/g, () => '‹会话›'],
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
  if (o.resourceIds) copy.sessionId = '‹会话›';
  return { ...copy, integrity: { canonicalization: 'RFC8785', digest: r.integrity.digest } };
}

export async function exportReport(c: ReportsContext, sid: string, opts: { format: 'json' | 'html'; mask?: MaskOptions; revision?: number }): Promise<{ url: string; key: string; expiresAt: string }> {
  const r = await loadStoredReport(c, sid, opts.revision);
  if (!r) throw new Error('no report has been generated for this session');
  const m: MaskOptions = { accountId: true, ip: true, includeHistory: true, ...(opts.mask ?? {}) };
  const masked = maskReport(r.report, m);
  const body = opts.format === 'json' ? JSON.stringify({ ...masked, exportNote: m.accountId === false ? undefined : 'masked copy; integrity.digest refers to the unmasked report' }, null, 2) : renderReportHtml(masked, { hideManualNotes: m.hideManualNotes === true, includeHistory: m.includeHistory !== false });
  const key = `${DataKeys.exports}${sid}/report-v${r.revision}-${Date.parse(c.nowIso)}.${opts.format}`;
  await c.deps.ports.objects.put(c.deps.env.buckets.data, key, body, { contentType: opts.format === 'json' ? 'application/json' : 'text/html; charset=utf-8' });
  const url = await c.deps.ports.objects.presign(c.deps.env.buckets.data, key, { method: 'GET', expiresInSeconds: 900 });
  return { url, key, expiresAt: new Date(Date.parse(c.nowIso) + 900_000).toISOString() };
}

const SHARE_ID_RE = /^[A-Za-z0-9_-]{22}$/;
export const SHARE_DAYS = [7, 30, 90] as const;

function shareMarkerKey(shareId: string): string {
  return `reports/_shares/${shareId}.json`;
}

export async function createShare(c: ReportsContext, sid: string, opts: { expiresInDays?: number | null; revision?: number }): Promise<{ shareId: string; url: string; expiresAt: string | null; events: PendingEvent[] }> {
  const r = await loadStoredReport(c, sid, opts.revision);
  if (!r) throw new Error('no report has been generated for this session');
  const days = opts.expiresInDays === null ? null : SHARE_DAYS.includes((opts.expiresInDays ?? 30) as (typeof SHARE_DAYS)[number]) ? (opts.expiresInDays ?? 30) : 30;
  const bytes = new Uint8Array(16);
  globalThis.crypto.getRandomValues(bytes);
  const shareId = bytesToBase64Url(bytes);
  const masked = maskReport(r.report, { accountId: true, ip: true, resourceIds: true, hideManualNotes: true, includeHistory: true });
  const web = c.deps.env.buckets.web;
  const prefix = WebKeys.share(shareId);
  await c.deps.ports.objects.put(web, `${prefix}index.html`, renderReportHtml(masked, { share: true, hideManualNotes: true }), { contentType: 'text/html; charset=utf-8' });
  await c.deps.ports.objects.put(web, `${prefix}report.json`, JSON.stringify({ ...masked, redactedCopy: true }, null, 2), { contentType: 'application/json' });
  await c.deps.ports.objects.put(c.deps.env.buckets.data, shareMarkerKey(shareId), JSON.stringify({ sessionId: sid, revision: r.revision }), { contentType: 'application/json' });
  const expiresAt = days === null ? null : new Date(Date.parse(c.nowIso) + days * 86_400_000).toISOString();
  await c.store.put(
    { ...Keys.reportShare(sid, shareId), type: 'ReportShare', shareId, sessionId: sid, revision: r.revision, expiresAt, revokedAt: null, objectKeys: [`${prefix}index.html`, `${prefix}report.json`], ver: 1, createdAt: c.nowIso, updatedAt: c.nowIso },
    { expectVer: null },
  );
  if (expiresAt) await c.deps.ports.scheduler.createOneTime({ name: ScheduleNames.shareExpire(shareId), group: 'atl-system', at: new Date(Math.ceil(Date.parse(expiresAt) / 60_000) * 60_000), payload: { kind: 'SHARE_EXPIRE', shareId } });
  const pc = await c.store.get<{ platformUrl?: string }>(Keys.platformConfig());
  return { shareId, url: `${pc?.platformUrl ?? ''}/share/${shareId}/index.html`, expiresAt, events: [] };
}

/** Revoke (learner) or expire (schedule) a share: delete the objects, invalidate `/share/<shareId>/*`, mark the item. */
export async function removeShare(c: ReportsContext, shareId: string, opts: { sessionId?: string; reason: 'revoked' | 'expired' }): Promise<{ removed: boolean }> {
  if (!SHARE_ID_RE.test(shareId)) return { removed: false };
  let sid = opts.sessionId;
  if (!sid) {
    const marker = await c.deps.ports.objects.get(c.deps.env.buckets.data, shareMarkerKey(shareId));
    sid = marker ? (JSON.parse(Buffer.from(marker).toString('utf8')) as { sessionId: string }).sessionId : undefined;
  }
  const web = c.deps.env.buckets.web;
  for (const k of await c.deps.ports.objects.list(web, WebKeys.share(shareId))) await c.deps.ports.objects.delete(web, k);
  await c.invalidate([`/share/${shareId}/*`]);
  if (sid) {
    await mutate<Record<string, unknown>>(c.store, Keys.reportShare(sid, shareId), (cur) => (cur && !cur.revokedAt ? { ...cur, revokedAt: c.nowIso, revokeReason: opts.reason } : null), { now: () => c.nowIso });
  }
  if (opts.reason === 'revoked') await c.deps.ports.scheduler.delete(ScheduleNames.shareExpire(shareId), 'atl-system').catch(() => undefined);
  return { removed: true };
}
