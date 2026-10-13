/**
 * App preview entries and the embeddability probe (03 §6.1).
 *
 * Entries come from `Environment.endpoints` / `LabSession.app` (02): `direct` (lab instance), `cdn`, `alb`,
 * `custom-domain`. `embeddable` is decided by atl-api: https only (else `MIXED_CONTENT`); a `GET /` with Node's default
 * trust store, 3 s timeout, no redirects, headers only (`UNTRUSTED_CERT` / `UNREACHABLE`); `Content-Security-Policy:
 * frame-ancestors` must allow the platform origin (`FRAME_ANCESTORS_MISSING`) and `X-Frame-Options: DENY|SAMEORIGIN`
 * blocks (`X_FRAME_OPTIONS`). Results are cached 60 s per container.
 *
 * SSRF guard (01 R-13, 03 §6.1): the host is resolved first; loopback, private, link-local, CGNAT, multicast and other
 * reserved addresses are refused, only port 443 is used and the connection goes to the resolved address (no DNS
 * rebinding between check and use). The probe never sends credentials.
 */
import dns from 'node:dns/promises';
import https from 'node:https';
import net from 'node:net';
import type { LookupFunction } from 'node:net';
import type { PREVIEW_REASON_CODES } from '@atl/shared';

export type PreviewReasonCode = (typeof PREVIEW_REASON_CODES)[number];

export interface PreviewTarget {
  id: 'direct' | 'cdn' | 'alb' | 'custom-domain' | 'app';
  url: string;
  embeddable: boolean;
  reason: PreviewReasonCode | null;
  via: string | null;
  label: string;
  probed: boolean;
  /** Probe detail (no secrets): the failing check. */
  detail?: string;
}

export interface ProbeResult {
  embeddable: boolean;
  reason: PreviewReasonCode | null;
  probed: boolean;
  detail?: string;
}

export type PreviewProber = (url: string, platformOrigin: string) => Promise<ProbeResult>;

// ---------------------------------------------------------------------------------------------------------------
// Address policy

function ipv4ToInt(ip: string): number {
  return ip.split('.').reduce((a, o) => (a << 8) + Number(o), 0) >>> 0;
}

const V4_BLOCKED: [string, number][] = [
  ['0.0.0.0', 8],
  ['10.0.0.0', 8],
  ['100.64.0.0', 10],
  ['127.0.0.0', 8],
  ['169.254.0.0', 16],
  ['172.16.0.0', 12],
  ['192.0.0.0', 24],
  ['192.0.2.0', 24],
  ['192.168.0.0', 16],
  ['198.18.0.0', 15],
  ['198.51.100.0', 24],
  ['203.0.113.0', 24],
  ['224.0.0.0', 4],
  ['240.0.0.0', 4],
];

/** True for addresses the probe must never connect to. */
export function isBlockedAddress(ip: string): boolean {
  if (net.isIPv4(ip)) {
    const n = ipv4ToInt(ip);
    return V4_BLOCKED.some(([base, bits]) => (n & (bits === 0 ? 0 : (~0 << (32 - bits)) >>> 0)) >>> 0 === ipv4ToInt(base));
  }
  if (net.isIPv6(ip)) {
    const s = ip.toLowerCase();
    const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(s);
    if (mapped) return isBlockedAddress(mapped[1]!);
    return s === '::' || s === '::1' || /^f[cd]/.test(s) || /^fe[89ab]/.test(s) || /^ff/.test(s) || s.startsWith('2001:db8') || s.startsWith('64:ff9b');
  }
  return true;
}

// ---------------------------------------------------------------------------------------------------------------
// Header checks

function sourceAllows(source: string, origin: string): boolean {
  if (source === '*') return true;
  if (source === origin) return true;
  const u = new URL(origin);
  if (source === `${u.protocol}//${u.host}`) return true;
  if (source === 'https:' && u.protocol === 'https:') return true;
  // https://*.example.com style wildcards
  const m = /^(https?:)\/\/\*\.(.+)$/.exec(source);
  return !!m && m[1] === u.protocol && u.host.endsWith(`.${m[2]}`);
}

export function frameHeadersVerdict(headers: Record<string, string | string[] | undefined>, platformOrigin: string): ProbeResult {
  const xfo = String(headers['x-frame-options'] ?? '').trim().toUpperCase();
  if (xfo === 'DENY' || xfo === 'SAMEORIGIN') return { embeddable: false, reason: 'X_FRAME_OPTIONS', probed: true, detail: `X-Frame-Options: ${xfo}` };
  const csp = ([] as string[]).concat(headers['content-security-policy'] ?? []).join(';');
  const fa = csp
    .split(';')
    .map((d) => d.trim())
    .find((d) => d.toLowerCase().startsWith('frame-ancestors'));
  if (!fa) return { embeddable: false, reason: 'FRAME_ANCESTORS_MISSING', probed: true, detail: 'no Content-Security-Policy frame-ancestors' };
  const sources = fa.split(/\s+/).slice(1);
  // 'self' is the app's own origin and 'none' nothing: only an explicit source can admit the platform
  if (!sources.some((s) => sourceAllows(s, platformOrigin))) {
    return { embeddable: false, reason: 'FRAME_ANCESTORS_MISSING', probed: true, detail: 'frame-ancestors does not include the platform origin' };
  }
  return { embeddable: true, reason: null, probed: true };
}

const TLS_ERRORS = /CERT|SELF_SIGNED|UNABLE_TO_VERIFY|UNABLE_TO_GET_ISSUER|ERR_TLS_CERT_ALTNAME_INVALID|HOSTNAME_MISMATCH/;

/** Default prober: resolve, refuse reserved addresses, TLS with the default trust store, read the headers of `GET /`. */
export function createHttpsProber(opts: { timeoutMs?: number; resolve?: (host: string) => Promise<{ address: string; family: number }[]> } = {}): PreviewProber {
  const timeoutMs = opts.timeoutMs ?? 3000;
  const resolve = opts.resolve ?? ((h: string) => dns.lookup(h, { all: true, verbatim: true }));
  return async (rawUrl, platformOrigin) => {
    let u: URL;
    try {
      u = new URL(rawUrl);
    } catch {
      return { embeddable: false, reason: 'UNREACHABLE', probed: false, detail: 'invalid URL' };
    }
    if (u.protocol !== 'https:') return { embeddable: false, reason: 'MIXED_CONTENT', probed: false };
    if (u.port && u.port !== '443') return { embeddable: false, reason: 'UNREACHABLE', probed: false, detail: 'only port 443 is probed' };
    const host = u.hostname.replace(/^\[|\]$/g, '');
    let addrs: { address: string; family: number }[];
    try {
      addrs = net.isIP(host) ? [{ address: host, family: net.isIP(host) }] : await resolve(host);
    } catch {
      return { embeddable: false, reason: 'UNREACHABLE', probed: true, detail: 'DNS resolution failed' };
    }
    const target = addrs.find((a) => !isBlockedAddress(a.address));
    if (!target || addrs.some((a) => isBlockedAddress(a.address))) return { embeddable: false, reason: 'UNREACHABLE', probed: true, detail: 'the address is not a public address' };
    const lookup: LookupFunction = (_h, o, cb) => {
      if ((o as { all?: boolean }).all) (cb as unknown as (e: null, a: { address: string; family: number }[]) => void)(null, [target]);
      else cb(null, target.address, target.family);
    };
    return new Promise<ProbeResult>((done) => {
      const req = https.request(
        { host, port: 443, path: '/', method: 'GET', lookup, ...(net.isIP(host) ? {} : { servername: host }), headers: { 'user-agent': 'atl-preview-probe/1', accept: 'text/html' }, timeout: timeoutMs, agent: false },
        (res) => {
          const verdict = frameHeadersVerdict(res.headers, platformOrigin);
          res.destroy();
          done(verdict);
        },
      );
      req.on('timeout', () => req.destroy(Object.assign(new Error('timeout'), { code: 'ETIMEDOUT' })));
      req.on('error', (e: NodeJS.ErrnoException) => {
        const code = String(e.code ?? e.message ?? '');
        done(TLS_ERRORS.test(code) ? { embeddable: false, reason: 'UNTRUSTED_CERT', probed: true, detail: code } : { embeddable: false, reason: 'UNREACHABLE', probed: true, detail: code || 'connection failed' });
      });
      req.end();
    });
  };
}

/** 60-second cache around a prober (03 §6.1). */
export function cachedProber(inner: PreviewProber, nowMs: () => number, ttlMs = 60_000): PreviewProber {
  const cache = new Map<string, { at: number; r: ProbeResult }>();
  return async (url, origin) => {
    const k = `${origin} ${url}`;
    const hit = cache.get(k);
    if (hit && nowMs() - hit.at < ttlMs) return hit.r;
    const r = await inner(url, origin);
    if (cache.size > 500) cache.clear();
    cache.set(k, { at: nowMs(), r });
    return r;
  };
}

// ---------------------------------------------------------------------------------------------------------------
// Entries

const LABELS: Record<PreviewTarget['id'], string> = { direct: '直连 EC2', cdn: 'CloudFront', alb: '负载均衡器', 'custom-domain': '自定义域名', app: '应用入口' };

function urlOf(v: unknown): string | null {
  if (typeof v === 'string' && /^https?:\/\//.test(v)) return v.replace(/\/+$/, '');
  if (v && typeof v === 'object') return urlOf((v as { baseUrl?: unknown; url?: unknown }).baseUrl ?? (v as { url?: unknown }).url);
  return null;
}

/** Entries of 03 §6.1 from `Environment.endpoints` (+ `LabSession.app.entryUrl`), de-duplicated by URL. */
export function previewEntries(endpoints: Record<string, unknown> | null | undefined, app: { entryUrl?: string | null } | null | undefined): { id: PreviewTarget['id']; url: string; via: string | null }[] {
  const e = endpoints ?? {};
  const raw: { id: PreviewTarget['id']; url: string | null; via: string | null }[] = [
    { id: 'direct', url: urlOf(e.direct) ?? urlOf(e.baseUrl), via: (e.https as { trusted?: boolean } | null | undefined)?.trusted ? 'letsencrypt-ip' : null },
    { id: 'cdn', url: urlOf(e.cdn) ?? urlOf(e.cdnBaseUrl), via: 'cloudfront' },
    { id: 'alb', url: urlOf(e.alb) ?? urlOf(e.loadBalancer) ?? urlOf(e.albBaseUrl), via: 'alb' },
    { id: 'custom-domain', url: urlOf(e.customDomain) ?? urlOf(e.customDomainUrl), via: 'custom-domain' },
    { id: 'app', url: urlOf(app?.entryUrl), via: null },
  ];
  const seen = new Set<string>();
  const out: { id: PreviewTarget['id']; url: string; via: string | null }[] = [];
  for (const r of raw) {
    if (!r.url || seen.has(r.url)) continue;
    seen.add(r.url);
    out.push({ id: r.id, url: r.url, via: r.via });
  }
  return out;
}

export async function previewTargets(entries: { id: PreviewTarget['id']; url: string; via: string | null }[], platformOrigin: string, probe: PreviewProber): Promise<PreviewTarget[]> {
  return Promise.all(
    entries.map(async (e) => {
      const r = await probe(e.url, platformOrigin).catch((err: unknown): ProbeResult => ({ embeddable: false, reason: 'UNREACHABLE', probed: false, detail: String(err) }));
      return { id: e.id, url: e.url, embeddable: r.embeddable, reason: r.reason, via: e.via, label: LABELS[e.id], probed: r.probed, ...(r.detail ? { detail: r.detail } : {}) };
    }),
  );
}
