/**
 * 界面打码器（08 P08“打码器”、D-UI-12、§9.2 #33）：按模式打码任意字符串，只用于显示；复制与“显示完整值”用原文。
 * 规则取自原型 maskStr：12 位账号 ID 只留后 4 位（`••••3333`）、公网 IPv4 打码后两段、IPv6 只留前两组。
 * 账号 ID 全站统一为 `••••后 4 位`（§3.5）。
 */

const MASK = '••••';

export function maskAccountId(accountId: string | null | undefined): string {
  if (!accountId) return '';
  const digits = accountId.replace(/\D/g, '');
  if (digits.length < 4) return MASK;
  return MASK + digits.slice(-4);
}

/** 是否已经是打码形式（服务端打过码时，界面不提供“显示”按钮，§9.2 #34）。 */
export function isMaskedAccountId(v: string | null | undefined): boolean {
  return !!v && v.includes('•');
}

function isPrivateIpv4(a: number, b: number): boolean {
  return a === 10 || a === 127 || a === 0 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 169 && b === 254);
}

export function redact(text: string | null | undefined): string {
  if (text == null) return '';
  let s = String(text).replace(/(^|[^0-9])(\d{8})(\d{4})(?![0-9])/g, (_m, p: string, _a: string, b: string) => `${p}${MASK}${b}`);
  s = s.replace(/\b(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})\b/g, (m, a: string, b: string) =>
    isPrivateIpv4(Number(a), Number(b)) ? m : `${a}.${b}.•.•`,
  );
  // 至少 3 个冒号，不误伤 10:42:10 这样的时间
  s = s.replace(/\b([0-9a-f]{1,4}):([0-9a-f]{1,4})(?::[0-9a-f]{0,4}){2,6}\b/gi, (_m, a: string, b: string) => `${a}:${b}:${MASK}`);
  return s;
}
