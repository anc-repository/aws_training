import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { json, problem } from '../../test/helpers';
import { saveReauthReplay } from '../../components/GlobalDialogs';
import { iso, mountAt } from '../sessions/testHarness';
import { certPayload, makeKey, signJws } from '../verify/testFixtures';
import { badgeAbbr } from './BadgeGlyph';
import CertificateDetailPage from './CertificateDetailPage';
import CertificatesPage, { badgeState } from './CertificatesPage';
import { eligibilityReasonText } from './certText';

const CERT = 'ATL-7K2M-9Q4X-1ABZ-C3DE';
const routes = [
  { path: '/certificates', element: <CertificatesPage /> },
  { path: '/certificates/:certId', element: <CertificateDetailPage /> },
];
const tracks = {
  items: [
    { id: 'quick-compare', title: '点名对比快速路径', certificate: { enabled: true, title: '七项点名对比证书' }, completion: { minAutoRatio: 0.8 }, progress: { requiredDone: 7, requiredTotal: 7, eligible: true } },
    { id: 'saa-main', title: 'SAA 主线', certificate: { enabled: true, title: 'SAA 主线结业证书' }, progress: { requiredDone: 2, requiredTotal: 35, eligible: false } },
    { id: 'secure', title: '安全专项', certificate: { enabled: true, title: '安全架构专项证书' }, progress: { requiredDone: 9, requiredTotal: 9, eligible: false } },
  ],
};
const trackDetail = (id: string) =>
  json(200, {
    track: { id },
    progress: { requiredDone: 2, requiredTotal: 35, groups: [{ groupId: 'g1', pick: 1, done: 0 }], verifiedRatio: 0.5 },
    certificate: { eligible: id === 'quick-compare', reasons: id === 'saa-main' ? [{ code: 'BADGE_PENDING', labId: 'svc-cdn' }] : [] },
  });
const base = (extra: Record<string, unknown> = {}) => ({
  'GET /api/v1/certificates': json(200, { items: [{ certId: 'ATL-AAAA-BBBB-CCCC-DDDD', scope: 'track', trackId: 'secure', status: 'valid', issuedAt: iso(-1000), public: true }] }),
  'GET /api/v1/tracks': json(200, tracks),
  'GET /api/v1/tracks/quick-compare': trackDetail('quick-compare'),
  'GET /api/v1/tracks/saa-main': trackDetail('saa-main'),
  'GET /api/v1/tracks/secure': trackDetail('secure'),
  'GET /api/v1/me/progress': json(200, { labs: [{ labId: 'svc-cdn', badge: { level: 'verified', status: 'valid', attemptId: 's4k7m2q9x1abc', evidenceScore: 0.97, earnedAt: iso(-2000) } }] }),
  ...extra,
});

describe('certificate texts', () => {
  it('eligibility reasons and badge states', () => {
    expect(eligibilityReasonText({ code: 'VERIFIED_RATIO_LOW', ratio: 0.5, min: 0.8 })).toBe('“已核验”占比 50% 低于要求的 80%');
    expect(eligibilityReasonText({ code: 'REQUIRED_CARD_MISSING', labId: 'svc-cache' }, () => '缓存')).toBe('必修卡片 svc-cache（缓存） 还没有有效徽章');
    expect(eligibilityReasonText({ code: 'GROUP_PICK_UNMET', groupId: 'g1', need: 1, have: 0 })).toContain('需要 1 张，已完成 0 张');
    expect(badgeState(null)).toBe('none');
    expect(badgeState({ status: 'pending' })).toBe('pending');
    expect(badgeState({ status: 'valid', level: 'attested' })).toBe('attested');
    expect(badgeAbbr('svc-cdn')).toBe('CDN');
    expect(badgeAbbr('sc-static-acceleration')).toBe('SA');
  });
});

describe('P09-A 证书与徽章', () => {
  it('track rows: eligible first with “领取…”, issued with cert id, not eligible with conditions and pending badges', async () => {
    mountAt('/certificates', { routes, api: base() });
    expect(await screen.findByRole('heading', { level: 1, name: '证书与徽章' })).toBeTruthy();
    expect(screen.getByText(/不是 AWS 官方认证/)).toBeTruthy();
    const table = await screen.findByRole('table', { name: '路径证书' });
    await waitFor(() => expect(within(table).getAllByRole('row')[1]!.getAttribute('data-track')).toBe('quick-compare'));
    const rows = within(table).getAllByRole('row').slice(1);
    expect(within(rows[0]!).getByRole('button', { name: '领取…' })).toBeTruthy();
    const secure = rows.find((r) => r.getAttribute('data-track') === 'secure')!;
    expect(secure.textContent).toContain('ATL-AAAA-BBBB-CCCC-DDDD');
    expect(secure.textContent).toContain('已公开');
    const saa = rows.find((r) => r.getAttribute('data-track') === 'saa-main')!;
    await waitFor(() => expect(saa.textContent).toContain('1 张徽章核验中，结束后才能计入'));
    expect(saa.textContent).toContain('已核验 50%（需 ≥ 80%）');
    // 图形（I6 f）：状态印章、必修完成度环、“已核验”占比条（低于门槛）
    expect(secure.querySelector('.vseal')!.getAttribute('data-seal')).toBe('check');
    expect(rows[0]!.querySelector('.vseal')!.getAttribute('data-seal')).toBe('star');
    expect(saa.querySelector('svg.pring[role="img"]')).toBeTruthy();
    expect(saa.querySelector('.vmeter')!.getAttribute('data-ok')).toBe('0');
  });

  it('claim: PATCH /me when the name changed, POST /certificates, 422 reasons listed', async () => {
    const { f } = mountAt('/certificates', {
      routes,
      api: base({ 'PATCH /api/v1/me': json(200, {}), 'POST /api/v1/certificates': problem(422, 'CERT_NOT_ELIGIBLE', { reasons: [{ code: 'VERIFIED_RATIO_LOW', ratio: 0.5, min: 0.8 }] }) }),
    });
    fireEvent.click(await screen.findByRole('button', { name: '领取…' }));
    const dlg = await screen.findByRole('dialog', { name: '领取：七项点名对比证书' });
    expect(within(dlg).getByText(/不会记录：你的邮箱、AWS 账号 ID、小测成绩/)).toBeTruthy();
    const name = within(dlg).getByLabelText('证书上显示的名字') as HTMLInputElement;
    expect(name.value).toBe('张三');
    fireEvent.change(name, { target: { value: '张小三' } });
    fireEvent.click(within(dlg).getByLabelText(/公开证书文件/));
    fireEvent.click(within(dlg).getByRole('button', { name: '签发证书' }));
    expect(await within(dlg).findByText('“已核验”占比 50% 低于要求的 80%')).toBeTruthy();
    expect(f.calls.find((c) => c.method === 'PATCH' && c.url.endsWith('/me'))!.body).toEqual({ certName: '张小三' });
    expect(f.calls.find((c) => c.method === 'POST' && c.url.endsWith('/certificates'))!.body).toEqual({ scope: 'track', trackId: 'quick-compare', displayName: '张小三', public: true });
  });

  it('claim succeeds → certificate detail; after re-login the saved request is replayed', async () => {
    saveReauthReplay({ routeId: 'issueCertificate', opts: { body: { scope: 'track', trackId: 'quick-compare' }, idempotencyKey: '11111111-2222-4333-8444-555555555555' }, createdAt: Date.now() });
    const { f, loc } = mountAt('/certificates', {
      routes,
      api: base({ 'POST /api/v1/certificates': json(201, { ok: true, certId: CERT }), [`GET /api/v1/certificates/${CERT}`]: problem(404, 'NOT_FOUND') }),
    });
    await waitFor(() => expect(loc()).toBe(`/certificates/${CERT}`));
    expect(f.calls.find((c) => c.method === 'POST')!.headers['idempotency-key']).toBe('11111111-2222-4333-8444-555555555555');
  });

  it('badge wall: earned vs not earned, detail drawer', async () => {
    mountAt('/certificates?tab=badges', { routes, api: base() });
    const item = await screen.findByRole('button', { name: '徽章：边缘缓存，已核验' });
    expect(screen.getByRole('heading', { name: /卡片徽章 · 1 \/ 1/ })).toBeTruthy();
    fireEvent.click(item);
    const drawer = await screen.findByRole('dialog', { name: '徽章 · 边缘缓存' });
    expect(within(drawer).getByText('0.97')).toBeTruthy();
    expect(within(drawer).getByRole('link', { name: '查看报告' }).getAttribute('href')).toBe('/sessions/s4k7m2q9x1abc/report');
  });

  it('observers: read-only (no claim)', async () => {
    mountAt('/certificates', { group: 'observer', routes, api: base() });
    await screen.findByRole('table', { name: '路径证书' });
    await waitFor(() => expect(screen.getAllByRole('row').length).toBeGreaterThan(1));
    expect(screen.queryByRole('button', { name: '领取…' })).toBeNull();
  });
});

describe('P09-C 证书详情', () => {
  async function certItem(over: Record<string, unknown> = {}) {
    const key = await makeKey();
    const jws = await signJws(key, 'atl-cert+jws', certPayload());
    return { certId: CERT, scope: 'track', trackId: 'quick-compare', status: 'valid', issuedAt: iso(-100), kid: key.kid, jws, public: false, sessionIds: ['s4k7m2q9x1abc', 's9q3w7k2m8xr1'], ...over };
  }

  it('shows labs, verify link, public toggle, signature actions and revoke (learner)', async () => {
    const item = await certItem();
    const { f } = mountAt(`/certificates/${CERT}`, {
      routes,
      api: {
        [`GET /api/v1/certificates/${CERT}`]: json(200, item),
        'GET /api/v1/certificates': json(200, { items: [item] }),
        [`PATCH /api/v1/certificates/${CERT}`]: json(202, { certId: CERT, public: true, status: 'updating' }),
        [`POST /api/v1/certificates/${CERT}/revoke`]: json(200, { status: 'revoked' }),
      },
    });
    expect(await screen.findByRole('heading', { level: 1, name: `七项点名对比证书 · ${CERT}` })).toBeTruthy();
    expect(screen.getByText(/持有人 张三/)).toBeTruthy();
    // 证书卡片（装饰，信息在下方文字中）：印章 + 包含的卡片的徽章
    const card = document.querySelector('[data-visual="certificate"]')!;
    expect(card.getAttribute('aria-hidden')).toBe('true');
    expect(card.querySelector('.vseal')!.getAttribute('data-seal')).toBe('check');
    expect(card.querySelectorAll('.certcard-labs svg[data-badge]')).toHaveLength(2);
    const labs = screen.getByRole('heading', { name: '包含的卡片（2）' }).closest('section')!;
    expect(within(labs).getAllByRole('link', { name: /查看 .* 的报告/ })[0]!.getAttribute('href')).toBe('/sessions/s4k7m2q9x1abc/report');
    expect(screen.getByText(`https://d1234abcd.cloudfront.net/verify/${CERT}`)).toBeTruthy();
    expect(screen.getByText(/未公开：对方需要使用你提供的证书文件/)).toBeTruthy();
    expect(screen.getByRole('button', { name: '下载离线验证包' })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: '公开' }));
    await waitFor(() => expect(f.calls.find((c) => c.method === 'PATCH')!.body).toEqual({ public: true }));
    fireEvent.click(screen.getByRole('button', { name: '吊销证书…' }));
    const dlg = await screen.findByRole('alertdialog', { name: '吊销证书' });
    expect(within(dlg).getByText(/密钥泄露/)).toBeTruthy();
    fireEvent.click(within(dlg).getByLabelText(/误签/));
    fireEvent.click(within(dlg).getByRole('button', { name: '吊销' }));
    await waitFor(() => expect(f.calls.find((c) => c.url.endsWith('/revoke'))!.body).toEqual({ reason: 'misissued' }));
  });

  it('revoked (superseded) links to the new certificate; assistants are read-only; unknown ids', async () => {
    const old = await certItem({ status: 'revoked', revokeReason: 'superseded', revokedAt: iso(-10) });
    const a = mountAt(`/certificates/${CERT}`, {
      group: 'assistant',
      routes,
      api: { [`GET /api/v1/certificates/${CERT}`]: json(200, old), 'GET /api/v1/certificates': json(200, { items: [old, { certId: 'ATL-NEWW-NEWW-NEWW-NEWW', trackId: 'quick-compare', status: 'valid' }] }) },
    });
    expect(await screen.findByText(/已吊销（被新证书取代/)).toBeTruthy();
    expect((await screen.findByRole('link', { name: 'ATL-NEWW-NEWW-NEWW-NEWW' })).getAttribute('href')).toBe('/certificates/ATL-NEWW-NEWW-NEWW-NEWW');
    expect(screen.queryByRole('button', { name: '吊销证书…' })).toBeNull();
    expect(screen.queryByRole('button', { name: '下载离线验证包' })).toBeNull();
    a.unmount();
    mountAt('/certificates/ATL-0000-0000-0000-0000', { routes, api: { 'GET /api/v1/certificates/ATL-0000-0000-0000-0000': problem(404, 'NOT_FOUND') } });
    expect(await screen.findByRole('heading', { level: 1, name: '没有这张证书' })).toBeTruthy();
  });
});
