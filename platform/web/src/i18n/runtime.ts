/**
 * 词典运行时（09 §1.2）：自写的轻量方案，不引入 i18next。
 *
 * - `msg` 是 zh-CN 词典（源）的深拷贝，结构与键完全相同；切换语言时按回退链（所选 → en → zh-CN）把每个叶子改写成当前语言的
 *   文案。对象的身份不变，所以各目录 strings.ts 里的别名（`export const S = msg.labs.ui`）和组件里的 `msg.app.retry`
 *   在重新渲染时自然取到新语言；
 * - 空字符串视为“未翻译”，按回退链取下一种语言；开发模式下把缺少的键汇总成一条控制台警告；
 * - 切换语言后 `LocaleRoot` 让应用原地重新渲染（不重新挂载，组件状态与终端连接保留，见 LocaleRoot.tsx），不需要整页刷新；
 * - 本模块不依赖 React（公开验证页与分享副本渲染器经 core.ts 使用它）；React hook 在 hooks.ts。
 * - 按需加载：zh-CN（源语言，也是类型来源）静态打包；ja、en 各是一个独立的 chunk，用到时才 `import()`（每个用户只下载自己的
 *   语言）。main.tsx 在首次渲染前 `await localeReady()`；切换到未加载的语言时先加载、加载完成后才真正切换（不会先闪一下中文）。
 *   `npm run i18n:check` 保证 ja / en 完整，运行时的回退只用已加载的词典。测试与分享副本渲染器用 `registerLocaleDict()`
 *   同步注册。
 */
import { applyHtmlLang, fallbackChain, hasStoredLocale, persistLocale, storedLocale, type Locale } from './locale';
import { setTextLocale } from './text';
import { zhCN, type Messages } from './zh-CN';

type Tree = Record<string, unknown>;

const DICTS: Partial<Record<Locale, unknown>> = { 'zh-CN': zhCN };
const LOADERS: Readonly<Record<Exclude<Locale, 'zh-CN'>, () => Promise<unknown>>> = {
  ja: () => import('./ja').then((m) => m.ja),
  en: () => import('./en').then((m) => m.en),
};
const loading = new Map<Locale, Promise<void>>();

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
  const chain = fallbackChain(loc)
    .map((l) => DICTS[l])
    .filter((d) => d !== undefined);
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
  // the document title (browser tab) follows the language too; pages without React (P09-V) set their own afterwards
  if (typeof document !== 'undefined') document.title = msg.app.fullName;
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

/** 同步注册一种语言的词典（测试、Node 中运行的分享副本渲染器）；当前语言因此变完整时重新改写。 */
export function registerLocaleDict(loc: Locale, dict: unknown): void {
  DICTS[loc] = dict;
  if (fallbackChain(current).includes(loc)) apply(current);
}

/** 加载一种语言的词典（已加载时立即完成；失败时抛出，界面保持原来的语言）。 */
export function loadLocale(loc: Locale): Promise<void> {
  if (DICTS[loc] !== undefined || loc === 'zh-CN') return Promise.resolve();
  let p = loading.get(loc);
  if (!p) {
    p = LOADERS[loc]().then((d) => {
      DICTS[loc] = d;
    });
    loading.set(loc, p);
    p.catch(() => loading.delete(loc));
  }
  return p;
}

/** 首次渲染前：加载当前语言的词典并改写文案（失败时以已有的词典显示，不阻止启动）。 */
export async function localeReady(): Promise<void> {
  const loc = current;
  try {
    await loadLocale(loc);
  } catch {
    return;
  }
  if (loc === current) apply(loc);
}

let wanted: Locale | null = null;

function commit(loc: Locale): void {
  wanted = null;
  if (loc === current) {
    applyHtmlLang(loc);
    return;
  }
  current = loc;
  apply(loc);
  for (const fn of [...listeners]) fn();
}

/**
 * 切换语言：改写词典、`<html lang>`、通知订阅者。`persist` 为 false 时不写 localStorage（测试用）。
 * 词典已加载时同步完成；否则先加载，加载完成（且期间没有选别的语言）后再切换。
 */
export function setLocale(loc: Locale, opts: { persist?: boolean } = {}): void {
  if (opts.persist !== false) persistLocale(loc);
  wanted = loc;
  if (loc === 'zh-CN' || DICTS[loc] !== undefined) {
    commit(loc);
    return;
  }
  loadLocale(loc).then(
    () => {
      if (wanted === loc) commit(loc);
    },
    () => {
      if (wanted === loc) wanted = null;
    },
  );
}

export function subscribeLocale(fn: () => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

export { hasStoredLocale };
