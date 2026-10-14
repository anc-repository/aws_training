/**
 * 视觉组件展示页（I6，开发专用）：全部服务图标（16 / 24 / 48px）、步骤类型与指标图标、进度环、条形图，以及样本卡片的架构图。
 * 亮色 / 暗色 / 400px 宽度下的截图自查见 shoot.py。
 */
import { useEffect, useState } from 'react';
import { BarChart, MetricIcon, ProgressRing, STEP_TYPES, StepTypeIcon, StepTypeTag } from '../ui/charts';
import type { DifficultyValue, CostTierValue, ProvisionValue } from '../ui/charts';
import { ArchDiagram } from '../ui/diagram';
import {
  GLYPH_GROUPS,
  GLYPH_MODULES,
  GroupSymbol,
  PseudoGlyph,
  ServiceChip,
  ServiceGlyph,
  VisualI18nProvider,
  resolveVisualLang,
  useVisualI18n,
  type VisualKey,
  type VisualLang,
} from '../ui/glyphs';
import { SAMPLE_CARDS } from './sampleCards';

type Theme = 'system' | 'light' | 'dark';

function readParams(): { theme: Theme; lang: VisualLang; card: string | null } {
  const q = new URLSearchParams(window.location.search);
  const theme = q.get('theme');
  return {
    theme: theme === 'light' || theme === 'dark' ? theme : 'system',
    lang: resolveVisualLang(q.get('lang')),
    card: q.get('card'),
  };
}

function writeParam(key: string, value: string | null) {
  const q = new URLSearchParams(window.location.search);
  if (value == null) q.delete(key);
  else q.set(key, value);
  window.history.replaceState(null, '', `${window.location.pathname}?${q.toString()}`);
}

const LANG_NAMES: Readonly<Record<VisualLang, string>> = { ja: '日本語', en: 'English', 'zh-CN': '中文' };
const DIFFS: readonly DifficultyValue[] = ['intro', 'beginner', 'intermediate', 'advanced'];
const COSTS: readonly CostTierValue[] = ['low', 'medium', 'high'];
const PROVISIONS: readonly ProvisionValue[] = ['A', 'B', 'C', 'D'];

export function Gallery() {
  const [params, setParams] = useState(readParams);
  useEffect(() => {
    const html = document.documentElement;
    if (params.theme === 'system') html.removeAttribute('data-theme');
    else html.setAttribute('data-theme', params.theme);
    html.setAttribute('lang', params.lang);
  }, [params]);
  const set = (patch: Partial<typeof params>) => {
    const next = { ...params, ...patch };
    writeParam('theme', next.theme === 'system' ? null : next.theme);
    writeParam('lang', next.lang);
    setParams(next);
  };
  const cards = params.card ? SAMPLE_CARDS.filter((c) => c.id === params.card) : SAMPLE_CARDS;
  return (
    <VisualI18nProvider lang={params.lang}>
      <div className="atl-app gal">
        <header className="gal-head">
          <h1>ATL visual gallery</h1>
          <p className="gal-note">dev only · src/ui/glyphs · src/ui/diagram · src/ui/charts</p>
          <div className="gal-toggles">
            <div role="group" aria-label="Theme" className="gal-seg">
              {(['system', 'light', 'dark'] as const).map((th) => (
                <button key={th} type="button" className="btn sm" aria-pressed={params.theme === th} onClick={() => set({ theme: th })}>
                  {th}
                </button>
              ))}
            </div>
            <div role="group" aria-label="Language" className="gal-seg">
              {(['ja', 'en', 'zh-CN'] as const).map((l) => (
                <button key={l} type="button" className="btn sm" aria-pressed={params.lang === l} onClick={() => set({ lang: l })}>
                  {LANG_NAMES[l]}
                </button>
              ))}
            </div>
          </div>
        </header>
        <main className="gal-main">
          <GlyphSection />
          <PrimitivesSection />
          <section className="gal-sec" aria-labelledby="gal-arch">
            <h2 id="gal-arch">ArchDiagram</h2>
            {cards.map((c) => (
              <article key={c.id} className="gal-card" data-card={c.id}>
                <h3 className="mono">{c.id}</h3>
                <div className="gal-arch-row">
                  <div className="gal-mini">
                    <ArchDiagram input={c.input} size="mini" title={c.id} />
                  </div>
                  <div className="gal-full">
                    <ArchDiagram input={c.input} title={c.id} />
                  </div>
                </div>
              </article>
            ))}
          </section>
        </main>
      </div>
    </VisualI18nProvider>
  );
}

function GlyphSection() {
  const { t } = useVisualI18n();
  return (
    <section className="gal-sec" aria-labelledby="gal-glyphs">
      <h2 id="gal-glyphs">ServiceGlyph · 40</h2>
      {GLYPH_GROUPS.map((g) => (
        <div key={g.id} className="gal-group">
          <h3>
            <GroupSymbol group={g.id} size={10} /> {g.id === 'base' ? '' : `${g.id} · `}
            {t(`visual.group.${g.id}` as VisualKey)}
          </h3>
          <ul className="gal-glyphs">
            {GLYPH_MODULES.filter((m) => m.group === g.id).map((m) => (
              <li key={m.id} data-glyph={m.id}>
                <span className="gal-sizes">
                  <ServiceGlyph id={m.id} size={16} />
                  <ServiceGlyph id={m.id} size={24} />
                  <ServiceGlyph id={m.id} size={48} label tooltip />
                </span>
                <span className="gal-name">
                  <b>{m.short}</b> <span className="mono">{m.abbr}</span>
                  <span className="gal-fn">{t(`visual.fn.${m.id}` as VisualKey)}</span>
                  <span className="gal-id mono">{m.id}</span>
                </span>
              </li>
            ))}
          </ul>
        </div>
      ))}
      <div className="gal-group">
        <h3>tones · pseudo nodes</h3>
        <div className="gal-inline">
          <ServiceGlyph id="cdn" size={36} />
          <ServiceGlyph id="cdn" size={36} tone="ghost" />
          <ServiceGlyph id="cdn" size={36} tone="muted" />
          <ServiceGlyph id="eventbridge" size={36} />
          <PseudoGlyph kind="browser" size={36} />
          <PseudoGlyph kind="nginx" size={36} />
          <ServiceChip id="storage" showFunction />
          <ServiceChip id="identity-pool" size={24} showFunction />
        </div>
      </div>
    </section>
  );
}

function PrimitivesSection() {
  const { t } = useVisualI18n();
  return (
    <section className="gal-sec" aria-labelledby="gal-prims">
      <h2 id="gal-prims">StepTypeIcon · MetricIcon · ProgressRing · BarChart</h2>
      <div className="gal-inline">
        {STEP_TYPES.map((s) => (
          <span key={s} className="gal-pair">
            <StepTypeIcon type={s} size={20} />
            <StepTypeTag type={s} />
          </span>
        ))}
      </div>
      <div className="gal-inline">
        {DIFFS.map((d) => (
          <MetricIcon key={d} kind="difficulty" value={d} />
        ))}
        <MetricIcon kind="duration" minutes={45} />
        <MetricIcon kind="duration" minutes={150} />
        {COSTS.map((c) => (
          <MetricIcon key={c} kind="cost" value={c} />
        ))}
        {PROVISIONS.map((p) => (
          <MetricIcon key={p} kind="provision" value={p} />
        ))}
      </div>
      <div className="gal-inline">
        <ProgressRing value={0} label="0" />
        <ProgressRing value={0.35} label="35" />
        <ProgressRing value={7} max={9} label="7/9" size={64} tone="pass" />
        <ProgressRing value={1} label="100" tone="neutral" />
        <ProgressRing value={0.5} label="small" size={24} />
      </div>
      <div className="gal-bars">
        <BarChart
          caption={t('visual.metric.duration')}
          data={[
            { key: 'cdn', label: 'CloudFront', value: 42, icon: <ServiceGlyph id="cdn" size={16} />, display: '42' },
            { key: 'waf', label: 'WAF', value: 18, icon: <ServiceGlyph id="waf" size={16} />, tone: 'before' },
            { key: 'database', label: 'RDS', value: 65, icon: <ServiceGlyph id="database" size={16} />, tone: 'third' },
            { key: 'iam', label: 'IAM', value: 0, icon: <ServiceGlyph id="iam" size={16} /> },
          ]}
        />
      </div>
    </section>
  );
}
