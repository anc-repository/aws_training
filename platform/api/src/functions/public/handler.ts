/**
 * atl-public — `/api/v1/public/*` (no auth; least fields), 01 §3.2, §8.2. May only read the `CERT#*` and `KEY#*`
 * partitions (`dynamodb:LeadingKeys`). The verify page does not depend on these routes: its verdict comes from local
 * WebCrypto verification of the static files (04 §10.6); these are convenience lookups.
 */
import { AtlError, isCertId } from '@atl/shared';
import { Keys } from '../../data/keys.js';
import { createHttpHandler, json, type RouteHandlers } from '../../http/router.js';
import type { DepsProvider, FunctionDeps } from '../../runtime/deps.js';
import { listSigningKeys, publicCertificateView, type CertificateItem, type SigningKeyItem } from '../../services/certificates/service.js';
import { DynamoItemStore, type ItemStore } from '../../services/progress/store.js';

export const PLATFORM_VERSION = process.env.ATL_PLATFORM_VERSION ?? '0.1.0-dev';

const SHORT_CACHE = { 'cache-control': 'public, max-age=60' };
const KID_RE = /^[A-Za-z0-9_-]{43}$/;

let storeFactory: (deps: FunctionDeps) => ItemStore = (deps) => new DynamoItemStore(deps.db, deps.env.tableName);
/** Test hook. */
export function setPublicStore(f: (deps: FunctionDeps) => ItemStore): void {
  storeFactory = f;
}

function keyView(k: SigningKeyItem): Record<string, unknown> {
  return {
    kid: k.kid,
    alg: k.alg ?? 'ES256',
    jwk: { kty: 'EC', crv: 'P-256', x: k.jwk.x, y: k.jwk.y, kid: k.kid, use: 'sig', alg: 'ES256' },
    publicKeyPem: k.publicKeyPem,
    validFrom: k.validFrom,
    validTo: k.validTo ?? null,
    purposes: k.purposes ?? ['cert', 'revocations'],
  };
}

export const ROUTE_HANDLERS: RouteHandlers = {
  publicHealth: async () => json(200, { status: 'ok', version: PLATFORM_VERSION }, { 'cache-control': 'no-store' }),
  publicGetCertificate: async (req) => {
    const certId = req.params.certId ?? '';
    if (!isCertId(certId)) throw new AtlError('NOT_FOUND', 'certificate not found');
    const cert = await storeFactory(req.deps).get<CertificateItem>(Keys.certificate(certId));
    if (!cert) throw new AtlError('NOT_FOUND', 'certificate not found');
    return json(200, publicCertificateView(cert), SHORT_CACHE);
  },
  publicListKeys: async (req) => {
    const keys = await listSigningKeys(storeFactory(req.deps));
    return json(200, { keys: keys.map(keyView) }, SHORT_CACHE);
  },
  publicGetKey: async (req) => {
    const kid = req.params.kid ?? '';
    if (!KID_RE.test(kid)) throw new AtlError('NOT_FOUND', 'key not found');
    const k = await storeFactory(req.deps).get<SigningKeyItem>(Keys.signingKey(kid));
    if (!k) throw new AtlError('NOT_FOUND', 'key not found');
    return json(200, keyView(k), SHORT_CACHE);
  },
};

export function createPublicHandler(getDeps: DepsProvider, handlers: RouteHandlers = ROUTE_HANDLERS) {
  return createHttpHandler({ fn: 'atl-public', handlers, getDeps });
}
