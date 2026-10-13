/**
 * Address helpers of the shared egress guard (01 §3.2 “共享出站库”, 04 §5.2.3): CIDR matching for IPv4 / IPv6 and the
 * list of address ranges a platform probe must never reach (private, loopback, link-local incl. 169.254.0.0/16, ULA,
 * multicast, reserved, documentation, CGNAT).
 */
import { isIP } from 'node:net';

function v4ToBigInt(ip: string): bigint {
  const parts = ip.split('.').map(Number);
  if (parts.length !== 4 || parts.some((p) => !Number.isInteger(p) || p < 0 || p > 255)) throw new TypeError(`bad IPv4: ${ip}`);
  return parts.reduce((acc, p) => (acc << 8n) + BigInt(p), 0n);
}

function v6ToBigInt(ip: string): bigint {
  let s = ip.toLowerCase();
  const zone = s.indexOf('%');
  if (zone >= 0) s = s.slice(0, zone);
  // embedded IPv4 tail
  const v4 = /(\d+\.\d+\.\d+\.\d+)$/.exec(s);
  if (v4) {
    const n = v4ToBigInt(v4[1]!);
    s = `${s.slice(0, -v4[1]!.length)}${((n >> 16n) & 0xffffn).toString(16)}:${(n & 0xffffn).toString(16)}`;
  }
  const [head, tail] = s.split('::') as [string, string | undefined];
  const h = head ? head.split(':') : [];
  const t = tail !== undefined && tail !== '' ? tail.split(':') : [];
  const fill = s.includes('::') ? 8 - h.length - t.length : 0;
  const groups = [...h, ...Array(fill).fill('0'), ...t];
  if (groups.length !== 8) throw new TypeError(`bad IPv6: ${ip}`);
  return groups.reduce((acc, g) => (acc << 16n) + BigInt(parseInt(g || '0', 16)), 0n);
}

export function parseAddress(ip: string): { family: 4 | 6; value: bigint } {
  const fam = isIP(ip.split('%')[0]!);
  if (fam === 4) return { family: 4, value: v4ToBigInt(ip) };
  if (fam === 6) return { family: 6, value: v6ToBigInt(ip) };
  throw new TypeError(`not an IP address: ${ip}`);
}

export function inCidr(ip: string, cidr: string): boolean {
  const [base, bitsStr] = cidr.split('/') as [string, string | undefined];
  let a: { family: 4 | 6; value: bigint };
  let b: { family: 4 | 6; value: bigint };
  try {
    a = parseAddress(ip);
    b = parseAddress(base);
  } catch {
    return false;
  }
  // IPv4-mapped IPv6 (::ffff:a.b.c.d) compares as IPv4
  if (a.family === 6 && b.family === 4 && a.value >> 32n === 0xffffn) a = { family: 4, value: a.value & 0xffffffffn };
  if (a.family !== b.family) return false;
  const width = a.family === 4 ? 32 : 128;
  const bits = bitsStr === undefined ? width : Number(bitsStr);
  if (!Number.isInteger(bits) || bits < 0 || bits > width) return false;
  const shift = BigInt(width - bits);
  return a.value >> shift === b.value >> shift;
}

export const FORBIDDEN_RANGES = [
  '0.0.0.0/8',
  '10.0.0.0/8',
  '100.64.0.0/10',
  '127.0.0.0/8',
  '169.254.0.0/16',
  '172.16.0.0/12',
  '192.0.0.0/24',
  '192.0.2.0/24',
  '192.88.99.0/24',
  '192.168.0.0/16',
  '198.18.0.0/15',
  '198.51.100.0/24',
  '203.0.113.0/24',
  '224.0.0.0/4',
  '240.0.0.0/4',
  '::/128',
  '::1/128',
  '::ffff:0:0/96',
  '64:ff9b::/96',
  '100::/64',
  '2001:db8::/32',
  'fc00::/7',
  'fe80::/10',
  'ff00::/8',
];

/** True when the address must not be contacted by a platform probe. IPv4-mapped IPv6 is judged by its IPv4 part. */
export function isForbiddenAddress(ip: string): boolean {
  let p: { family: 4 | 6; value: bigint };
  try {
    p = parseAddress(ip);
  } catch {
    return true;
  }
  if (p.family === 6 && p.value >> 32n === 0xffffn) {
    const v4 = p.value & 0xffffffffn;
    const dotted = [24n, 16n, 8n, 0n].map((s) => ((v4 >> s) & 0xffn).toString()).join('.');
    return isForbiddenAddress(dotted);
  }
  return FORBIDDEN_RANGES.some((r) => inCidr(ip, r));
}
