import { render } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { SAMPLE_CARDS, sampleCard } from '../../dev-gallery/sampleCards';
import { MODULE_IDS } from '../glyphs/data';
import { VisualI18nProvider } from '../glyphs/visualI18n';
import {
  ArchDiagram,
  FRAME_MODULES,
  LANE_RANK,
  archInputFromCatalogCard,
  archInputFromIntro,
  archInputFromLab,
  buildArchModel,
  edgePath,
  laneOf,
  layoutArch,
  routeEdges,
  type ArchInput,
  type ArchModel,
  type ArchState,
} from './index';

const statusOf = (s: ArchState) => Object.fromEntries(s.nodes.map((n) => [n.id, n.status]));
const edgeKeys = (s: ArchState) => s.edges.map((e) => `${e.from}>${e.to}:${e.kind}${e.highlight ? '*' : ''}`);

/** 紧凑的布局摘要（快照用）：泳道、节点格位。 */
function layoutSummary(model: ArchModel, size: 'full' | 'mini') {
  const layout = layoutArch(model, size);
  return {
    size: `${layout.width}x${layout.height}`,
    lanes: layout.lanes.map((l) => `${l.id}@${l.x}+${l.width}`),
    nodes: Object.values(layout.nodes)
      .map((n) => `${n.id}:${n.col},${n.row}@${n.cx},${n.cy}`)
      .sort(),
    frame: layout.frame ? `${layout.frame.x},${layout.frame.y} ${layout.frame.width}x${layout.frame.height}` : null,
  };
}

/** 模型摘要：两状态的节点状态与连线（* = 强调）。 */
function modelSummary(model: ArchModel) {
  return {
    before: { nodes: statusOf(model.before), edges: edgeKeys(model.before), frame: model.before.frame },
    after: { nodes: statusOf(model.after), edges: edgeKeys(model.after), frame: model.after.frame },
    added: model.added,
  };
}

describe('lanes', () => {
  it('place every registry module in exactly one lane (network is the VPC frame)', () => {
    for (const id of MODULE_IDS) {
      if (FRAME_MODULES.includes(id)) expect(laneOf(id)).toBeNull();
      else expect(laneOf(id), id).not.toBeNull();
    }
    const all = Object.values(LANE_RANK).flat();
    expect(new Set(all).size).toBe(all.length);
    expect(all.filter((id) => !MODULE_IDS.includes(id)).sort()).toEqual(['browser', 'nginx']);
  });
});

describe('buildArchModel', () => {
  it('is deterministic and independent of input order', () => {
    for (const card of SAMPLE_CARDS) {
      const a = buildArchModel(card.input);
      const shuffled: ArchInput = {
        ...card.input,
        start: [...(card.input.start ?? [])].reverse(),
        targets: [...(card.input.targets ?? [])].reverse(),
      };
      const b = buildArchModel(shuffled);
      expect(b, card.id).toEqual(a);
      expect(layoutArch(b, 'full'), card.id).toEqual(layoutArch(a, 'full'));
      expect(layoutArch(b, 'mini'), card.id).toEqual(layoutArch(a, 'mini'));
    }
  });

  it('marks new targets, ghosts their local implementation and highlights their edges (sc-edge-protection)', () => {
    const m = buildArchModel(sampleCard('sc-edge-protection').input);
    expect(statusOf(m.before)).toEqual({ browser: 'present', cdn: 'ghost', waf: 'ghost', nginx: 'present', ec2: 'present', iam: 'present' });
    expect(m.before.nodes.find((n) => n.id === 'waf')?.local).toBe('nginx');
    expect(statusOf(m.after)).toMatchObject({ cdn: 'new', waf: 'new', ec2: 'present' });
    expect(edgeKeys(m.before)).toEqual(['browser>nginx:flow', 'nginx>ec2:flow']);
    expect(edgeKeys(m.after)).toEqual(['browser>cdn:flow*', 'cdn>nginx:flow*', 'waf>cdn:attach*', 'nginx>ec2:flow']);
    expect(m.added).toEqual(['cdn', 'waf']);
  });

  it('swaps the Nginx entry for the ALB in the same slot (svc-load-balancer)', () => {
    const m = buildArchModel(sampleCard('svc-load-balancer').input);
    expect(statusOf(m.before)).toMatchObject({ nginx: 'present' });
    expect(statusOf(m.after)).toMatchObject({ 'load-balancer': 'new' });
    expect(statusOf(m.after).nginx).toBeUndefined();
    const layout = layoutArch(m, 'full');
    expect([layout.nodes.nginx.cx, layout.nodes.nginx.cy]).toEqual([layout.nodes['load-balancer'].cx, layout.nodes['load-balancer'].cy]);
  });

  it('pulls in hard dependencies as implied nodes and keeps optional targets apart', () => {
    const m = buildArchModel({ targets: ['db-proxy'] });
    expect(statusOf(m.after)).toMatchObject({ 'db-proxy': 'new', database: 'implied' });
    expect(edgeKeys(m.after)).toContain('db-proxy>database:flow*');
    const p = buildArchModel(sampleCard('sc-image-pipeline').input);
    expect(statusOf(p.after)).toMatchObject({ 'image-processing': 'new', tagging: 'new', workflow: 'optional' });
    expect(p.optional).toEqual(['workflow']);
    expect(p.after.edges.find((e) => e.to === 'workflow')?.optional).toBe(true);
  });

  it('marks targets that already exist at the start as changed (sc-db-performance)', () => {
    const m = buildArchModel(sampleCard('sc-db-performance').input);
    expect(statusOf(m.after)).toMatchObject({ database: 'changed', cache: 'new', 'db-proxy': 'new', secrets: 'present' });
    expect(m.changed).toEqual(['database']);
  });

  it('draws the VPC frame only in states that have the network module', () => {
    const m = buildArchModel(sampleCard('sc-private-network').input);
    expect(m.before.frame).toBe('present');
    expect(m.after.frame).toBe('changed');
    expect(layoutArch(m, 'full').frame).not.toBeNull();
    expect(buildArchModel({ targets: [{ id: 'network', from: 'default' }] }).before.frame).toBeNull();
  });

  it('reports unknown ids instead of drawing them', () => {
    expect(buildArchModel({ start: ['eventbridge'], targets: ['s3'] }).unknown).toEqual(['eventbridge']);
  });

  it('lays out every module alone without NaN and every edge gets a path', () => {
    for (const id of MODULE_IDS) {
      const m = buildArchModel({ start: ['iam'], targets: [id] });
      for (const size of ['full', 'mini'] as const) {
        const l = layoutArch(m, size);
        expect(Number.isFinite(l.width) && Number.isFinite(l.height), id).toBe(true);
        for (const e of [...m.before.edges, ...m.after.edges]) expect(edgePath(l, e), `${id} ${e.from}>${e.to}`).toMatch(/^M[\d.]+ [\d.]+[CV]/);
      }
    }
  });

  it('routes fan-out edges through separate ports and keeps the main path straight', () => {
    const m = buildArchModel(sampleCard('sc-user-identity').input);
    const l = layoutArch(m, 'full');
    const paths = routeEdges(l, m.after.edges);
    const startY = (key: string) => Number(/^M[\d.]+ ([\d.]+)/.exec(paths[key])?.[1]);
    expect(startY('browser>cdn')).toBe(l.nodes.browser.cy);
    const fan = ['browser>cdn', 'browser>social-api', 'browser>auth', 'browser>identity-pool'].map(startY);
    expect(new Set(fan).size).toBe(4);
    expect(fan).toEqual([...fan].sort((a, b) => a - b));
    // 同列相邻的竖线从上方节点的标签下面开始（不穿过标签）
    expect(paths['social-api>auth']).toBe(`M${l.nodes['social-api'].cx} ${l.nodes['social-api'].cy + 18 + 23}V${l.nodes.auth.cy - 22}`);
  });

  it('keeps mini diagrams card-sized', () => {
    for (const card of SAMPLE_CARDS) {
      const l = layoutArch(buildArchModel(card.input), 'mini');
      expect(l.width, card.id).toBeLessThanOrEqual(6 * 30 + 5 * 2 + 8);
      expect(l.height, card.id).toBeLessThanOrEqual(4 * 26 + 10);
    }
  });

  it('matches the layout snapshots', () => {
    for (const id of ['svc-ec2', 'sc-edge-protection', 'sc-ha-web', 'sc-user-identity', 'sc-private-network', 'sc-threat-compliance']) {
      const m = buildArchModel(sampleCard(id).input);
      expect({ model: modelSummary(m), full: layoutSummary(m, 'full'), mini: layoutSummary(m, 'mini') }).toMatchSnapshot(id);
    }
  });
});

describe('adapters', () => {
  it('read catalog cards, intro data and lab.yaml into the same input', () => {
    const fromCard = archInputFromCatalogCard({
      startProfiles: [
        { variant: 'acme-off', select: 'learner', modules: ['iam', 'cdn'] },
        { variant: 'default', select: 'default', modules: ['iam'] },
      ],
      targets: [{ module: 'tls', from: 'selfsigned', to: 'acm' }],
    });
    expect(fromCard).toEqual({ start: ['iam'], targets: [{ id: 'tls', from: 'selfsigned', to: 'acm', optional: false }] });
    const fromIntro = archInputFromIntro({
      resources: { provisions: [{ item: 'iam', kind: 'module' }, { item: 'workstation', kind: 'platform' }], targets: [{ moduleId: 'tls', from: 'selfsigned', to: 'acm' }] },
    });
    expect(fromIntro).toEqual(fromCard);
    const fromLab = archInputFromLab({
      startProfile: { provisions: [{ item: 'iam', kind: 'module', set: { IAM_CREDENTIALS: 'role' } }] },
      targetModules: [{ id: 'cdn', driver: 'cloudfront', set: { CDN_MEDIA_ORIGIN: 's3' } }],
    });
    expect(fromLab.options).toEqual({ IAM_CREDENTIALS: 'role', CDN_MEDIA_ORIGIN: 's3' });
    expect(fromLab.start).toEqual(['iam']);
  });
});

describe('<ArchDiagram>', () => {
  it('renders the before/after pair with titles and text summaries in the current language', () => {
    const { container } = render(
      <VisualI18nProvider lang="ja">
        <ArchDiagram input={sampleCard('sc-edge-protection').input} />
      </VisualI18nProvider>,
    );
    const svgs = container.querySelectorAll('svg.arch-svg');
    expect(svgs).toHaveLength(2);
    expect(svgs[0].getAttribute('role')).toBe('img');
    expect(svgs[0].querySelector('title')?.textContent).toBe('構成図（開始時）');
    expect(svgs[1].querySelector('desc')?.textContent).toBe('完了後：ブラウザ、CloudFront、WAF、Nginx、EC2、IAM。追加：CloudFront、WAF');
    expect(container.querySelectorAll('.al-title')[0].textContent).toBe('クライアント');
    expect(container.querySelector('.arch-scroll')?.getAttribute('tabindex')).toBe('0');
    expect([...container.querySelectorAll('.arch-legend li')].map((li) => li.textContent)).toEqual(['追加', 'ローカル実装']);
  });

  it('renders English labels and keeps product names untranslated', () => {
    const { container } = render(
      <VisualI18nProvider lang="en">
        <ArchDiagram input={sampleCard('svc-database').input} mode="after" />
      </VisualI18nProvider>,
    );
    const labels = [...container.querySelectorAll('.an-label')].map((t) => t.textContent);
    expect(labels).toEqual(['Browser', 'Nginx', 'EC2', 'RDS', 'IAM']);
    expect(container.querySelector('title')?.textContent).toBe('Architecture (When done)');
  });

  it('mini diagrams can be decorative and match the snapshot', () => {
    const { container } = render(
      <VisualI18nProvider lang="ja">
        <ArchDiagram input={sampleCard('sc-event-fanout').input} size="mini" decorative />
      </VisualI18nProvider>,
    );
    const fig = container.querySelector('figure') as HTMLElement;
    expect(fig.getAttribute('aria-hidden')).toBe('true');
    expect(container.querySelectorAll('svg.arch-svg')).toHaveLength(1);
    expect(container.querySelector('.an-label')).toBeNull();
    expect(fig.innerHTML.replace(/ad[a-zA-Z0-9]+-after/g, 'ID-after')).toMatchSnapshot();
  });
});
