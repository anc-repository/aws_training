/**
 * 结果类画面的多语言与图形化（09 §1、「视觉化」I6 f；web-results）：
 * - 本组负责的词典（结果画面与全局框架）ja / en 没有缺键、空值与占位符不一致；
 * - 图形组件（visuals.tsx）的几何与可访问性；
 * - 页面在日语下渲染（默认语言）。
 */
import { render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { setLocale } from '../../i18n';
import { compareDicts } from '../../i18n/dict';
import enCore from '../../i18n/en/core';
import enFrame from '../../i18n/en/frame';
import enPages from '../../i18n/en/pages';
import jaCore from '../../i18n/ja/core';
import jaFrame from '../../i18n/ja/frame';
import jaPages from '../../i18n/ja/pages';
import { en } from '../../i18n/en';
import { ja } from '../../i18n/ja';
import { zhCN } from '../../i18n/zh-CN';
import zhCore from '../../i18n/zh-CN/core';
import zhFrame from '../../i18n/zh-CN/frame';
import zhPages from '../../i18n/zh-CN/pages';
import { json } from '../../test/helpers';
import { ledgerSegments } from '../end/ResourceStages';
import { STAGE_ICON } from '../end/EndPhaseList';
import { END_STAGES } from '../end/phases';
import { renderShareHtml } from '../share/renderShare';
import SessionsPage from './SessionsPage';
import { iso, mountAt } from './testHarness';
import { CertSeal, MiniBar, RatioMeter, StackBar, StepStrip, VTile, VTiles } from './visuals';

/** 本组负责的命名空间（整个）与共享命名空间中的子树。 */
const OWN_NS = ['experiments', 'end', 'report', 'share', 'certificates', 'verify', 'sessions'] as const;
const CORE_KEYS = ['app', 'nav', 'roles', 'account', 'session', 'footer', 'banners', 'p13', 'errors', 'i18n', 'fmt'] as const;
const FRAME_KEYS = ['routes', 'bar', 'notFound', 'residualOf', 'actions', 'pill', 'onboarding', 'footerCatalog', 'manualPage'] as const;

const pick = (o: Record<string, unknown>, keys: readonly string[]) => Object.fromEntries(keys.map((k) => [k, o[k]]));

afterEach(() => setLocale('zh-CN', { persist: false }));

describe('dictionaries owned by the result screens and the global frame (09 §1.5)', () => {
  it.each(['ja', 'en'] as const)('%s: every key translated, placeholders match', (lang) => {
    const dict = (lang === 'ja' ? ja : en) as unknown as Record<string, unknown>;
    const src = zhCN as unknown as Record<string, unknown>;
    for (const ns of OWN_NS) expect(compareDicts(src[ns], dict[ns]), ns).toEqual([]);
    const core = lang === 'ja' ? jaCore : enCore;
    const frame = lang === 'ja' ? jaFrame : enFrame;
    const pages = lang === 'ja' ? jaPages : enPages;
    expect(compareDicts(pick(zhCore, CORE_KEYS), pick(core as Record<string, unknown>, CORE_KEYS))).toEqual([]);
    expect(compareDicts(pick(zhFrame, FRAME_KEYS), pick(frame as Record<string, unknown>, FRAME_KEYS))).toEqual([]);
    expect(compareDicts(zhPages.manualExport, (pages as { manualExport?: unknown }).manualExport)).toEqual([]);
  });

  it('AWS service names, CLI and tags stay untranslated (I3)', () => {
    expect((ja as typeof zhCN).end.page.manualGuide).toContain('{tag}');
    expect((en as typeof zhCN).report.page.billNote).toContain('AWS Cost Explorer');
    expect((ja as typeof zhCN).report.page.billNote).toContain('atl:session-id');
    expect((ja as typeof zhCN).end.page.afterBody).toContain('CloudTrail');
  });
});

describe('visual primitives (I6 f)', () => {
  it('stack bar: segments in order, widths add up, zero segments omitted, tooltips', () => {
    const { container } = render(
      <StackBar
        segments={[
          { key: 'a', value: 3, tone: 'pass', label: 'A' },
          { key: 'b', value: 0, tone: 'pend', label: 'B' },
          { key: 'c', value: 1, tone: 'fail', label: 'C' },
        ]}
      />,
    );
    const rects = [...container.querySelectorAll('rect[data-seg]')];
    expect(rects.map((r) => r.getAttribute('data-seg'))).toEqual(['a', 'c']);
    expect(rects.map((r) => Number(r.getAttribute('width')))).toEqual([75, 25]);
    expect(rects[1]!.getAttribute('x')).toBe('75');
    expect(rects[0]!.querySelector('title')!.textContent).toBe('A: 3');
    expect(container.querySelector('svg')!.getAttribute('aria-hidden')).toBe('true');
  });

  it('mini bar, ratio meter with threshold, seal marks, step strip', () => {
    const { container } = render(
      <>
        <MiniBar done={1} total={4} />
        <RatioMeter value={0.5} min={0.8} />
        <RatioMeter value={0.9} min={0.8} />
        <CertSeal tone="pass" mark="check" />
        <CertSeal tone="faint" mark="none" hollow />
        <StepStrip
          items={[
            { key: 's1', n: 1, tone: 'pass', filled: true, tip: '1 a · done' },
            { key: 's2', n: 2, tone: 'mut', filled: false, tip: '2 b · available' },
          ]}
        />
      </>,
    );
    expect(container.querySelector('.vmini rect.vtone')!.getAttribute('width')).toBe('25');
    expect([...container.querySelectorAll('.vmeter')].map((m) => m.getAttribute('data-ok'))).toEqual(['0', '1']);
    expect(container.querySelector('.vmeter-tick')!.getAttribute('x1')).toBe('80');
    expect([...container.querySelectorAll('.vseal')].map((s) => s.getAttribute('data-seal'))).toEqual(['check', 'none']);
    expect(container.querySelector('.vseal.hollow')).toBeTruthy();
    const li = container.querySelectorAll('.vstrip li');
    expect(li).toHaveLength(2);
    expect(li[0]!.className).toBe('vtone pass fill');
    expect(li[1]!.getAttribute('title')).toBe('2 b · available');
    // CSP style-src 'self'：不写 style 属性
    expect(container.querySelector('[style]')).toBeNull();
  });

  it('tiles: decorative tiles are hidden from screen readers', () => {
    render(
      <VTiles decorative>
        <VTile visual={<span />} value={3} label="x" />
      </VTiles>,
    );
    expect(document.querySelector('.vtiles')!.getAttribute('aria-hidden')).toBe('true');
  });

  it('every end stage has an icon; ledger segments use the cleanup-state tones', () => {
    for (const s of END_STAGES) expect(STAGE_ICON[s.id]).toBeTruthy();
    const segs = ledgerSegments({ deleted: 2, deleting: 1, waiting: 0, retained: 0, attention: 1, total: 4 });
    expect(segs.map((s) => `${s.key}:${s.tone}`)).toEqual(['deleted:pass', 'deleting:pend', 'waiting:mut', 'retained:kept', 'attention:fail']);
  });
});

describe('Japanese (default) rendering', () => {
  it('P11 my labs in Japanese: title, end reason, duration and the overview tiles', async () => {
    setLocale('ja', { persist: false });
    mountAt('/sessions', {
      routes: [{ path: '/sessions', element: <SessionsPage /> }],
      api: {
        'GET /api/v1/sessions': json(200, {
          items: [{ sessionId: 's4k7m2q9x1abc', labId: 'svc-cdn', state: 'ENDED', endReason: 'USER_ENDED', createdAt: iso(-200), readyAt: iso(-190), endedAt: iso(-99), durationMinutes: 91, cleanup: { deleted: 3, manual: 0 } }],
          next: null,
        }),
      },
    });
    expect(await screen.findByRole('heading', { level: 1, name: 'ラボ履歴' })).toBeTruthy();
    expect(await screen.findByText('受講者が終了')).toBeTruthy();
    expect(screen.getAllByText(/1 時間 31 分/).length).toBeGreaterThan(0);
    const tiles = document.querySelector('[data-section="overview"] .vtiles')!;
    expect(tiles.getAttribute('aria-hidden')).toBe('true');
    expect([...tiles.querySelectorAll('[data-tile]')].map((x) => x.getAttribute('data-tile'))).toEqual(['sessions', 'ended', 'time', 'manual']);
  });

  it('share copy: the Japanese block comes first and is the default', () => {
    const html = renderShareHtml({ lab: { id: 'svc-cdn', title: 'CDN' }, steps: [{ stepId: 's1', title: 'a', state: 'done' }] }, { publishedAt: '2026-10-13T11:00:00Z', expiresAt: null });
    expect(html.indexOf('id="ja"')).toBeLessThan(html.indexOf('id="en"'));
    expect(html).toContain('<title>svc-cdn · ラボレポート（マスク済みコピー）</title>');
    expect(html).toContain('aria-label="ステップ: 100%"');
  });
});
