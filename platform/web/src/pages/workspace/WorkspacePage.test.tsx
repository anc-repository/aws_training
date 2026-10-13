import type { CognitoGroup } from '@atl/shared';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SessionView } from '../../api/types';
import { AppProviders } from '../../app/App';
import { createServices } from '../../app/services';
import { fakeFetch, json, problem, type FakeCall } from '../../test/helpers';
import { LiveRegion } from '../../ui';
import { setSsmClient, type SsmClientModule, type SsmConnectionOptions, type SsmStateChange } from '../../workspace/terminal/channel';
import { setTermFactory, type TermHandle } from '../../workspace/terminal/TerminalView';
import { clearContentCache, type LabDoc } from '../../workspace/model/lab';
import WorkspacePage from './WorkspacePage';

const MIN = 60_000;
const iso = (ms: number) => new Date(ms).toISOString();

const LAB: LabDoc = {
  id: 'svc-test',
  kind: 'service',
  title: 'Amazon S3：测试卡片',
  provision: { class: 'A' },
  services: [{ id: 's3', role: 'primary' }],
  retain: { allowed: true, maxHours: 24 },
  variables: { rawBucket: { label: '原图桶', from: 'derived' } },
  steps: [
    { id: 'orient', type: 'cli', title: '观察起始状态', manual: 'manual/10.md', estMinutes: 5, panel: 'terminal-workstation', checks: ['storage-local'] },
    { id: 'enable', type: 'script', title: '接入 S3', manual: 'manual/20.md', estMinutes: 10, checks: ['bucket-bpa'], experiment: { module: 'storage', id: 'upload-burst', label: 'after' } },
  ],
  checks: {
    'storage-local': { id: 'storage-local', title: '驱动为 local', type: 'capability' },
    'bucket-bpa': { id: 'bucket-bpa', title: '桶开启了 BPA', type: 'aws-readonly', manualFallback: { observed: { question: '显示什么？', options: [{ value: 'on', label: '开启', expected: true }, { value: 'off', label: '关闭', fixHint: '重新执行 enable' }] } } },
  },
  experiments: [{ module: 'storage', id: 'upload-burst', labels: [{ id: 'before', role: 'baseline' }, { id: 'after', role: 'treatment' }], pairs: [['before', 'after']], required: true }],
  manuals: {
    'manual/10.md': {
      frontMatter: { step: 'orient' },
      ast: {
        type: 'root',
        children: [
          { type: 'paragraph', children: [{ type: 'text', value: '先看清起点：桶 ' }, { type: 'inlineCode', value: '{{ var.rawBucket }}' }] },
          { type: 'code', lang: 'bash', attributes: { runsOn: 'workstation' }, value: 'aws s3 ls s3://{{ var.rawBucket }}' },
          { type: 'code', lang: 'bash', attributes: { runsOn: 'workstation' }, value: 'scripts/module disable storage' },
          { type: 'containerDirective', name: 'why', children: [{ type: 'paragraph', children: [{ type: 'text', value: '因为 S3 更耐久' }] }] },
          { type: 'leafDirective', name: 'console-link', label: '打开照片桶', attributes: { link: 's3.bucket', bucket: '{{ var.rawBucket }}' } },
          { type: 'leafDirective', name: 'checks', attributes: {} },
        ],
      },
    },
    'manual/20.md': {
      frontMatter: { step: 'enable' },
      ast: {
        type: 'root',
        children: [
          { type: 'containerDirective', name: 'method', attributes: { kind: 'console' }, children: [{ type: 'paragraph', children: [{ type: 'text', value: '控制台做法' }] }] },
          { type: 'containerDirective', name: 'method', attributes: { kind: 'script', default: true }, children: [{ type: 'code', lang: 'bash', attributes: { runsOn: 'workstation' }, value: 'scripts/module enable storage' }] },
          { type: 'containerDirective', name: 'expected', children: [{ type: 'paragraph', children: [{ type: 'text', value: '驱动变为 s3' }] }] },
        ],
      },
    },
  },
};

function sessionView(p: Partial<SessionView> = {}): SessionView {
  const now = Date.now();
  return {
    sessionId: 's1',
    labId: 'svc-test',
    catalogVersion: 'v1',
    state: 'RUNNING',
    ver: 4,
    createdAt: iso(now - 40 * MIN),
    readyAt: iso(now - 30 * MIN),
    deadlineAt: iso(now + 60 * MIN),
    deadlineVersion: 1,
    serverNow: iso(now),
    limits: { extensionsLeft: 2, extensionMinutes: 30, extensionMinutesLeft: 60, maxDeadlineAt: iso(now + 120 * MIN), keepAllowed: true, keepMaxHours: 24 },
    allowedActions: ['end', 'extend', 'end-keep'],
    env: { envId: 'env1', envName: 'e7k2', hourlyEstimate: { start: { low: 0.1, high: 0.2 }, completed: { low: 0.2, high: 0.3 } } },
    phases: [],
    ...p,
  };
}

interface Setup {
  view?: Partial<SessionView>;
  group?: CognitoGroup;
  path?: string;
  routes?: Record<string, ((c: FakeCall) => Response) | Response>;
}

function LocationProbe() {
  const l = useLocation();
  return <div data-testid="loc">{`${l.pathname}${l.search}${l.hash}`}</div>;
}

function setup(o: Setup = {}) {
  let v = sessionView(o.view);
  const f = fakeFetch({
    'GET /api/v1/platform': json(200, { version: '1', region: 'ap-northeast-1', maintenance: false, mode: 'NORMAL' }),
    'GET /api/v1/me': json(200, { sub: 'u1', groups: [o.group ?? 'learner'], onboarding: { completedAt: '2026-10-13T00:00:00Z' } }),
    'GET /api/v1/platform/guardrails': json(200, { budget: null, mode: 'NORMAL', maintenance: false, uninstalling: false }),
    'GET /api/v1/catalog': json(200, { catalogVersion: 'v1' }),
    'GET /api/v1/resources/manual': json(200, { items: [] }),
    'GET /api/v1/time': () => json(200, { serverNow: new Date().toISOString() }),
    'GET /api/v1/sessions/current': () => json(200, v),
    'GET /api/v1/sessions/s1': () => json(200, v),
    'GET /api/v1/sessions/s1/events': json(200, { events: [], next: null, hasMore: false, pollAfterMs: 60000 }),
    'POST /api/v1/sessions/s1/heartbeat': () => json(200, { serverNow: new Date().toISOString(), state: v.state === 'READY' ? 'RUNNING' : v.state, ver: v.ver, deadlineAt: v.deadlineAt, deadlineVersion: 1 }),
    'GET /api/v1/sessions/s1/vars': json(200, { session: { region: 'ap-northeast-1', env: 'e7k2', accountId: '********3333' }, vars: [{ name: 'rawBucket', label: '原图桶', from: 'derived', value: 'cloudalbum-e7k2-raw' }] }),
    'GET /api/v1/sessions/s1/steps': json(200, { sessionId: 's1', items: [] }),
    'GET /api/v1/sessions/s1/progress': json(200, { sessionId: 's1', status: 'active', steps: [], stepsDone: 0, stepsTotal: 2, drifted: [], missing: ['orient', 'enable'] }),
    'GET /api/v1/sessions/s1/workspace': json(200, { sessionId: 's1', labId: 'svc-test', region: 'ap-northeast-1', targets: [{ tab: 'terminal-workstation', instanceId: 'i-0def1234abc567890', runAs: 'labuser' }], terminals: [], console: { links: [{ linkId: 's3.bucket' }] }, features: { workstation: 'ec2' } }),
    'GET /api/v1/sessions/s1/experiment-runs': json(200, { items: [] }),
    'GET /api/v1/sessions/s1/cost': json(200, { currency: 'USD', estimate: { low: 0.1, high: 0.2 }, billable: [] }),
    'GET /api/v1/sessions/s1/module-ops': json(200, { items: [] }),
    'GET /api/v1/sessions/s1/check-runs': json(200, { items: [] }),
    'GET /api/v1/sessions/s1/preview': json(200, { targets: [{ id: 'app', url: 'http://54.1.2.3', embeddable: false, reason: 'MIXED_CONTENT' }] }),
    'POST /api/v1/sessions/s1/steps/orient/check-runs': json(202, { runId: '01JRUN0000000000000000001', state: 'queued' }),
    'POST /api/v1/sessions/s1/terminals': json(201, { terminalId: 't1', ssmSessionId: 'atl-s1-term-1', instanceId: 'i-0def1234abc567890', streamUrl: 'wss://ssmmessages.ap-northeast-1.amazonaws.com/v1/data-channel/x', tokenValue: 'tok', runAs: 'labuser' }),
    'POST /api/v1/sessions/s1/workspace-events': json(202, { accepted: 1 }),
    'GET /content/v1/labs/svc-test.json': json(200, LAB),
    'GET /content/v1/catalog/index.json': json(200, { taxonomy: { services: [{ id: 's3', abbr: 'S3', category: 'C' }] } }),
    ...(o.routes ?? {}),
  });
  globalThis.fetch = f.impl;
  const services = createServices({
    config: { apiBase: '/api/v1', auth: 'dev' },
    fetchImpl: f.impl,
    sessionChannel: null,
    authChannel: null,
    location: { origin: 'http://127.0.0.1:5174', hostname: '127.0.0.1', assign: vi.fn() },
    connectivityTarget: null,
  });
  services.auth.devLogin(o.group ?? 'learner', 'u1');
  const utils = render(
    <AppProviders services={services}>
      <MemoryRouter initialEntries={[o.path ?? '/workspace/s1']}>
        <Routes>
          <Route path="/workspace/:sid" element={<WorkspacePage />} />
          <Route path="*" element={<div>other page</div>} />
        </Routes>
        <LocationProbe />
      </MemoryRouter>
      <LiveRegion />
    </AppProviders>,
  );
  return {
    ...utils,
    f,
    services,
    setView: (p: Partial<SessionView>) => {
      v = { ...v, ...p, ver: v.ver + 1 };
    },
    loc: () => screen.getByTestId('loc').textContent,
    calls: (method: string, path: string) => f.calls.filter((c) => c.method === method && c.url.split('?')[0] === path),
  };
}

// ---- 协议层与 xterm 替身
class FakeConn {
  static all: FakeConn[] = [];
  state: SsmStateChange['state'] = 'idle';
  private l = new Set<(e: SsmStateChange) => void>();
  inputs: (string | Uint8Array)[] = [];
  constructor(public readonly opts: SsmConnectionOptions) {
    FakeConn.all.push(this);
  }
  on(_t: string, fn: (e: SsmStateChange) => void) {
    this.l.add(fn);
    return () => this.l.delete(fn);
  }
  emit(state: SsmStateChange['state']) {
    const previous = this.state;
    this.state = state;
    for (const f of this.l) f({ state, previous });
  }
  setOutputSink() {}
  async start() {
    this.emit('requesting');
    try {
      await this.opts.open();
    } catch (error) {
      for (const f of this.l) f({ state: 'failed', previous: 'requesting', failure: { reason: 'open-failed', message: 'x', error } });
      return;
    }
    this.emit('connecting');
    queueMicrotask(() => this.emit('ready'));
  }
  sendInput(d: string | Uint8Array) {
    this.inputs.push(d);
    return true;
  }
  resize() {}
  retryNow() {}
  close() {
    this.emit('closed');
  }
  dispose() {}
}

const pasted: string[] = [];
const fakeTerm: TermHandle['term'] = {
  cols: 120,
  rows: 30,
  modes: { bracketedPasteMode: true },
  options: {},
  write: () => undefined,
  paste: (s: string) => void pasted.push(s),
  focus: () => undefined,
  onData: () => ({ dispose: () => undefined }),
};

beforeEach(() => {
  clearContentCache();
  FakeConn.all = [];
  pasted.length = 0;
  setSsmClient({ SsmTerminalConnection: FakeConn as unknown as SsmClientModule['SsmTerminalConnection'], getTabClientId: () => 'c1' });
  setTermFactory(async () => ({ term: fakeTerm, fit: () => undefined, dispose: () => undefined }));
});

afterEach(() => {
  setSsmClient(undefined);
  setTermFactory(null);
});

describe('P04 准备模式', () => {
  it('shows the six phases, keeps the manual readable with paste and checks disabled, and cancels', async () => {
    const t = setup({
      view: {
        state: 'PROVISIONING',
        readyAt: null,
        deadlineAt: null,
        allowedActions: ['cancel'],
        phases: [
          { name: 'start.validate', status: 'DONE' },
          { name: 'provision.base', status: 'RUNNING' },
        ],
      },
      routes: { 'POST /api/v1/sessions/s1/end': json(202, { ...sessionView({ state: 'CLEANING', readyAt: null }) }) },
    });
    const panel = await screen.findByRole('region', { name: '准备进度' });
    expect(within(panel).getAllByRole('listitem')).toHaveLength(6);
    expect(within(panel).getByText('创建基础环境').closest('li')!.getAttribute('aria-current')).toBe('step');
    expect(within(panel).getByText(/环境准备：较快/)).toBeTruthy();
    expect(await screen.findByRole('heading', { name: /观察起始状态/ })).toBeTruthy();
    expect(screen.getAllByText('倒计时未开始', { exact: false }).length).toBeGreaterThan(0);
    const paste = screen.getAllByRole('button', { name: '粘贴到工作台终端' })[0]!;
    expect(paste.getAttribute('aria-disabled')).toBe('true');
    fireEvent.click(within(panel).getByRole('button', { name: '取消…' }));
    const dlg = await screen.findByRole('alertdialog', { name: '取消实验' });
    expect(within(dlg).getByText(/已经创建的资源会被释放/)).toBeTruthy();
    expect(document.activeElement?.textContent).toBe('继续准备');
    fireEvent.click(within(dlg).getByRole('button', { name: '取消实验' }));
    await waitFor(() => expect(t.calls('POST', '/api/v1/sessions/s1/end')).toHaveLength(1));
    expect(t.calls('POST', '/api/v1/sessions/s1/end')[0]!.body).toEqual({ disposition: 'destroy', when: 'now' });
  });

  it('renders the failure panel with the code-specific title and the compensation result', async () => {
    setup({ view: { state: 'FAILED', readyAt: null, deadlineAt: null, allowedActions: [], failure: { code: 'CAPACITY', message: 'InsufficientInstanceCapacity', diagnostics: ['runner: exit 1'] } } });
    expect(await screen.findByRole('heading', { name: '可用区容量不足' })).toBeTruthy();
    expect(screen.getByText('已释放已创建的资源')).toBeTruthy();
    expect(screen.getByRole('button', { name: '重新开始' })).toBeTruthy();
    expect(screen.getByText(/这次尝试不计入次数/)).toBeTruthy();
  });
});

describe('P05 分屏工作台', () => {
  it('learner: heartbeat, manual with variables, four tabs, step check', async () => {
    const t = setup();
    expect(await screen.findByRole('heading', { name: /观察起始状态/ })).toBeTruthy();
    await waitFor(() => expect(t.calls('POST', '/api/v1/sessions/s1/heartbeat').length).toBeGreaterThan(0));
    expect(t.calls('POST', '/api/v1/sessions/s1/heartbeat')[0]!.body).toEqual({ workbench: true });
    expect(await screen.findAllByText('cloudalbum-e7k2-raw')).not.toHaveLength(0);
    const tabs = screen.getByRole('tablist', { name: '右侧标签' });
    expect(within(tabs).getAllByRole('tab').map((x) => x.getAttribute('data-tab'))).toEqual(['terminal-lab', 'terminal-workstation', 'console', 'preview']);
    expect(within(tabs).getByRole('tab', { name: /工作台/ }).getAttribute('aria-selected')).toBe('true');
    fireEvent.click(screen.getAllByRole('button', { name: /^检测/ })[0]!);
    await waitFor(() => expect(t.calls('POST', '/api/v1/sessions/s1/steps/orient/check-runs')).toHaveLength(1));
  });

  it('pastes a command into the workstation terminal (opened on demand) and confirms dangerous commands', async () => {
    const t = setup();
    await screen.findByRole('heading', { name: /观察起始状态/ });
    await waitFor(() => expect(t.calls('POST', '/api/v1/sessions/s1/terminals').length).toBeGreaterThan(0));
    const [first, danger] = screen.getAllByRole('button', { name: '粘贴到工作台终端' });
    fireEvent.click(first!);
    await waitFor(() => expect(pasted).toEqual(['aws s3 ls s3://cloudalbum-e7k2-raw']));
    expect(t.calls('POST', '/api/v1/sessions/s1/terminals')[0]!.body).toMatchObject({ target: 'workstation', clientId: 'c1' });
    fireEvent.click(danger!);
    const dlg = await screen.findByRole('alertdialog', { name: '粘贴危险命令' });
    expect(document.activeElement?.textContent).toBe('取消');
    fireEvent.click(within(dlg).getByRole('button', { name: '我了解，粘贴' }));
    await waitFor(() => expect(pasted).toContain('scripts/module disable storage'));
  });

  it('extend: quotes first, then extends with If-Match and the quote', async () => {
    const t = setup({
      routes: {
        'POST /api/v1/sessions/s1/quotes': json(200, { quoteId: 'q1', currency: 'USD', priceAsOf: '2026-10-01', expiresAt: iso(Date.now() + 15 * MIN), hourly: { start: null, completed: { low: 0.2, high: 0.3 } } }),
        'POST /api/v1/sessions/s1/extend': json(200, sessionView({ deadlineAt: iso(Date.now() + 90 * MIN), ver: 5 })),
      },
    });
    await screen.findByRole('heading', { name: /观察起始状态/ });
    fireEvent.click(screen.getByRole('button', { name: /延长 30 分钟（剩 2 次）/ }));
    const dlg = await screen.findByRole('dialog', { name: '延长 30 分钟' });
    await within(dlg).findByText(/费用（估算 · 按当前环境实际启用的资源）/);
    const submit = within(dlg).getByRole('button', { name: '延长 30 分钟' });
    expect(submit.hasAttribute('disabled')).toBe(true);
    fireEvent.click(within(dlg).getByRole('checkbox', { name: '我了解延长期间资源继续计费' }));
    fireEvent.click(submit);
    await waitFor(() => expect(t.calls('POST', '/api/v1/sessions/s1/extend')).toHaveLength(1));
    const c = t.calls('POST', '/api/v1/sessions/s1/extend')[0]!;
    expect(c.body).toEqual({ minutes: 30, quoteId: 'q1', expectedDeadlineVersion: 1 });
    expect(c.headers['if-match']).toBe('"4"');
    expect(c.headers['idempotency-key']).toBeTruthy();
    expect(t.calls('POST', '/api/v1/sessions/s1/quotes')[0]!.body).toEqual({ purpose: 'EXTEND', minutes: 30 });
  });

  it('end: release explains the remaining charges and navigates to the reclaim page', async () => {
    const t = setup({ routes: { 'POST /api/v1/sessions/s1/end': json(202, sessionView({ state: 'ENDING' })) } });
    await screen.findByRole('heading', { name: /观察起始状态/ });
    fireEvent.click(screen.getByRole('button', { name: '结束实验…' }));
    const dlg = await screen.findByRole('dialog', { name: '结束实验' });
    expect(within(dlg).getByText(/回收完成前（通常几分钟，CloudFront、RDS 等更久）已创建的资源仍按实际时长计费/)).toBeTruthy();
    expect(within(dlg).getByText(/≈ \$0\.100～\$0\.200/)).toBeTruthy();
    fireEvent.click(within(dlg).getByRole('button', { name: '结束并释放资源' }));
    await waitFor(() => expect(t.loc()).toBe('/sessions/s1/end'));
    expect(t.calls('POST', '/api/v1/sessions/s1/end')[0]!.body).toEqual({ disposition: 'destroy', when: 'now' });
  });

  it('end with keep: asks for a KEEP quote and the acknowledgement', async () => {
    const t = setup({
      routes: {
        'POST /api/v1/sessions/s1/quotes': json(200, { quoteId: 'qk', purpose: 'KEEP', currency: 'USD', expiresAt: iso(Date.now() + 15 * MIN), retainHourly: 0.05 }),
        'POST /api/v1/sessions/s1/end': json(202, sessionView({ preferredDisposition: 'keep' } as Partial<SessionView>)),
      },
    });
    await screen.findByRole('heading', { name: /观察起始状态/ });
    fireEvent.click(screen.getByRole('button', { name: '结束实验…' }));
    const dlg = await screen.findByRole('dialog', { name: '结束实验' });
    fireEvent.click(within(dlg).getByRole('radio', { name: '保留环境' }));
    fireEvent.click(within(dlg).getByRole('radio', { name: /到期时按上面的选择处理/ }));
    await within(dlg).findByText(/保留期间持续计费（估算）/);
    const submit = within(dlg).getByRole('button', { name: '到期时保留 4 小时' });
    expect(submit.hasAttribute('disabled')).toBe(true);
    fireEvent.click(within(dlg).getByRole('checkbox', { name: '我了解保留期间这些资源会持续计费' }));
    fireEvent.click(submit);
    await waitFor(() => expect(t.calls('POST', '/api/v1/sessions/s1/end')).toHaveLength(1));
    expect(t.calls('POST', '/api/v1/sessions/s1/end')[0]!.body).toEqual({ disposition: 'keep', when: 'at-expiry', keepHours: 4, quoteId: 'qk' });
    expect(t.loc()).toBe('/workspace/s1');
  });

  it('T-15 banner and the one-time T-5 dialog', async () => {
    setup({ view: { state: 'EXPIRING', deadlineAt: iso(Date.now() + 4 * MIN) } });
    expect(await screen.findByText(/到期后自动收回访问并释放资源/)).toBeTruthy();
    const dlg = await screen.findByRole('dialog', { name: '还剩 5 分钟' });
    expect(document.activeElement?.textContent).toBe('知道了');
    fireEvent.click(within(dlg).getByRole('button', { name: '知道了' }));
    await waitFor(() => expect(screen.queryByRole('dialog', { name: '还剩 5 分钟' })).toBeNull());
  });

  it('deadline passed: alertdialog overlay, focus on “查看回收进度”, no “end” call from the browser', async () => {
    const t = setup({ view: { state: 'RUNNING', deadlineAt: iso(Date.now() - 5_000) } });
    const ovl = await screen.findByRole('alertdialog', { name: /实验时间已到/ });
    await waitFor(() => expect(document.activeElement?.textContent).toBe('查看回收进度'));
    expect(within(ovl).getByRole('button', { name: '查看报告' })).toBeTruthy();
    expect(t.calls('POST', '/api/v1/sessions/s1/end')).toHaveLength(0);
    expect(document.querySelector('.wsbar')!.hasAttribute('inert')).toBe(true);
  });

  it('observer: read-only manual, no terminals, console or submit', async () => {
    setup({ group: 'observer', view: { allowedActions: [] } });
    await screen.findByRole('heading', { name: /观察起始状态/ });
    expect(screen.getAllByText('只读：你的角色不能连接终端或控制台').length).toBeGreaterThan(0);
    expect(screen.queryByRole('button', { name: '提交实验' })).toBeNull();
    expect(screen.queryByRole('button', { name: /^检测/ })).toBeNull();
    expect(screen.queryByRole('button', { name: '结束实验…' })).toBeNull();
  });

  it('drawers live in the query string: ?check= evidence and ?exp= comparison', async () => {
    setup({ path: '/workspace/s1?step=enable&exp=storage/upload-burst' });
    const drawer = await screen.findByRole('dialog', { name: '对比实验 · storage/upload-burst' });
    expect(within(drawer).getByText('还没有运行这个实验')).toBeTruthy();
    expect(within(drawer).getAllByText(/npm run exp -- storage upload-burst --label/)).toHaveLength(2);
    fireEvent.keyDown(drawer, { key: 'Escape' });
    await waitFor(() => expect(screen.queryByRole('dialog', { name: /对比实验/ })).toBeNull());
    expect(screen.getByRole('tablist', { name: '做法' })).toBeTruthy();
    fireEvent.click(screen.getByText('桶开启了 BPA'));
    expect(await screen.findByRole('dialog', { name: '检查详情：桶开启了 BPA' })).toBeTruthy();
    expect(screen.getByTestId('loc').textContent).toContain('check=bucket-bpa');
  });

  it('missing session → not-found message after the direct read', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    setup({ routes: { 'GET /api/v1/sessions/s1': problem(404, 'NOT_FOUND'), 'GET /api/v1/sessions/current': new Response(null, { status: 204 }) } });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(5000);
    });
    expect(await screen.findByText('没有找到这个实验会话')).toBeTruthy();
  });
});

describe('P05 右栏与手册的交互', () => {
  it('console launcher: opens a named blank window synchronously, then POSTs the federation form into it', async () => {
    const win = { opener: {} as unknown, close: vi.fn(), location: { href: '' } };
    const open = vi.spyOn(window, 'open').mockImplementation(() => win as unknown as Window);
    const submitted: { action: string; target: string; method: string; fields: Record<string, string> }[] = [];
    vi.spyOn(HTMLFormElement.prototype, 'submit').mockImplementation(function (this: HTMLFormElement) {
      const fields: Record<string, string> = {};
      for (const el of Array.from(this.querySelectorAll('input'))) fields[el.name] = el.value;
      submitted.push({ action: this.action, target: this.target, method: this.method, fields });
    });
    const t = setup({
      routes: {
        'POST /api/v1/sessions/s1/console-link': json(200, {
          form: { action: 'https://signin.aws.amazon.com/federation', fields: { Action: 'login', Issuer: 'atl', Destination: 'https://console.aws.amazon.com/', SigninToken: 'tok' } },
          consoleSessionExpiresAt: iso(Date.now() + 60 * MIN),
        }),
      },
    });
    await screen.findByRole('heading', { name: /观察起始状态/ });
    fireEvent.click(screen.getByRole('tab', { name: /AWS 控制台/ }));
    expect(screen.getByText(/最长 1 小时，到期后需要续期/)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: '在新标签页打开 AWS 控制台' }));
    expect(open).toHaveBeenCalledWith('about:blank', expect.stringMatching(/^atl-aws-console-/));
    expect(win.opener).toBeNull();
    await waitFor(() => expect(submitted).toHaveLength(1));
    expect(submitted[0]).toMatchObject({ action: 'https://signin.aws.amazon.com/federation', method: 'post', fields: { Action: 'login', SigninToken: 'tok' } });
    expect(submitted[0]!.target).toBe(open.mock.calls[0]![1]);
    expect(t.calls('POST', '/api/v1/sessions/s1/console-link')[0]!.body).toEqual({});
  });

  it('console launcher: popup blocked → inline fallback that submits to _blank', async () => {
    vi.spyOn(window, 'open').mockImplementation(() => null);
    const targets: string[] = [];
    vi.spyOn(HTMLFormElement.prototype, 'submit').mockImplementation(function (this: HTMLFormElement) {
      targets.push(this.target);
    });
    setup({ routes: { 'POST /api/v1/sessions/s1/console-link': json(200, { form: { action: 'https://signin.aws.amazon.com/federation', fields: { Action: 'login' } } }) } });
    await screen.findByRole('heading', { name: /观察起始状态/ });
    fireEvent.click(screen.getByRole('tab', { name: /AWS 控制台/ }));
    fireEvent.click(screen.getByRole('button', { name: '在新标签页打开 AWS 控制台' }));
    expect(await screen.findByText(/浏览器拦截了新窗口/)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: '在新标签页打开' }));
    expect(targets).toEqual(['_blank']);
  });

  it('preview: embeds only trusted HTTPS entries with the 03 §6.4 sandbox; otherwise a new-tab card', async () => {
    setup({
      routes: {
        'GET /api/v1/sessions/s1/preview': json(200, {
          default: 'cdn',
          targets: [
            { id: 'cdn', url: 'https://d111.cloudfront.net', embeddable: true },
            { id: 'direct', url: 'http://54.1.2.3', embeddable: false, reason: 'MIXED_CONTENT' },
          ],
        }),
      },
    });
    await screen.findByRole('heading', { name: /观察起始状态/ });
    fireEvent.click(screen.getByRole('tab', { name: /应用预览/ }));
    const frame = (await screen.findByTitle(/CloudAlbum 应用预览/)) as HTMLIFrameElement;
    expect(frame.getAttribute('src')).toBe('https://d111.cloudfront.net/');
    expect(frame.getAttribute('sandbox')).toBe('allow-scripts allow-same-origin allow-forms allow-popups allow-popups-to-escape-sandbox allow-downloads');
    expect(frame.getAttribute('referrerpolicy')).toBe('no-referrer');
    fireEvent.change(screen.getByLabelText('入口'), { target: { value: 'direct' } });
    expect(await screen.findByText(/嵌入会被浏览器作为混合内容拦截/)).toBeTruthy();
    expect(screen.queryByTitle(/CloudAlbum 应用预览/)).toBeNull();
  });

  it('manual confirmation (degraded aws-readonly): only the expected value with a 6+ character note can be submitted', async () => {
    const t = setup({
      path: '/workspace/s1?step=enable',
      routes: {
        'GET /api/v1/sessions/s1/steps': json(200, {
          sessionId: 's1',
          items: [{ stepId: 'enable', state: 'error', checks: { 'bucket-bpa': { effective: 'error', lastAuto: { result: 'error', at: iso(Date.now()), errorCode: 'ACCESS_DENIED' } } } }],
        }),
        'POST /api/v1/sessions/s1/steps/enable/manual-confirmations': json(201, { confirmationId: 'c1', kind: 'degraded', result: 'manual', reviewPending: true }),
      },
    });
    await screen.findByRole('heading', { name: /接入 S3/ });
    fireEvent.click(await screen.findByRole('button', { name: '手动确认：桶开启了 BPA' }));
    const dlg = await screen.findByRole('dialog', { name: '手动确认：桶开启了 BPA' });
    fireEvent.click(within(dlg).getByRole('radio', { name: '关闭' }));
    expect(within(dlg).getByText(/重新执行 enable/)).toBeTruthy();
    const submit = within(dlg).getByRole('button', { name: '提交确认' });
    expect(submit.hasAttribute('disabled')).toBe(true);
    fireEvent.click(within(dlg).getByRole('radio', { name: '开启' }));
    fireEvent.change(within(dlg).getByLabelText(/备注/), { target: { value: '短' } });
    expect(submit.hasAttribute('disabled')).toBe(true);
    fireEvent.change(within(dlg).getByLabelText(/备注/), { target: { value: '在控制台看到四项都开启了' } });
    fireEvent.click(submit);
    await waitFor(() => expect(t.calls('POST', '/api/v1/sessions/s1/steps/enable/manual-confirmations')).toHaveLength(1));
    expect(t.calls('POST', '/api/v1/sessions/s1/steps/enable/manual-confirmations')[0]!.body).toEqual({ checkId: 'bucket-bpa', observed: 'on', note: '在控制台看到四项都开启了' });
    expect(await within(dlg).findByText(/等待助教复核/)).toBeTruthy();
  });

  it('splitter: separator semantics, keyboard resize and Enter collapse; leader key switches tabs', async () => {
    setup();
    await screen.findByRole('heading', { name: /观察起始状态/ });
    const sep = screen.getByRole('separator', { name: '调整手册宽度' });
    expect(Number(sep.getAttribute('aria-valuemin'))).toBeGreaterThan(0);
    expect(Number(sep.getAttribute('aria-valuemax'))).toBeLessThan(100);
    const before = Number(sep.getAttribute('aria-valuenow'));
    fireEvent.keyDown(sep, { key: 'ArrowRight', shiftKey: true });
    expect(Number(screen.getByRole('separator').getAttribute('aria-valuenow'))).toBeGreaterThan(before);
    expect(localStorage.getItem('atl.ws.layout.v1')).toContain('split');
    fireEvent.keyDown(screen.getByRole('separator'), { key: 'Enter' });
    fireEvent.click(await screen.findByRole('button', { name: '展开手册' }));
    fireEvent.keyDown(document.body, { key: '.', code: 'Period', ctrlKey: true });
    expect(await screen.findByText('等待第二个键…')).toBeTruthy();
    fireEvent.keyDown(document.body, { key: '3', code: 'Digit3' });
    await waitFor(() => expect(screen.getByRole('tab', { name: /AWS 控制台/ }).getAttribute('aria-selected')).toBe('true'));
  });
});
