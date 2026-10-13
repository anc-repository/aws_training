/**
 * 复制到剪贴板（08 P05.4）：优先 Clipboard API；不可用（沙箱 iframe、非安全上下文）时返回 false，
 * 由调用方“真正选中”文本并提示按 Ctrl+C（selectNodeText），或弹出预先选中的只读文本框。
 */
export async function copyText(text: string): Promise<boolean> {
  try {
    if (globalThis.navigator?.clipboard?.writeText) {
      await globalThis.navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    /* 落到兜底 */
  }
  return false;
}

/** 用 Range / Selection 选中节点中的文本（剪贴板不可用时的兜底）。 */
export function selectNodeText(node: Node | null): boolean {
  if (!node) return false;
  try {
    const sel = globalThis.getSelection?.();
    if (!sel) return false;
    const range = document.createRange();
    range.selectNodeContents(node);
    sel.removeAllRanges();
    sel.addRange(range);
    return true;
  } catch {
    return false;
  }
}
