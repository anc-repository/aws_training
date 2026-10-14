/**
 * Static verification site (04 §10.6) written by atl-certs to `atl-web`: `verify/index.html` + `verify/verify.js`
 * (no Cognito, no API calls, CSP `script-src 'self'`), `/.well-known/atl/jwks.json`, `/public/revocations.jws`,
 * `/public/certs/<certId>.jws`, and the offline verification bundle.
 */
import type { EcPublicJwk } from '@atl/shared/node';
import { OFFLINE_VERIFY_MJS, VERIFY_PAGE_JS } from './verify-core.js';

export const CERT_DISCLAIMER =
  '本证明由部署在学员自己 AWS 账号中的自托管 AWS Training Lab 实例自动签发，表示该实例记录到持有人完成了所列实验，签名可用于确认内容未被篡改、且出自该实例的签名密钥。它不是 AWS 官方认证，也不代表 AWS Certified Solutions Architect – Associate 或任何 AWS 认证资格；签发者与持有人可能是同一人，平台的数据与密钥由账号所有者控制。验证结果只说明“该实例签发了此内容”，不说明签发过程的独立性。';

/** The page's own <meta> CSP (frame-ancestors only works as a header: the atl-web-verify policy of CloudFront sends it). */
export const VERIFY_CSP = "default-src 'self'; connect-src 'self'; img-src 'self' data:; script-src 'self'; style-src 'self' 'unsafe-inline'";

export function verifyPageHtml(): string {
  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="${VERIFY_CSP.replace(/"/g, '&quot;')}">
<meta name="robots" content="noindex">
<title>证书验证 · AWS Training Lab（自托管）</title>
<style>
:root { --fg: #1d2330; --muted: #5b6475; --bg: #ffffff; --line: #d9dee7; --ok: #1b7f3a; --bad: #b42318; --warn: #9a6700; }
@media (prefers-color-scheme: dark) { :root { --fg: #e6e9ef; --muted: #a3acbd; --bg: #12151b; --line: #2b313c; --ok: #4cc27a; --bad: #ff7b72; --warn: #e3b341; } }
body { margin: 0; font: 15px/1.6 system-ui, -apple-system, "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif; color: var(--fg); background: var(--bg); }
main { max-width: 760px; margin: 0 auto; padding: 24px 16px 48px; }
.nature { border: 1px solid var(--line); border-left: 4px solid var(--warn); padding: 12px 14px; color: var(--muted); font-size: 13px; }
.status { font-size: 22px; font-weight: 600; margin: 20px 0 8px; }
.status.valid { color: var(--ok); } .status.revoked, .status.invalid-signature, .status.bad-payload, .status.wrong-type { color: var(--bad); }
.status.unknown-key, .status.key-not-valid, .status.malformed { color: var(--warn); }
dl { display: grid; grid-template-columns: 8em 1fr; gap: 6px 12px; } dt { color: var(--muted); } dd { margin: 0; overflow-wrap: anywhere; }
h2 { font-size: 16px; margin-top: 28px; }
</style>
</head>
<body>
<main>
<h1>证书验证</h1>
<p class="nature">${CERT_DISCLAIMER}</p>
<div id="result" class="status" role="status" aria-live="polite">正在验证…</div>
<div id="revocation"></div>
<div id="warning"></div>
<dl>
<dt>持有人</dt><dd id="holder">—</dd>
<dt>成果</dt><dd id="achievement">—</dd>
<dt>签发时间</dt><dd id="issued">—</dd>
<dt>密钥指纹</dt><dd id="kid">—</dd>
</dl>
<ul id="labs"></ul>
<h2>如何独立核对</h2>
<p>验证完全在浏览器中完成：页面读取本实例的公钥（/.well-known/atl/jwks.json）与签名的吊销列表，用 WebCrypto 验证 ES256 签名。建议持有人在自己的公开主页上公布上面的密钥指纹，第三方即可对照。平台卸载后，本页与公开证书文件随之失效；请使用证书页提供的离线验证包。</p>
</main>
<script src="/verify/verify.js"></script>
</body>
</html>
`;
}

export function verifyPageJs(): string {
  return VERIFY_PAGE_JS;
}

/**
 * The files of `verify/` that atl-certs publishes. The designed page P09-V (08; platform/web/public-pages, built by
 * `npm run build -w @atl/web`) is embedded into the Lambda bundle by platform/api/build.mjs (`__ATL_VERIFY_PAGE__`) and set by
 * the dev server from its build output; without it the minimal page above is published (same URLs, same public files).
 */
export interface VerifyPageAssets {
  'index.html': string;
  'verify.js': string;
  'verify.css'?: string;
}

declare const __ATL_VERIFY_PAGE__: VerifyPageAssets | null | undefined;

let verifyAssetsOverride: VerifyPageAssets | null = null;

/** Dev / tests: publish these files instead (null = back to the bundled page or the fallback). */
export function setVerifyPageAssets(a: VerifyPageAssets | null): void {
  verifyAssetsOverride = a;
}

export function verifyPageAssets(): VerifyPageAssets {
  if (verifyAssetsOverride) return verifyAssetsOverride;
  const bundled = typeof __ATL_VERIFY_PAGE__ === 'undefined' ? null : __ATL_VERIFY_PAGE__;
  if (bundled && bundled['index.html'] && bundled['verify.js']) return bundled;
  return { 'index.html': verifyPageHtml(), 'verify.js': verifyPageJs() };
}

export interface JwksKeyEntry {
  kid: string;
  jwk: EcPublicJwk;
  validFrom: string;
  validTo: string | null;
  purposes: string[];
}

/** `/.well-known/atl/jwks.json` (04 §10.6): every key ever used, with validity and purposes, plus all platform origins. */
export function jwksDocument(input: { installId: string; keys: JwksKeyEntry[]; origins: string[] }): Record<string, unknown> {
  return {
    installId: input.installId,
    keys: input.keys.map((k) => ({
      kty: 'EC',
      crv: 'P-256',
      x: k.jwk.x,
      y: k.jwk.y,
      kid: k.kid,
      use: 'sig',
      alg: 'ES256',
      'atl:validFrom': k.validFrom,
      'atl:validTo': k.validTo,
      'atl:purposes': k.purposes,
    })),
    origins: [...new Set(input.origins)],
    disclaimer: '自托管 AWS Training Lab 实例的签名公钥；不是 AWS 官方认证。',
  };
}

/** Offline verification bundle (04 §10.5): `{ jws, jwk, jwks, revocationsJws, verifyScript }`. */
export function offlineBundle(input: { jws: string; jwks: Record<string, unknown>; kid: string; revocationsJws: string | null }): Record<string, unknown> {
  const keys = (input.jwks.keys as { kid: string }[]) ?? [];
  return {
    schema: 'atl.offline-verify/v1',
    jws: input.jws,
    jwk: keys.find((k) => k.kid === input.kid) ?? null,
    jwks: input.jwks,
    revocationsJws: input.revocationsJws,
    verifyScript: OFFLINE_VERIFY_MJS,
    howTo: 'Save verifyScript as verify.mjs and this JSON as cert.json, then run: node verify.mjs cert.json [report.json]',
    disclaimer: CERT_DISCLAIMER,
  };
}
