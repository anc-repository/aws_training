/**
 * StreamUrl check before connecting (03 §3.2 step 8, §3.1 “原样使用 StreamUrl”).
 *
 * The URL is used exactly as returned by StartSession / ResumeSession (its query parameters such as `role` or
 * `cell-number` belong to the service). Like the official plugin since 1.2.889.0 (`validateStreamUrl` in
 * aws/session-manager-plugin `src/sessionmanagerplugin/session/session.go`): the scheme must be wss, no userinfo,
 * and the host must be a Session Manager message endpoint. The plugin also accepts hosts listed in
 * `AWS_SSM_PLUGIN_ADDITIONAL_STREAM_HOSTS` and VPC endpoint names; here `additionalHosts` plays that role (e.g. a
 * dual-stack host once 01 registers one — the CSP `connect-src` must list it too). `allowLoopback` admits
 * ws:// and wss:// on 127.0.0.1 / localhost / [::1] for the local mock (dev mode only).
 */

export interface StreamUrlPolicy {
  /** When set, the host must be exactly `ssmmessages.<region>.amazonaws.com` (`.amazonaws.com.cn` for cn-*). */
  region?: string;
  additionalHosts?: readonly string[];
  allowLoopback?: boolean;
}

export type StreamUrlCheck = { ok: true; url: string } | { ok: false; reason: string };

const LOOPBACK = new Set(['127.0.0.1', 'localhost', '[::1]', '::1']);
const ANY_REGION_HOST = /^ssmmessages\.[a-z]{2}(?:-[a-z]+)+-\d+\.amazonaws\.com(?:\.cn)?$/;

export function expectedStreamHost(region: string): string {
  return `ssmmessages.${region}.amazonaws.com${region.startsWith('cn-') ? '.cn' : ''}`;
}

export function checkStreamUrl(raw: string, policy: StreamUrlPolicy = {}): StreamUrlCheck {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return { ok: false, reason: 'StreamUrl is not a valid URL' };
  }
  if (u.username !== '' || u.password !== '') return { ok: false, reason: 'StreamUrl must not contain userinfo' };
  const host = u.hostname.toLowerCase();
  if (policy.allowLoopback && LOOPBACK.has(host) && (u.protocol === 'ws:' || u.protocol === 'wss:')) return { ok: true, url: raw };
  if (u.protocol !== 'wss:') return { ok: false, reason: `StreamUrl has unexpected scheme ${JSON.stringify(u.protocol.replace(/:$/, ''))}, expected "wss"` };
  if (host === '') return { ok: false, reason: 'StreamUrl has no host' };
  if (policy.additionalHosts?.some((h) => h.toLowerCase() === host)) return { ok: true, url: raw };
  const ok = policy.region ? host === expectedStreamHost(policy.region) : ANY_REGION_HOST.test(host);
  return ok ? { ok: true, url: raw } : { ok: false, reason: `StreamUrl host ${JSON.stringify(host)} is not a recognized Session Manager stream endpoint` };
}
