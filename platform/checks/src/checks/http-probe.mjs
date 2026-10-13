// http-probe (04 §6.4, §5.2.3 `from: lab`): requests from the lab instance to the local targets (self, origin-private,
// cdn-origin) or to an entry the platform resolved from the control plane (cdn, cdn-alias, tls-domain, public-dns, alb):
// those arrive as `host` in the args. Requests to /api/lab/probe/* carry the probe token automatically: the local token on
// loopback targets, one-time tokens (one per request) otherwise (06 PM-09, PM-13). Tokens never appear in the output.
import { CheckError } from '../lib/context.mjs';
import { probe } from '../lib/http.mjs';

const ALLOWED_HEADERS = {
  Accept: /^[A-Za-z0-9*/.+;=, -]{1,128}$/,
  'Accept-Encoding': /^[a-z0-9*,; =.-]{1,64}$/,
  'X-Compare-Bypass': /^[A-Za-z0-9_-]{1,32}$/,
  Authorization: /^Bearer probe$/,
  Cookie: /^ca_probe=1$/,
};
const LOCAL = new Set(['self', 'origin-private', 'cdn-origin']);

function baseUrl(args, ctx) {
  if (args.target === 'self') return { url: ctx.dev ? ctx.appBaseUrl : 'http://127.0.0.1', hostHeader: args.hostHeader ?? null };
  if (args.target === 'origin-private') {
    if (ctx.dev) return { url: ctx.appBaseUrl, hostHeader: null };
    const ip = ctx.networkAddresses().find((a) => /^(10|172|192)\./.test(a));
    if (!ip) throw new CheckError('TARGET_UNRESOLVED', 'no private IPv4 address on this host');
    return { url: `http://${ip}`, hostHeader: null };
  }
  if (args.target === 'cdn-origin') {
    if (ctx.dev) return { url: ctx.appBaseUrl, hostHeader: null };
    const port = Number(ctx.moduleEnv('cdn')?.CDN_ORIGIN_PORT ?? 8080);
    if (!Number.isInteger(port) || port < 1 || port > 65535) throw new CheckError('TARGET_UNRESOLVED', 'bad CDN_ORIGIN_PORT');
    return { url: `http://127.0.0.1:${port}`, hostHeader: null };
  }
  if (!args.host) throw new CheckError('TARGET_UNRESOLVED', `target ${args.target} needs a host resolved by the platform`);
  const scheme = args.scheme ?? 'https';
  return { url: `${scheme}://${args.host}${args.port ? `:${args.port}` : ''}`, hostHeader: null };
}

export default async function httpProbe(args, ctx) {
  const { url, hostHeader } = baseUrl(args, ctx);
  if (!url) throw new CheckError('RUNNER_UNAVAILABLE', 'no local CloudAlbum to probe');
  const headers = {};
  for (const [k, v] of Object.entries(args.headers ?? {})) {
    if (!ALLOWED_HEADERS[k] || typeof v !== 'string' || !ALLOWED_HEADERS[k].test(v)) throw new CheckError('NOT_ALLOWED', `header not allowed: ${k}`);
    headers[k] = v;
  }
  if (hostHeader) headers.Host = hostHeader;
  if (args.nonce) headers['X-ATL-Probe-Nonce'] = args.nonce;
  const repeat = args.repeat ?? 1;
  const isProbePath = args.path.startsWith('/api/lab/probe/');
  let perRequestHeaders;
  if (isProbePath) {
    if (LOCAL.has(args.target)) {
      const t = ctx.localProbeToken();
      if (!t) throw new CheckError('RUNNER_UNAVAILABLE', 'local probe token missing (cloudalbum probe-token --init)');
      headers['X-ATL-Probe-Token'] = t;
    } else {
      const { tokens } = await ctx.oneTimeProbeTokens(repeat + (args.stripQuery ? 1 : 0), 60);
      perRequestHeaders = (i) => ({ 'X-ATL-Probe-Token': tokens[i] });
    }
  }
  const responses = await probe({ url: `${url}${args.path}`, method: args.method ?? 'GET', headers, repeat, intervalMs: args.intervalMs ?? 500, timeoutMs: 10_000, perRequestHeaders });
  const out = { target: args.target, responses };
  if (args.stripQuery && args.path.includes('?')) {
    const stripped = args.path.slice(0, args.path.indexOf('?'));
    const r2 = await probe({
      url: `${url}${stripped}`,
      method: args.method ?? 'GET',
      headers,
      repeat: 1,
      timeoutMs: 10_000,
      perRequestHeaders: perRequestHeaders ? () => perRequestHeaders(repeat) : undefined,
    });
    out.unsigned = r2[0];
  }
  return out;
}
