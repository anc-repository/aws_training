// backend/src/adapters/email/reserved.ts —— 保留域名不真正发信（06 PM-46、04#email 第 12 节；两种模式都生效）
//
// RFC 2606 / RFC 6761 的保留名：example.com、example.net、example.org 及其子域，以及顶级域 .example、.invalid、.test、.localhost。
// 平台模式的管理员（atl-admin@example.com）与种子测试用户都用这些域名；SES 档遇到它们不调用 SES，只写 outbox，
// 路径段 email=outbox:reserved。notification=sns 档也不为这些地址创建邮件订阅（PM-M23）。

const RESERVED_SLDS = ['example.com', 'example.net', 'example.org'];
const RESERVED_TLDS = ['example', 'invalid', 'test', 'localhost'];

export const RESERVED_NOTE = '保留域名，未发送';

/** 地址的域名部分（小写，去掉末尾的点）；不是邮件地址时返回 undefined */
export function domainOf(address: string): string | undefined {
  const m = /<([^>]+)>/.exec(address);
  const addr = (m ? m[1]! : address).trim().toLowerCase();
  const at = addr.lastIndexOf('@');
  if (at <= 0 || at === addr.length - 1) return undefined;
  return addr.slice(at + 1).replace(/\.+$/, '');
}

export function isReservedDomain(domain: string): boolean {
  const d = domain.toLowerCase().replace(/\.+$/, '');
  if (RESERVED_SLDS.some((s) => d === s || d.endsWith(`.${s}`))) return true;
  const tld = d.split('.').pop() ?? '';
  return RESERVED_TLDS.includes(tld);
}

export function isReservedAddress(address: string): boolean {
  const d = domainOf(address);
  return d !== undefined && isReservedDomain(d);
}
