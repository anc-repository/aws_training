import { render } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import registryYaml from '../../../../../modules/registry.yaml?raw';
import taxonomyYaml from '../../../../../labs/_catalog/taxonomy.yaml?raw';
import { buildGlyphRegistrySource } from '../../../scripts/gen-glyph-registry.mjs';
import generatedSource from './registry.generated.ts?raw';
import {
  GLYPH_GROUPS,
  GLYPH_MODULES,
  GROUP_SYMBOLS,
  MODULE_IDS,
  MOTIFS,
  ServiceChip,
  ServiceGlyph,
  VISUAL_MESSAGES,
  VisualI18nProvider,
  glyphModule,
  resolveModuleId,
  resolveVisualLang,
  visualT,
} from './index';

const registryModuleIds = [...registryYaml.matchAll(/^ {2}([a-z0-9-]+):\s*$/gm)].map((m) => m[1]);

describe('glyph registry (generated from modules/registry.yaml)', () => {
  it('is up to date with registry.yaml and taxonomy.yaml', () => {
    expect(generatedSource.replace(/\r\n/g, '\n')).toBe(buildGlyphRegistrySource(registryYaml, taxonomyYaml));
  });

  it('has all 40 registry modules, in registry order', () => {
    expect(registryModuleIds).toHaveLength(40);
    expect(MODULE_IDS).toEqual(registryModuleIds);
  });

  it('every module has exactly one motif, a known group with a symbol, and a unique abbreviation', () => {
    expect(Object.keys(MOTIFS).sort()).toEqual([...MODULE_IDS].sort());
    const groups = new Set(GLYPH_GROUPS.map((g) => g.id));
    expect([...groups].sort()).toEqual(['A', 'B', 'C', 'D', 'E', 'F', 'base']);
    for (const g of groups) expect(GROUP_SYMBOLS[g]).toBeTruthy();
    for (const m of GLYPH_MODULES) {
      expect(groups.has(m.group)).toBe(true);
      expect(m.abbr.length).toBeGreaterThan(0);
      expect(m.abbr.length).toBeLessThanOrEqual(4);
    }
    expect(new Set(GLYPH_MODULES.map((m) => m.abbr)).size).toBe(40);
  });

  it('derives hard dependencies from requires (own-switch conditions only, warnings excluded)', () => {
    expect(glyphModule('db-proxy')?.deps.hard).toEqual(['database']);
    expect(glyphModule('identity-pool')?.deps.hard).toEqual(['storage']);
    expect(glyphModule('autoscaling')?.deps.hard).toEqual(['iam', 'load-balancer']);
    expect(glyphModule('waf')?.deps.anyOf).toEqual([['cdn', 'load-balancer']]);
    expect(glyphModule('load-balancer')?.deps.hard).toEqual([]);
    expect(glyphModule('social-api')?.deps.cond).toContain('social-store');
  });

  it('resolves taxonomy service ids and attached services to modules', () => {
    expect(resolveModuleId('s3')).toBe('storage');
    expect(resolveModuleId('cloudfront')).toBe('cdn');
    expect(resolveModuleId('ebs')).toBe('ec2');
    expect(resolveModuleId('shield')).toBe('waf');
    // 与模块 id 同名的服务 id 不做别名：config 是 Parameter Store 模块
    expect(resolveModuleId('config')).toBe('config');
    expect(resolveModuleId('eventbridge')).toBeNull();
  });
});

describe('<ServiceGlyph>', () => {
  it('renders every module at 16, 24 and 48 px (icon below 40 px, badge with abbreviation from 40 px)', () => {
    for (const id of MODULE_IDS) {
      for (const size of [16, 24, 48]) {
        const { container, unmount } = render(<ServiceGlyph id={id} size={size} />);
        const svg = container.querySelector('svg') as SVGSVGElement;
        expect(svg.getAttribute('data-glyph')).toBe(id);
        expect(svg.getAttribute('width')).toBe(String(size));
        expect(svg.getAttribute('aria-hidden')).toBe('true');
        expect(svg.querySelector('.sg-motif')).not.toBeNull();
        const text = svg.querySelector('.sg-abbr');
        if (size >= 40) expect(text?.textContent).toBe(glyphModule(id)?.abbr);
        else expect(text).toBeNull();
        unmount();
      }
    }
  });

  it('labels the glyph in the provider language and accepts service ids', () => {
    const { getByRole, rerender } = render(
      <VisualI18nProvider lang="ja">
        <ServiceGlyph id="s3" label />
      </VisualI18nProvider>,
    );
    expect(getByRole('img').getAttribute('aria-label')).toBe('Amazon S3（写真のオブジェクトストレージ）');
    expect(getByRole('img').getAttribute('data-glyph')).toBe('storage');
    rerender(
      <VisualI18nProvider lang="en">
        <ServiceGlyph id="storage" label tooltip />
      </VisualI18nProvider>,
    );
    expect(getByRole('img').getAttribute('aria-label')).toBe('Amazon S3 (Photo object storage)');
    expect(getByRole('img').querySelector('title')?.textContent).toBe('Amazon S3 · Data and storage');
  });

  it('without a provider follows <html lang> (set by the i18n runtime)', () => {
    const html = document.documentElement;
    const prev = html.getAttribute('lang');
    try {
      html.setAttribute('lang', 'en');
      const { getByRole } = render(<ServiceGlyph id="queue" label />);
      expect(getByRole('img').getAttribute('aria-label')).toBe('Amazon SQS (Async job queue and dead-letter queue)');
    } finally {
      if (prev == null) html.removeAttribute('lang');
      else html.setAttribute('lang', prev);
    }
  });

  it('falls back to a neutral tile for unknown ids', () => {
    const { container } = render(<ServiceGlyph id="eventbridge" />);
    const svg = container.querySelector('svg') as SVGSVGElement;
    expect(svg.classList.contains('unknown')).toBe(true);
    expect(svg.querySelector('.sg-abbr')?.textContent).toBe('EVE');
  });

  it('ServiceChip shows the product short name untranslated and the function in the current language', () => {
    const { container } = render(
      <VisualI18nProvider lang="zh-CN">
        <ServiceChip id="cache" showFunction />
      </VisualI18nProvider>,
    );
    expect(container.querySelector('.sg-chip-name')?.textContent).toBe('ElastiCache');
    expect(container.querySelector('.sg-chip-fn')?.textContent).toBe('共享缓存');
  });
});

describe('visual i18n adapter', () => {
  const placeholders = (s: string) => [...s.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort();

  it('ja and en cover every zh-CN key with the same placeholders', () => {
    const src = VISUAL_MESSAGES['zh-CN'];
    for (const lang of ['ja', 'en'] as const) {
      const dict = VISUAL_MESSAGES[lang];
      expect(Object.keys(dict).sort()).toEqual(Object.keys(src).sort());
      for (const [k, v] of Object.entries(src)) {
        expect(dict[k as keyof typeof dict].trim(), `${lang} ${k}`).not.toBe('');
        expect(placeholders(dict[k as keyof typeof dict]), `${lang} ${k}`).toEqual(placeholders(v));
      }
    }
    for (const id of MODULE_IDS) expect(src[`visual.fn.${id}` as keyof typeof src]).toBeTruthy();
  });

  it('defaults to ja and normalizes BCP 47 tags', () => {
    expect(resolveVisualLang(undefined)).toBe('ja');
    expect(resolveVisualLang('fr')).toBe('ja');
    expect(resolveVisualLang('en-US')).toBe('en');
    expect(resolveVisualLang('zh-Hans-CN')).toBe('zh-CN');
  });

  it('prefers the external translator, then the built-in dictionary', () => {
    expect(visualT('ja', 'visual.diagram.after', undefined, () => null)).toBe('完了後');
    expect(visualT('ja', 'visual.diagram.after', undefined, (k) => (k === 'visual.diagram.after' ? 'X' : null))).toBe('X');
    expect(visualT('en', 'visual.diagram.added', { nodes: 'S3' })).toBe('Added: S3');
  });
});
