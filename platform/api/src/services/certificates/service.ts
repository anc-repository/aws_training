/**
 * Certificates (04 §10): signing key bookkeeping (`SigningKey`, JWKS), eligibility (tracks-and-catalog §5.5 for track
 * certificates, 04 §10.2 for optional card certificates), payloads (§10.4), issuance, revocation and the signed
 * revocation list (§10.7), publication of the static verification files (§10.6), offline bundles (§10.5).
 */
import { createHmac } from 'node:crypto';
import { canonicalJson, newCertId, WebKeys, type PlatformConfigItem } from '@atl/shared';
import { jwkThumbprint, sha256Hex, type EcPublicJwk } from '@atl/shared/node';
import { Gsi1, Keys, SkPrefix } from '../../data/keys.js';
import type { FunctionDeps } from '../../runtime/deps.js';
import type { PendingEvent } from '../progress/events.js';
import { mutate, type ItemStore } from '../progress/store.js';
import { trackProgress, type TrackDef } from '../progress/tracks.js';
import type { LabAttemptItem, LabProgressItem } from '../progress/types.js';
import { CERT_TYP, decodeJws, REVOCATIONS_TYP, signJws } from './jws.js';
import { CERT_DISCLAIMER, jwksDocument, offlineBundle, verifyPageAssets, type JwksKeyEntry } from './static-site.js';

export const ISSUER_NAME = 'AWS Training Lab（自托管实例）';
export const SHORT_DISCLAIMER = '本证明由部署在学员自己 AWS 账号中的自托管 AWS Training Lab 实例自动签发，不是 AWS 官方认证。';
export const REVOKE_REASONS = ['learner-request', 'superseded', 'content-defect', 'misissued', 'key-compromise', 'evidence-invalidated', 'dependency-revoked'] as const;
export type RevokeReason = (typeof REVOKE_REASONS)[number];

export class CertError extends Error {
  constructor(
    readonly code: 'CERT_NOT_ELIGIBLE' | 'NOT_FOUND' | 'INVALID_STATE' | 'VALIDATION_FAILED',
    message: string,
    readonly reasons: string[] = [],
  ) {
    super(message);
    this.name = 'CertError';
  }
}

export interface SigningKeyItem {
  kid: string;
  keyId: string;
  alg: 'ES256';
  publicKeyPem: string;
  jwk: EcPublicJwk;
  validFrom: string;
  validTo: string | null;
  purposes: string[];
}

export interface CertificateItem {
  type: 'Certificate';
  certId: string;
  sub: string;
  scope: 'track' | 'lab';
  trackId: string | null;
  labIds: string[];
  sessionIds: string[];
  issuedAt: string;
  kid: string;
  jws: string;
  payloadHash: string;
  status: 'valid' | 'revoked';
  revokedAt: string | null;
  revokeReason: RevokeReason | null;
  public: boolean;
  displayName: string;
}

export interface CertContext {
  deps: FunctionDeps;
  store: ItemStore;
  nowIso: string;
  /** CloudFront invalidation of `atl-web` paths (no-op when not configured). */
  invalidate: (paths: string[]) => Promise<void>;
}

function spkiPem(der: Uint8Array): string {
  const b64 = Buffer.from(der).toString('base64');
  return `-----BEGIN PUBLIC KEY-----\n${b64.match(/.{1,64}/g)!.join('\n')}\n-----END PUBLIC KEY-----\n`;
}

/** HMAC-SHA256 reference (subject / attempt), keyed with the installation id (04 §10.4). */
export function refOf(salt: string, value: string): string {
  return `sha256:${createHmac('sha256', `atl-ref:${salt}`).update(value).digest('hex')}`;
}

async function platformConfig(c: CertContext): Promise<(PlatformConfigItem & Record<string, unknown>) | null> {
  return c.store.get<PlatformConfigItem & Record<string, unknown>>(Keys.platformConfig());
}

// ---------------------------------------------------------------------------------------------------------------
// signing keys and JWKS

export async function listSigningKeys(store: ItemStore): Promise<SigningKeyItem[]> {
  return store.query<SigningKeyItem>(Gsi1.signingKey('x').GSI1PK, { index: 'GSI1' });
}

/**
 * The current signing key (the KMS key id in `ATL_SIGNING_KEY_ID`). Registers it as `SigningKey` on first use and closes
 * the validity of a previous key (rotation, §10.8).
 */
export async function currentSigningKey(c: CertContext): Promise<SigningKeyItem> {
  const keyId = c.deps.env.signingKeyId;
  if (!keyId) throw new Error('ATL_SIGNING_KEY_ID is not configured');
  const keys = await listSigningKeys(c.store);
  const hit = keys.find((k) => k.keyId === keyId && k.validTo === null);
  if (hit) return hit;
  const pub = await c.deps.ports.signer.getPublicKey(keyId);
  const jwk: EcPublicJwk = { kty: 'EC', crv: 'P-256', x: pub.jwk.x, y: pub.jwk.y };
  const kid = jwkThumbprint(jwk);
  const item: SigningKeyItem = { kid, keyId, alg: 'ES256', publicKeyPem: spkiPem(pub.spkiDer), jwk, validFrom: c.nowIso, validTo: null, purposes: ['cert', 'revocations'] };
  for (const old of keys.filter((k) => k.validTo === null && k.kid !== kid)) {
    await mutate<SigningKeyItem>(c.store, Keys.signingKey(old.kid), (cur) => (cur ? ({ ...cur, validTo: c.nowIso } as SigningKeyItem & Record<string, unknown>) : null), { now: () => c.nowIso });
  }
  await mutate<SigningKeyItem>(c.store, Keys.signingKey(kid), (cur) => (cur ? ({ ...cur, keyId, validTo: null } as SigningKeyItem & Record<string, unknown>) : ({ ...item, type: 'SigningKey', ...Gsi1.signingKey(c.nowIso) } as SigningKeyItem & Record<string, unknown>)), { now: () => c.nowIso });
  await publishJwks(c);
  return item;
}

export async function publishJwks(c: CertContext): Promise<Record<string, unknown>> {
  const pc = await platformConfig(c);
  const keys = await listSigningKeys(c.store);
  const web = c.deps.env.buckets.web;
  let origins: string[] = [];
  const prev = await c.deps.ports.objects.get(web, WebKeys.jwks).catch(() => null);
  if (prev) {
    try {
      origins = (JSON.parse(Buffer.from(prev).toString('utf8')) as { origins?: string[] }).origins ?? [];
    } catch {
      origins = [];
    }
  }
  if (pc?.platformUrl) origins.push(pc.platformUrl);
  const doc = jwksDocument({
    installId: pc?.installationId ?? 'unknown',
    keys: keys.map((k): JwksKeyEntry => ({ kid: k.kid, jwk: k.jwk, validFrom: k.validFrom, validTo: k.validTo, purposes: k.purposes ?? ['cert', 'revocations'] })),
    origins,
  });
  await c.deps.ports.objects.put(web, WebKeys.jwks, `${JSON.stringify(doc, null, 2)}\n`, { contentType: 'application/json' });
  await c.invalidate([`/${WebKeys.jwks}`]);
  return doc;
}

const VERIFY_TYPES: Record<string, string> = { 'index.html': 'text/html; charset=utf-8', 'verify.js': 'text/javascript; charset=utf-8', 'verify.css': 'text/css; charset=utf-8' };

/** verify/index.html + verify/verify.js (+ verify.css of P09-V): the platform's static verification entry (§10.6). */
export async function publishVerifyPage(c: CertContext): Promise<void> {
  const web = c.deps.env.buckets.web;
  const assets = verifyPageAssets();
  // the script last: ensureVerification compares verify.js, so a half-published page is completed on the next call
  for (const name of ['verify.css', 'index.html', 'verify.js'] as const) {
    const body = assets[name];
    if (body !== undefined) await c.deps.ports.objects.put(web, `${WebKeys.verify}${name}`, body, { contentType: VERIFY_TYPES[name]! });
  }
  await c.invalidate([`/${WebKeys.verify}*`]);
}

// ---------------------------------------------------------------------------------------------------------------
// revocation list

export interface RevocationEntry {
  certId: string;
  revokedAt: string;
  reason: RevokeReason;
}

export async function latestRevocationList(store: ItemStore): Promise<{ seq: number; jws: string; entries: RevocationEntry[] } | null> {
  const items = await store.query<{ seq: number; jws: string }>(Keys.revocationList(1).PK, { skPrefix: SkPrefix.revocation, ascending: false, limit: 1 });
  const it = items[0];
  if (!it) return null;
  const payload = decodeJws(it.jws).payload as { entries?: RevocationEntry[] };
  return { seq: it.seq, jws: it.jws, entries: payload.entries ?? [] };
}

/** Append entries, re-sign the whole list with a new sequence number and publish `/public/revocations.jws`. */
export async function publishRevocations(c: CertContext, add: RevocationEntry[] = []): Promise<{ seq: number; jws: string }> {
  const key = await currentSigningKey(c);
  const pc = await platformConfig(c);
  for (let attempt = 0; attempt < 5; attempt++) {
    const prev = await latestRevocationList(c.store);
    const known = new Set((prev?.entries ?? []).map((e) => e.certId));
    const entries = [...(prev?.entries ?? []), ...add.filter((e) => !known.has(e.certId))];
    const seq = (prev?.seq ?? 0) + 1;
    const payload = { v: 1, installId: pc?.installationId ?? 'unknown', seq, issuedAt: c.nowIso, entries };
    const { jws } = await signJws(c.deps.ports.signer, key, REVOCATIONS_TYP, payload);
    try {
      await c.store.put({ ...Keys.revocationList(seq), type: 'RevocationList', seq, jws, issuedAt: c.nowIso, ver: 1, createdAt: c.nowIso, updatedAt: c.nowIso }, { expectVer: null });
    } catch {
      continue; // a concurrent revocation took this sequence number: rebuild from the newer list
    }
    await c.deps.ports.objects.put(c.deps.env.buckets.web, WebKeys.revocations, `${jws}\n`, { contentType: 'application/jose' });
    await c.invalidate([`/${WebKeys.revocations}`]);
    return { seq, jws };
  }
  throw new Error('revocation list: too many concurrent updates');
}

// ---------------------------------------------------------------------------------------------------------------
// eligibility and payloads

export async function loadTrack(c: CertContext, catalogVersion: string, trackId: string): Promise<TrackDef | null> {
  const web = c.deps.env.buckets.web;
  const raw = await c.deps.ports.objects.get(web, `${WebKeys.content(catalogVersion)}tracks/${trackId}.json`).catch(() => null);
  if (raw) return JSON.parse(Buffer.from(raw).toString('utf8')) as TrackDef;
  // the catalog index (05 §8.4 `catalog/index.json`, 04 §2.5 `index.json`) also carries the tracks
  for (const name of ['catalog/index.json', 'index.json']) {
    const index = await c.deps.ports.objects.get(web, `${WebKeys.content(catalogVersion)}${name}`).catch(() => null);
    if (!index) continue;
    const tracks = (JSON.parse(Buffer.from(index).toString('utf8')) as { tracks?: TrackDef[] }).tracks ?? [];
    const t = tracks.find((x) => x.id === trackId);
    if (t) return t;
  }
  return null;
}

async function currentCatalogVersion(c: CertContext): Promise<string | null> {
  const cur = await c.store.get<{ catalogVersion?: string }>(Keys.catalogCurrent());
  return cur?.catalogVersion ?? null;
}

async function latestReportDigest(store: ItemStore, sid: string): Promise<string | null> {
  const reps = await store.query<{ version?: number; digest?: string }>(Keys.labSession(sid).PK, { skPrefix: SkPrefix.report });
  const last = reps.sort((a, b) => (b.version ?? 0) - (a.version ?? 0))[0];
  return last?.digest ?? null;
}

async function defectiveRelease(store: ItemStore, catalogVersion: string): Promise<boolean> {
  const r = await store.get<{ defective?: boolean }>(Keys.catalogRelease(catalogVersion)).catch(() => null);
  return r?.defective === true;
}

async function displayNameOf(c: CertContext, sub: string, override?: string): Promise<string> {
  if (override && override.trim()) return override.trim().slice(0, 64);
  const p = await c.store.get<{ certName?: string; displayName?: string }>(Keys.userProfile(sub));
  return (p?.certName || p?.displayName || '学员').slice(0, 64);
}

function issuerOf(pc: (PlatformConfigItem & Record<string, unknown>) | null, kid: string) {
  return { name: ISSUER_NAME, origin: pc?.platformUrl ?? 'https://localhost', installId: pc?.installationId ?? 'unknown', kid };
}

export interface IssueRequest {
  sub: string;
  scope: 'track' | 'lab';
  trackId?: string;
  labId?: string;
  displayName?: string;
  public?: boolean;
}

/** Track certificate eligibility (tracks §5.5) with the lab attempts it would cite. */
export async function trackEligibility(c: CertContext, sub: string, trackId: string): Promise<{ eligible: boolean; reasons: string[]; track: TrackDef | null; progress: LabProgressItem[]; catalogVersion: string | null }> {
  const catalogVersion = await currentCatalogVersion(c);
  const track = catalogVersion ? await loadTrack(c, catalogVersion, trackId) : null;
  if (!track) return { eligible: false, reasons: [`unknown track ${trackId}`], track: null, progress: [], catalogVersion };
  const progress = await c.store.query<LabProgressItem>(Keys.userProfile(sub).PK, { skPrefix: SkPrefix.lab });
  const tp = trackProgress(track, progress);
  const reasons = [...tp.reasons];
  if (track.certificate && !track.certificate.enabled) reasons.push('this track does not issue certificates');
  for (const lab of tp.countedCards) {
    const p = progress.find((x) => x.labId === lab);
    const attempt = p?.badge ? await c.store.get<LabAttemptItem>(Keys.labAttempt(p.badge.attemptId)) : null;
    if (attempt && (await defectiveRelease(c.store, attempt.catalogVersion))) reasons.push(`卡片 ${lab} 所用的内容版本 ${attempt.catalogVersion} 已被标记为有缺陷`);
  }
  return { eligible: tp.status === 'completed' && reasons.length === 0, reasons, track, progress, catalogVersion };
}

export async function issueCertificate(c: CertContext, req: IssueRequest): Promise<{ certificate: CertificateItem; events: PendingEvent[] }> {
  const pc = await platformConfig(c);
  const salt = pc?.installationId ?? 'unknown';
  const key = await currentSigningKey(c);
  const certId = newCertId();
  const displayName = await displayNameOf(c, req.sub, req.displayName);
  const base = {
    v: 1,
    certId,
    issuer: issuerOf(pc, key.kid),
    subject: { displayName, ref: refOf(salt, req.sub) },
    issuedAt: c.nowIso,
    nature: 'self-hosted-self-signed',
    disclaimer: SHORT_DISCLAIMER,
    verify: `${pc?.platformUrl ?? 'https://localhost'}/verify/${certId}`,
  };
  let payload: Record<string, unknown>;
  let labIds: string[];
  let sessionIds: string[];
  let trackId: string | null = null;
  if (req.scope === 'track') {
    if (!req.trackId) throw new CertError('VALIDATION_FAILED', 'trackId is required');
    const el = await trackEligibility(c, req.sub, req.trackId);
    if (!el.eligible || !el.track) throw new CertError('CERT_NOT_ELIGIBLE', 'the learning path is not complete', el.reasons);
    const labs: Record<string, unknown>[] = [];
    sessionIds = [];
    for (const labId of trackProgress(el.track, el.progress).countedCards) {
      const p = el.progress.find((x) => x.labId === labId)!;
      const b = p.badge!;
      const a = await c.store.get<LabAttemptItem>(Keys.labAttempt(b.attemptId));
      sessionIds.push(b.attemptId);
      labs.push({
        labId,
        labVersion: b.labVersion,
        attemptRef: refOf(salt, b.attemptId),
        reportDigest: (await latestReportDigest(c.store, b.attemptId)) ?? null,
        badgeLevel: b.level,
        checks: { auto: a?.checksSummary?.auto ?? 0, manual: a?.checksSummary?.manual ?? 0 },
        completedAt: a?.completedAt ?? b.earnedAt,
      });
    }
    labIds = labs.map((l) => String(l.labId));
    trackId = el.track.id;
    payload = {
      ...base,
      kind: 'track',
      achievement: {
        trackId: el.track.id,
        trackVersion: el.track.version,
        title: el.track.certificate?.title ?? el.track.title,
        contentDigest: el.catalogVersion ? ((await c.store.get<{ contentDigest?: string }>(Keys.catalogRelease(el.catalogVersion)))?.contentDigest ?? null) : null,
        verifiedRatio: trackProgress(el.track, el.progress).verifiedRatio,
        labs,
      },
    };
  } else {
    if (!req.labId) throw new CertError('VALIDATION_FAILED', 'labId is required');
    const p = await c.store.get<LabProgressItem>(Keys.labProgress(req.sub, req.labId));
    const b = p?.badge;
    if (!b || b.status !== 'valid') throw new CertError('CERT_NOT_ELIGIBLE', 'the card has no valid badge', ['卡片尚未完成或徽章无效']);
    const a = await c.store.get<LabAttemptItem>(Keys.labAttempt(b.attemptId));
    const session = await c.store.get<Record<string, unknown>>(Keys.labSession(b.attemptId));
    const catalogVersion = a?.catalogVersion ?? String(session?.catalogVersion ?? '');
    const raw = catalogVersion ? await c.deps.ports.objects.get(c.deps.env.buckets.web, `${WebKeys.content(catalogVersion)}labs/${req.labId}.json`).catch(() => null) : null;
    const card = raw ? (JSON.parse(Buffer.from(raw).toString('utf8')) as { lab?: { title?: string; certificate?: { enabled?: boolean; maxManualChecks?: number; title?: string }; saa?: { domains?: string[] } } }) : null;
    const reasons: string[] = [];
    if (!card?.lab?.certificate?.enabled) reasons.push('本卡片不签发证书（certificate.enabled: false）');
    const max = card?.lab?.certificate?.maxManualChecks;
    if (max !== undefined && (a?.checksSummary?.manual ?? 0) > max) reasons.push(`手动满足的检查 ${a?.checksSummary?.manual} 项超过上限 ${max}`);
    if (catalogVersion && (await defectiveRelease(c.store, catalogVersion))) reasons.push(`内容版本 ${catalogVersion} 已被标记为有缺陷`);
    if (reasons.length) throw new CertError('CERT_NOT_ELIGIBLE', 'card certificate conditions are not met', reasons);
    const chain = ((await c.store.get<{ sessionChain?: string[] }>(Keys.environment(String(session?.envId ?? 'none'))).catch(() => null))?.sessionChain ?? []) as string[];
    sessionIds = [b.attemptId];
    labIds = [req.labId];
    payload = {
      ...base,
      kind: 'lab',
      achievement: { labId: req.labId, labVersion: b.labVersion, title: card?.lab?.certificate?.title ?? card?.lab?.title ?? req.labId, contentDigest: a?.contentDigest ?? null, saaDomains: card?.lab?.saa?.domains ?? [] },
      evidence: {
        attemptRef: refOf(salt, b.attemptId),
        sessions: [...new Set([...chain.filter((s) => s !== b.attemptId), b.attemptId])].map((s) => refOf(salt, s)),
        region: String(session?.region ?? pc?.region ?? c.deps.env.region),
        startedAt: String(session?.readyAt ?? session?.createdAt ?? ''),
        completedAt: a?.completedAt ?? b.earnedAt,
        activeMinutes: null,
        checks: { auto: a?.checksSummary?.auto ?? 0, manual: a?.checksSummary?.manual ?? 0 },
        experiments: { validPairs: null },
        reportDigest: await latestReportDigest(c.store, b.attemptId),
      },
    };
  }
  const { jws, payloadBytes } = await signJws(c.deps.ports.signer, key, CERT_TYP, payload);
  const cert: CertificateItem = {
    type: 'Certificate',
    certId,
    sub: req.sub,
    scope: req.scope,
    trackId,
    labIds,
    sessionIds,
    issuedAt: c.nowIso,
    kid: key.kid,
    jws,
    payloadHash: `sha256:${sha256Hex(payloadBytes)}`,
    status: 'valid',
    revokedAt: null,
    revokeReason: null,
    public: req.public === true,
    displayName,
  };
  await c.store.put({ ...Keys.certificate(certId), ...Gsi1.certificate(req.sub, c.nowIso, certId), ...cert, ver: 1, createdAt: c.nowIso, updatedAt: c.nowIso } as never, { expectVer: null });
  const events: PendingEvent[] = [{ type: 'certificate.issued', sessionId: sessionIds[sessionIds.length - 1] ?? null, data: { certId, scope: req.scope, sub: req.sub, ...(trackId ? { trackId } : {}) } }];
  if (cert.public) await publishCertificateFile(c, cert);
  // one valid certificate per track / card: older ones are superseded (§10.2)
  const mine = await c.store.query<CertificateItem>(Keys.userProfile(req.sub).PK, { index: 'GSI1', skPrefix: SkPrefix.gsi1Cert });
  const superseded = mine.filter((x) => x.certId !== certId && x.status === 'valid' && x.scope === req.scope && (req.scope === 'track' ? x.trackId === trackId : x.labIds?.[0] === req.labId));
  if (superseded.length) {
    for (const s of superseded) await markRevoked(c, s.certId, 'superseded');
    await publishRevocations(c, superseded.map((s) => ({ certId: s.certId, revokedAt: c.nowIso, reason: 'superseded' as const })));
    for (const s of superseded) events.push({ type: 'certificate.revoked', sessionId: null, data: { certId: s.certId, reason: 'superseded' } });
  }
  return { certificate: cert, events };
}

async function markRevoked(c: CertContext, certId: string, reason: RevokeReason): Promise<CertificateItem | null> {
  return mutate<CertificateItem>(c.store, Keys.certificate(certId), (cur) => (cur && cur.status !== 'revoked' ? ({ ...cur, status: 'revoked', revokedAt: c.nowIso, revokeReason: reason } as CertificateItem & Record<string, unknown>) : null), { now: () => c.nowIso });
}

export async function revokeCertificate(c: CertContext, certId: string, reason: RevokeReason, by?: string): Promise<{ certificate: CertificateItem; seq: number; events: PendingEvent[] }> {
  if (!REVOKE_REASONS.includes(reason)) throw new CertError('VALIDATION_FAILED', `unknown reason ${reason}`);
  const cur = await c.store.get<CertificateItem>(Keys.certificate(certId));
  if (!cur) throw new CertError('NOT_FOUND', `certificate ${certId} not found`);
  if (by && cur.sub !== by) throw new CertError('NOT_FOUND', `certificate ${certId} not found`);
  if (cur.status === 'revoked') {
    const list = await latestRevocationList(c.store);
    return { certificate: cur, seq: list?.seq ?? 0, events: [] };
  }
  const updated = (await markRevoked(c, certId, reason)) ?? cur;
  const { seq } = await publishRevocations(c, [{ certId, revokedAt: c.nowIso, reason }]);
  return { certificate: updated, seq, events: [{ type: 'certificate.revoked', sessionId: null, data: { certId, reason } }] };
}

/** Revoke track certificates citing a withdrawn badge (`evidence-invalidated`, 04 §10.7). */
export async function revokeForWithdrawnBadge(c: CertContext, sub: string, attemptId: string): Promise<string[]> {
  const mine = await c.store.query<CertificateItem>(Keys.userProfile(sub).PK, { index: 'GSI1', skPrefix: SkPrefix.gsi1Cert });
  const hit = mine.filter((x) => x.status === 'valid' && (x.sessionIds ?? []).includes(attemptId));
  for (const h of hit) await markRevoked(c, h.certId, 'evidence-invalidated');
  if (hit.length) await publishRevocations(c, hit.map((h) => ({ certId: h.certId, revokedAt: c.nowIso, reason: 'evidence-invalidated' as const })));
  return hit.map((h) => h.certId);
}

export async function publishCertificateFile(c: CertContext, cert: Pick<CertificateItem, 'certId' | 'jws'>): Promise<void> {
  await c.deps.ports.objects.put(c.deps.env.buckets.web, WebKeys.publicCert(cert.certId), `${cert.jws}\n`, { contentType: 'application/jose' });
  await c.invalidate([`/${WebKeys.publicCert(cert.certId)}`]);
}

export async function setCertificatePublic(c: CertContext, certId: string, sub: string, isPublic: boolean): Promise<CertificateItem> {
  const cur = await c.store.get<CertificateItem>(Keys.certificate(certId));
  if (!cur || cur.sub !== sub) throw new CertError('NOT_FOUND', `certificate ${certId} not found`);
  const updated = (await mutate<CertificateItem>(c.store, Keys.certificate(certId), (x) => (x ? ({ ...x, public: isPublic } as CertificateItem & Record<string, unknown>) : null), { now: () => c.nowIso })) ?? cur;
  if (isPublic) await publishCertificateFile(c, updated);
  else {
    await c.deps.ports.objects.delete(c.deps.env.buckets.web, WebKeys.publicCert(certId));
    await c.invalidate([`/${WebKeys.publicCert(certId)}`]);
  }
  return updated;
}

export async function certificateOfflineBundle(c: CertContext, certId: string, sub: string): Promise<Record<string, unknown>> {
  const cert = await c.store.get<CertificateItem>(Keys.certificate(certId));
  if (!cert || cert.sub !== sub) throw new CertError('NOT_FOUND', `certificate ${certId} not found`);
  const raw = await c.deps.ports.objects.get(c.deps.env.buckets.web, WebKeys.jwks).catch(() => null);
  const jwks = raw ? (JSON.parse(Buffer.from(raw).toString('utf8')) as Record<string, unknown>) : await publishJwks(c);
  const rev = await latestRevocationList(c.store);
  return offlineBundle({ jws: cert.jws, jwks, kid: cert.kid, revocationsJws: rev?.jws ?? null });
}

/** `atl-public` view of a certificate (least fields; JWS only when public). */
export function publicCertificateView(cert: CertificateItem): Record<string, unknown> {
  return {
    certId: cert.certId,
    status: cert.status,
    scope: cert.scope,
    issuedAt: cert.issuedAt,
    kid: cert.kid,
    ...(cert.status === 'revoked' ? { revokedAt: cert.revokedAt, revokeReason: cert.revokeReason } : {}),
    ...(cert.public ? { jws: cert.jws } : {}),
    disclaimer: CERT_DISCLAIMER,
  };
}

export function payloadDigestOf(payload: unknown): string {
  return `sha256:${sha256Hex(canonicalJson(payload))}`;
}
