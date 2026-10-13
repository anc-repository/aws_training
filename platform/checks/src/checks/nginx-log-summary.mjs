// nginx-log-summary (04 §6.4; 06 PM-18): reads the tail of the JSON access log. `nonce` counts every line whose query
// string has `atlprobe=<nonce>` (probe lines included — the platform's own requests carry the nonce); `counts` exclude
// `probe=1` lines. `cfIds` reports whether each CloudFront request id reached the origin.
import fs from 'node:fs';
import { parsePathHeader } from '../lib/http.mjs';

const TAIL_BYTES = 8 * 1024 * 1024;

export function parseDuration(s) {
  const m = /^(\d{1,4})([smh])$/.exec(s);
  if (!m) return null;
  return Number(m[1]) * (m[2] === 's' ? 1000 : m[2] === 'm' ? 60_000 : 3_600_000);
}

export function readTailLines(file) {
  let fd;
  try {
    fd = fs.openSync(file, 'r');
  } catch {
    return null;
  }
  try {
    const size = fs.fstatSync(fd).size;
    const start = Math.max(0, size - TAIL_BYTES);
    const buf = Buffer.alloc(size - start);
    fs.readSync(fd, buf, 0, buf.length, start);
    const lines = buf.toString('utf8').split('\n');
    if (start > 0) lines.shift();
    return lines;
  } finally {
    fs.closeSync(fd);
  }
}

function argsHas(args, key, value) {
  if (typeof args !== 'string' || !args) return false;
  return args.split('&').some((kv) => {
    const i = kv.indexOf('=');
    return i > 0 && kv.slice(0, i) === key && decodeURIComponent(kv.slice(i + 1)) === value;
  });
}

export function summarize(lines, args, now = Date.now()) {
  const windowMs = parseDuration(args.window ?? '10m');
  const since = now - windowMs;
  const counts = { total: 0, byStatus: {}, byPort: {}, ...(args.groupBy ? { byGroup: {} } : {}) };
  const nonce = args.nonce ? { count: 0, ports: [], firstTs: null } : undefined;
  const cfSeen = new Map((args.cfIds ?? []).map((id) => [id, false]));
  for (const line of lines) {
    if (!line.trim()) continue;
    let r;
    try {
      r = JSON.parse(line);
    } catch {
      continue;
    }
    const ts = Date.parse(r.ts);
    if (!Number.isFinite(ts) || ts < since) continue;
    if (nonce && argsHas(r.args, 'atlprobe', args.nonce)) {
      nonce.count++;
      const port = Number(r.port);
      if (Number.isFinite(port) && !nonce.ports.includes(port)) nonce.ports.push(port);
      if (!nonce.firstTs || r.ts < nonce.firstTs) nonce.firstTs = r.ts;
    }
    if (r.cf_id && cfSeen.has(r.cf_id)) cfSeen.set(r.cf_id, true);
    if (String(r.probe) === '1') continue;
    if (args.path && !(typeof r.uri === 'string' && r.uri.startsWith(args.path))) continue;
    counts.total++;
    const sc = `${String(r.status).charAt(0)}xx`;
    counts.byStatus[sc] = (counts.byStatus[sc] ?? 0) + 1;
    counts.byPort[String(r.port ?? '')] = (counts.byPort[String(r.port ?? '')] ?? 0) + 1;
    if (args.groupBy) {
      let g;
      if (args.groupBy === 'entry') g = parsePathHeader(r.path).entry ?? 'unknown';
      else if (args.groupBy === 'via-cloudfront') g = r.cf_id || /cloudfront/i.test(r.via ?? '') ? 'cloudfront' : 'direct';
      else g = r.alb_trace ? 'alb' : 'direct';
      counts.byGroup[g] = (counts.byGroup[g] ?? 0) + 1;
    }
  }
  return {
    window: args.window ?? '10m',
    counts,
    ...(nonce ? { nonce } : {}),
    ...(args.cfIds ? { cfIds: [...cfSeen.entries()].map(([id, seen]) => ({ id, seen })) } : {}),
  };
}

export default async function nginxLogSummary(args, ctx) {
  const lines = readTailLines(ctx.paths.nginxLog);
  if (lines === null) return { logPresent: false, ...summarize([], args) };
  return { logPresent: true, ...summarize(lines, args) };
}
