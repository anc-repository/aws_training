/**
 * Shared egress guard for platform-side HTTP probes (01 §3.2 `safe-fetch`, 04 §5.2.3): the host is resolved by the
 * platform, every resolved address is checked (private, loopback, link-local, ULA, multicast, reserved → rejected), the
 * request connects to the validated IP while SNI and `Host` keep the hostname (no DNS rebinding window), ports 80/443
 * plus explicitly enumerated ones, no redirects, ≤ 64 KB body, only JSON bodies parsed, TLS verification on, peer address
 * and certificate recorded. Repeated requests reuse one keep-alive connection; a reconnect is reported.
 *
 * 01 asks for one implementation at `platform/api/src/net/safe-fetch.ts` shared with atl-api's preview probe; this file is
 * that implementation, placed with atl-checks until the integration moves it (implementation-notes platform-checks).
 */
import dns from 'node:dns/promises';
import http from 'node:http';
import https from 'node:https';
import type { Socket } from 'node:net';
import type { TLSSocket } from 'node:tls';
import { isForbiddenAddress } from './net.js';
import { ProbeError, type HttpProbePort, type HttpProbeRequest, type HttpProbeResponse } from './ports.js';

export const MAX_BODY_BYTES = 64 * 1024;

export function parsePathHeader(v: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  if (!v) return out;
  for (const part of v.split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = part.slice(i + 1).trim();
  }
  return out;
}

export interface SafeFetchOptions {
  /** Dev / tests only: allow loopback and private addresses. */
  allowPrivate?: boolean;
  lookup?: (host: string) => Promise<string[]>;
  /** Trust store override for tests (PEM). */
  ca?: string | Buffer;
}

async function defaultLookup(host: string): Promise<string[]> {
  const r = await dns.lookup(host, { all: true, verbatim: true });
  return r.map((a) => a.address);
}

export class SafeFetch implements HttpProbePort {
  constructor(private readonly opts: SafeFetchOptions = {}) {}

  async resolve(host: string): Promise<string[]> {
    try {
      return await (this.opts.lookup ?? defaultLookup)(host);
    } catch (e) {
      throw new ProbeError('TARGET_UNRESOLVED', `cannot resolve ${host}: ${(e as NodeJS.ErrnoException).code ?? String(e)}`);
    }
  }

  async fetch(req: HttpProbeRequest & { keepBody?: boolean }): Promise<HttpProbeResponse[]> {
    let u: URL;
    try {
      u = new URL(req.url);
    } catch {
      throw new ProbeError('TARGET_UNRESOLVED', 'invalid URL');
    }
    if (u.protocol !== 'http:' && u.protocol !== 'https:') throw new ProbeError('TARGET_UNRESOLVED', `scheme ${u.protocol} not allowed`);
    if (u.username || u.password) throw new ProbeError('TARGET_UNRESOLVED', 'credentials in URL are not allowed');
    const isHttps = u.protocol === 'https:';
    const port = u.port ? Number(u.port) : isHttps ? 443 : 80;
    if (![80, 443, ...(req.extraPorts ?? [])].includes(port)) throw new ProbeError('TARGET_UNRESOLVED', `port ${port} not allowed`);
    const hostname = u.hostname.replace(/^\[|\]$/g, '');
    const addresses = await this.resolve(hostname);
    if (addresses.length === 0) throw new ProbeError('TARGET_UNRESOLVED', `${hostname} has no addresses`);
    if (!this.opts.allowPrivate) {
      const bad = addresses.filter((a) => isForbiddenAddress(a));
      if (bad.length) throw new ProbeError('TARGET_UNRESOLVED', `${hostname} resolves to a forbidden address`);
    }
    const ip = addresses[0]!;
    const mod = isHttps ? https : http;
    const agent = new (isHttps ? https.Agent : http.Agent)({
      keepAlive: true,
      maxSockets: 1,
      // connect to the validated IP only (DNS rebinding safe); SNI / Host keep the hostname
      lookup: (_h: string, _o: unknown, cb: (err: Error | null, address: string, family: number) => void) => cb(null, ip, ip.includes(':') ? 6 : 4),
    } as https.AgentOptions);
    const out: HttpProbeResponse[] = [];
    let lastSocket: Socket | null = null;
    try {
      for (let i = 0; i < req.repeat; i++) {
        if (i > 0) await new Promise((r) => setTimeout(r, req.intervalMs));
        const extra = req.perRequestHeaders ? req.perRequestHeaders(i) : {};
        const t0 = Date.now();
        const r = await new Promise<HttpProbeResponse>((resolve, reject) => {
          const cr = mod.request(
            {
              protocol: u.protocol,
              host: hostname,
              port,
              path: `${u.pathname}${u.search}`,
              method: req.method,
              agent,
              headers: { Host: u.host, 'User-Agent': 'atl-checks/1', ...req.headers, ...extra },
              timeout: req.timeoutMs,
              ...(isHttps ? { servername: hostname, rejectUnauthorized: true, ...(this.opts.ca ? { ca: this.opts.ca } : {}) } : {}),
            },
            (res) => {
              const chunks: Buffer[] = [];
              let size = 0;
              res.on('data', (d: Buffer) => {
                size += d.length;
                if (size <= MAX_BODY_BYTES) chunks.push(d);
              });
              res.on('end', () => {
                const sock = res.socket as Socket;
                const reconnected = lastSocket !== null && sock !== lastSocket;
                lastSocket = sock;
                const headers: Record<string, string> = {};
                for (const [k, v] of Object.entries(res.headers)) headers[k.toLowerCase()] = Array.isArray(v) ? v.join(', ') : String(v ?? '');
                const body = Buffer.concat(chunks).toString('utf8');
                let json: unknown;
                if ((headers['content-type'] ?? '').includes('json')) {
                  try {
                    json = JSON.parse(body);
                  } catch {
                    json = undefined;
                  }
                }
                const resp: HttpProbeResponse = {
                  status: res.statusCode ?? 0,
                  headers,
                  ...(json !== undefined ? { json } : {}),
                  ...(req.keepBody ? { bodyText: body.slice(0, 16 * 1024) } : {}),
                  pathSegments: parsePathHeader(headers['x-cloudalbum-path']),
                  timingMs: Date.now() - t0,
                  peer: { address: sock?.remoteAddress ?? null, family: sock?.remoteFamily ?? null },
                  ...(reconnected ? { reconnected: true } : {}),
                  dns: { host: hostname, addresses },
                };
                if (isHttps) {
                  const c = (sock as TLSSocket).getPeerCertificate?.(false);
                  if (c && c.subject) {
                    resolve({
                      ...resp,
                      tls: {
                        subject: (c.subject.CN as string | undefined) ?? null,
                        subjectAltNames: typeof c.subjectaltname === 'string' ? c.subjectaltname.split(/,\s*/).map((s) => s.replace(/^DNS:/, '').replace(/^IP Address:/, '')) : [],
                        issuer: (c.issuer?.O as string | undefined) ?? (c.issuer?.CN as string | undefined) ?? null,
                        notAfter: c.valid_to ? new Date(c.valid_to).toISOString() : null,
                        protocol: (sock as TLSSocket).getProtocol?.() ?? null,
                      },
                    });
                    return;
                  }
                }
                resolve(resp);
              });
              res.on('error', (e) => reject(new ProbeError('NETWORK', e.message)));
            },
          );
          cr.on('timeout', () => cr.destroy(new ProbeError('TIMEOUT', `request to ${hostname} timed out`)));
          cr.on('error', (e) => reject(e instanceof ProbeError ? e : new ProbeError('NETWORK', `${hostname}: ${(e as NodeJS.ErrnoException).code ?? e.message}`)));
          cr.end();
        });
        out.push(r);
      }
    } finally {
      agent.destroy();
    }
    return out;
  }
}
