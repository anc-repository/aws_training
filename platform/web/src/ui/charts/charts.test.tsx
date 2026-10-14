import { render } from '@testing-library/react';
import type { ReactNode } from 'react';
import { describe, expect, it } from 'vitest';
import { VisualI18nProvider } from '../glyphs/visualI18n';
import { BarChart, MetricIcon, MetricStrip, ProgressRing, STEP_TYPES, StepTypeIcon, StepTypeTag, barWidths, ringGeometry } from './index';

const inLang = (lang: string, node: ReactNode) => render(<VisualI18nProvider lang={lang}>{node}</VisualI18nProvider>);
/** 读屏可见的文字（去掉 aria-hidden 的部分）。 */
const spokenText = (el: Element) => {
  const c = el.cloneNode(true) as Element;
  c.querySelectorAll('[aria-hidden="true"]').forEach((n) => n.remove());
  return c.textContent;
};

describe('<StepTypeIcon>', () => {
  it('has a distinct drawing for every lab step type and labels it in the current language', () => {
    const drawings = new Set<string>();
    for (const type of STEP_TYPES) {
      const { container, unmount } = inLang('ja', <StepTypeIcon type={type} label />);
      const svg = container.querySelector('svg') as SVGSVGElement;
      expect(svg.getAttribute('data-step-type')).toBe(type);
      drawings.add(svg.innerHTML);
      unmount();
    }
    expect(drawings.size).toBe(STEP_TYPES.length);
    const { getByRole } = inLang('ja', <StepTypeIcon type="experiment" label />);
    expect(getByRole('img').getAttribute('aria-label')).toBe('比較実験');
  });

  it('StepTypeTag shows icon + short label; unknown types fall back to the raw id', () => {
    const { container } = inLang('en', <StepTypeTag type="cli" />);
    expect(container.textContent).toBe('CLI');
    const unknown = inLang('en', <StepTypeTag type="quiz" />);
    expect(unknown.container.textContent).toBe('quiz');
    expect(unknown.container.querySelector('svg')?.getAttribute('aria-hidden')).toBe('true');
  });
});

describe('<MetricIcon>', () => {
  it('formats durations with Intl per language', () => {
    expect(inLang('ja', <MetricIcon kind="duration" minutes={90} />).container.querySelector('.mi-text')?.textContent).toBe('90 分');
    expect(inLang('en', <MetricIcon kind="duration" minutes={90} />).container.querySelector('.mi-text')?.textContent).toBe('90 min');
    expect(inLang('zh-CN', <MetricIcon kind="duration" minutes={90} />).container.querySelector('.mi-text')?.textContent).toBe('90分钟');
  });

  it('pairs each icon with a short label and a screen-reader metric name', () => {
    const { container } = inLang('ja', <MetricStrip difficulty="intermediate" minutes={60} cost="medium" provision="C" />);
    const items = [...container.querySelectorAll('.mi')];
    expect(items.map((m) => m.getAttribute('data-metric'))).toEqual(['difficulty', 'duration', 'cost', 'provision']);
    expect(items.map(spokenText)).toEqual(['難易度：中級', '所要時間の目安：60 分', 'コスト区分：中', '環境準備：遅め']);
    expect(container.querySelectorAll('.mi-ico rect.on')).toHaveLength(3);
    expect(container.querySelectorAll('.mi-cost .on')).toHaveLength(2);
  });

  it('compact metrics are a single labelled image', () => {
    const { getByRole } = inLang('en', <MetricIcon kind="provision" value="A" compact />);
    expect(getByRole('img').getAttribute('aria-label')).toBe('Setup time: Fast');
  });
});

describe('<ProgressRing>', () => {
  it('computes the arc and labels it with an Intl percentage', () => {
    expect(ringGeometry(3, 4, 48).ratio).toBe(0.75);
    expect(ringGeometry(5, 4, 48).ratio).toBe(1);
    expect(ringGeometry(1, 0, 48).ratio).toBe(0);
    const { getByRole, container } = inLang('ja', <ProgressRing value={3} max={5} label="必修カード" />);
    expect(getByRole('img').getAttribute('aria-label')).toBe('必修カード：60%');
    expect(container.querySelector('.pring-text')?.textContent).toBe('60%');
    const small = inLang('en', <ProgressRing value={0} label="Elective" size={24} />);
    expect(small.container.querySelector('.pring-fill')).toBeNull();
    expect(small.container.querySelector('.pring-text')).toBeNull();
  });
});

describe('<BarChart>', () => {
  it('is a data table: row headers, decorative bars scaled to the max, value text', () => {
    expect(barWidths([{ value: 2 }, { value: 4 }, { value: 0 }])).toEqual([50, 100, 0]);
    expect(barWidths([{ value: 2 }], 8)).toEqual([25]);
    const { container } = inLang(
      'en',
      <BarChart
        caption="Completed cards by domain"
        data={[
          { key: 'secure', label: 'Secure', value: 3 },
          { key: 'cost', label: 'Cost', value: 1234, tone: 'before' },
        ]}
      />,
    );
    expect(container.querySelector('caption')?.textContent).toBe('Completed cards by domain');
    const rows = [...container.querySelectorAll('tbody tr')];
    expect(rows.map((r) => r.querySelector('th')?.textContent)).toEqual(['Secure', 'Cost']);
    expect(rows.map((r) => r.querySelector('.bchart-val')?.textContent)).toEqual(['3', '1,234']);
    expect(rows[1].querySelector('.bchart-fill')?.getAttribute('class')).toBe('bchart-fill before');
    expect(rows[0].querySelector('.bchart-bar')?.getAttribute('aria-hidden')).toBe('true');
    expect(container.querySelectorAll('thead th')).toHaveLength(2);
  });
});
