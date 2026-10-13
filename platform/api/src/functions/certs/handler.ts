/**
 * atl-certs — reports, exports, share links, certificates, revocation lists, JWKS and the static verify page
 * (04 §9, §10). Invoked asynchronously by atl-api / atl-checks / atl-timer (and synchronously by FinalizeAttempt for the
 * report snapshot). The only function allowed to call `kms:Sign` (01 §6.9).
 *
 * Action names (besides `kind: SHARE_EXPIRE` from atl-timer) follow atl-api's DOWNSTREAM_ACTIONS: GenerateReport,
 * ExportReport, CreateShare, RevokeShare, IssueCertificate, RevokeCertificate, PublishCertificate, ExportArchive; plus
 * ExpireShare, OfflineBundle, PublishJwks, PublishVerifyPage, EvidenceInvalidated (implementation-notes platform-checks).
 */
import { Keys, SkPrefix } from '../../data/keys.js';
import { ActionNotImplementedError, type ActionHandler, type DepsProvider, type FunctionDeps } from '../../runtime/deps.js';
import {
  CertError,
  certificateOfflineBundle,
  currentSigningKey,
  issueCertificate,
  publishJwks,
  publishRevocations,
  publishVerifyPage,
  revokeCertificate,
  revokeForWithdrawnBadge,
  setCertificatePublic,
  trackEligibility,
  type CertContext,
  type RevokeReason,
} from '../../services/certificates/service.js';
import { decodeJws } from '../../services/certificates/jws.js';
import { emitEvents } from '../../services/progress/events.js';
import { DynamoItemStore, type ItemStore } from '../../services/progress/store.js';
import { createShare, exportReport, generateReport, removeShare, type ReportsContext } from '../../services/reports/publish.js';
import { createInvalidator, type Invalidator } from './invalidate.js';

export const FUNCTION_NAME = 'atl-certs';

export interface CertsOptions {
  store?: (deps: FunctionDeps) => ItemStore;
  invalidator?: (deps: FunctionDeps) => Invalidator;
}

const str = (v: unknown): string => (typeof v === 'string' ? v : '');

function ctxOf(deps: FunctionDeps, o: CertsOptions): CertContext & ReportsContext {
  return {
    deps,
    store: o.store ? o.store(deps) : new DynamoItemStore(deps.db, deps.env.tableName),
    nowIso: new Date(deps.ports.clock.nowMs()).toISOString(),
    invalidate: o.invalidator ? o.invalidator(deps) : createInvalidator(deps),
  };
}

/**
 * Certificate errors reach synchronous callers (atl-api `IssueCertificate`, `RevokeCertificate`) as `Atl.<CODE>` errors,
 * which atl-api maps to 01 §8.6 codes (e.g. 422 `CERT_NOT_ELIGIBLE` with `reasons`).
 */
function certFail(e: unknown): never {
  if (e instanceof CertError) throw Object.assign(new Error(e.message), { name: `Atl.${e.code}`, code: e.code, reasons: e.reasons });
  throw e;
}

type CertsAction = (p: Record<string, unknown>, c: CertContext & ReportsContext) => Promise<unknown>;

export const CERTS_ACTIONS: Record<string, CertsAction> = {
  GenerateReport: async (p, c) => {
    const r = await generateReport(c, str(p.sessionId), str(p.reason) || 'request');
    await emitEvents(c.deps, c.store, r.events);
    return { revision: r.revision, digest: r.digest, created: r.created };
  },
  ExportReport: async (p, c) => exportReport(c, str(p.sessionId), { format: p.format === 'json' ? 'json' : 'html', ...(p.mask && typeof p.mask === 'object' ? { mask: p.mask as never } : {}), ...(typeof p.revision === 'number' ? { revision: p.revision } : {}) }),
  CreateShare: async (p, c) => {
    const days = p.expiresInDays === null ? null : typeof p.expiresInDays === 'number' ? p.expiresInDays : undefined;
    return createShare(c, str(p.sessionId), { ...(days !== undefined ? { expiresInDays: days } : {}), ...(typeof p.revision === 'number' ? { revision: p.revision } : {}) });
  },
  RevokeShare: async (p, c) => removeShare(c, str(p.shareId), { ...(str(p.sessionId) ? { sessionId: str(p.sessionId) } : {}), reason: 'revoked' }),
  ExpireShare: async (p, c) => removeShare(c, str(p.shareId), { reason: 'expired' }),
  IssueCertificate: async (p, c) => {
    try {
      const r = await issueCertificate(c, {
        sub: str(p.sub),
        scope: p.scope === 'lab' ? 'lab' : 'track',
        ...(typeof p.trackId === 'string' ? { trackId: p.trackId } : {}),
        ...(typeof p.labId === 'string' ? { labId: p.labId } : {}),
        ...(typeof p.displayName === 'string' ? { displayName: p.displayName } : {}),
        ...(typeof p.public === 'boolean' ? { public: p.public } : {}),
      });
      await emitEvents(c.deps, c.store, r.events);
      // the report of the cited attempts gets a revision with the certificate link
      for (const sid of r.certificate.sessionIds) await generateReport(c, sid, 'certificate').catch(() => undefined);
      return { ok: true, certId: r.certificate.certId, jws: r.certificate.jws, payload: decodeJws(r.certificate.jws).payload, scope: r.certificate.scope, issuedAt: r.certificate.issuedAt };
    } catch (e) {
      return certFail(e);
    }
  },
  CertificateEligibility: async (p, c) => trackEligibility(c, str(p.sub), str(p.trackId)).then((r) => ({ eligible: r.eligible, reasons: r.reasons })),
  RevokeCertificate: async (p, c) => {
    try {
      const r = await revokeCertificate(c, str(p.certId), (str(p.reason) || 'learner-request') as RevokeReason, typeof p.sub === 'string' ? p.sub : undefined);
      await emitEvents(c.deps, c.store, r.events);
      return { ok: true, certId: r.certificate.certId, status: r.certificate.status, revokedAt: r.certificate.revokedAt, revokeReason: r.certificate.revokeReason, revocationsSeq: r.seq };
    } catch (e) {
      return certFail(e);
    }
  },
  PublishCertificate: async (p, c) => {
    try {
      const r = await setCertificatePublic(c, str(p.certId), str(p.sub), p.public !== false);
      return { ok: true, certId: r.certId, public: r.public };
    } catch (e) {
      return certFail(e);
    }
  },
  OfflineBundle: async (p, c) => {
    try {
      return await certificateOfflineBundle(c, str(p.certId), str(p.sub));
    } catch (e) {
      return certFail(e);
    }
  },
  PublishJwks: async (_p, c) => {
    await currentSigningKey(c);
    return publishJwks(c);
  },
  PublishVerifyPage: async (_p, c) => {
    await publishVerifyPage(c);
    if (!(await c.store.query(Keys.revocationList(1).PK, { skPrefix: SkPrefix.revocation, limit: 1 })).length) await publishRevocations(c, []);
    return { ok: true };
  },
  EvidenceInvalidated: async (p, c) => {
    const revoked = await revokeForWithdrawnBadge(c, str(p.sub), str(p.attemptId));
    await emitEvents(
      c.deps,
      c.store,
      revoked.map((certId) => ({ type: 'certificate.revoked' as const, sessionId: str(p.attemptId) || null, data: { certId, reason: 'evidence-invalidated' } })),
    );
    return { revoked };
  },
  ExportArchive: async (p, c) => {
    // learning archive (01 §4.8): progress, reports index and certificates of the learner as one JSON document
    const sub = str(p.sub);
    const progress = await c.store.query(Keys.userProfile(sub).PK, { skPrefix: SkPrefix.lab });
    const reports = await c.store.query(Keys.userProfile(sub).PK, { index: 'GSI1', skPrefix: SkPrefix.gsi1Report });
    const certs = await c.store.query(Keys.userProfile(sub).PK, { index: 'GSI1', skPrefix: SkPrefix.gsi1Cert });
    const key = str(p.key) || `exports/${sub}/archive-${Date.parse(c.nowIso)}.json`;
    await c.deps.ports.objects.put(c.deps.env.buckets.data, key, JSON.stringify({ schema: 'atl.learning-archive/v1', generatedAt: c.nowIso, progress, reports, certificates: certs }, null, 2), { contentType: 'application/json' });
    const url = await c.deps.ports.objects.presign(c.deps.env.buckets.data, key, { method: 'GET', expiresInSeconds: 3600 });
    return { exportId: str(p.exportId), key, url };
  },
};

/** Extra / test actions, looked up first at call time. */
export const ACTIONS: Record<string, ActionHandler> = {};

export function createCertsHandler(getDeps: DepsProvider, actions?: Record<string, ActionHandler>, options: CertsOptions = {}) {
  return async (event: unknown): Promise<unknown> => {
    const payload = (event && typeof event === 'object' ? event : {}) as Record<string, unknown>;
    // atl-timer forwards the schedule payload `{ kind: SHARE_EXPIRE, shareId }`
    const name = typeof payload.action === 'string' ? payload.action : payload.kind === 'SHARE_EXPIRE' ? 'ExpireShare' : '';
    const extra = (actions ?? ACTIONS)[name];
    if (extra) return extra(payload, await getDeps());
    const fn = CERTS_ACTIONS[name];
    if (!fn) throw new ActionNotImplementedError(FUNCTION_NAME, name || '(none)');
    return fn(payload, ctxOf(await getDeps(), options));
  };
}
