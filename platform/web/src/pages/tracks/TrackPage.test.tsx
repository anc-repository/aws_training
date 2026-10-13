import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { json, problem } from '../../test/helpers';
import { callsOf, renderPage, TRACK_MAIN } from '../labs/testing';
import TrackPage from './TrackPage';

const trackDetail = (eligible: boolean, reasons: { code: string; [k: string]: unknown }[] = []) => ({
  track: TRACK_MAIN,
  progress: { trackId: 'saa-main', required: [], optional: [], groups: [], requiredDone: 1, requiredTotal: 3, verifiedRatio: 1, completed: false, certificate: { eligible, reasons } },
  certificate: { eligible, reasons, current: null },
});

function page(routes: Record<string, Response> = {}, group?: 'learner' | 'assistant') {
  return renderPage({
    path: '/tracks/saa-main',
    route: '/tracks/:trackId',
    element: <TrackPage />,
    group,
    others: ['/certificates/:certId'],
    routes: {
      'GET /api/v1/tracks/saa-main': json(200, trackDetail(false, [{ code: 'REQUIRED_CARD_MISSING', labId: 'svc-iam' }, { code: 'REQUIRED_CARD_MISSING', labId: 'svc-queue' }, { code: 'GROUP_PICK_UNMET', groupId: 'g1', need: 1, have: 0 }])),
      ...routes,
    },
  });
}

describe('P02-T 路径详情', () => {
  it('shows progress, the certificate conditions table and the stage list; claiming is disabled with the reasons', async () => {
    page();
    expect(await screen.findByRole('heading', { level: 1, name: /SAA 主线/ })).toBeTruthy();
    const cert = await screen.findByRole('region', { name: /证书：SAA 主线结业证书/ });
    await waitFor(() => expect(cert.textContent).toContain('1 / 3'));
    expect(cert.textContent).toContain('（异步 的组未完成）');
    const claim = within(cert).getByRole('button', { name: '领取证书' });
    expect(claim.getAttribute('aria-disabled')).toBe('true');
    await waitFor(() => expect(cert.textContent).toContain('还差必修 2 张（svc-iam、svc-queue）、选修组 1 个'));
    const stages = screen.getByRole('region', { name: '阶段与卡片' });
    expect(within(stages).getByRole('group', { name: '选修组：选 1 张，已完成 0 张' })).toBeTruthy();
    expect(within(stages).getByRole('button', { name: /基线/ }).getAttribute('aria-expanded')).toBe('true');
    expect(screen.getByText('还没有签发过本路径的证书。')).toBeTruthy();
  });

  it('eligible learners claim the certificate; 422 shows the server reasons; success goes to the certificate', async () => {
    const r1 = page({ 'GET /api/v1/tracks/saa-main': json(200, trackDetail(true)), 'POST /api/v1/certificates': problem(422, 'CERT_NOT_ELIGIBLE', { reasons: [{ code: 'VERIFIED_RATIO_LOW', ratio: 0.5, min: 0.7 }] }) });
    const claim = await screen.findByRole('button', { name: '领取证书' });
    await waitFor(() => expect(claim.getAttribute('aria-disabled')).toBeNull());
    fireEvent.click(claim);
    const dlg = await screen.findByRole('dialog', { name: '领取：SAA 主线结业证书' });
    fireEvent.click(within(dlg).getByRole('button', { name: '签发证书' }));
    expect(await within(dlg).findByText('还不满足领取条件：已核验占比不足（50% < 70%）')).toBeTruthy();
    expect(callsOf(r1.f, 'POST', '/certificates')[0]!.body).toMatchObject({ scope: 'track', trackId: 'saa-main', public: false, displayName: '张三' });
    r1.unmount();
    const r2 = page({ 'GET /api/v1/tracks/saa-main': json(200, trackDetail(true)), 'POST /api/v1/certificates': json(201, { certId: 'ATL-AAAA-BBBB-CCCC-DDDD' }) });
    fireEvent.click(await screen.findByRole('button', { name: '领取证书' }));
    const dlg2 = await screen.findByRole('dialog');
    fireEvent.click(within(dlg2).getByRole('button', { name: '签发证书' }));
    await waitFor(() => expect(r2.loc()).toBe('/certificates/ATL-AAAA-BBBB-CCCC-DDDD'));
  });

  it('assistants have no claim button and cannot set the current track', async () => {
    page({}, 'assistant');
    await screen.findByRole('heading', { level: 1 });
    await screen.findByRole('region', { name: /证书：SAA/ });
    expect(screen.queryByRole('button', { name: '领取证书' })).toBeNull();
    expect(screen.queryByRole('button', { name: '设为当前路径' })).toBeNull();
  });

  it('unknown tracks are not found', async () => {
    renderPage({ path: '/tracks/nope', route: '/tracks/:trackId', element: <TrackPage /> });
    expect(await screen.findByRole('heading', { level: 1, name: '没有这条学习路径' })).toBeTruthy();
  });
});
