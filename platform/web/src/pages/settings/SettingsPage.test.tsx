import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { json, problem } from '../../test/helpers';
import { callsOf, renderPage } from '../labs/testing';
import SettingsPage from './SettingsPage';

function page(tab: string, opts: { group?: 'learner' | 'assistant' | 'observer'; routes?: Record<string, Response | (() => Response)>; platform?: Record<string, unknown>; current?: Record<string, unknown> | null } = {}) {
  return renderPage({ path: `/settings/${tab}`, route: '/settings/:tab', element: <SettingsPage />, group: opts.group, routes: opts.routes, platform: opts.platform, current: opts.current as never });
}

describe('P12 设置', () => {
  it('learners see all tabs in the side nav; observers get “角色不足” on learner-only tabs; unknown tabs go to profile', async () => {
    const a = page('platform');
    const nav = await screen.findByRole('navigation', { name: '设置' });
    expect(within(nav).getAllByRole('link')).toHaveLength(9);
    expect(within(nav).getByRole('link', { name: '关于与体检' }).getAttribute('aria-current')).toBe('page');
    expect(await screen.findByText('ap-northeast-1')).toBeTruthy();
    a.unmount();
    const o = page('guardrails', { group: 'observer' });
    expect(await screen.findByRole('heading', { level: 1, name: '角色不足' })).toBeTruthy();
    o.unmount();
    const u = page('bogus');
    await waitFor(() => expect(u.loc()).toBe('/settings/profile'));
  });

  it('profile: saves the display name; local preferences apply immediately', async () => {
    const { f } = page('profile', { group: 'assistant' });
    const name = await screen.findByRole('textbox', { name: '显示名' });
    await waitFor(() => expect((name as HTMLInputElement).value).toBe('张三'));
    fireEvent.change(name, { target: { value: '李四' } });
    fireEvent.click(screen.getByRole('button', { name: '保存' }));
    await waitFor(() => expect(callsOf(f, 'PATCH', '/me')[0]!.body).toEqual({ displayName: '李四', certName: null }));
    expect(await screen.findByText('已保存')).toBeTruthy();
    fireEvent.click(screen.getByRole('radio', { name: '暗' }));
    expect(document.documentElement.getAttribute('data-theme')).toBe('dark');
    fireEvent.change(screen.getByRole('combobox', { name: '终端字号' }), { target: { value: '16' } });
    expect(JSON.parse(localStorage.getItem('atl.ws.terminal.v1')!)).toMatchObject({ fontSize: 16 });
    fireEvent.click(screen.getByRole('checkbox', { name: /启用单键快捷键/ }));
    expect(localStorage.getItem('atl.shortcuts.v1')).toBe('false');
    document.documentElement.removeAttribute('data-theme');
  });

  it('workspace settings: PATCH only the changes with If-Match; 412 refreshes and explains', async () => {
    let n = 0;
    const { f } = page('workspace', {
      routes: {
        'GET /api/v1/settings': json(200, { ver: 7, limits: { readyIdleMinutes: 60, extension: { minutes: 30, maxCount: 2 } }, reclaim: { blockStartOnResidual: 'ack' }, terminal: { persistence: 'none' } }),
        'PATCH /api/v1/settings': () => (++n === 1 ? json(200, { ver: 8 }) : problem(412, 'PRECONDITION_FAILED')),
      },
    });
    const sel = await screen.findByRole('combobox', { name: /有未释放的残留时开始新实验/ });
    fireEvent.change(sel, { target: { value: 'block' } });
    fireEvent.click(screen.getByRole('button', { name: '保存' }));
    await waitFor(() => expect(callsOf(f, 'PATCH', '/settings')).toHaveLength(1));
    const call = callsOf(f, 'PATCH', '/settings')[0]!;
    expect(call.body).toEqual({ reclaim: { blockStartOnResidual: 'block' } });
    expect(call.headers['if-match']).toBe('"7"');
    expect(await screen.findByText('已保存 · 下一次开始实验时生效')).toBeTruthy();
    fireEvent.change(await screen.findByRole('textbox', { name: /就绪空闲时限/ }), { target: { value: '30' } });
    fireEvent.click(screen.getByRole('button', { name: '保存' }));
    expect(await screen.findByText(/设置刚被修改（可能在另一个标签页），已刷新/)).toBeTruthy();
  });

  it('guardrails: maintenance toggle and the 409 explanation', async () => {
    const { f } = page('guardrails', { routes: { 'POST /api/v1/platform/maintenance': problem(409, 'INVALID_STATE') } });
    const btn = await screen.findByRole('button', { name: '进入维护模式' });
    fireEvent.click(btn);
    expect(await screen.findByText('仍有进行中或保留中的环境，不能进入维护模式。')).toBeTruthy();
    expect(callsOf(f, 'POST', '/platform/maintenance')[0]!.body).toEqual({ on: true });
  });

  it('uninstall: blockers, confirm by typing “atl”, prepare, and the delete-stack step once ready', async () => {
    let ready = false;
    const { f } = page('uninstall', {
      routes: {
        'GET /api/v1/platform/uninstall/status': () =>
          json(200, ready ? { ready: true, mode: 'UNINSTALLING', terminationProtection: false, blockers: [], rescanWarning: null } : { ready: false, mode: 'NORMAL', terminationProtection: true, blockers: [{ code: 'MANUAL_RESIDUALS', count: 2 }, { code: 'REVOCATIONS_PENDING', until: '2026-10-14T09:20:00Z' }], rescanWarning: '最近一次会话结束不足 6 小时，CloudTrail 中可能还有未到达的事件' }),
        'POST /api/v1/platform/uninstall/prepare': () => {
          ready = true;
          return json(202, { execution: 'x' });
        },
      },
    });
    expect(await screen.findByText('待人工处理的残留 2 项')).toBeTruthy();
    expect(screen.getByText(/吊销条目尚未过期（约 \d\d:\d\d 后自动清理）/)).toBeTruthy();
    expect(screen.getByText('全部阻塞项解除后出现。')).toBeTruthy();
    const prepare = screen.getByRole('button', { name: '结束全部实验并回收' }) as HTMLButtonElement;
    expect(prepare.disabled).toBe(true);
    fireEvent.change(screen.getByRole('textbox', { name: '输入 atl 以确认' }), { target: { value: 'atl' } });
    expect(prepare.disabled).toBe(false);
    fireEvent.click(prepare);
    await waitFor(() => expect(callsOf(f, 'POST', '/platform/uninstall/prepare')).toHaveLength(1));
    expect(callsOf(f, 'POST', '/platform/uninstall/prepare')[0]!.headers['idempotency-key']).toBeTruthy();
    expect(await screen.findByText(/平台已关闭 atl 栈的终止保护/)).toBeTruthy();
  });

  it('upgrade: shows the update, the prerequisite and a copy-only change-set command', async () => {
    page('upgrade', { platform: { update: { latest: 'v1.1.0', notesUrl: 'https://docs.aws.amazon.com/x', templateUrl: 'https://example.com/t.yaml' } }, current: { labId: 'svc-cdn', sessionId: 's1', state: 'RUNNING' } });
    expect(await screen.findByText('有新版本 v1.1.0')).toBeTruthy();
    await waitFor(() => expect(screen.getByText(/当前有 svc-cdn 实验中/)).toBeTruthy());
    expect(document.body.textContent).toContain('--template-url https://example.com/t.yaml');
  });

  it('audit: source IP is masked for learners and can be revealed', async () => {
    page('audit', { routes: { 'GET /api/v1/audit-events': json(200, { items: [{ auditId: 'a1', at: '2026-10-14T00:00:00Z', action: 'session.start', actor: { sub: 'u1', role: 'learner', via: 'web' }, target: 'svc-cdn', result: 'ok', sourceIp: '198.51.100.23' }] }) } });
    const cell = await screen.findByText('198.51.•.•');
    fireEvent.click(screen.getByRole('button', { name: '显示完整来源 IP' }));
    await waitFor(() => expect(cell.textContent).toBe('198.51.100.23'));
  });
});
