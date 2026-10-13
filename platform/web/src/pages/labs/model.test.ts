import { describe, expect, it } from 'vitest';
import {
  activeFilterCount,
  cardFlags,
  cardStateOf,
  emptyQuery,
  facetCounts,
  filterCards,
  groupCards,
  hasCatalogParams,
  membershipOf,
  parseCatalogQuery,
  pathOrderOf,
  recommendNext,
  reuseHintsOf,
  searchHint,
  searchMatch,
  serializeCatalogQuery,
  serviceCells,
  sortCards,
  spatialNext,
  trackSummary,
  type FilterContext,
  type Holder,
  type ProgressLike,
} from './model';
import { DOMAIN_TEXT } from './strings';
import { catalogIndex, NOW, TRACK_MAIN } from './testing';

const index = catalogIndex();
const cards = new Map(index.cards.map((c) => [c.id, c]));
const ctx: FilterContext = { tax: index.taxonomy, statusOf: (id) => (id === 'svc-ec2' ? 'completed' : 'not_started') };
const ids = (xs: { id: string }[]) => xs.map((x) => x.id);

describe('catalog query string (05 §2.7)', () => {
  it('parses known values, drops unknown ones and round-trips without defaults', () => {
    const q = parseCatalogQuery(new URLSearchParams('view=map&cell=sqs&kind=service,bogus&dom=secure&primary=1&d=beginner&cost=low,high&st=completed&nomanual=1&q=lab%2010&sort=duration&group=none'));
    expect(q).toMatchObject({ view: 'map', cell: 'sqs', kind: ['service'], dom: ['secure'], primary: true, d: ['beginner'], cost: ['low', 'high'], st: ['completed'], nomanual: true, q: 'lab 10', sort: 'duration', group: 'none' });
    const back = serializeCatalogQuery(q);
    expect(back.get('view')).toBe('map');
    expect(back.get('kind')).toBe('service');
    expect(parseCatalogQuery(back)).toEqual(q);
    expect(serializeCatalogQuery(emptyQuery()).toString()).toBe('');
    expect(activeFilterCount(q)).toBe(1 + 1 + 1 + 2 + 1 + 1 + 1);
  });

  it('only keeps `cell` in the map view and `track` in the tracks view', () => {
    expect(serializeCatalogQuery({ ...emptyQuery(), cell: 'sqs' }).has('cell')).toBe(false);
    expect(serializeCatalogQuery({ ...emptyQuery(), view: 'tracks', track: 'quick-compare' }).get('track')).toBe('quick-compare');
    expect(hasCatalogParams(new URLSearchParams('foo=1'))).toBe(false);
    expect(hasCatalogParams(new URLSearchParams('q=x'))).toBe(true);
  });
});

describe('search, filters and counts', () => {
  it('matches “Lab 10” / “lab-10” by legacy lab number, other text by substring', () => {
    const q = (s: string) => ids(index.cards.filter((c) => searchMatch(c, s, index.taxonomy)));
    expect(q('Lab 10')).toEqual(['svc-queue', 'sc-decoupling']);
    expect(q('lab-1')).toEqual(['svc-iam', 'svc-cost']);
    expect(q('死信')).toEqual(['svc-queue']);
    expect(q('cloudfront')).toEqual(['svc-cdn']);
    expect(searchHint(cards.get('svc-queue')!, 'lab 10')).toEqual({ kind: 'lab', n: 10 });
    expect(searchHint(cards.get('svc-queue')!, '心跳')).toEqual({ kind: 'topic', text: '可见性超时、心跳与长轮询' });
    expect(searchHint(cards.get('svc-queue')!, 'SQS')).toBeNull();
  });

  it('ORs values within a facet and ANDs across facets; nomanual hides required learner inputs', () => {
    const base = emptyQuery();
    expect(ids(filterCards(index.cards, { ...base, kind: ['scenario'] }, ctx))).toEqual(['sc-decoupling']);
    expect(ids(filterCards(index.cards, { ...base, dom: ['cost'] }, ctx))).toEqual(['svc-ec2', 'svc-queue', 'svc-cost']);
    expect(ids(filterCards(index.cards, { ...base, dom: ['cost'], primary: true }, ctx))).toEqual(['svc-cost']);
    expect(ids(filterCards(index.cards, { ...base, cost: ['medium', 'high'] }, ctx))).toEqual(['svc-cdn']);
    expect(ids(filterCards(index.cards, { ...base, svc: ['sqs'] }, ctx))).toEqual(['svc-queue', 'sc-decoupling']);
    expect(ids(filterCards(index.cards, { ...base, st: ['completed'] }, ctx))).toEqual(['svc-ec2']);
    expect(filterCards(index.cards, { ...base, nomanual: true }, ctx).some((c) => c.id === 'svc-cost')).toBe(false);
    // 个人进度不可用：“状态”维度不参与筛选
    expect(filterCards(index.cards, { ...base, st: ['completed'] }, { ...ctx, statusOf: null })).toHaveLength(index.cards.length);
  });

  it('counts each value as “select it with the other facets unchanged”', () => {
    const c = facetCounts(index.cards, { ...emptyQuery(), kind: ['service'] }, ctx);
    expect(c.kind).toEqual({ service: 5, scenario: 1 });
    expect(c.d.intermediate).toBe(1); // svc-cdn（场景卡被“类型 = 单服务”排除）
    expect(c.st.completed).toBe(1);
  });
});

describe('sorting and grouping', () => {
  it('path order follows the current track, then category and service-cell order', () => {
    const order = pathOrderOf(index, 'saa-main');
    expect(ids(sortCards(index.cards, 'path', { pathOrder: order }))).toEqual(['svc-ec2', 'svc-iam', 'svc-queue', 'svc-cost', 'sc-decoupling', 'svc-cdn']);
    expect(ids(sortCards(index.cards, 'duration', { pathOrder: order })).slice(0, 2)).toEqual(['svc-cost', 'svc-ec2']);
    expect(ids(sortCards(index.cards, 'cost', { pathOrder: order })).pop()).toBe('svc-cdn');
    const recent = sortCards(index.cards, 'recent', { pathOrder: order, lastAttemptAt: (id) => (id === 'svc-cdn' ? 2 : id === 'svc-iam' ? 1 : 0) });
    expect(ids(recent).slice(0, 2)).toEqual(['svc-cdn', 'svc-iam']);
  });

  it('groups by kind (categories, then scenarios), by domain (with “also” rows) and none', () => {
    const k = groupCards(index.cards, 'kind', { tax: index.taxonomy, onlyPrimary: false, domainLabel: (d) => DOMAIN_TEXT[d] });
    expect(k.map((s) => s.id)).toEqual(['cat-base', 'cat-A', 'cat-B', 'cat-D', 'cat-F', 'scenario']);
    expect(k[0]!.title).toBe('单服务卡片 · 基础');
    const d = groupCards(index.cards, 'domain', { tax: index.taxonomy, onlyPrimary: false, domainLabel: (x) => DOMAIN_TEXT[x] });
    const cost = d.find((s) => s.id === 'dom-cost')!;
    expect(ids(cost.cards)).toEqual(['svc-cost']);
    expect(ids(cost.also)).toEqual(['svc-ec2', 'svc-queue']);
    expect(groupCards(index.cards, 'domain', { tax: index.taxonomy, onlyPrimary: true, domainLabel: (x) => x }).every((s) => !s.also.length)).toBe(true);
    const cat = groupCards(index.cards, 'category', { tax: index.taxonomy, onlyPrimary: false, domainLabel: (x) => x });
    expect(ids(cat.find((s) => s.id === 'cat-D')!.cards)).toEqual(['svc-queue', 'sc-decoupling']);
  });
});

describe('card state (05 §2.9)', () => {
  const holder = (state: Holder['state'], p: Partial<Holder> = {}): Holder => ({ labId: 'svc-queue', sessionId: 's1', state, ...p });
  it('takes the first matching row: holder states, cleanup failed, completed, attempted, not started', () => {
    expect(cardStateOf('svc-queue', holder('PROVISIONING'), null, NOW)).toMatchObject({ key: 'preparing', group: 'in_progress', action: 'workspace' });
    const run = cardStateOf('svc-queue', holder('RUNNING', { deadlineAt: new Date(NOW + 36 * 60_000 + 48_000).toISOString() }), null, NOW);
    expect(run).toMatchObject({ key: 'running', tone: 'pend' });
    expect(run.text).toBe('进行中 · 剩余 36:48');
    expect(cardStateOf('svc-queue', holder('RUNNING', { deadlineAt: new Date(NOW + 10 * 60_000).toISOString() }), null, NOW).tone).toBe('drift');
    expect(cardStateOf('svc-queue', holder('CLEANING'), null, NOW)).toMatchObject({ text: '正在释放', action: 'progress' });
    expect(cardStateOf('svc-queue', holder('KEPT', { keepUntil: new Date(NOW).toISOString() }), null, NOW).key).toBe('kept');
    expect(cardStateOf('svc-iam', holder('RUNNING'), { status: 'completed', lastSession: { sessionId: 'x', state: 'CLEANUP_FAILED' } }, NOW).key).toBe('cleanup-failed');
    expect(cardStateOf('svc-iam', null, { status: 'completed_manual' }, NOW)).toMatchObject({ key: 'completed-manual', shape: 'man', group: 'completed' });
    expect(cardStateOf('svc-iam', null, { status: 'attempted' }, NOW)).toMatchObject({ key: 'incomplete', group: 'incomplete' });
    expect(cardStateOf('svc-iam', null, null, NOW)).toMatchObject({ key: 'not-started', shape: 'ring' });
  });

  it('flags: planned is not a flag; limited only without a DR region; new-version from the completed major', () => {
    const q = cards.get('svc-queue')!;
    expect(cardFlags(cards.get('svc-cost')!)).toEqual(['needs-email']);
    expect(cardFlags({ ...q, flags: ['beta', 'limited'] }, { drRegion: 'ap-northeast-3' })).toEqual(['beta']);
    expect(cardFlags({ ...q, version: '2.0.0', flags: [] }, { completedMajor: 1 })).toEqual(['new-version']);
  });
});

describe('track progress and recommendations (tracks §5.5, 05 §2.11)', () => {
  const prog = (m: Record<string, ProgressLike>) => new Map(Object.entries(m));
  const valid = (level: 'verified' | 'attested' | 'self-reported' = 'verified'): ProgressLike => ({ status: 'completed', badge: { level, status: 'valid' } });

  it('counts required cards and elective groups; self-reported badges do not count; ratio decides eligibility', () => {
    const s0 = trackSummary(TRACK_MAIN, prog({}));
    expect(s0).toMatchObject({ requiredDone: 0, requiredTotal: 3, groups: 1, groupsDone: 0, min: 4, ratio: null, eligible: false });
    expect(s0.unmetGroups).toEqual([{ stageId: 's2', stageTitle: '异步', title: '阶段综合' }]);
    const s1 = trackSummary(TRACK_MAIN, prog({ 'svc-ec2': valid(), 'svc-iam': valid('attested'), 'svc-queue': valid(), 'svc-cdn': valid('self-reported') }));
    expect(s1).toMatchObject({ requiredDone: 3, groupsDone: 0, completed: false });
    const s2 = trackSummary(TRACK_MAIN, prog({ 'svc-ec2': valid(), 'svc-iam': valid('attested'), 'svc-queue': valid(), 'sc-decoupling': valid() }));
    expect(s2).toMatchObject({ counted: 4, verified: 3, attested: 1, completed: true, eligible: true });
    expect(s2.ratio).toBeCloseTo(0.75);
    const s3 = trackSummary(TRACK_MAIN, prog({ 'svc-ec2': valid('attested'), 'svc-iam': valid('attested'), 'svc-queue': valid(), 'sc-decoupling': valid() }));
    expect(s3.eligible).toBe(false);
    expect(trackSummary(TRACK_MAIN, prog({ 'svc-queue': { status: 'completed', badge: { level: 'verified', status: 'pending' } } })).pending).toEqual(['svc-queue']);
    expect(trackSummary(TRACK_MAIN, prog({}), 'svc-queue').inProgress).toBe(1);
  });

  it('recommends the first unfinished required card (soft prerequisites first), then the shortest elective', () => {
    expect(recommendNext(TRACK_MAIN, prog({}), null, cards)).toMatchObject({ labId: 'svc-ec2', stageId: 's1', reason: 'next-in-path' });
    expect(recommendNext(TRACK_MAIN, prog({ 'svc-ec2': valid() }), null, cards)?.labId).toBe('svc-iam');
    // svc-queue 的建议前置（svc-iam）未完成：仍推荐它，但标记“前置缺失”
    expect(recommendNext({ ...TRACK_MAIN, stages: [TRACK_MAIN.stages[1]!] }, prog({}), null, cards)).toMatchObject({ labId: 'svc-queue', reason: 'next-in-path-prereq-missing' });
    const done = prog({ 'svc-ec2': valid(), 'svc-iam': valid(), 'svc-queue': valid() });
    expect(recommendNext(TRACK_MAIN, done, null, cards)).toMatchObject({ labId: 'sc-decoupling', reason: 'elective', groupId: 'g1' });
    // 持有环境的卡片视为已完成；保留中的环境可复用时给出 reuseFrom
    const kept: Holder = { labId: 'svc-ec2', sessionId: 's1', state: 'KEPT' };
    expect(recommendNext(TRACK_MAIN, prog({}), kept, cards)).toMatchObject({ labId: 'svc-iam', reuseFrom: 'svc-ec2' });
    expect(recommendNext(TRACK_MAIN, prog({ ...Object.fromEntries(done), 'sc-decoupling': valid() }), null, cards)).toBeNull();
  });

  it('reuse hints between adjacent cards and track membership', () => {
    expect([...reuseHintsOf(TRACK_MAIN, cards)]).toEqual([
      ['svc-iam', 'svc-ec2'],
      ['svc-queue', 'svc-iam'],
    ]);
    expect(membershipOf(index, 'svc-queue').map((m) => [m.track.id, m.role])).toEqual([
      ['saa-main', 'required'],
      ['quick-compare', 'required'],
    ]);
    expect(membershipOf(index, 'sc-decoupling')[0]!.role).toBe('group');
  });
});

describe('service map', () => {
  it('joins the map with the taxonomy and marks cells without scenario cards', () => {
    const cells = serviceCells(index);
    expect(cells.find((c) => c.id === 'sqs')).toMatchObject({ short: 'SQS', name: 'Amazon SQS', fn: '异步任务队列与死信队列', category: 'D', mark: '' });
    expect(cells.find((c) => c.id === 'iam')!.mark).toBe('†');
  });

  it('moves focus by geometry with the arrow keys', () => {
    const rects = [
      { id: 'a', x: 0, y: 0, w: 100, h: 50 },
      { id: 'b', x: 110, y: 0, w: 100, h: 50 },
      { id: 'c', x: 0, y: 60, w: 100, h: 50 },
    ];
    expect(spatialNext(rects, 'a', 'ArrowRight')).toBe('b');
    expect(spatialNext(rects, 'a', 'ArrowDown')).toBe('c');
    expect(spatialNext(rects, 'b', 'ArrowLeft')).toBe('a');
    expect(spatialNext(rects, 'a', 'ArrowUp')).toBeNull();
  });
});
