// backend/src/adapters/waf/ipset.ts —— denylist.conf ↔ WAF IP 集合的纯函数（01#waf 第 2 节“IP 封禁”；wave1-waf）
//
// - WAF IP 集合只接受 CIDR 写法（单个地址写成 /32），并且一个集合只有一种地址族：模板建的 cloudalbum-blocklist 是 IPV4。
//   denylist.conf 里的 IPv6 条目只在本地（Nginx geo）生效，同步时计入 skippedIpv6，探针在 detail 中说明。
// - 前缀按网络地址对齐（198.51.100.7/24 → 198.51.100.0/24），避免控制面因“主机位非零”拒绝整个 UpdateIPSet。
// - 同步语义：denylist.conf 是唯一来源，IP 集合被整体替换为“当前未过期的 IPv4 条目”（控制台里手工加入的地址会在下一次同步时移除）。
import { isIP } from 'node:net';

/** 模板中 IP 集合的容量上限以官方文档为准；这里只截断到一个保守值，超出部分记 truncated */
export const IPSET_MAX_ADDRESSES = 10_000;

export interface DenylistLike { cidr: string; until?: string }

function ipv4ToInt(ip: string): number {
  return ip.split('.').reduce((acc, o) => ((acc << 8) | Number(o)) >>> 0, 0);
}

function intToIpv4(n: number): string {
  return [24, 16, 8, 0].map((s) => (n >>> s) & 0xff).join('.');
}

/** IPv4 地址或 CIDR → 网络地址对齐的 CIDR（WAF 要求的写法）；IPv6、/0 与非法值返回 undefined */
export function toWafIpv4Cidr(value: string): string | undefined {
  const [ip, bits, extra] = value.trim().split('/');
  if (extra !== undefined || !ip || isIP(ip) !== 4) return undefined;
  const prefix = bits === undefined ? 32 : /^\d{1,2}$/.test(bits) ? Number(bits) : NaN;
  if (!Number.isInteger(prefix) || prefix < 1 || prefix > 32) return undefined;
  const mask = prefix === 32 ? 0xffffffff : (~((1 << (32 - prefix)) - 1)) >>> 0;
  return `${intToIpv4((ipv4ToInt(ip) & mask) >>> 0)}/${prefix}`;
}

export function isIpv6Entry(value: string): boolean {
  return isIP(value.trim().split('/')[0] ?? '') === 6;
}

export interface DesiredAddresses {
  /** 去重、排序后的 IPv4 CIDR */
  addresses: string[];
  skippedIpv6: number;
  invalid: number;
  truncated: number;
}

/** denylist 中当前有效（未过期）的条目 → IP 集合应有的地址 */
export function desiredAddresses(entries: readonly DenylistLike[], now = Date.now()): DesiredAddresses {
  const set = new Set<string>();
  let skippedIpv6 = 0;
  let invalid = 0;
  for (const e of entries) {
    if (e.until && Date.parse(e.until) <= now) continue;
    if (isIpv6Entry(e.cidr)) {
      skippedIpv6 += 1;
      continue;
    }
    const c = toWafIpv4Cidr(e.cidr);
    if (c) set.add(c);
    else invalid += 1;
  }
  const all = [...set].sort();
  return { addresses: all.slice(0, IPSET_MAX_ADDRESSES), skippedIpv6, invalid, truncated: Math.max(0, all.length - IPSET_MAX_ADDRESSES) };
}

export interface AddressDiff { add: string[]; remove: string[]; same: boolean }

/** 现有地址（控制面返回，可能不是对齐写法）与期望地址的差异 */
export function diffAddresses(current: readonly string[], desired: readonly string[]): AddressDiff {
  const cur = new Set(current.map((a) => toWafIpv4Cidr(a) ?? a.trim()));
  const want = new Set(desired);
  const add = [...want].filter((a) => !cur.has(a)).sort();
  const remove = [...cur].filter((a) => !want.has(a)).sort();
  return { add, remove, same: add.length === 0 && remove.length === 0 };
}

export interface WebAclRef {
  arn: string;
  name: string;
  id: string;
  scope: 'CLOUDFRONT' | 'REGIONAL';
  region: string;
}

/** arn:aws:wafv2:us-east-1:111122223333:global/webacl/cloudalbum-lab-acl/<id>（global = CLOUDFRONT 范围） */
export function parseWebAclArn(arn: string | undefined): WebAclRef | undefined {
  const m = /^arn:aws[a-z-]*:wafv2:([a-z0-9-]+):\d{12}:(global|regional)\/webacl\/([^/]+)\/([^/]+)$/.exec(arn ?? '');
  if (!m) return undefined;
  return { arn: arn!, region: m[1]!, scope: m[2] === 'global' ? 'CLOUDFRONT' : 'REGIONAL', name: m[3]!, id: m[4]! };
}

/** WAF 控制面所在区域：Web ACL ARN 中的区域；解析不了时 CLOUDFRONT → us-east-1，REGIONAL → 应用区域 */
export function wafRegionOf(scope: string | undefined, webAclArn: string | undefined, appRegion: string): string {
  const ref = parseWebAclArn(webAclArn);
  if (ref) return ref.region;
  return scope === 'REGIONAL' ? appRegion : 'us-east-1';
}
