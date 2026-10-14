/**
 * 词典运行时（09 §1.2）：自写的轻量方案，不引入 i18next。
 *
 * - `msg` 是 zh-CN 词典（源）的深拷贝，结构与键完全相同；切换语言时按回退链（所选 → en → zh-CN）把每个叶子改写成当前语言的
 *   文案。对象的身份不变，所以各目录 strings.ts 里的别名（`export const S = msg.labs.ui`）和组件里的 `msg.app.retry`
 *   在重新渲染时自然取到新语言；
 * - 空字符串视为“未翻译”，按回退链取下一种语言；开发模式下把缺少的键汇总成一条控制台警告；
 * - 切换语言后 `LocaleRoot` 以语言为 key 重新挂载应用（见 LocaleRoot.tsx），不需要整页刷新；
 * - 本模块不依赖 React（公开验证页与分享副本渲染器经 core.ts 使用它）；React hook 在 hooks.ts。
 */
import { en } from './en';
import { ja } from './ja';
import { applyHtmlLang, fallbackChain, hasStoredLocale, persistLocale, storedLocale, type Locale } from './locale';
import { setTextLocale } from './text';
import { zhCN, type Messages } from './zh-CN';

type Tree = Record<string, unknown>;

const DICTS: Readonly<Record<Locale, unknown>> = { 'zh-CN': zhCN, ja, en };

function deepClone<T>(v: T): T {
  if (Array.isArray(v)) return v.map(deepClone) as T;
  if (v && typeof v === 'object') {
    const out: Tree = {};
    for (const [k, x] of Object.entries(v as Tree)) out[k] = deepClone(x);
    return out as T;
  }
  return v;
}

function lookup(dict: unknown, path: readonly string[]): unknown {
  let cur = dict;
  for (const k of path) {
    if (!cur || typeof cur !== 'object') return undefined;
    cur = (cur as Tree)[k];
  }
  return cur;
}

/** 当前语言的界面文案（结构与 zh-CN 词典相同；只读）。 */
export const msg: Messages = deepClone(zhCN);

let current: Locale = storedLocale();
let lastMissing: string[] = [];
const listeners = new Set<() => void>();

function isDev(): boolean {
  try {
    return import.meta.env.DEV === true && import.meta.env.MODE !== 'test';
  } catch {
    return false;
  }
}

/** 把 `msg` 的每个叶子改写成 `loc` 的文案；返回走了回退的键（a.b.c）。 */
function materialize(loc: Locale): string[] {
  const chain = fallbackChain(loc).map((l) => DICTS[l]);
  const missing: string[] = [];
  const walk = (src: unknown, target: Tree, path: string[]) => {
    for (const k of Object.keys(src as Tree)) {
      const s = (src as Tree)[k];
      const p = [...path, k];
      if (typeof s === 'string') {
        let value = s;
        for (let i = 0; i < chain.length; i++) {
          const v = lookup(chain[i], p);
          if (typeof v === 'string' && v !== '') {
            value = v;
            if (i > 0) missing.push(p.join('.'));
            break;
          }
        }
        target[k] = value;
      } else if (s && typeof s === 'object') {
        walk(s, target[k] as Tree, p);
      }
    }
  };
  walk(zhCN, msg as unknown as Tree, []);
  return missing;
}

function warnMissing(loc: Locale, missing: readonly string[]): void {
  if (!missing.length || !isDev()) return;
  const head = missing.slice(0, 20).join(', ');
  console.warn(`[i18n] ${missing.length} key(s) have no ${loc} text and fall back (${loc} → en → zh-CN): ${head}${missing.length > 20 ? ', …' : ''}`);
}

function apply(loc: Locale): void {
  lastMissing = materialize(loc);
  setTextLocale(loc);
  applyHtmlLang(loc);
  warnMissing(loc, lastMissing);
}

apply(current);

export function getLocale(): Locale {
  return current;
}

/** 当前语言下走了回退的键（测试与诊断用）。 */
export function missingKeys(): readonly string[] {
  return lastMissing;
}

/**
 * 切换语言：改写词典、`<html lang>`、通知订阅者。`persist` 为 false 时不写 localStorage（测试用）。
 */
export function setLocale(loc: Locale, opts: { persist?: boolean } = {}): void {
  if (opts.persist !== false) persistLocale(loc);
  if (loc === current) {
    applyHtmlLang(loc);
    return;
  }
  current = loc;
  apply(loc);
  for (const fn of [...listeners]) fn();
}

export function subscribeLocale(fn: () => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

export { hasStoredLocale };
