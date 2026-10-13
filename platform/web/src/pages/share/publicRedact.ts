/**
 * 公开产物的打码器（08 P08“打码器”、D-UI-12、§9.2 #33）：报告分享副本（P08-S）与公开验证页（P09-V）共用。
 * 纯函数、不依赖 DOM 与 SPA 代码，可以打进验证页的 verify.js，也可以由 atl-certs 在 Node 中调用（public-pages/build.mjs 产出 ESM）。
 *
 * 两档：
 * - `standard`（验证页、SPA 默认显示）：12 位账号 ID 只留后 4 位（`••••3333`，含 ARN 的账号段、桶名后缀、URL 中的账号）、
 *   公网 IPv4 `203.0.•.•`（私有、回环、链路本地不打码）、IPv6 `2001:db8:••••`（至少 3 个冒号，不误伤 `10:42:10`）；
 * - `share`（分享副本、默认导出）：再加上会话 id 与环境名只留前缀（`s4k7••••`、`e7k2••••`）、CloudFront 域名与 ALB DNS 名中段打码、
 *   常见资源 ID（EC2 `i-` / `sg-` / `vol-` …、CloudFront 分配 ID）中段打码、邮箱整段替换。
 * 规则与 SPA 的界面打码器（src/lib/redact.ts）同一取向；服务端强制执行时应共用这一份（§9.2 #33，等 @atl/contracts）。
 */

export type RedactLevel = 'standard' | 'share';

export const MASK = '••••';

function isPrivateIpv4(a: number, b: number): boolean {
  return a === 10 || a === 127 || a === 0 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 169 && b === 254);
}

/** 账号 ID：只留后 4 位。 */
export function maskAccount(id: string): string {
  const digits = id.replace(/\D/g, '');
  return digits.length < 4 ? MASK : MASK + digits.slice(-4);
}

/** 中段打码：保留开头 keepStart 位与结尾 keepEnd 位。 */
export function maskMiddle(s: string, keepStart = 4, keepEnd = 2): string {
  if (s.length <= keepStart + keepEnd + 1) return s.slice(0, Math.max(1, Math.min(keepStart, s.length - 1))) + MASK;
  return `${s.slice(0, keepStart)}${MASK}${s.slice(s.length - keepEnd)}`;
}

function standardPass(text: string): string {
  // ARN 的账号段（12 位）：arn:<partition>:<service>:<region>:<account>:…
  let s = text.replace(/\b(arn:aws[a-z-]*:[a-z0-9-]*:[a-z0-9-]*:)(\d{12})(?=:)/g, (_m, p: string, acct: string) => `${p}${maskAccount(acct)}`);
  // 其余位置的 12 位账号 ID（前后不是数字）
  s = s.replace(/(^|[^0-9])(\d{12})(?![0-9])/g, (_m, p: string, acct: string) => `${p}${maskAccount(acct)}`);
  // 公网 IPv4
  s = s.replace(/\b(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})\b/g, (m, a: string, b: string, c: string, d: string) => {
    const n = [a, b, c, d].map(Number);
    if (n.some((x) => x > 255)) return m;
    return isPrivateIpv4(n[0]!, n[1]!) ? m : `${a}.${b}.•.•`;
  });
  // IPv6：至少 3 个冒号
  s = s.replace(/\b([0-9a-f]{1,4}):([0-9a-f]{1,4})(?::[0-9a-f]{0,4}){2,6}\b/gi, (_m, a: string, b: string) => `${a}:${b}:${MASK}`);
  return s;
}

const SHARE_RULES: [RegExp, (m: string, ...g: string[]) => string][] = [
  // 邮箱（报告不含邮箱；防御性替换）
  [/\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g, () => '‹邮箱›'],
  // CloudFront 域名：d1234abcd.cloudfront.net → d123••••.cloudfront.net
  [/\b([a-z0-9]{6,20})\.cloudfront\.net\b/g, (_m, host: string) => `${maskMiddle(host, 4, 0)}.cloudfront.net`],
  // ALB / ELB DNS 名：<name>-<n>.<region>.elb.amazonaws.com → 名称中段打码
  [/\b([a-z0-9][a-z0-9-]{3,})(\.[a-z0-9-]+)?\.elb\.amazonaws\.com\b/gi, (_m, host: string, region: string | undefined) => `${maskMiddle(host, 4, 0)}${region ?? ''}.elb.amazonaws.com`],
  // API Gateway 端点
  [/\b([a-z0-9]{10})\.execute-api\.([a-z0-9-]+)\.amazonaws\.com\b/g, (_m, id: string, region: string) => `${maskMiddle(id, 3, 0)}.execute-api.${region}.amazonaws.com`],
  // EC2 公网 DNS：ec2-203-0-113-10.<region>.compute.amazonaws.com
  [/\bec2-\d{1,3}-\d{1,3}-\d{1,3}-\d{1,3}\.[a-z0-9.-]*amazonaws\.com\b/g, () => 'ec2-‹地址›.amazonaws.com'],
  // EC2 等资源 ID：i-0abc… sg-… vol-… subnet-… vpc-… eni-… ami-… nat-… igw-… rtb-… snap-… vpce-… lt-…
  [/\b(i|sg|vol|subnet|vpc|eni|ami|nat|igw|rtb|snap|vpce|lt|eipalloc|eipassoc)-([0-9a-f]{8,17})\b/g, (_m, kind: string, id: string) => `${kind}-${maskMiddle(id, 3, 2)}`],
  // CloudFront 分配 ID（E + 大写字母数字 13～14 位）
  [/\bE[A-Z0-9]{12,13}\b/g, (m) => maskMiddle(m, 4, 2)],
  // 会话 id：s + 12 位（Crockford base32 小写）→ 只留前缀
  [/\bs[0-9a-hjkmnp-tv-z]{12}\b/g, (m) => `${m.slice(0, 4)}${MASK}`],
  // 环境名：cloudalbum-<envName>，或含数字的 e + 7 位
  [/\b(cloudalbum-)(e[0-9a-z]{7})\b/g, (_m, p: string, env: string) => `${p}${env.slice(0, 4)}${MASK}`],
  [/\be(?=[0-9a-z]{7}\b)(?=[0-9a-z]{0,6}[0-9])[0-9a-z]{7}\b/g, (m) => `${m.slice(0, 4)}${MASK}`],
];

/** 打码任意字符串（只用于显示与公开产物；复制、“显示完整值”用原文）。 */
export function redactText(text: string | null | undefined, level: RedactLevel = 'standard'): string {
  if (text == null) return '';
  let s = standardPass(String(text));
  if (level === 'share') for (const [re, fn] of SHARE_RULES) s = s.replace(re, fn as (m: string, ...g: string[]) => string);
  return s;
}

/** 深度打码一个 JSON 值中的全部字符串（键名不变；`svg` 字段不处理，由渲染器重新生成图表）。 */
export function redactDeep<T>(value: T, level: RedactLevel = 'share'): T {
  const walk = (v: unknown, key?: string): unknown => {
    if (typeof v === 'string') return key === 'svg' ? v : redactText(v, level);
    if (Array.isArray(v)) return v.map((x) => walk(x));
    if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v as Record<string, unknown>).map(([k, x]) => [k, walk(x, k)]));
    return v;
  };
  return walk(value) as T;
}
