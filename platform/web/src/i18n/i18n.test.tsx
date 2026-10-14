import { act, fireEvent, render, screen } from '@testing-library/react';
import { useEffect, useState, type ReactNode } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { contentUrl, fetchContentJson, manualUntranslated, untranslated } from './content';
import { compareDicts, coverage } from './dict';
import { en } from './en';
import { fmtClock, fmtDate } from './format';
import { ja } from './ja';
import { DEFAULT_LOCALE, fallbackChain, storedLocale } from './locale';
import { LanguageSwitcher } from './LanguageSwitcher';
import { LocaleRoot } from './LocaleRoot';
import { useReloadOnLocale } from './hooks';
import { getLocale, msg, setLocale } from './runtime';
import { placeholders, t } from './text';
import { rich } from './template';
import { zhCN } from './zh-CN';

afterEach(() => setLocale('zh-CN', { persist: false }));

describe('locale (I1)', () => {
  it('defaults to Japanese on the first visit and never reads the browser language', () => {
    vi.spyOn(navigator, 'language', 'get').mockReturnValue('zh-CN');
    expect(storedLocale()).toBe('ja');
    expect(DEFAULT_LOCALE).toBe('ja');
  });

  it('remembers the choice in localStorage and follows it with <html lang>', () => {
    setLocale('en');
    expect(globalThis.localStorage.getItem('atl.locale.v1')).toBe('"en"');
    expect(storedLocale()).toBe('en');
    expect(document.documentElement.lang).toBe('en');
    setLocale('zh-CN', { persist: false });
    expect(document.documentElement.lang).toBe('zh-CN');
  });

  it('falls back selected → en → zh-CN (I2)', () => {
    expect(fallbackChain('ja')).toEqual(['ja', 'en', 'zh-CN']);
    expect(fallbackChain('en')).toEqual(['en', 'zh-CN']);
    expect(fallbackChain('zh-CN')).toEqual(['zh-CN', 'en']);
  });
});

describe('dictionaries', () => {
  it('ja and en have exactly the keys of zh-CN, every one translated, with matching placeholders (I2 CI check)', () => {
    // 空字符串（未翻译）也算问题：新增的键必须同时给出 ja 与 en，否则 npm test 失败（与 npm run i18n:check 相同）
    for (const d of [ja, en]) {
      const issues = compareDicts(zhCN, d);
      expect(issues).toEqual([]);
    }
    expect(coverage(zhCN, ja).total).toBeGreaterThan(1500);
  });

  it('msg is rewritten in place on a language switch; missing texts fall back to zh-CN', () => {
    const alias = msg.app;
    setLocale('ja', { persist: false });
    expect(getLocale()).toBe('ja');
    expect(msg.app).toBe(alias);
    // 语言切换器的文案已有三种语言
    expect(msg.i18n.untranslated).toBe('未翻訳');
    // 尚未翻译的键回退到 zh-CN 源文案（不会是空字符串）
    expect(msg.app.retry.length).toBeGreaterThan(0);
    setLocale('en', { persist: false });
    expect(msg.i18n.untranslated).toBe('Not translated');
    setLocale('zh-CN', { persist: false });
    expect(msg.app.retry).toBe('重试');
  });
});

describe('templates', () => {
  it('substitutes placeholders and plural branches', () => {
    expect(t('{n} 张卡片', { n: 3 })).toBe('3 张卡片');
    setLocale('en', { persist: false });
    const tpl = '{n, plural, one {# card} other {# cards}} in {track}';
    expect(t(tpl, { n: 1, track: 'saa' })).toBe('1 card in saa');
    expect(t(tpl, { n: 12, track: 'saa' })).toBe('12 cards in saa');
    expect(placeholders(tpl)).toEqual(['n', 'track']);
  });

  it('rich() keeps the word order of the template', () => {
    render(<p data-testid="r">{rich('Session {sid} · {state}', { sid: <b>s1</b>, state: 'RUNNING' })}</p>);
    expect(screen.getByTestId('r').innerHTML).toBe('Session <b>s1</b> · RUNNING');
  });
});

describe('format (Intl)', () => {
  it('keeps the 08 §1.6 zh-CN formats and uses Intl for ja / en', () => {
    const at = new Date(2026, 9, 13, 10, 42).getTime();
    const now = new Date(2026, 9, 14).getTime();
    expect(fmtDate(at, now, 'zh-CN')).toBe('10/13 10:42');
    expect(fmtDate(new Date(2025, 0, 2).getTime(), now, 'zh-CN')).toBe('2025-01-02');
    expect(fmtClock(at, 'ja')).toBe('10:42');
    expect(fmtDate(at, now, 'en')).toMatch(/Oct/);
  });
});

describe('content by language (I4)', () => {
  it('rewrites content URLs: zh-CN at the root, ja / en under <lang>/', () => {
    expect(contentUrl('/content/2026.10.1/catalog/index.json', 'ja')).toBe('/content/2026.10.1/ja/catalog/index.json');
    expect(contentUrl('/content/2026.10.1/ja/labs/svc-cdn.json', 'zh-CN')).toBe('/content/2026.10.1/labs/svc-cdn.json');
    expect(contentUrl('/api/v1/catalog', 'ja')).toBe('/api/v1/catalog');
  });

  it('falls back to the source file when the language file is missing and marks the document', async () => {
    const calls: string[] = [];
    const fake = (async (url: string) => {
      calls.push(url);
      return url.includes('/ja/') ? new Response('', { status: 404 }) : new Response(JSON.stringify({ title: '源' }), { status: 200 });
    }) as unknown as typeof fetch;
    const r = await fetchContentJson<{ title: string }>('/content/v1/labs/svc-cdn.json', fake, 'ja');
    expect(calls).toEqual(['/content/v1/ja/labs/svc-cdn.json', '/content/v1/labs/svc-cdn.json']);
    expect(r.ok).toBe(true);
    expect(untranslated(r.data, '/title')).toBe(true);
  });

  it('reads fallback pointers written by labs:build', () => {
    const doc = { i18n: { lang: 'ja', fallback: ['/steps/2/title', '/summary'] } };
    expect(untranslated(doc, '/summary')).toBe(true);
    expect(untranslated(doc, '/steps/2')).toBe(true);
    expect(untranslated(doc, '/title')).toBe(false);
    expect(untranslated({ i18n: { lang: 'zh-CN', fallback: ['/x'] } }, '/x')).toBe(false);
    expect(manualUntranslated({ lang: 'zh-CN' }, 'ja')).toBe(true);
    expect(manualUntranslated({ lang: 'ja' }, 'ja')).toBe(false);
  });
});

describe('LanguageSwitcher', () => {
  it('lists 日本語 / English / 中文 and switches the language', async () => {
    const onChanged = vi.fn();
    render(<LanguageSwitcher onChanged={onChanged} />);
    const select = screen.getByRole('combobox');
    expect(Array.from((select as HTMLSelectElement).options).map((o) => o.text)).toEqual(['日本語', 'English', '中文']);
    fireEvent.change(select, { target: { value: 'en' } });
    expect(getLocale()).toBe('en');
    expect(onChanged).toHaveBeenCalledWith('en');
  });
});

describe('LocaleRoot (switching in place)', () => {
  it('re-renders the whole tree in the new language without remounting it (state and effects survive)', () => {
    setLocale('ja', { persist: false });
    const mounts = vi.fn();
    const unmounts = vi.fn();
    const reloads = vi.fn();
    function Leaf() {
      const [n, setN] = useState(0);
      useEffect(() => {
        mounts();
        return () => unmounts();
      }, []);
      useReloadOnLocale(reloads);
      return (
        <button type="button" onClick={() => setN((x) => x + 1)}>
          {msg.i18n.untranslated} {n}
        </button>
      );
    }
    // a parent that never re-renders by itself: the leaf must still follow the language
    function Static({ children }: { children: ReactNode }) {
      return <div>{children}</div>;
    }
    function App() {
      return (
        <Static>
          <Leaf />
        </Static>
      );
    }
    render(
      <LocaleRoot>
        <App />
      </LocaleRoot>,
    );
    fireEvent.click(screen.getByRole('button'));
    expect(screen.getByRole('button').textContent).toBe('未翻訳 1');
    act(() => setLocale('en', { persist: false }));
    expect(screen.getByRole('button').textContent).toBe('Not translated 1');
    expect(document.documentElement.lang).toBe('en');
    expect(mounts).toHaveBeenCalledTimes(1);
    expect(unmounts).not.toHaveBeenCalled();
    expect(reloads).toHaveBeenCalledTimes(1);
  });
});
