/**
 * The certificate verification algorithm of 04 §10.5 as dependency-free JavaScript source, shared verbatim by the static
 * verify page (`verify/verify.js`), the offline tool (`verify.mjs` in the offline bundle) and the server-side tests.
 * Runs in browsers and Node ≥ 20 (WebCrypto `crypto.subtle`, `TextEncoder`, `atob`); no `eval`, no network access —
 * the caller passes the documents it fetched.
 *
 * `atlVerify({ jws, jwks, revocationsJws?, reports?, now? })` → `{ status, ... }` where status is one of
 * `valid`, `revoked`, `invalid-signature`, `unknown-key`, `key-not-valid`, `wrong-type`, `bad-payload`, `malformed`.
 */
export const VERIFY_CORE_JS = String.raw`
const ATL_DISCLAIMER = '本证明由部署在学员自己 AWS 账号中的自托管 AWS Training Lab 实例自动签发，表示该实例记录到持有人完成了所列实验；它不是 AWS 官方认证，也不代表任何 AWS 认证资格。签发者与持有人可能是同一人，验证结果只说明“该实例签发了此内容”。';

function atlB64uToBytes(s) {
  if (!/^[A-Za-z0-9_-]*$/.test(s)) throw new Error('bad base64url');
  const b64 = s.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (s.length % 4)) % 4);
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function atlDecode(jws) {
  const parts = String(jws).trim().split('.');
  if (parts.length !== 3) throw new Error('not a compact JWS');
  const dec = new TextDecoder();
  return {
    header: JSON.parse(dec.decode(atlB64uToBytes(parts[0]))),
    payloadBytes: atlB64uToBytes(parts[1]),
    payload: JSON.parse(dec.decode(atlB64uToBytes(parts[1]))),
    signingInput: parts[0] + '.' + parts[1],
    signature: atlB64uToBytes(parts[2]),
  };
}

async function atlVerifySig(d, jwk) {
  if (d.signature.length !== 64) return false;
  const key = await crypto.subtle.importKey('jwk', { kty: 'EC', crv: 'P-256', x: jwk.x, y: jwk.y, ext: true }, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['verify']);
  return crypto.subtle.verify({ name: 'ECDSA', hash: 'SHA-256' }, key, d.signature, new TextEncoder().encode(d.signingInput));
}

function atlCanonical(v) {
  if (v === null) return 'null';
  if (typeof v === 'boolean') return v ? 'true' : 'false';
  if (typeof v === 'number') { if (!isFinite(v)) throw new Error('non-finite'); return JSON.stringify(v); }
  if (typeof v === 'string') return JSON.stringify(v);
  if (Array.isArray(v)) return '[' + v.map(atlCanonical).join(',') + ']';
  const keys = Object.keys(v).filter((k) => v[k] !== undefined).sort();
  return '{' + keys.map((k) => JSON.stringify(k) + ':' + atlCanonical(v[k])).join(',') + '}';
}

async function atlSha256Hex(s) {
  const h = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s));
  return Array.from(new Uint8Array(h)).map((b) => b.toString(16).padStart(2, '0')).join('');
}

/** Digest of an atl.report/v1 object (RFC 8785 of the report without integrity). */
async function atlReportDigest(report) {
  const copy = Object.assign({}, report);
  delete copy.integrity;
  return 'sha256:' + (await atlSha256Hex(atlCanonical(copy)));
}

async function atlVerify(input) {
  const out = { status: 'malformed', disclaimer: ATL_DISCLAIMER };
  let d;
  try { d = atlDecode(input.jws); } catch (e) { out.detail = String(e && e.message || e); return out; }
  out.header = d.header; out.payload = d.payload;
  if (d.header.alg !== 'ES256' || d.header.typ !== 'atl-cert+jws') { out.status = 'wrong-type'; return out; }
  const keys = (input.jwks && input.jwks.keys) || [];
  const jwk = keys.find((k) => k.kid === d.header.kid);
  out.kid = d.header.kid;
  if (!jwk) { out.status = 'unknown-key'; return out; }
  const issuedAt = Date.parse(d.payload.issuedAt);
  const from = jwk['atl:validFrom'] ? Date.parse(jwk['atl:validFrom']) : -Infinity;
  const to = jwk['atl:validTo'] ? Date.parse(jwk['atl:validTo']) : Infinity;
  if (!(issuedAt >= from && issuedAt <= to)) { out.status = 'key-not-valid'; return out; }
  if (!(await atlVerifySig(d, jwk))) { out.status = 'invalid-signature'; return out; }
  const p = d.payload;
  const origins = (input.jwks && input.jwks.origins) || [];
  if (p.v !== 1 || p.nature !== 'self-hosted-self-signed' || !p.issuer || (origins.length && origins.indexOf(p.issuer.origin) < 0)) { out.status = 'bad-payload'; return out; }
  if (input.revocationsJws) {
    try {
      const r = atlDecode(input.revocationsJws);
      const rk = keys.find((k) => k.kid === r.header.kid);
      if (r.header.typ === 'atl-revocations+jws' && rk && (await atlVerifySig(r, rk))) {
        out.revocationsSeq = r.payload.seq;
        const hit = (r.payload.entries || []).find((e) => e.certId === p.certId);
        if (hit) { out.status = 'revoked'; out.revocation = hit; return out; }
      } else out.revocationsWarning = 'revocation list signature not verified';
    } catch (e) { out.revocationsWarning = 'revocation list unreadable'; }
  } else out.revocationsWarning = 'no revocation list available';
  out.status = 'valid';
  if (input.reports && p.achievement) {
    const labs = p.achievement.labs || (p.evidence ? [{ labId: p.achievement.labId, reportDigest: p.evidence.reportDigest }] : []);
    out.reports = [];
    for (const l of labs) {
      const rep = input.reports.find((r) => r && r.lab && r.lab.id === l.labId);
      if (!rep) continue;
      const dg = await atlReportDigest(rep);
      out.reports.push({ labId: l.labId, consistent: dg === l.reportDigest });
    }
  }
  return out;
}
`;

/** Browser script of the verify page (`verify/verify.js`, CSP `script-src 'self'`). */
export const VERIFY_PAGE_JS = `${VERIFY_CORE_JS}
(function () {
  function el(id) { return document.getElementById(id); }
  function text(id, s) { var e = el(id); if (e) e.textContent = s; }
  var LABELS = { valid: '有效', revoked: '已吊销', 'invalid-signature': '签名无效（内容被修改或不是本实例签发）', 'unknown-key': '未知密钥（可能来自另一个 ATL 实例，或密钥已被移除）', 'key-not-valid': '密钥不在有效期内', 'wrong-type': '不是 ATL 证书', 'bad-payload': '证书内容不符合格式', malformed: '无法解析' };
  async function getText(path) { try { var r = await fetch(path, { credentials: 'omit', cache: 'no-store' }); return r.ok ? await r.text() : null; } catch (e) { return null; } }
  async function run() {
    var certId = (location.pathname.match(/\\/verify\\/(ATL-[0-9A-Z-]{19})/) || [])[1] || null;
    var frag = new URLSearchParams(location.hash.slice(1));
    var jws = frag.get('jws');
    if (!jws && certId) jws = await getText('/public/certs/' + certId + '.jws');
    if (!jws) { text('result', '该证书未公开，请使用持有人提供的证书文件或带 #jws= 的链接'); return; }
    var jwksText = await getText('/.well-known/atl/jwks.json');
    var jwks = jwksText ? JSON.parse(jwksText) : { keys: [] };
    var rev = await getText('/public/revocations.jws');
    var r = await atlVerify({ jws: jws.trim(), jwks: jwks, revocationsJws: rev && rev.trim() });
    try {
      var seen = Number(localStorage.getItem('atl.revocations.seq') || '0');
      if (r.revocationsSeq !== undefined) { if (r.revocationsSeq < seen) r.revocationsWarning = '吊销列表可能是旧版本'; else localStorage.setItem('atl.revocations.seq', String(r.revocationsSeq)); }
    } catch (e) {}
    el('result').className = 'status ' + r.status;
    text('result', LABELS[r.status] || r.status);
    if (r.revocation) text('revocation', '吊销原因：' + r.revocation.reason + ' · ' + r.revocation.revokedAt);
    if (r.revocationsWarning) text('warning', r.revocationsWarning);
    var p = r.payload || {};
    text('holder', (p.subject && p.subject.displayName) || '—');
    var a = p.achievement || {};
    text('achievement', (a.title || a.trackId || a.labId || '—') + (a.trackVersion || a.labVersion ? '（版本 ' + (a.trackVersion || a.labVersion) + '）' : ''));
    text('issued', p.issuedAt || '—');
    text('kid', r.kid || '—');
    var list = el('labs');
    (a.labs || []).forEach(function (l) { var li = document.createElement('li'); li.textContent = l.labId + ' · ' + l.labVersion + ' · ' + l.badgeLevel + ' · 报告摘要 ' + String(l.reportDigest || '').slice(0, 19); list.appendChild(li); });
  }
  run();
})();
`;

/** Node offline verification tool (`node verify.mjs bundle.json [report.json …]`), no third-party libraries. */
export const OFFLINE_VERIFY_MJS = `#!/usr/bin/env node
// ATL offline certificate verification (04 §10.5). Usage: node verify.mjs <offline-bundle.json> [report.json ...]
// Works after the platform is uninstalled (no network); revocations are only as fresh as the bundle.
import fs from 'node:fs';
${VERIFY_CORE_JS}
const [bundleFile, ...reportFiles] = process.argv.slice(2);
if (!bundleFile) { console.error('usage: node verify.mjs <offline-bundle.json> [report.json ...]'); process.exit(64); }
const bundle = JSON.parse(fs.readFileSync(bundleFile, 'utf8'));
const jwks = bundle.jwks ?? { keys: [bundle.jwk], origins: bundle.origins ?? [] };
const reports = reportFiles.map((f) => JSON.parse(fs.readFileSync(f, 'utf8')));
const r = await atlVerify({ jws: bundle.jws, jwks, revocationsJws: bundle.revocationsJws, reports });
console.log(JSON.stringify({ status: r.status, certId: r.payload?.certId ?? null, holder: r.payload?.subject?.displayName ?? null, kid: r.kid ?? null, revocation: r.revocation ?? null, warning: r.revocationsWarning ?? null, reports: r.reports ?? [], disclaimer: r.disclaimer }, null, 2));
process.exit(r.status === 'valid' ? 0 : 1);
`;
