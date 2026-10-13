/**
 * Experiment runs, reports, shares and certificates (01 §8.2 “对比实验”, “小测、报告、分享与证书”; 04 §7, §9, §10).
 * Reads come from `atl-main` and pre-signed links into `atl-data`; rendering, sharing and signing are asynchronous
 * requests to `atl-certs` (the only function with `kms:Sign`).
 */
import { AtlError, isCertId, newUlid } from '@atl/shared';
import { Keys, SkPrefix } from '../data/keys.js';
import { accepted, apiPath, created, ok } from '../http/responses.js';
import type { RouteHandlers } from '../http/router.js';
import { parseBody, z } from '../http/validate.js';
import { experimentRunsByUser, reportsByUser, stripKeys, type Item } from '../repositories/index.js';
import { trackProgress, type ProgressRecord } from '../services/catalog/progress.js';
import { dispatch, experimentRunView } from '../services/sessions/agent.js';
import { mapDownstreamError } from '../services/sessions/lifecycle-client.js';
import { auditOk, loadSession, principalOf, subjectSub, type ApiContext } from './context.js';
import type { ApiExtensions } from './extensions.js';
import { wrap } from './platform.js';

const ULID = /^[0-7][0-9A-HJKMNP-TV-Za-hjkmnp-tv-z]{25}$/;
const LINK_SECONDS = 900;

async function presignGet(ctx: ApiContext, key: string | undefined | null): Promise<{ url: string; expiresAt: string } | null> {
  if (!key) return null;
  const url = await ctx.deps.ports.objects.presign(ctx.deps.env.buckets.data, key, { method: 'GET', expiresInSeconds: LINK_SECONDS });
  return { url, expiresAt: new Date(ctx.nowMs + LINK_SECONDS * 1000).toISOString() };
}

/** All experiment runs of the subject across sessions (AP9 for one module; all modules share the `EXP#` prefix). */
async function subjectRuns(ctx: ApiContext, module?: string): Promise<Item[]> {
  const sub = await subjectSub(ctx);
  if (!sub) return [];
  if (module) return experimentRunsByUser(ctx.repos.table, sub, module);
  return ctx.repos.table.queryAll({ index: 'GSI1', pk: Keys.userProfile(sub).PK, sk: { beginsWith: SkPrefix.experiment }, descending: true }, 1000);
}

async function findRun(ctx: ApiContext, runId: string): Promise<Item> {
  if (!ULID.test(runId)) throw new AtlError('NOT_FOUND', 'experiment run not found');
  const run = (await subjectRuns(ctx)).find((r) => r.runId === runId);
  if (!run) throw new AtlError('NOT_FOUND', `experiment run ${runId} not found`);
  // GSI1 is ALL-projected but eventually consistent: re-read the item
  return (await ctx.repos.sessions.getChild({ PK: String(run.PK), SK: String(run.SK) })) ?? run;
}

async function readResult(ctx: ApiContext, run: Item): Promise<Record<string, unknown> | null> {
  if (typeof run.s3Key !== 'string') return null;
  const bytes = await ctx.deps.ports.objects.get(ctx.deps.env.buckets.data, run.s3Key);
  if (!bytes) return null;
  try {
    return JSON.parse(Buffer.from(bytes).toString('utf8')) as Record<string, unknown>;
  } catch {
    return null;
  }
}

/** Numeric leaves of an object as dotted paths (for the side-by-side comparison). */
function numericLeaves(o: unknown, prefix = '', out: Record<string, number> = {}): Record<string, number> {
  if (o && typeof o === 'object' && !Array.isArray(o)) {
    for (const [k, v] of Object.entries(o)) numericLeaves(v, prefix ? `${prefix}.${k}` : k, out);
  } else if (typeof o === 'number' && Number.isFinite(o)) out[prefix] = o;
  return out;
}

function reportView(r: Item): Record<string, unknown> {
  return stripKeys(r);
}

/** Synchronous call of atl-certs (certificate issue / revoke answer with the signed result, 01 §8.3). */
async function callCerts(ctx: ApiContext, payload: Record<string, unknown>): Promise<Record<string, unknown> | null> {
  try {
    return await ctx.deps.ports.invoker.invoke<Record<string, unknown> | null>('atl-certs', payload);
  } catch (e) {
    mapDownstreamError(e, `atl-certs ${String(payload.action)}`);
  }
}

async function loadCert(ctx: ApiContext): Promise<Item> {
  const certId = ctx.req.params.certId ?? '';
  if (!isCertId(certId)) throw new AtlError('NOT_FOUND', 'certificate not found');
  const cert = await ctx.repos.certificates.get(certId);
  const sub = await subjectSub(ctx);
  if (!cert || cert.sub !== sub) throw new AtlError('NOT_FOUND', `certificate ${certId} not found`);
  return cert;
}

export function reportRoutes(ext: ApiExtensions): RouteHandlers {
  return {
    // ---- experiment runs (04 §7)
    listSessionExperimentRuns: wrap(ext, async (ctx) => {
      const s = await loadSession(ctx, ctx.req.params.sid);
      const items = (await ctx.repos.sessions.children(s.sid, SkPrefix.experiment, { all: true })).items;
      return ok({ sessionId: s.sid, items: items.map(experimentRunView) });
    }),

    listExperimentRuns: wrap(ext, async (ctx) => {
      const { module, experiment } = ctx.req.query;
      let items = await subjectRuns(ctx, module || undefined);
      if (experiment) items = items.filter((r) => r.experiment === experiment);
      return ok({ items: items.map(experimentRunView) });
    }),

    getExperimentRun: wrap(ext, async (ctx) => {
      const run = await findRun(ctx, ctx.req.params.runId ?? '');
      return ok({ ...experimentRunView(run), download: await presignGet(ctx, run.s3Key as string | undefined) });
    }),

    compareExperimentRuns: wrap(ext, async (ctx) => {
      const { a, b } = ctx.req.query;
      if (!a || !b) throw new AtlError('VALIDATION_FAILED', 'query parameters a and b are required');
      const [ra, rb] = await Promise.all([findRun(ctx, a), findRun(ctx, b)]);
      const [xa, xb] = await Promise.all([readResult(ctx, ra), readResult(ctx, rb)]);
      const ma = numericLeaves({ client: xa?.client, server: (ra.server as unknown) ?? xa?.server });
      const mb = numericLeaves({ client: xb?.client, server: (rb.server as unknown) ?? xb?.server });
      const metrics = [...new Set([...Object.keys(ma), ...Object.keys(mb)])].sort().map((k) => ({
        metric: k,
        a: ma[k] ?? null,
        b: mb[k] ?? null,
        delta: ma[k] !== undefined && mb[k] !== undefined ? Number((mb[k]! - ma[k]!).toFixed(4)) : null,
      }));
      const va = (ra.variant ?? {}) as { cardVariant?: string };
      const vb = (rb.variant ?? {}) as { cardVariant?: string };
      const instA = ((xa?.environment as { instanceType?: string } | undefined) ?? {}).instanceType ?? null;
      const instB = ((xb?.environment as { instanceType?: string } | undefined) ?? {}).instanceType ?? null;
      const reasons: string[] = [];
      if (ra.module !== rb.module || ra.experiment !== rb.experiment) reasons.push('DIFFERENT_EXPERIMENT');
      if ((ra.scenario ?? null) !== (rb.scenario ?? null)) reasons.push('DIFFERENT_SCENARIO');
      if ((va.cardVariant ?? null) !== (vb.cardVariant ?? null)) reasons.push('DIFFERENT_CARD_VARIANT');
      if (instA !== instB) reasons.push('DIFFERENT_INSTANCE_TYPE');
      if (ra.forced === true || rb.forced === true) reasons.push('FORCED');
      return ok({ a: experimentRunView(ra), b: experimentRunView(rb), comparable: reasons.length === 0, reasons, metrics });
    }),

    // ---- reports (04 §9)
    generateReport: wrap(ext, async (ctx) => {
      const s = await loadSession(ctx, ctx.req.params.sid);
      if (s.state === 'REQUESTED' || s.state === 'PROVISIONING') throw new AtlError('INVALID_STATE', 'there is nothing to report before the environment is ready');
      await dispatch(ctx, 'atl-certs', { action: 'GenerateReport', sessionId: s.sid, requestedBy: principalOf(ctx).sub });
      return accepted({ sessionId: s.sid, status: 'queued' }, apiPath('/sessions', s.sid, '/report'));
    }),

    getReport: wrap(ext, async (ctx) => {
      const s = await loadSession(ctx, ctx.req.params.sid);
      const all = (await ctx.repos.sessions.children(s.sid, SkPrefix.report, { all: true })).items.sort((x, y) => Number(y.version ?? 0) - Number(x.version ?? 0));
      const latest = all[0];
      if (!latest) throw new AtlError('NOT_FOUND', `session ${s.sid} has no report yet`);
      const keys = (latest.s3Keys ?? {}) as { json?: string; html?: string };
      return ok({
        ...reportView(latest),
        downloads: { json: await presignGet(ctx, keys.json), html: await presignGet(ctx, keys.html) },
        revisions: all.map((r) => ({ version: r.version ?? null, generatedAt: r.generatedAt ?? null, status: r.status ?? null, digest: r.digest ?? null })),
      });
    }),

    exportReport: wrap(ext, async (ctx) => {
      const s = await loadSession(ctx, ctx.req.params.sid);
      const format = ctx.req.query.format ?? 'html';
      if (format !== 'json' && format !== 'html') throw new AtlError('VALIDATION_FAILED', 'format must be json or html');
      const mask = ctx.req.query.mask ?? 'on';
      const latest = await ctx.repos.sessions.latestReport(s.sid);
      if (!latest) throw new AtlError('NOT_FOUND', `session ${s.sid} has no report yet`);
      const keys = (latest.s3Keys ?? {}) as Record<string, string | undefined>;
      const key = mask === 'off' ? keys[`${format}Unmasked`] : keys[format];
      await auditOk(ctx, 'report.export', { sessionId: s.sid, details: { format, mask, version: latest.version ?? null } });
      if (!key) {
        await dispatch(ctx, 'atl-certs', { action: 'ExportReport', sessionId: s.sid, version: latest.version ?? null, format, mask, requestedBy: principalOf(ctx).sub });
        return accepted({ sessionId: s.sid, status: 'rendering', retryAfterSeconds: 10 });
      }
      return ok({ sessionId: s.sid, format, mask, version: latest.version ?? null, download: await presignGet(ctx, key) });
    }),

    createReportShare: wrap(ext, async (ctx) => {
      const s = await loadSession(ctx, ctx.req.params.sid);
      const body = parseBody(z.object({ expiresInHours: z.number().int().min(1).max(24 * 30).default(72), mask: z.enum(['on', 'off']).default('on') }).strict(), ctx.req.body);
      if (!(await ctx.repos.sessions.latestReport(s.sid))) throw new AtlError('INVALID_STATE', 'generate the report before sharing it');
      const shareId = newUlid(ctx.nowMs).toLowerCase();
      const expiresAt = new Date(ctx.nowMs + body.expiresInHours * 3_600_000).toISOString();
      await dispatch(ctx, 'atl-certs', { action: 'CreateShare', sessionId: s.sid, shareId, expiresAt, mask: body.mask, requestedBy: principalOf(ctx).sub });
      await auditOk(ctx, 'report.share', { sessionId: s.sid, target: shareId, details: { expiresAt } });
      return accepted({ shareId, status: 'creating', expiresAt, url: `/share/${shareId}/` }, apiPath('/sessions', s.sid, '/report/shares'));
    }),

    listReportShares: wrap(ext, async (ctx) => {
      const s = await loadSession(ctx, ctx.req.params.sid);
      const items = (await ctx.repos.sessions.children(s.sid, SkPrefix.share, { all: true })).items;
      return ok({ sessionId: s.sid, items: items.map((i) => ({ ...stripKeys(i), url: `/share/${String(i.shareId)}/` })) });
    }),

    deleteReportShare: wrap(ext, async (ctx) => {
      const s = await loadSession(ctx, ctx.req.params.sid);
      const shareId = ctx.req.params.shareId ?? '';
      const share = /^[0-9a-z]{26}$/.test(shareId) ? await ctx.repos.sessions.getChild(Keys.reportShare(s.sid, shareId)) : null;
      if (!share) throw new AtlError('NOT_FOUND', 'share not found');
      await dispatch(ctx, 'atl-certs', { action: 'RevokeShare', sessionId: s.sid, shareId, requestedBy: principalOf(ctx).sub });
      await auditOk(ctx, 'report.share_revoke', { sessionId: s.sid, target: shareId });
      return accepted({ shareId, status: 'revoking' });
    }),

    listReports: wrap(ext, async (ctx) => {
      const sub = await subjectSub(ctx);
      let items = sub ? await reportsByUser(ctx.repos.table, sub) : [];
      const labId = ctx.req.query.labId;
      if (labId) items = items.filter((r) => r.labId === labId);
      return ok({ items: items.map(reportView) });
    }),

    // ---- certificates (04 §10, tracks §5.5)
    issueCertificate: wrap(ext, async (ctx) => {
      const body = parseBody(
        z
          .object({
            scope: z.enum(['track', 'lab']),
            trackId: z.string().regex(/^[a-z][a-z0-9-]{1,31}$/).optional(),
            labId: z.string().max(28).optional(),
            displayName: z.string().trim().min(1).max(64).optional(),
            public: z.boolean().optional(),
          })
          .strict(),
        ctx.req.body,
      );
      const p = principalOf(ctx);
      const rel = await ctx.catalog.requireCurrent();
      const defective = new Set<string>();
      if ((await ctx.repos.platform.getRelease(rel.catalogVersion))?.defective) defective.add(rel.catalogVersion);
      const progress = (await ctx.repos.users.progress(p.sub)).map((x) => stripKeys(x) as unknown as ProgressRecord);
      let request: Record<string, unknown>;
      if (body.scope === 'track') {
        if (!body.trackId) throw new AtlError('VALIDATION_FAILED', 'trackId is required for scope track');
        const track = (await ctx.catalog.index(rel.catalogVersion)).tracks.find((t) => t.id === body.trackId);
        if (!track) throw new AtlError('NOT_FOUND', `track ${body.trackId} not found`);
        const tp = trackProgress(track, progress, defective);
        if (!tp.certificate.eligible) throw new AtlError('CERT_NOT_ELIGIBLE', `track ${track.id} is not complete`, { reasons: tp.certificate.reasons });
        request = { scope: 'track', trackId: track.id, labs: [...tp.required.map((r) => r.labId), ...tp.groups.flatMap((g) => g.cards)] };
      } else {
        // scope `lab` is kept for compatibility (01 §8.2): only cards with `certificate.enabled: true` (04 §10.2)
        if (!body.labId) throw new AtlError('VALIDATION_FAILED', 'labId is required for scope lab');
        const lab = await ctx.catalog.requireLab(body.labId, rel.catalogVersion);
        const reasons: { code: string; [k: string]: unknown }[] = [];
        if ((lab.certificate as { enabled?: boolean } | undefined)?.enabled !== true) reasons.push({ code: 'LAB_CERTIFICATES_DISABLED', labId: lab.id });
        const badge = progress.find((x) => x.labId === lab.id)?.badge;
        if (!badge || badge.status !== 'valid') reasons.push({ code: badge?.status === 'pending' ? 'BADGE_PENDING' : 'REQUIRED_CARD_MISSING', labId: lab.id });
        if (badge?.catalogVersion && defective.has(badge.catalogVersion)) reasons.push({ code: 'CONTENT_DEFECTIVE', catalogVersion: badge.catalogVersion });
        if (reasons.length) throw new AtlError('CERT_NOT_ELIGIBLE', `card ${lab.id} does not qualify for a certificate`, { reasons });
        request = { scope: 'lab', labId: lab.id, labs: [lab.id] };
      }
      // atl-certs signs (the only function with kms:Sign); the response carries certId + JWS (01 §8.3)
      const issued = await callCerts(ctx, {
        action: 'IssueCertificate',
        sub: p.sub,
        catalogVersion: rel.catalogVersion,
        ...request,
        ...(body.displayName ? { displayName: body.displayName } : {}),
        ...(body.public !== undefined ? { public: body.public } : {}),
      });
      const certId = (issued as { certId?: string } | null)?.certId ?? null;
      await auditOk(ctx, 'certificate.issue', { target: certId ?? String(request.trackId ?? request.labId), details: { scope: request.scope } });
      return created(issued ?? {}, certId ? apiPath('/certificates', certId) : undefined);
    }),

    listCertificates: wrap(ext, async (ctx) => {
      const sub = await subjectSub(ctx);
      const items = sub ? await ctx.repos.certificates.listByUser(sub) : [];
      return ok({ items: items.map((c) => ({ ...stripKeys(c), jws: undefined })) });
    }),

    getCertificate: wrap(ext, async (ctx) => ok(stripKeys(await loadCert(ctx)))),

    patchCertificate: wrap(ext, async (ctx) => {
      const cert = await loadCert(ctx);
      const body = parseBody(z.object({ public: z.boolean() }).strict(), ctx.req.body);
      if (cert.status !== 'valid' && body.public) throw new AtlError('INVALID_STATE', 'a revoked certificate cannot be published');
      await dispatch(ctx, 'atl-certs', { action: 'PublishCertificate', certId: cert.certId, public: body.public, requestedBy: principalOf(ctx).sub });
      await auditOk(ctx, 'certificate.publish', { target: String(cert.certId), details: { public: body.public } });
      return accepted({ certId: cert.certId, public: body.public, status: 'updating' });
    }),

    getOfflineBundle: wrap(ext, async (ctx) => {
      const cert = await loadCert(ctx);
      // the bundle of 04 §10.5 ({ jws, jwk, jwks, revocationsJws, verifyScript }) is assembled by atl-certs, which owns the
      // published jwks.json, the signed revocation list and the verification algorithm (synchronous call)
      const bundle = await callCerts(ctx, { action: 'OfflineBundle', certId: cert.certId, sub: cert.sub });
      if (!bundle) throw new AtlError('INTERNAL', 'atl-certs returned no offline bundle');
      return {
        statusCode: 200,
        headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'content-disposition': `attachment; filename="${String(cert.certId)}.atl-bundle.json"` },
        body: JSON.stringify(bundle, null, 2),
      };
    }),

    revokeCertificate: wrap(ext, async (ctx) => {
      const cert = await loadCert(ctx);
      const body = parseBody(z.object({ reason: z.enum(['learner-request', 'content-defect', 'misissued', 'key-compromise']).default('learner-request') }).strict(), ctx.req.body);
      if (cert.status === 'revoked') throw new AtlError('INVALID_STATE', 'the certificate is already revoked');
      const r = await callCerts(ctx, { action: 'RevokeCertificate', certId: cert.certId, reason: body.reason, requestedBy: principalOf(ctx).sub });
      await auditOk(ctx, 'certificate.revoke', { target: String(cert.certId), details: { reason: body.reason } });
      return ok(r ?? { certId: cert.certId, status: 'revoked', reason: body.reason });
    }),
  };
}
