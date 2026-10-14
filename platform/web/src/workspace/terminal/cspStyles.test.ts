/**
 * xterm.js 6 在 `style-src 'self'` 下的补丁（cspStyles.ts，03 §3.7.6）：jsdom 没有可构造样式表，这里用一个记录文本的替身；
 * 真实浏览器中的效果（0 个 securitypolicyviolation、行文字为等宽字体）由 e2e:platform 的“4b csp-live”阶段在生产构建上验证。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { addStyleViaCssom, canAdoptStyles, openWithAdoptedStyles, patchRowStyleWrites } from './cspStyles';

class FakeSheet {
  static all: FakeSheet[] = [];
  text = '';
  constructor() {
    FakeSheet.all.push(this);
  }
  replaceSync(t: string) {
    this.text = t;
  }
}

function installAdoptedSheets(): void {
  vi.stubGlobal('CSSStyleSheet', FakeSheet);
  Object.defineProperty(document, 'adoptedStyleSheets', { configurable: true, writable: true, value: [] });
}

beforeEach(() => {
  FakeSheet.all = [];
});

afterEach(() => {
  vi.unstubAllGlobals();
  delete (document as unknown as Record<string, unknown>).adoptedStyleSheets;
  document.body.innerHTML = '';
});

describe('openWithAdoptedStyles', () => {
  it('turns <style> created during open() into adopted constructable sheets and restores createElement', () => {
    installAdoptedSheets();
    const host = document.createElement('div');
    document.body.appendChild(host);
    const proto = Object.getPrototypeOf(document) as Document;
    const styles = openWithAdoptedStyles(document, () => {
      const st = document.createElement('style');
      host.appendChild(st);
      st.textContent = '.xterm-rows { font-family: monospace; }';
      const other = document.createElement('div');
      other.className = 'xterm-screen';
      host.appendChild(other);
    });
    expect(styles).not.toBeNull();
    // no real <style> element reached the DOM; the text lives in an adopted sheet
    expect(document.querySelectorAll('style')).toHaveLength(0);
    expect(host.querySelector('.xterm-screen')).not.toBeNull();
    expect(FakeSheet.all).toHaveLength(1);
    expect(FakeSheet.all[0]!.text).toContain('font-family: monospace');
    expect(document.adoptedStyleSheets).toEqual([FakeSheet.all[0]]);
    // createElement is the prototype's again (later <style> elements are not touched)
    expect(Object.prototype.hasOwnProperty.call(document, 'createElement')).toBe(false);
    expect(document.createElement).toBe(proto.createElement);
    // later textContent updates (theme / font size changes) replace the sheet's rules
    const standIn = host.querySelector('[data-atl-adopted-style]') as HTMLElement;
    standIn.textContent = '.xterm-rows { font-size: 18px; }';
    expect(FakeSheet.all[0]!.text).toBe('.xterm-rows { font-size: 18px; }');
    expect(standIn.textContent).toBe('.xterm-rows { font-size: 18px; }');
    // xterm's dispose removes the element → the sheet is dropped
    standIn.remove();
    expect(document.adoptedStyleSheets).toEqual([]);
    expect(styles!.sheets.size).toBe(0);
  });

  it('dispose() drops the sheets xterm did not remove', () => {
    installAdoptedSheets();
    const keep = new FakeSheet() as unknown as CSSStyleSheet;
    document.adoptedStyleSheets = [keep];
    const styles = openWithAdoptedStyles(document, () => {
      const a = document.createElement('STYLE');
      document.body.appendChild(a);
      a.textContent = 'a{}';
      const b = document.createElement('style');
      document.body.appendChild(b);
      b.textContent = 'b{}';
    })!;
    expect(document.adoptedStyleSheets).toHaveLength(3);
    styles.dispose();
    expect(document.adoptedStyleSheets).toEqual([keep]);
  });

  it('without constructable stylesheets it just runs open()', () => {
    expect(canAdoptStyles(document)).toBe(false);
    const open = vi.fn(() => document.body.appendChild(document.createElement('style')));
    expect(openWithAdoptedStyles(document, open)).toBeNull();
    expect(open).toHaveBeenCalledTimes(1);
    expect(document.querySelectorAll('style')).toHaveLength(1);
  });

  it('restores createElement when open() throws', () => {
    installAdoptedSheets();
    expect(() =>
      openWithAdoptedStyles(document, () => {
        throw new Error('boom');
      }),
    ).toThrow('boom');
    expect(Object.prototype.hasOwnProperty.call(document, 'createElement')).toBe(false);
    expect(document.createElement('style').tagName).toBe('STYLE');
  });
});

describe('patchRowStyleWrites', () => {
  it('replaces the row factory _addStyle (setAttribute style) with CSSOM on the prototype', () => {
    class RowFactory {
      _addStyle(el: HTMLElement, style: string) {
        el.setAttribute('style', `${el.getAttribute('style') || ''}${style};`);
      }
    }
    const factory = new RowFactory();
    const term = { _core: { _renderService: { _renderer: { value: { _rowFactory: factory } } } } };
    expect(patchRowStyleWrites(term)).toBe(true);
    const span = document.createElement('span');
    const setAttribute = vi.spyOn(span, 'setAttribute');
    factory._addStyle(span, 'color:#0a141e');
    factory._addStyle(span, 'background-color:#ffffff');
    expect(setAttribute).not.toHaveBeenCalled();
    expect(span.style.getPropertyValue('color')).toBe('rgb(10, 20, 30)');
    expect(span.style.getPropertyValue('background-color')).toBe('rgb(255, 255, 255)');
    // a second terminal shares the prototype; patching again is a no-op
    expect(patchRowStyleWrites({ _core: { _renderService: { _renderer: { value: { _rowFactory: new RowFactory() } } } } })).toBe(true);
    expect(patchRowStyleWrites({})).toBe(false);
    expect(patchRowStyleWrites(null)).toBe(false);
  });

  it('addStyleViaCssom ignores malformed declarations', () => {
    const el = document.createElement('span');
    addStyleViaCssom(el, 'color:rgba(1, 2, 3, 0.5);nonsense;:x');
    expect(el.style.getPropertyValue('color')).toBe('rgba(1, 2, 3, 0.5)');
    expect(el.getAttribute('style')).toContain('color');
  });
});

describe('real xterm.js 6 (DOM renderer) in jsdom', () => {
  it('opens without a single <style> element and with the row style patch applied', async () => {
    installAdoptedSheets();
    // jsdom has no canvas and no matchMedia: xterm falls back to its own colour parsing without a canvas
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(null);
    vi.stubGlobal('matchMedia', (q: string) => ({ matches: false, media: q, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {} }));
    const { Terminal } = await import('@xterm/xterm');
    const host = document.createElement('div');
    document.body.appendChild(host);
    const term = new Terminal({ fontFamily: 'JetBrains Mono, monospace', fontSize: 14, minimumContrastRatio: 4.5 });
    const styles = openWithAdoptedStyles(document, () => term.open(host));
    expect(host.querySelector('.xterm-screen')).not.toBeNull();
    expect(document.querySelectorAll('style')).toHaveLength(0);
    expect(host.querySelectorAll('[data-atl-adopted-style]')).toHaveLength(3);
    const css = FakeSheet.all.map((s) => s.text).join('\n');
    expect(css).toContain('font-family: JetBrains Mono, monospace');
    expect(css).toContain('.xterm-scrollable-element');
    expect(patchRowStyleWrites(term)).toBe(true);
    term.dispose();
    styles?.dispose();
    expect(document.adoptedStyleSheets).toEqual([]);
  });
});
