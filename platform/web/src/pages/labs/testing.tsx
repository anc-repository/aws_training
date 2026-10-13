/**
 * 本组画面（P00～P03、P10、P12）的测试工具（只被 *.test.tsx 引用）：一个小目录夹具（taxonomy、卡片、路径、服务地图、简介）
 * 与渲染单个画面的 renderPage（真实的服务容器 + 假 fetch：API 路由与 /content/ 静态内容都走同一个假实现）。
 */
import type { CognitoGroup } from '@atl/shared';
import { render, screen } from '@testing-library/react';
import type { ReactElement } from 'react';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import { vi } from 'vitest';
import type { SessionView } from '../../api/types';
import { AppProviders } from '../../app/App';
import { createServices } from '../../app/services';
import { fakeFetch, json, type FakeResponder } from '../../test/helpers';
import { resetContentCache } from './data';
import type { CardIntro, CatalogCard, CatalogIndex, TrackDef } from './types';

export const NOW = Date.now();
export const V = '2026.10.1';

function card(c: Partial<CatalogCard> & Pick<CatalogCard, 'id' | 'kind' | 'title'>): CatalogCard {
  return {
    version: '1.0.0',
    status: 'beta',
    startable: true,
    summary: `${c.title} 的一句话简介，写清把什么换成什么、能看到什么差别。`,
    services: [],
    difficulty: 'beginner',
    estimatedMinutes: 60,
    timeLimitMinutes: 90,
    costTier: { required: 'low', withOptional: 'low' },
    provisionClass: 'A',
    variants: [{ id: 'default', title: '默认', select: 'default' }],
    learnerInputs: [],
    accountImpact: [],
    platformOps: [],
    flags: ['beta'],
    legacyLabs: [],
    prerequisites: [],
    reuseFrom: [],
    workstation: { required: true, savingsMode: 'ok' },
    ...c,
  };
}

export const TRACK_MAIN: TrackDef = {
  id: 'saa-main',
  title: 'SAA 主线',
  audience: '备考 SAA-C03 的学员',
  stages: [
    { id: 's1', title: '基线', legacyLabs: [0, 1], items: [{ card: 'svc-ec2', role: 'required' }, { card: 'svc-iam', role: 'required' }] },
    {
      id: 's2',
      title: '异步',
      items: [
        { card: 'svc-queue', role: 'required' },
        { card: 'svc-cost', role: 'optional' },
        { group: 'g1', title: '阶段综合', pick: 1, cards: ['sc-decoupling', 'svc-cdn'] },
      ],
    },
  ],
  completion: { minAutoRatio: 0.7 },
  certificate: { enabled: true, title: 'SAA 主线结业证书' },
  requiredCards: 4,
  requiredMinutes: 180,
  totalMinutes: 300,
};

export const TRACK_QUICK: TrackDef = {
  id: 'quick-compare',
  title: '点名对比快速路径',
  stages: [{ id: 'c', title: '对比', items: [{ card: 'svc-queue', role: 'required' }, { card: 'svc-cdn', role: 'required' }] }],
  completion: { minAutoRatio: 0.8 },
  certificate: { enabled: true, title: '七项点名对比证书' },
  requiredCards: 2,
  requiredMinutes: 120,
  totalMinutes: 120,
};

export function catalogIndex(): CatalogIndex {
  return {
    schema: 'atl.catalog-index/v2',
    catalogVersion: V,
    taxonomy: {
      categories: [
        { id: 'base', label: '基础（EC2）' },
        { id: 'A', label: '入口、网络与扩展' },
        { id: 'B', label: '身份与安全' },
        { id: 'D', label: '计算、异步与通知' },
        { id: 'F', label: '治理、成本与交付' },
      ],
      services: [
        { id: 'ec2', abbr: 'EC2', name: 'Amazon EC2', short: 'EC2', function: '运行整个应用', category: 'base', module: 'ec2' },
        { id: 'cloudfront', abbr: 'CF', name: 'Amazon CloudFront', short: 'CloudFront', function: '内容分发与边缘缓存', category: 'A', module: 'cdn' },
        { id: 'iam', abbr: 'IAM', name: 'AWS IAM', short: 'IAM', function: '服务器访问 AWS 的凭证', category: 'B', module: 'iam' },
        { id: 'sqs', abbr: 'SQS', name: 'Amazon SQS', short: 'SQS', function: '异步任务队列与死信队列', category: 'D', module: 'queue' },
        { id: 'lambda', abbr: 'λ', name: 'AWS Lambda', short: 'Lambda', function: '缩略图生成', category: 'D', module: 'image-processing' },
        { id: 'budgets', abbr: 'BUD', name: 'AWS Budgets', short: 'Budgets', function: '费用护栏与告警', category: 'F', module: 'cost' },
        { id: 'ebs', abbr: 'EBS', name: 'Amazon EBS', short: 'EBS', featureOf: 'ec2' },
      ],
    },
    defaults: { view: 'grid', group: 'kind', sort: 'path', track: 'saa-main' },
    cards: [
      card({ id: 'svc-ec2', kind: 'service', title: 'Amazon EC2：运行整个应用', service: 'Amazon EC2', function: '运行整个应用', category: 'base', services: [{ id: 'ec2', role: 'primary' }, { id: 'ebs', role: 'supporting' }], difficulty: 'intro', legacyLabs: [0], saa: { domains: ['resilient', 'cost'], primaryDomain: 'resilient', topicTitles: ['EBS 卷与实例生命周期'] }, domains: ['resilient', 'cost'], badge: { title: 'EC2 基线' } }),
      card({ id: 'svc-iam', kind: 'service', title: 'AWS IAM：服务器访问 AWS 的凭证', service: 'AWS IAM', function: '服务器访问 AWS 的凭证', category: 'B', services: [{ id: 'iam', role: 'primary' }], legacyLabs: [1], saa: { domains: ['secure'], primaryDomain: 'secure', topicTitles: [] }, domains: ['secure'], badge: { title: '临时凭证' }, reuseFrom: [{ labId: 'svc-ec2', extraModules: [] }] }),
      card({
        id: 'svc-queue',
        kind: 'service',
        title: 'Amazon SQS：异步任务队列与死信队列',
        service: 'Amazon SQS',
        function: '异步任务队列与死信队列',
        category: 'D',
        services: [{ id: 'sqs', role: 'primary' }],
        legacyLabs: [10],
        saa: { domains: ['resilient', 'performance', 'cost'], primaryDomain: 'resilient', topicTitles: ['可见性超时、心跳与长轮询', '死信队列与重放'] },
        domains: ['resilient', 'performance', 'cost'],
        mainDrivers: ['SQS 请求（含空队列的长轮询）'],
        badge: { title: '削峰填谷' },
        prerequisites: [{ id: 'svc-ec2', kind: 'soft' }, { id: 'svc-iam', kind: 'soft' }],
        reuseFrom: [{ labId: 'svc-iam', extraModules: [] }],
        workstation: { required: false, savingsMode: 'degraded' },
      }),
      card({
        id: 'svc-cost',
        kind: 'service',
        status: 'planned',
        startable: false,
        title: 'AWS Budgets：费用护栏与告警',
        service: 'AWS Budgets',
        function: '费用护栏与告警',
        category: 'F',
        services: [{ id: 'budgets', role: 'primary' }],
        legacyLabs: [1],
        saa: { domains: ['cost'], primaryDomain: 'cost', topicTitles: [] },
        domains: ['cost'],
        estimatedMinutes: 45,
        learnerInputs: [{ id: 'notify-email', required: true }],
        flags: ['needs-email', 'planned'],
        badge: { title: '费用护栏' },
      }),
      card({
        id: 'svc-cdn',
        kind: 'service',
        title: 'Amazon CloudFront：内容分发与边缘缓存',
        service: 'Amazon CloudFront',
        function: '内容分发与边缘缓存',
        category: 'A',
        services: [{ id: 'cloudfront', role: 'primary' }],
        legacyLabs: [5],
        difficulty: 'intermediate',
        estimatedMinutes: 90,
        timeLimitMinutes: 150,
        costTier: { required: 'medium', withOptional: 'high' },
        provisionClass: 'B',
        saa: { domains: ['performance'], primaryDomain: 'performance', topicTitles: [] },
        domains: ['performance'],
        badge: { title: '边缘缓存' },
      }),
      card({
        id: 'sc-decoupling',
        kind: 'scenario',
        title: '削峰与重试',
        subtitle: 'SQS + EC2 worker + Lambda',
        services: [
          { id: 'sqs', role: 'primary' },
          { id: 'lambda', role: 'primary' },
          { id: 'ec2', role: 'supporting' },
        ],
        servicesCount: 3,
        difficulty: 'intermediate',
        estimatedMinutes: 90,
        timeLimitMinutes: 150,
        legacyLabs: [10],
        saa: { domains: ['resilient'], primaryDomain: 'resilient', topicTitles: [] },
        domains: ['resilient'],
        badge: { title: '削峰与重试', short: '削峰重试' },
      }),
    ],
    tracks: [TRACK_MAIN, TRACK_QUICK],
    serviceMap: [
      { id: 'ec2', module: 'ec2', category: 'base', abbr: 'EC2', serviceCard: 'svc-ec2', creditedBy: ['sc-decoupling'], appearsIn: [] },
      { id: 'cloudfront', module: 'cdn', category: 'A', abbr: 'CF', serviceCard: 'svc-cdn', creditedBy: [], appearsIn: [] },
      { id: 'iam', module: 'iam', category: 'B', abbr: 'IAM', serviceCard: 'svc-iam', creditedBy: [], appearsIn: [] },
      { id: 'sqs', module: 'queue', category: 'D', abbr: 'SQS', serviceCard: 'svc-queue', creditedBy: ['sc-decoupling'], appearsIn: [] },
      { id: 'budgets', module: 'cost', category: 'F', abbr: 'BUD', serviceCard: 'svc-cost', creditedBy: [], appearsIn: [] },
    ],
  };
}

export function cardIntro(id: string): CardIntro {
  if (id === 'svc-cost') return { id, status: 'planned', startable: false, overview: null, story: null, objectives: [], steps: [], experiments: [] };
  return {
    id,
    status: 'beta',
    startable: true,
    story: '起始状态已经是“本地档异步”：任务放进 api 进程内的队列。',
    overview: {
      type: 'root',
      children: [
        { type: 'heading', depth: 2, children: [{ type: 'text', value: '背景' }] },
        { type: 'paragraph', children: [{ type: 'text', value: '进程一重启，排队的任务全部丢失。' }] },
        { type: 'containerDirective', name: 'why', children: [{ type: 'paragraph', children: [{ type: 'text', value: '至少一次投递。' }] }] },
        { type: 'heading', depth: 2, children: [{ type: 'text', value: '对比实验预告' }] },
        { type: 'paragraph', children: [{ type: 'strong', children: [{ type: 'text', value: '没有 SQS' }] }, { type: 'text', value: '：任务会丢。' }] },
        { type: 'paragraph', children: [{ type: 'link', url: 'https://evil.example.com/x', children: [{ type: 'text', value: '外部链接' }] }] },
      ],
    },
    objectives: [{ text: '用至少一次投递与幂等去重解释“重启不丢任务”', domain: 'resilient' }],
    resources: {
      provisions: [
        { item: 'iam', kind: 'module', displayName: 'AWS IAM', reason: '应用调用 SQS 需要凭证', variant: 'default' },
        { item: 'queue', kind: 'local', displayName: 'Amazon SQS', reason: 'memory 队列是基线', variant: 'default' },
        { item: 'mgmt-channel', kind: 'platform', displayName: 'mgmt-channel', reason: '管理通道', variant: 'default' },
      ],
      extraStacks: [],
      targets: [{ moduleId: 'queue', displayName: 'Amazon SQS', from: 'memory', to: 'sqs', optional: false }],
      expectedWarnings: [],
    },
    steps: [
      { id: 'orient', type: 'observe', title: '观察本地异步', optional: false },
      { id: 'enable-sqs', type: 'script', title: '接入 SQS', optional: false, wait: { typicalMinutes: 3, maxMinutes: 10 }, startsBilling: { class: 'usage' } },
      { id: 'ab', type: 'experiment', title: '（选做）运行时 A/B', optional: true },
    ],
    experiments: [{ module: 'queue', id: 'upload-burst', title: 'queue/upload-burst', required: true }],
    saa: { topics: [{ title: '可见性超时、心跳与长轮询', domain: 'resilient' }], confusables: [{ a: 'SQS', b: 'SNS', rule: '拉取 vs 推送' }] },
    cleanupSummary: '结束后删除任务队列与死信队列。',
    timing: { extensions: { maxCount: 2, minutesEach: 30 }, retain: { allowed: true, maxHours: 24 } },
    workstation: { required: false, savingsMode: 'degraded' },
    prerequisites: { cards: [{ id: 'svc-ec2', kind: 'soft' }, { id: 'svc-iam', kind: 'soft' }], knowledge: ['JSON'] },
    accountImpact: [],
    platformOps: [],
  };
}

export function sessionView(p: Partial<SessionView> = {}): SessionView {
  return {
    sessionId: 's1',
    labId: 'svc-cdn',
    state: 'RUNNING',
    ver: 2,
    createdAt: new Date(NOW - 3_600_000).toISOString(),
    readyAt: new Date(NOW - 1_800_000).toISOString(),
    deadlineAt: new Date(NOW + 3_600_000).toISOString(),
    serverNow: new Date(NOW).toISOString(),
    allowedActions: ['end', 'extend'],
    limits: { extensionsLeft: 2, extensionMinutes: 30 },
    ...p,
  };
}

export interface BackendOptions {
  group?: CognitoGroup | null;
  current?: Partial<SessionView> | null;
  onboarded?: boolean;
  platform?: Record<string, unknown>;
  guardrails?: Record<string, unknown>;
  manual?: Record<string, unknown>;
  routes?: Record<string, FakeResponder | Response>;
}

export function backend(o: BackendOptions = {}) {
  const current = o.current === undefined || o.current === null ? null : sessionView(o.current);
  const index = catalogIndex();
  const base: Record<string, FakeResponder | Response> = {
    'GET /api/v1/platform': json(200, {
      version: '1.0.0',
      region: 'ap-northeast-1',
      drRegion: 'ap-northeast-3',
      accountId: '111122223333',
      maintenance: false,
      mode: 'NORMAL',
      limits: { maxSessionMinutes: 360, maxKeepHours: 24, readyIdleMinutes: 60, extension: { minutes: 30, maxCount: 2 } },
      allowedInstanceTypes: ['t4g.small'],
      preflight: { checkedAt: new Date(NOW - 86_400_000).toISOString(), items: [] },
      ...o.platform,
    }),
    'GET /api/v1/me': json(200, {
      sub: 'u1',
      groups: [o.group ?? 'learner'],
      displayName: '张三',
      certName: null,
      currentTrackId: 'saa-main',
      onboarding: o.onboarded === false ? null : { completedAt: '2026-10-13T00:00:00Z', version: '1' },
    }),
    'GET /api/v1/platform/guardrails': json(200, { budget: null, mode: 'NORMAL', maintenance: false, uninstalling: false, reclaim: { blockStartOnResidual: 'ack' }, ...o.guardrails }),
    'GET /api/v1/catalog': json(200, { catalogVersion: V, indexUrl: `/content/${V}/catalog/index.json`, cardIntroUrlTemplate: `/content/${V}/catalog/cards/{labId}.json`, region: 'ap-northeast-1', drRegion: 'ap-northeast-3' }),
    'GET /api/v1/resources/manual': json(200, { items: [], total: 0, hourlyBlocking: 0, ...o.manual }),
    'GET /api/v1/time': () => json(200, { serverNow: new Date().toISOString() }),
    'GET /api/v1/sessions/current': () => (current ? json(200, current) : new Response(null, { status: 204 })),
    'GET /api/v1/sessions/s1': () => json(200, current),
    'GET /api/v1/sessions/s1/events': json(200, { events: [], next: null, hasMore: false, pollAfterMs: 15000 }),
    'GET /api/v1/labs': json(200, { catalogVersion: V, currentTrackId: 'saa-main', environment: null, items: [{ labId: 'svc-ec2', status: 'completed', attempts: 1, badge: { level: 'verified', status: 'valid' } }] }),
    'GET /api/v1/me/mastery': json(200, { catalogVersion: V, services: [{ id: 'ec2', level: 'mastered', score: 60, needsReview: false, serviceCard: { labId: 'svc-ec2', badgeLevel: 'verified' }, scenarioCredits: [], quiz: { ratio: null } }] }),
    'GET /api/v1/me/progress': json(200, { labs: [{ labId: 'svc-ec2', status: 'completed', attempts: 1, badge: { level: 'verified', status: 'valid', earnedAt: '2026-10-10T00:00:00Z' } }], tracks: [] }),
    'GET /api/v1/tracks': json(200, { catalogVersion: V, items: index.tracks.map((x) => ({ ...x, progress: { requiredDone: 0, requiredTotal: 3, completed: false, eligible: false } })) }),
    'GET /api/v1/certificates': json(200, { items: [] }),
    'GET /api/v1/sessions': json(200, { items: [], next: null }),
    'PATCH /api/v1/me': json(200, {}),
    [`GET /content/${V}/catalog/index.json`]: () => json(200, catalogIndex()),
    [`GET /content/${V}/catalog/cards/*`]: (c) => {
      const id = decodeURIComponent(c.url.split('/').pop()!.replace(/\.json(\?.*)?$/, ''));
      return json(200, cardIntro(id));
    },
    ...o.routes,
  };
  return fakeFetch(base);
}

function LocationProbe() {
  const l = useLocation();
  return <div data-testid="loc">{`${l.pathname}${l.search}${l.hash}`}</div>;
}

export interface RenderPageOptions extends BackendOptions {
  path: string;
  route: string;
  element: ReactElement;
  /** 其他路由（导航目标的探针）。 */
  others?: string[];
}

export function renderPage(o: RenderPageOptions) {
  resetContentCache();
  const f = backend(o);
  globalThis.fetch = f.impl;
  const services = createServices({
    config: { apiBase: '/api/v1', auth: 'dev' },
    fetchImpl: f.impl,
    sessionChannel: null,
    authChannel: null,
    location: { origin: 'http://127.0.0.1:5174', hostname: '127.0.0.1', assign: vi.fn() },
    connectivityTarget: null,
  });
  if (o.group !== null) services.auth.devLogin(o.group ?? 'learner', 'u1');
  else void services.auth.init();
  const utils = render(
    <AppProviders services={services}>
      <MemoryRouter initialEntries={[o.path]}>
        <Routes>
          <Route path={o.route} element={o.element} />
          {(o.others ?? []).map((p) => (
            <Route key={p} path={p} element={<div data-testid="other">{p}</div>} />
          ))}
          <Route path="*" element={<div data-testid="other">elsewhere</div>} />
        </Routes>
        <LocationProbe />
      </MemoryRouter>
    </AppProviders>,
  );
  return { ...utils, f, services, loc: () => screen.getByTestId('loc').textContent ?? '' };
}

/** 某个方法 + 路径（不含查询串）的全部调用。 */
export function callsOf(f: ReturnType<typeof fakeFetch>, method: string, pathSuffix: string) {
  return f.calls.filter((c) => c.method === method && c.url.split('?')[0]!.endsWith(pathSuffix));
}
