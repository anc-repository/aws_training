/**
 * experiments/tls/lib.ts —— tls 实验共用：各入口（直连、CDN、ALB、有效入口 URL）、一次握手读证书（等价于
 * `openssl s_client -connect host:443 -servername host` + `openssl x509 -noout -issuer -subject -dates -ext subjectAltName`）、
 * 握手计时（curl 的 time_appconnect - time_connect）、nmap ssl-enum-ciphers 的解析，以及 tls 感知器的服务端证据。
 */
import tls from 'node:tls';
import type { ScenarioContext } from '../_lib/scenario.js';
import { strParam } from '../_lib/scenario.js';

export interface TlsEntry { entry: 'direct' | 'cdn' | 'alb' | 'entry'; host: string; port: number; servername?: string }

function hostOf(url: string | undefined): string {
  if (!url) return '';
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return '';
  }
}

function rec(v: unknown): Record<string, unknown> {
  return v && typeof v === 'object' ? (v as Record<string, unknown>) : {};
}

/**
 * 被测入口：--param hosts=direct=1.2.3.4,cdn=dxxx.cloudfront.net > capabilities（ec2 的 publicIpv4、cdn 的 baseUrl、app.entry、
 * tls 的 domain）> 运行器目标。直连的 SNI 用 TLS_DOMAIN（有域名时），与 Nginx 的 server_name _ 无关。
 */
export function tlsEntries(ctx: Pick<ScenarioContext, 'params' | 'capabilities' | 'target'>): TlsEntry[] {
  const explicit = strParam(ctx, 'hosts', '');
  if (explicit) {
    return explicit.split(',').map((x) => x.trim()).filter(Boolean).map((x) => {
      const [k, v] = x.includes('=') ? x.split('=', 2) as [string, string] : ['entry', x];
      const entry = (['direct', 'cdn', 'alb', 'entry'].includes(k) ? k : 'entry') as TlsEntry['entry'];
      return { entry, host: v, port: 443, servername: v };
    });
  }
  const caps = ctx.capabilities;
  const tlsData = rec(caps.modules?.tls?.data);
  const domain = typeof tlsData.domain === 'string' && tlsData.domain ? tlsData.domain : '';
  const ip = String(rec(caps.modules?.ec2?.data).publicIpv4 ?? '') || (/^\d+(\.\d+){3}$/.test(hostOf(ctx.target)) ? hostOf(ctx.target) : '');
  const out: TlsEntry[] = [];
  const directHost = ip || hostOf(ctx.target);
  if (directHost) out.push({ entry: 'direct', host: directHost, port: 443, ...(domain ? { servername: domain } : {}) });
  const cdn = hostOf(String(rec(caps.modules?.cdn?.public).baseUrl ?? rec(caps.modules?.cdn?.data).baseUrl ?? ''));
  if (cdn) out.push({ entry: 'cdn', host: cdn, port: 443, servername: cdn });
  const entry = caps.app?.entry;
  const eh = entry?.baseUrl?.startsWith('https://') ? hostOf(entry.baseUrl) : '';
  if (eh && !out.some((e) => e.host === eh)) out.push({ entry: 'entry', host: eh, port: 443, servername: eh });
  return out;
}

export interface CertInfo {
  entry: TlsEntry['entry'];
  host: string;
  servername?: string;
  ok: boolean;
  error?: string;
  issuer?: string;
  subject?: string;
  sans?: string[];
  notBefore?: string;
  notAfter?: string;
  daysLeft?: number;
  serial?: string;
  protocol?: string | null;
  cipher?: string;
  alpn?: string | false | null;
  trusted?: boolean;
  trustError?: string | null;
  /** TCP 连接完成 → TLS 握手完成（毫秒） */
  handshakeMs?: number;
  connectMs?: number;
}

const first = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v);

/** 一次全新的 TLS 握手（不复用会话）：证书、协议、套件、ALPN、链是否受信任、握手耗时 */
export function inspectEntry(e: TlsEntry, timeoutMs = 8000): Promise<CertInfo> {
  return new Promise((resolve) => {
    const t0 = performance.now();
    let tConnect: number | undefined;
    let done = false;
    const finish = (c: CertInfo) => { if (!done) { done = true; resolve(c); } };
    const s = tls.connect({
      host: e.host, port: e.port, rejectUnauthorized: false, ALPNProtocols: ['h2', 'http/1.1'],
      ...(e.servername && !/^\d+(\.\d+){3}$/.test(e.servername) ? { servername: e.servername } : {}),
    }, () => {
      const t1 = performance.now();
      const c = s.getPeerCertificate(false);
      const sans = typeof c.subjectaltname === 'string' ? c.subjectaltname.split(/,\s*/).map((x) => x.replace(/^(DNS|IP Address):/, '')) : [];
      const notAfter = c.valid_to ? new Date(c.valid_to).toISOString() : undefined;
      finish({
        entry: e.entry, host: e.host, ...(e.servername ? { servername: e.servername } : {}), ok: true,
        issuer: first(c.issuer?.O) ?? first(c.issuer?.CN), subject: first(c.subject?.CN), sans,
        notBefore: c.valid_from ? new Date(c.valid_from).toISOString() : undefined, notAfter,
        daysLeft: notAfter ? Math.floor((Date.parse(notAfter) - Date.now()) / 86_400_000) : undefined,
        serial: c.serialNumber, protocol: s.getProtocol(), cipher: s.getCipher()?.name, alpn: s.alpnProtocol ?? null,
        trusted: s.authorized, trustError: s.authorized ? null : String(s.authorizationError ?? ''),
        handshakeMs: tConnect !== undefined ? Math.round((t1 - tConnect) * 10) / 10 : undefined,
        connectMs: tConnect !== undefined ? Math.round((tConnect - t0) * 10) / 10 : undefined,
      });
      s.end();
    });
    s.once('connect', () => { tConnect = performance.now(); });
    s.setTimeout(timeoutMs, () => { s.destroy(); finish({ entry: e.entry, host: e.host, ok: false, error: 'TIMEOUT' }); });
    s.once('error', (err: NodeJS.ErrnoException) => finish({ entry: e.entry, host: e.host, ok: false, error: err.code ?? err.message }));
  });
}

/** 证书来源的分类：自签名 / Let's Encrypt / Amazon（ACM）/ CloudFront 默认证书 */
export function certKind(c: CertInfo): 'selfsigned' | 'letsencrypt' | 'amazon' | 'cf-default' | 'other' | 'unknown' {
  if (!c.ok) return 'unknown';
  if (c.sans?.includes('*.cloudfront.net')) return 'cf-default';
  if (/amazon/i.test(c.issuer ?? '')) return 'amazon';
  if (/let'?s encrypt/i.test(c.issuer ?? '')) return 'letsencrypt';
  if (c.trusted === false && (c.issuer === c.subject || /cloudalbum-l0/.test(c.issuer ?? ''))) return 'selfsigned';
  return c.trusted ? 'other' : 'selfsigned';
}

export interface CipherScan { protocols: string[]; ciphers: Record<string, string[]>; leastStrength?: string }

/** `nmap --script ssl-enum-ciphers -p 443 <host>` 的输出 → 协议、各协议的套件、最低强度等级 */
export function parseSslEnumCiphers(text: string): CipherScan {
  const protocols: string[] = [];
  const ciphers: Record<string, string[]> = {};
  let current: string | undefined;
  let inCiphers = false;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.replace(/^\|[_ ]?\s*/, '').trimEnd();
    const proto = /^\s*(TLSv1(\.\d)?|SSLv3):\s*$/.exec(line);
    if (proto) {
      current = proto[1]!;
      protocols.push(current);
      ciphers[current] = [];
      inCiphers = false;
      continue;
    }
    if (/^\s*ciphers:\s*$/.test(line)) { inCiphers = true; continue; }
    if (/^\s*(compressors|cipher preference|warnings):/.test(line)) { inCiphers = false; continue; }
    const c = /^\s*((?:TLS|SSL)_[A-Z0-9_]+)\b/.exec(line);
    if (inCiphers && current && c) ciphers[current]!.push(c[1]!);
  }
  const least = /least strength:\s*([A-F])/.exec(text)?.[1];
  return { protocols, ciphers, ...(least ? { leastStrength: least } : {}) };
}

/** 服务端证据：tls 感知器（实例上对 127.0.0.1:443 等入口的握手、via、续期定时器）与 capabilities.https */
export async function serverEvidence(ctx: ScenarioContext): Promise<Record<string, unknown>> {
  const caps = await ctx.client.get('/api/capabilities', { record: false }).catch(() => undefined);
  if (!caps?.ok) return {};
  const j = caps.json<Record<string, unknown>>();
  const tlsMod = rec(rec(j.modules).tls);
  return {
    https: j.https ?? null,
    tls: { driver: tlsMod.driver ?? null, status: tlsMod.status ?? null, via: rec(tlsMod.data).via ?? null, entries: rec(tlsMod.data).entries ?? null },
  };
}
