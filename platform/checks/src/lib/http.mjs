// HTTP(S) probe used by http-probe / tls-handshake / capability-snapshot: no redirects, ≤ 64 KB body, JSON only parsed,
// repeated requests reuse one keep-alive connection (04 §5.2.3), TLS verification on, peer and certificate recorded.
import http from 'node:http';
import https from 'node:https';
import { CheckError } from './context.mjs';

export const MAX_BODY = 64 * 1024;

/** `x-cloudalbum-path: entry=cloudfront>nginx;inst=i-…;az=…` → `{ entry: 'cloudfront>nginx', inst: 'i-…', az: '…' }`. */
export function parsePathHeader(v) {
  const out = {};
  if (typeof v !== 'string' || !v) return out;
  for (const part of v.split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = part.slice(i + 1).trim();
  }
  return out;
}

function lowerHeaders(h) {
  const out = {};
  for (const [k, v] of Object.entries(h ?? {})) out[k.toLowerCase()] = Array.isArray(v) ? v.join(', ') : String(v);
  return out;
}

function certInfo(sock) {
  if (!sock || typeof sock.getPeerCertificate !== 'function') return undefined;
  const c = sock.getPeerCertificate(false);
  if (!c || !c.subject) return undefined;
  const sans = typeof c.subjectaltname === 'string' ? c.subjectaltname.split(/,\s*/).map((s) => s.replace(/^DNS:/, '').replace(/^IP Address:/, '')) : [];
  return {
    subject: c.subject.CN ?? null,
    subjectAltNames: sans,
    issuer: c.issuer?.O ?? c.issuer?.CN ?? null,
    notAfter: c.valid_to ? new Date(c.valid_to).toISOString() : null,
    protocol: typeof sock.getProtocol === 'function' ? sock.getProtocol() : null,
  };
}

/**
 * Send `repeat` requests over one connection. `url` is absolute; `connectHost` (optional) is the address to dial while
 * SNI / Host use the URL host (DNS-rebinding safe callers pass the validated IP).
 */
export async function probe({ url, method = 'GET', headers = {}, repeat = 1, intervalMs = 500, timeoutMs = 10_000, connectHost, perRequestHeaders }) {
  const u = new URL(url);
  const isHttps = u.protocol === 'https:';
  const mod = isHttps ? https : http;
  const agent = new mod.Agent({ keepAlive: true, maxSockets: 1 });
  const responses = [];
  let lastSocket = null;
  try {
    for (let i = 0; i < repeat; i++) {
      if (i > 0) await new Promise((r) => setTimeout(r, intervalMs));
      const extra = perRequestHeaders ? perRequestHeaders(i) : {};
      const t0 = Date.now();
      const r = await new Promise((resolve, reject) => {
        const req = mod.request(
          {
            host: connectHost ?? u.hostname,
            port: u.port || (isHttps ? 443 : 80),
            path: `${u.pathname}${u.search}`,
            method,
            agent,
            servername: isHttps ? u.hostname : undefined,
            headers: { Host: u.host, 'User-Agent': 'atl-check/1', ...headers, ...extra },
            timeout: timeoutMs,
          },
          (res) => {
            const chunks = [];
            let size = 0;
            res.on('data', (d) => {
              size += d.length;
              if (size <= MAX_BODY) chunks.push(d);
            });
            res.on('end', () => {
              const sock = res.socket;
              const reconnected = lastSocket !== null && sock !== lastSocket;
              lastSocket = sock;
              const hdrs = lowerHeaders(res.headers);
              const body = Buffer.concat(chunks).toString('utf8');
              let json;
              if ((hdrs['content-type'] ?? '').includes('json')) {
                try {
                  json = JSON.parse(body);
                } catch {
                  json = undefined;
                }
              }
              resolve({
                status: res.statusCode ?? 0,
                headers: hdrs,
                ...(json !== undefined ? { json } : {}),
                pathSegments: parsePathHeader(hdrs['x-cloudalbum-path']),
                timingMs: Date.now() - t0,
                peer: { address: sock?.remoteAddress ?? null, family: sock?.remoteFamily ?? null },
                ...(isHttps ? { tls: certInfo(sock) } : {}),
                ...(reconnected ? { reconnected: true } : {}),
                ...(size > MAX_BODY ? { bodyTruncated: true } : {}),
              });
            });
            res.on('error', reject);
          },
        );
        req.on('timeout', () => req.destroy(new CheckError('TIMEOUT', `request to ${u.host} timed out`)));
        req.on('error', (e) => reject(e instanceof CheckError ? e : new CheckError('NETWORK', `${u.host}: ${e.code ?? e.message}`)));
        req.end();
      });
      responses.push(r);
    }
  } finally {
    agent.destroy();
  }
  return responses;
}
