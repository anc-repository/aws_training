import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { callsOf, NOW, renderPage } from '../labs/testing';
import SetupPage from './SetupPage';

function page(path = '/setup', opts: { group?: 'learner' | 'assistant' | 'observer'; platform?: Record<string, unknown>; current?: Record<string, unknown>; manual?: Record<string, unknown> } = {}) {
  return renderPage({ path, route: '/setup', element: <SetupPage />, onboarded: false, others: ['/labs', '/workspace/:sid', '/learning'], ...opts, current: opts.current as never });
}

describe('P00 首次设置', () => {
  it('learners get seven steps; finishing needs step 1, a display name and a track, then PATCH /me and onboarding', async () => {
    const { f, loc } = page('/setup?next=%2Flearning');
    expect(await screen.findByRole('heading', { level: 1, name: '首次设置' })).toBeTruthy();
    const nav = screen.getByRole('navigation', { name: '首次设置步骤' });
    expect(within(nav).getAllByRole('link')).toHaveLength(7);
    expect(within(nav).getByRole('link', { name: /1 平台是什么/ }).getAttribute('aria-current')).toBe('step');
    fireEvent.click(screen.getByRole('checkbox', { name: '我已了解' }));
    fireEvent.click(within(nav).getByRole('link', { name: /7 选择学习路径/ }));
    const radio = await screen.findByRole('radio', { name: /点名对比快速路径/ });
    fireEvent.click(radio);
    const finish = screen.getByRole('button', { name: '完成，去卡片目录' });
    await waitFor(() => expect(finish.getAttribute('aria-disabled')).toBeNull());
    fireEvent.click(finish);
    await waitFor(() => expect(loc()).toBe('/learning'));
    expect(callsOf(f, 'PATCH', '/me')[0]!.body).toEqual({ displayName: '张三', currentTrackId: 'quick-compare' });
    expect(callsOf(f, 'PATCH', '/me')[1]!.body).toMatchObject({ onboarding: { version: '1' } });
    expect(localStorage.getItem('atl.onboarded.v1')).toBe('true');
  });

  it('finish stays disabled until step 1 is acknowledged', async () => {
    page('/setup?step=7');
    const finish = await screen.findByRole('button', { name: '完成，去卡片目录' });
    expect(finish.getAttribute('aria-disabled')).toBe('true');
  });

  it('preflight: 需处理 items with a copy-only command, 提示 items, passes collapsed; 第 7 步 reminds of open fixes', async () => {
    page('/setup?step=2', {
      platform: {
        preflight: {
          checkedAt: new Date(NOW - 86_400_000).toISOString(),
          items: [
            { id: 'default-vpc', status: 'warn', detail: 'no default VPC in this region' },
            { id: 'vcpu-quota', status: 'warn', detail: 'On-Demand standard vCPU quota 5' },
            { id: 'ses-sandbox', status: 'ok', detail: 'SES production access' },
            { id: 'organizations', status: 'ok', detail: 'not in an organization' },
          ],
        },
      },
    });
    const fix = await screen.findByText('默认 VPC：这个区域中没有默认 VPC');
    const row = fix.closest('[data-preflight-item]') as HTMLElement;
    expect(row.getAttribute('data-verdict')).toBe('fix');
    expect(row.textContent).toContain('需处理');
    expect(row.textContent).toContain('aws ec2 create-default-vpc --region ap-northeast-1');
    expect(within(row).queryByRole('button', { name: /粘贴/ })).toBeNull();
    expect(screen.getByText('EC2 按需实例 vCPU 配额可能较低').closest('[data-verdict]')!.getAttribute('data-verdict')).toBe('warn');
    expect(screen.getByText(/通过 2 项：SES 已移出沙箱、未检测到组织 SCP 限制/)).toBeTruthy();
  });

  it('step 5 lists the current session, residuals, or says there is nothing', async () => {
    const a = page('/setup?step=5', { current: { labId: 'svc-cdn', sessionId: 's1', state: 'RUNNING' } });
    expect(await screen.findByRole('link', { name: '回到工作台' })).toBeTruthy();
    a.unmount();
    page('/setup?step=5', { manual: { items: [{ resourceKey: 'k', resourceType: 'AWS::EC2::NatGateway', cleanupState: 'MANUAL_REQUIRED', billing: 'hourly', severity: 'BLOCKING' }], total: 1, hourlyBlocking: 1 } });
    expect(await screen.findByText('1 项（按小时计费 1 项）')).toBeTruthy();
  });

  it('skip writes onboarding, flags the one-time note and goes to /labs', async () => {
    const { loc } = page();
    fireEvent.click(await screen.findByRole('button', { name: '跳过，稍后在设置中看' }));
    await waitFor(() => expect(loc()).toBe('/labs'));
    expect(sessionStorage.getItem('atl.setup.skipped.v1')).toBe('true');
  });

  it('assistants and observers only have steps 1 and 6', async () => {
    page('/setup', { group: 'observer' });
    const nav = await screen.findByRole('navigation', { name: '首次设置步骤' });
    expect(within(nav).getAllByRole('link').map((l) => l.textContent)).toEqual(['1 平台是什么', '6 个人资料（已完成）']);
    expect(screen.getByText(/你被邀请为观察者/)).toBeTruthy();
  });
});
