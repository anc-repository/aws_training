/**
 * 带文字的常量表（09 §1.2）：状态、形状、色调这类不随语言变化的属性写在代码里，`text` 从当前语言的词典读取（getter），
 * 所以模块级的表在切换语言后不需要重建。
 */
export function withText<K extends string, M extends object>(base: Readonly<Record<K, M>>, texts: Readonly<Record<K, string>>): Readonly<Record<K, M & { readonly text: string }>> {
  const out = {} as Record<K, M & { readonly text: string }>;
  for (const k of Object.keys(base) as K[]) {
    out[k] = Object.defineProperty({ ...base[k] }, 'text', { get: () => texts[k], enumerable: true, configurable: true }) as M & { readonly text: string };
  }
  return out;
}

/** 按键取当前语言的文字（数组形式的选项表用）。 */
export function textOf<K extends string>(texts: Readonly<Record<K, string>>, k: K): string {
  return texts[k];
}
