/**
 * 词典的类型与比较（09 §1.5）：ja / en 词典与 zh-CN 结构相同，叶子是字符串（空字符串表示“未翻译”）。
 * `compareDicts` 是 `npm run i18n:check` 与单元测试共用的纯函数：缺少的键、多余的键、占位符不一致、类型不一致。
 */
import { placeholders } from './text';

/** 与源词典结构相同、叶子为字符串的词典（键可省略，由 i18n:check 检查是否齐全）。 */
export type Dict<T> = T extends string
  ? string
  : T extends readonly (infer U)[]
    ? readonly Dict<U>[]
    : T extends object
      ? { readonly [K in keyof T]?: Dict<T[K]> }
      : never;

export interface DictIssue {
  key: string;
  kind: 'missing' | 'empty' | 'extra' | 'placeholders' | 'type';
  detail?: string;
}

/** 叶子路径 → 值（数组下标也是一段路径）。 */
export function flatten(v: unknown, prefix = '', out = new Map<string, unknown>()): Map<string, unknown> {
  if (v && typeof v === 'object') {
    for (const [k, x] of Object.entries(v as Record<string, unknown>)) {
      const p = prefix ? `${prefix}.${k}` : k;
      if (x && typeof x === 'object') flatten(x, p, out);
      else out.set(p, x);
    }
  }
  return out;
}

/** 比较一种语言的词典与源词典。 */
export function compareDicts(source: unknown, target: unknown): DictIssue[] {
  const src = flatten(source);
  const dst = flatten(target);
  const issues: DictIssue[] = [];
  for (const [key, s] of src) {
    if (!dst.has(key)) {
      issues.push({ key, kind: 'missing' });
      continue;
    }
    const d = dst.get(key);
    if (typeof d !== 'string' || typeof s !== 'string') {
      if (typeof d !== typeof s) issues.push({ key, kind: 'type', detail: `${typeof s} expected, got ${typeof d}` });
      continue;
    }
    if (d === '') {
      issues.push({ key, kind: 'empty' });
      continue;
    }
    const a = placeholders(s).join(',');
    const b = placeholders(d).join(',');
    if (a !== b) issues.push({ key, kind: 'placeholders', detail: `zh-CN {${a}} ≠ {${b}}` });
  }
  for (const key of dst.keys()) if (!src.has(key)) issues.push({ key, kind: 'extra' });
  return issues;
}

export interface Coverage {
  total: number;
  translated: number;
}

export function coverage(source: unknown, target: unknown): Coverage {
  const src = flatten(source);
  const dst = flatten(target);
  let translated = 0;
  for (const key of src.keys()) {
    const d = dst.get(key);
    if (typeof d === 'string' && d !== '') translated++;
  }
  return { total: src.size, translated };
}
