/**
 * P09-V 公开验证页的文案（08 P09-V；09 §1.8）。验证页单独打包（public-pages/build.mjs，IIFE），不加载 React 与 SPA 的运行时，
 * 所以这里用一个独立的小解析器：词典与 SPA 相同（`src/i18n/<lang>/verify.ts`，由 i18n:check 一起检查），回退链相同
 * （所选 → en → zh-CN）。语言：`?lang=` → 与 SPA 同源的 localStorage 选择（`atl.locale.v1`）→ 日语。
 * `boot()` 之前（以及单元测试中）是 zh-CN 源文案。
 */
import en from '../../i18n/en/verify';
import ja from '../../i18n/ja/verify';
import { fallbackChain, isLocale, storedLocale, type Locale } from '../../i18n/locale';
import zh from '../../i18n/zh-CN/verify';

type Tree = Record<string, unknown>;

const DICTS: Readonly<Record<Locale, unknown>> = { 'zh-CN': zh, ja, en };

function clone<T>(v: T): T {
  return JSON.parse(JSON.stringify(v)) as T;
}

function lookup(dict: unknown, path: readonly string[]): unknown {
  let cur = dict;
  for (const k of path) {
    if (!cur || typeof cur !== 'object') return undefined;
    cur = (cur as Tree)[k];
  }
  return cur;
}

/** 当前语言的验证页文案（结构与 zh-CN 相同）。 */
export const VT: typeof zh = clone(zh);

let current: Locale = 'zh-CN';

export function verifyLocale(): Locale {
  return current;
}

export function setVerifyLocale(loc: Locale): void {
  current = loc;
  const chain = fallbackChain(loc).map((l) => DICTS[l]);
  const walk = (src: Tree, target: Tree, path: string[]) => {
    for (const [k, s] of Object.entries(src)) {
      const p = [...path, k];
      if (typeof s === 'string') {
        let value = s;
        for (const d of chain) {
          const v = lookup(d, p);
          if (typeof v === 'string' && v !== '') {
            value = v;
            break;
          }
        }
        target[k] = value;
      } else if (s && typeof s === 'object') walk(s as Tree, target[k] as Tree, p);
    }
  };
  walk(zh as unknown as Tree, VT as unknown as Tree, []);
}

/** `?lang=ja|en|zh-CN` → 已保存的选择 → 日语（I1）。 */
export function pickVerifyLocale(search: string): Locale {
  const q = new URLSearchParams(search).get('lang');
  if (isLocale(q)) return q;
  return storedLocale();
}
