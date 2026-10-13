// tls-handshake (04 §6.4): certificate of an entry (issuer, subject, SANs, expiry, protocol). The platform passes the
// host it resolved for the target (cdn, cdn-alias, tls-domain, public-dns, alb); `self` handshakes with 127.0.0.1:443.
import tls from 'node:tls';
import { CheckError } from '../lib/context.mjs';

export default async function tlsHandshake(args, ctx) {
  const host = args.target === 'self' ? '127.0.0.1' : args.host;
  if (!host) throw new CheckError('TARGET_UNRESOLVED', `target ${args.target} needs a host resolved by the platform`);
  const servername = args.target === 'self' ? args.servername ?? undefined : args.host;
  const port = args.port ?? 443;
  if (ctx.dev && args.target === 'self') return { issuer: null, subject: null, subjectAltNames: [], notAfter: null, protocol: null, dev: true };
  return new Promise((resolve, reject) => {
    const s = tls.connect({ host, port, servername, rejectUnauthorized: false, timeout: 8000 }, () => {
      const c = s.getPeerCertificate(false);
      const sans = typeof c.subjectaltname === 'string' ? c.subjectaltname.split(/,\s*/).map((x) => x.replace(/^DNS:/, '').replace(/^IP Address:/, '')) : [];
      const out = {
        issuer: c.issuer?.O ?? c.issuer?.CN ?? null,
        subject: c.subject?.CN ?? null,
        subjectAltNames: sans,
        notAfter: c.valid_to ? new Date(c.valid_to).toISOString() : null,
        protocol: s.getProtocol(),
        authorized: s.authorized,
        authorizationError: s.authorized ? null : String(s.authorizationError ?? ''),
      };
      s.end();
      resolve(out);
    });
    s.on('timeout', () => {
      s.destroy();
      reject(new CheckError('TIMEOUT', `TLS handshake with ${host} timed out`));
    });
    s.on('error', (e) => reject(new CheckError('NETWORK', `TLS ${host}: ${e.code ?? e.message}`)));
  });
}
