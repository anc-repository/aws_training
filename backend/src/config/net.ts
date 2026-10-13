/** Small network helpers shared by config/schema.ts and the rules engine. */
import { isIP } from 'node:net';

const LOOPBACK_NAMES = new Set(['localhost', 'localhost.localdomain', 'ip6-localhost', 'ip6-loopback']);

/**
 * 提取主机部分：接受裸主机名、`host:port`、`[v6]:port` 与 URL（`rediss://h:6379`、`postgres://u@h/db`）。
 */
export function hostOf(value: string | undefined | null): string {
  if (!value) return '';
  const v = value.trim();
  if (!v) return '';
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(v)) {
    try {
      return new URL(v).hostname.replace(/^\[|\]$/g, '').toLowerCase();
    } catch {
      return '';
    }
  }
  if (v.startsWith('[')) return v.slice(1, v.indexOf(']') > 0 ? v.indexOf(']') : undefined).toLowerCase();
  if (isIP(v) === 6) return v.toLowerCase();
  const colon = v.lastIndexOf(':');
  return (colon > 0 ? v.slice(0, colon) : v).toLowerCase();
}

/** 主机部分是否为回环地址（127.0.0.0/8、::1、localhost）。用于 selfHosted.match 与 `VAR=loopback` 表达式。 */
export function isLoopback(value: string | undefined | null): boolean {
  const host = hostOf(value);
  if (!host) return false;
  if (LOOPBACK_NAMES.has(host)) return true;
  if (isIP(host) === 4) return host.startsWith('127.');
  if (isIP(host) === 6) return host === '::1' || host === '0:0:0:0:0:0:0:1';
  return false;
}
