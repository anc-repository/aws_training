/**
 * xterm.js 6 与生产 CSP `style-src 'self'`（01 §10.6、03 §3.7.6 的首选方案、08 V-4；CSP 不变）。
 *
 * xterm 6 的 DOM 渲染器有两类内联样式，在没有 'unsafe-inline' 的 CSP 下都会被浏览器拒绝：
 * - 运行时 `<style>`：DomRenderer 的主题样式（前景色、ANSI 色、font-family / font-size、光标与选区）和尺寸样式，Viewport 的
 *   滚动条样式（node_modules/@xterm/xterm/src/browser/renderer/dom/DomRenderer.ts、Viewport.ts）；
 * - `setAttribute('style', …)`：DomRendererRowFactory._addStyle（真彩色前景 / 背景、最低对比度调整后的颜色）。
 * 被拒绝后行文字回退成页面的比例字体，而 xterm 仍按等宽字体测量单元格，列对齐、光标、换行与选区全部错位。
 *
 * 处理（运行时补丁，不需要 patch-package）：
 * 1. `openWithAdoptedStyles`：在 `term.open()` 期间临时替换 `document.createElement`，'style' 换成一个不渲染的 `<template>`
 *    替身（不是 `<style>`，浏览器不对它做 CSP 检查）；替身的 textContent 写进一个可构造样式表（`new CSSStyleSheet()` +
 *    `replaceSync()`），挂到 `document.adoptedStyleSheets`，`remove()` 时摘下。可构造样式表经 CSSOM 生效，不受 style-src
 *    的内联限制。xterm 6 只在 open() 中创建这 3 个元素，之后（换主题、改字号）只改它们的 textContent。
 * 2. `patchRowStyleWrites`：把行工厂原型上的 `_addStyle` 改为 `element.style.setProperty`（CSSOM）。
 * 浏览器不支持可构造样式表（Safari < 16.4）或 xterm 内部结构变了时不打补丁，行为与原来相同（控制台警告一次）。
 */

type CreateElement = Document['createElement'];

export interface AdoptedStyles {
  /** 本终端创建的样式表（测试与诊断用）。 */
  readonly sheets: ReadonlySet<CSSStyleSheet>;
  /** 摘下本终端仍挂着的样式表（终端 dispose 之后调用；xterm 自己 remove() 过的不受影响）。 */
  dispose(): void;
}

/** 当前环境能否用可构造样式表代替 `<style>`。 */
export function canAdoptStyles(doc: Document): boolean {
  const Sheet = (globalThis as { CSSStyleSheet?: typeof CSSStyleSheet }).CSSStyleSheet;
  return typeof Sheet === 'function' && typeof Sheet.prototype?.replaceSync === 'function' && Array.isArray((doc as { adoptedStyleSheets?: unknown }).adoptedStyleSheets);
}

function adopt(doc: Document, sheet: CSSStyleSheet): void {
  if (!doc.adoptedStyleSheets.includes(sheet)) doc.adoptedStyleSheets = [...doc.adoptedStyleSheets, sheet];
}

function drop(doc: Document, sheet: CSSStyleSheet): void {
  if (doc.adoptedStyleSheets.includes(sheet)) doc.adoptedStyleSheets = doc.adoptedStyleSheets.filter((s) => s !== sheet);
}

/** 一个 `<style>` 的替身：可以 append / remove，textContent 写入可构造样式表。 */
function styleStandIn(doc: Document, create: CreateElement, sheets: Set<CSSStyleSheet>): HTMLElement {
  const el = create.call(doc, 'template');
  el.setAttribute('data-atl-adopted-style', '');
  const sheet = new CSSStyleSheet();
  sheets.add(sheet);
  let text = '';
  Object.defineProperty(el, 'textContent', {
    configurable: true,
    get: () => text,
    set: (v: unknown) => {
      text = v === null || v === undefined ? '' : String(v);
      try {
        sheet.replaceSync(text);
      } catch {
        /* replaceSync 只在含 @import 时报错；xterm 的样式没有 */
      }
      adopt(doc, sheet);
    },
  });
  const remove = el.remove.bind(el);
  Object.defineProperty(el, 'remove', {
    configurable: true,
    value: () => {
      remove();
      drop(doc, sheet);
      sheets.delete(sheet);
    },
  });
  return el;
}

/**
 * 在 `open()` 执行期间把 `doc.createElement('style')` 换成替身（只影响这段同步代码），之后恢复原状。
 * 不支持可构造样式表时直接执行 `open()`，返回 null。
 */
export function openWithAdoptedStyles(doc: Document, open: () => void): AdoptedStyles | null {
  if (!canAdoptStyles(doc)) {
    open();
    return null;
  }
  const sheets = new Set<CSSStyleSheet>();
  const own = Object.prototype.hasOwnProperty.call(doc, 'createElement');
  const previous = doc.createElement;
  const patched = function (this: Document, tagName: string, options?: ElementCreationOptions): HTMLElement {
    if (typeof tagName === 'string' && tagName.toLowerCase() === 'style') return styleStandIn(doc, previous, sheets);
    return previous.call(doc, tagName, options);
  };
  Object.defineProperty(doc, 'createElement', { configurable: true, writable: true, value: patched });
  try {
    open();
  } finally {
    if (own) Object.defineProperty(doc, 'createElement', { configurable: true, writable: true, value: previous });
    else delete (doc as unknown as Record<string, unknown>).createElement;
  }
  return {
    sheets,
    dispose: () => {
      for (const s of sheets) drop(doc, s);
      sheets.clear();
    },
  };
}

const PATCHED = Symbol.for('atl.xterm.cssomAddStyle');

interface RowFactoryProto {
  _addStyle?: (el: HTMLElement, style: string) => void;
  [PATCHED]?: boolean;
}

/** `prop:value` → `element.style.setProperty(prop, value)`（CSSOM，不经 style 属性）。 */
export function addStyleViaCssom(el: HTMLElement, style: string): void {
  for (const decl of style.split(';')) {
    const i = decl.indexOf(':');
    if (i <= 0) continue;
    const prop = decl.slice(0, i).trim();
    const value = decl.slice(i + 1).trim();
    if (prop && value) el.style.setProperty(prop, value);
  }
}

/**
 * 把 DOM 渲染器行工厂的 `_addStyle`（`setAttribute('style', …)`）改为 CSSOM。路径是 xterm 6.0 的内部结构
 * （`Terminal._core._renderService._renderer.value._rowFactory`，见 lib/xterm.mjs）；改的是原型，所有终端共用一次。
 * 返回 false 表示没找到（xterm 版本变化），调用方给出警告。
 */
export function patchRowStyleWrites(term: unknown): boolean {
  const core = (term as { _core?: { _renderService?: { _renderer?: { value?: { _rowFactory?: unknown } } } } } | null)?._core;
  const factory = core?._renderService?._renderer?.value?._rowFactory;
  const proto = (factory ? Object.getPrototypeOf(factory) : null) as RowFactoryProto | null;
  if (!proto || typeof proto._addStyle !== 'function') return false;
  if (!proto[PATCHED]) {
    proto._addStyle = addStyleViaCssom;
    proto[PATCHED] = true;
  }
  return true;
}
