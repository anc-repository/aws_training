/**
 * 40 张服务卡的“完成后”构成图：卡片的核心路径都在图上（I6 b）。数据取 labs/_catalog/catalog.yaml（labs:catalog 生成，
 * 与目录索引的 startProfiles / targets 相同），每张卡的连线写进快照，改连线规则时逐张核对。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import { archInputFromCatalogCard, buildArchModel, FRAME_MODULES, laneOf, type ArchState, type CatalogCardLike } from './index';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..', '..');
const catalog = parse(fs.readFileSync(path.join(REPO, 'labs', '_catalog', 'catalog.yaml'), 'utf8')) as {
  cards: (CatalogCardLike & { id: string; kind: string; targets?: { module: string; from?: string | null; to?: string | null; optional?: boolean }[] })[];
};
const serviceCards = catalog.cards.filter((c) => c.kind === 'service');

const edgeKeys = (s: ArchState) => s.edges.map((e) => `${e.from}>${e.to}:${e.kind}`);

/** 卡片的核心路径（完成后必须出现的连线）。 */
const CORE: Readonly<Record<string, readonly string[]>> = {
  'svc-ec2': ['browser>nginx:flow', 'nginx>ec2:flow'],
  // 浏览器用预签名 URL 直传 S3，EC2 只签发 URL
  'svc-storage': ['browser>storage:flow', 'ec2>storage:aux'],
  'svc-identity-pool': ['browser>identity-pool:aux', 'identity-pool>storage:flow', 'browser>storage:flow'],
  'svc-cdn': ['browser>cdn:flow', 'cdn>nginx:flow'],
  'svc-load-balancer': ['browser>load-balancer:flow', 'load-balancer>ec2:flow'],
  'svc-waf': ['waf>cdn:attach'],
  'svc-tls': ['tls>nginx:attach'],
  'svc-dns': ['browser>dns:aux'],
  'svc-auth': ['browser>auth:aux'],
  'svc-database': ['ec2>database:flow'],
  'svc-db-proxy': ['ec2>db-proxy:flow', 'db-proxy>database:flow'],
  'svc-cache': ['ec2>cache:flow'],
  'svc-queue': ['ec2>queue:flow'],
  'svc-notification': ['ec2>notification:flow'],
  'svc-email': ['ec2>email:flow'],
  'svc-image-processing': ['storage>image-processing:flow'],
  'svc-social-api': ['browser>social-api:flow'],
  'svc-social-store': ['ec2>social-store:flow'],
  'svc-shared-fs': ['ec2>shared-fs:flow'],
  'svc-scheduler': ['scheduler>ec2:flow'],
  'svc-autoscaling': ['autoscaling>ec2:attach'],
  'svc-workflow': ['ec2>workflow:flow'],
  'svc-tagging': ['ec2>tagging:flow'],
  'svc-analytics': ['ec2>analytics:flow'],
};

describe('service cards: the core path of every card is on its “when done” diagram', () => {
  it('reads the 40 service cards', () => {
    expect(serviceCards).toHaveLength(40);
  });

  it('every target is drawn as added / changed, and connected by a request or attach line unless it is cross-cutting', () => {
    const problems: string[] = [];
    for (const card of serviceCards) {
      const m = buildArchModel(archInputFromCatalogCard(card));
      for (const t of card.targets ?? []) {
        if (FRAME_MODULES.includes(t.module)) {
          if (!m.after.frame) problems.push(`${card.id}: ${t.module} frame missing`);
          continue;
        }
        const node = m.after.nodes.find((n) => n.id === t.module);
        if (!node || !['new', 'changed', 'optional'].includes(node.status)) problems.push(`${card.id}: ${t.module} is ${node?.status ?? 'missing'}`);
        // 运维与安全泳道是横切关注点（不画连线）
        if (laneOf(t.module) === 'ops') continue;
        if (!m.after.edges.some((e) => (e.from === t.module || e.to === t.module) && e.kind !== 'dep')) problems.push(`${card.id}: ${t.module} has no request / attach line`);
      }
      for (const k of CORE[card.id] ?? []) if (!edgeKeys(m.after).includes(k)) problems.push(`${card.id}: missing ${k} (has ${edgeKeys(m.after).join(', ')})`);
    }
    expect(problems).toEqual([]);
  });

  it('the start diagram of svc-storage has the local implementation as a ghost and no direct upload yet', () => {
    const card = serviceCards.find((c) => c.id === 'svc-storage')!;
    const m = buildArchModel(archInputFromCatalogCard(card));
    expect(m.before.nodes.find((n) => n.id === 'storage')).toEqual({ id: 'storage', status: 'ghost', local: 'local' });
    expect(edgeKeys(m.before).some((k) => k.includes('storage'))).toBe(false);
  });

  it('matches the per-card edge snapshot', () => {
    const summary = Object.fromEntries(serviceCards.map((c) => [c.id, edgeKeys(buildArchModel(archInputFromCatalogCard(c)).after)]));
    expect(summary).toMatchSnapshot();
  });
});
