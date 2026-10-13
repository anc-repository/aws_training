/**
 * Built-in corroborators (04 §5.4): `ip-in-aws-ranges` (peer addresses inside a service's published ranges),
 * `tls-san` (certificate SAN matches a pattern such as `*.cloudfront.net`) and `fresh-nonce` (the run's nonce does not
 * appear in other evidence of this attempt — replay guard).
 */
import { inCidr } from './net.js';
import type { IpRange } from './ports.js';

export function ipInRanges(addresses: unknown, service: string, ranges: IpRange[]): { ok: boolean; observed: { address: string; inRange: boolean; prefix?: string }[] } {
  const list = (Array.isArray(addresses) ? addresses : [addresses]).filter((a): a is string => typeof a === 'string' && a.length > 0);
  const svc = ranges.filter((r) => r.service === service);
  const observed = list.map((address) => {
    const hit = svc.find((r) => inCidr(address, r.prefix));
    return { address, inRange: !!hit, ...(hit ? { prefix: hit.prefix } : {}) };
  });
  return { ok: observed.length > 0 && observed.every((o) => o.inRange), observed };
}

/** DNS-style wildcard match of one SAN (`*.cloudfront.net` matches exactly one label). */
export function sanMatches(san: string, pattern: string): boolean {
  const s = san.toLowerCase();
  const p = pattern.toLowerCase();
  if (p === s) return true;
  if (p.startsWith('*.')) {
    const suffix = p.slice(1);
    if (!s.endsWith(suffix)) return false;
    const label = s.slice(0, -suffix.length);
    return label.length > 0 && !label.includes('.');
  }
  if (s.startsWith('*.')) return sanMatches(p, s);
  return false;
}

export function tlsSan(sans: unknown, expect: string): { ok: boolean; observed: { subjectAltNames: string[]; expect: string } } {
  const list = (Array.isArray(sans) ? sans : typeof sans === 'string' ? sans.split(/,\s*/) : []).filter((x): x is string => typeof x === 'string');
  return { ok: list.some((s) => sanMatches(s, expect)), observed: { subjectAltNames: list.slice(0, 20), expect } };
}

/** Is `nonce` absent from the other evidence of the attempt (stringified)? */
export function freshNonce(nonce: string, otherEvidence: unknown[]): { ok: boolean; observed: { seenElsewhere: number } } {
  const seen = otherEvidence.filter((e) => e !== undefined && JSON.stringify(e).includes(nonce)).length;
  return { ok: seen === 0, observed: { seenElsewhere: seen } };
}

/** Parse ip-ranges.json (https://ip-ranges.amazonaws.com/ip-ranges.json). */
export function parseIpRanges(json: unknown): IpRange[] {
  const j = json as { prefixes?: { ip_prefix?: string; service?: string; region?: string }[]; ipv6_prefixes?: { ipv6_prefix?: string; service?: string; region?: string }[] };
  const out: IpRange[] = [];
  for (const p of j.prefixes ?? []) if (p.ip_prefix && p.service) out.push({ prefix: p.ip_prefix, service: p.service, ...(p.region ? { region: p.region } : {}) });
  for (const p of j.ipv6_prefixes ?? []) if (p.ipv6_prefix && p.service) out.push({ prefix: p.ipv6_prefix, service: p.service, ...(p.region ? { region: p.region } : {}) });
  return out;
}
