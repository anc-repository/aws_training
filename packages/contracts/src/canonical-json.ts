/**
 * RFC 8785（JSON Canonicalization Scheme）规范化，与 platform/shared 的 jcs 同一算法（06 PM-33 第 11 步、PM-38）：
 * - 对象成员按键的 UTF-16 码元顺序排序；数组保持顺序；
 * - 数字按 ECMAScript Number.prototype.toString（JSON.stringify 对有限数即为该形式）；非有限数拒绝；
 * - 字符串按 JSON.stringify 转义（RFC 8785 §3.2.2.2 与 ECMAScript 一致）；
 * - undefined 的对象成员省略（与 JSON.stringify 一致），数组中的 undefined 拒绝。
 * scripts/module 的 plan 摘要与 experiments 的 integrity 摘要都用它（sha256 由调用方用 node:crypto 计算）。
 */
export function canonicalJson(value: unknown): string {
  if (value === null) return 'null';
  switch (typeof value) {
    case 'boolean':
      return value ? 'true' : 'false';
    case 'number':
      if (!Number.isFinite(value)) throw new TypeError('canonicalJson: non-finite number');
      return Object.is(value, -0) ? '0' : JSON.stringify(value);
    case 'string':
      return JSON.stringify(value);
    case 'object': {
      if (Array.isArray(value)) {
        return `[${value.map((v) => {
          if (v === undefined) throw new TypeError('canonicalJson: undefined in array');
          return canonicalJson(v);
        }).join(',')}]`;
      }
      const obj = value as Record<string, unknown>;
      const keys = Object.keys(obj).filter((k) => obj[k] !== undefined).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
      return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalJson(obj[k])}`).join(',')}}`;
    }
    default:
      throw new TypeError(`canonicalJson: unsupported type ${typeof value}`);
  }
}
