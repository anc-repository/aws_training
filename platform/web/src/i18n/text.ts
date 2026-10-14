/**
 * 文案模板（09 §1.3）：
 * - `{name}` 占位由 `t()` 代入（与原来的 zh-CN.ts 相同）；
 * - 复数（英语需要）：`{n, plural, one {# card} other {# cards}}`，`#` 是按当前语言格式化的数字，分支里也可以写 `{name}`；
 *   支持的类别取 Intl.PluralRules（zero / one / two / few / many / other）与精确值 `=0`、`=1`；
 * 本模块不依赖 React（公开验证页与分享副本渲染器也使用它）；富文本 `rich()` 在 template.ts。
 */
import { INTL_TAG, type Locale } from './locale';

export type Vars = Record<string, string | number | null | undefined>;

let pluralLocale: Locale = 'zh-CN';
const pluralRules = new Map<Locale, Intl.PluralRules>();

/** 由运行时在切换语言时设置（复数规则与数字格式按当前语言）。 */
export function setTextLocale(l: Locale): void {
  pluralLocale = l;
}

function plural(n: number): string {
  let r = pluralRules.get(pluralLocale);
  if (!r) {
    r = new Intl.PluralRules(INTL_TAG[pluralLocale]);
    pluralRules.set(pluralLocale, r);
  }
  return r.select(n);
}

/** 找到与 `open` 处的 `{` 配对的 `}`。 */
function matchBrace(s: string, open: number): number {
  let depth = 0;
  for (let i = open; i < s.length; i++) {
    if (s[i] === '{') depth++;
    else if (s[i] === '}' && --depth === 0) return i;
  }
  return -1;
}

/** `{n, plural, one {…} other {…}}` → 选中的分支（`#` 换成数字）。 */
export function expandPlurals(template: string, vars: Vars): string {
  const re = /\{(\w+),\s*plural,/g;
  let out = '';
  let last = 0;
  for (let m = re.exec(template); m; m = re.exec(template)) {
    const start = m.index;
    const end = matchBrace(template, start);
    if (end < 0) break;
    const body = template.slice(m.index + m[0].length, end);
    const branches = new Map<string, string>();
    const br = /\s*(=\d+|zero|one|two|few|many|other)\s*\{/g;
    for (let b = br.exec(body); b; b = br.exec(body)) {
      const o = b.index + b[0].length - 1;
      const c = matchBrace(body, o);
      if (c < 0) break;
      branches.set(b[1]!, body.slice(o + 1, c));
      br.lastIndex = c + 1;
    }
    const raw = vars[m[1]!];
    const n = typeof raw === 'number' ? raw : Number(raw);
    let chosen = branches.get('other') ?? '';
    if (Number.isFinite(n)) chosen = branches.get(`=${n}`) ?? branches.get(plural(n)) ?? chosen;
    out += template.slice(last, start) + chosen.replace(/#/g, Number.isFinite(n) ? n.toLocaleString(INTL_TAG[pluralLocale]) : String(raw ?? ''));
    last = end + 1;
    re.lastIndex = end + 1;
  }
  return last ? out + template.slice(last) : template;
}

/** 代入 `{name}` 占位（缺少的变量保留原样）与复数分支。 */
export function t(template: string, vars: Vars = {}): string {
  const expanded = template.includes(', plural,') ? expandPlurals(template, vars) : template;
  return expanded.replace(/\{(\w+)\}/g, (m, k: string) => {
    const v = vars[k];
    return v === undefined || v === null ? m : String(v);
  });
}

/** 模板中的占位名（`{name}` 与复数变量），i18n:check 用来比较各语言是否一致。 */
export function placeholders(template: string): string[] {
  const names = new Set<string>();
  for (const m of template.matchAll(/\{(\w+)(?:\}|,\s*plural,)/g)) names.add(m[1]!);
  return [...names].sort();
}
