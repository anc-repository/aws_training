import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { json } from '../../test/helpers';
import { callsOf, renderPage } from '../labs/testing';
import LearningPage from './LearningPage';

function page(path = '/learning', group?: 'learner' | 'assistant' | 'observer', routes: Record<string, Response> = {}) {
  return renderPage({ path, route: '/learning', element: <LearningPage />, group, others: ['/sessions/:sid'], routes });
}

describe('P10 我的学习', () => {
  it('tabs change the URL; the track progress lists every track with the current one first', async () => {
    const { f } = page();
    expect(await screen.findByRole('heading', { level: 1, name: '我的学习' })).toBeTruthy();
    const nav = screen.getByRole('navigation', { name: '我的学习' });
    expect(within(nav).getByRole('link', { name: '路径进度' }).getAttribute('aria-current')).toBe('page');
    expect(within(nav).getByRole('link', { name: '徽章墙' }).getAttribute('href')).toBe('/learning?tab=badges');
    const rows = await screen.findAllByText(/^必修 \d+\/\d+/);
    expect(rows.length).toBe(2);
    const main = document.querySelector('[data-track-row="saa-main"]') as HTMLElement;
    expect(main.textContent).toContain('★ SAA 主线（当前）');
    expect(main.textContent).toContain('必修 1/3');
    expect(main.textContent).toContain('推荐下一张：svc-iam');
    expect(within(main).getByRole('img', { name: /已核验 1 张、含手动 0 张、进行中 0 张，最少完成 4 张/ })).toBeTruthy();
    const quick = document.querySelector('[data-track-row="quick-compare"]') as HTMLElement;
    fireEvent.click(within(quick).getByRole('button', { name: '设为当前路径' }));
    await waitFor(() => expect(callsOf(f, 'PATCH', '/me').some((c) => (c.body as { currentTrackId?: string }).currentTrackId === 'quick-compare')).toBe(true));
  });

  it('mastery tab: summary counts and the shared service map', async () => {
    page('/learning?tab=mastery');
    expect(await screen.findByText(/服务掌握度（5）· 熟练 0 · 已掌握 1 · 已接触 0 · 未开始 4 · 需复习 0/)).toBeTruthy();
    expect(screen.getByRole('button', { name: /Amazon EC2，运行整个应用，已掌握，60 分/ })).toBeTruthy();
  });

  it('badge wall: earned and missing badges, filter, and the badge drawer', async () => {
    page('/learning?tab=badges');
    expect(await screen.findByRole('heading', { level: 2, name: /卡片徽章 · 1 \/ 6/ })).toBeTruthy();
    fireEvent.click(screen.getByRole('checkbox', { name: '只看已获得' }));
    await waitFor(() => expect(document.querySelectorAll('[data-badge-card]')).toHaveLength(1));
    fireEvent.click(document.querySelector('[data-badge-card="svc-ec2"]')!);
    const drawer = await screen.findByRole('dialog', { name: '徽章 · EC2 基线' });
    expect(drawer.textContent).toContain('已核验');
    expect(drawer.textContent).toContain('计入的服务格');
  });

  it('recent sessions: compact table with spans written as “1 小时 31 分”', async () => {
    const { loc } = page('/learning?tab=history', undefined, {
      'GET /api/v1/sessions': json(200, {
        items: [{ sessionId: 'sx', labId: 'svc-cdn', state: 'ENDED', createdAt: '2026-10-13T08:20:00Z', readyAt: '2026-10-13T08:31:00Z', endedAt: '2026-10-13T10:02:00Z', durationMinutes: 91, cleanup: null }],
        next: null,
      }),
    });
    const cell = await screen.findByText('1 小时 31 分');
    const row = cell.closest('tr')!;
    expect(row.textContent).toContain('已释放');
    expect(within(row).getByRole('link', { name: '报告' }).getAttribute('href')).toBe('/sessions/sx/report');
    fireEvent.keyDown(row, { key: 'Enter' });
    await waitFor(() => expect(loc()).toBe('/sessions/sx'));
  });

  it('assistants see the learner’s progress (subject) and cannot change the current track', async () => {
    page('/learning', 'assistant', { 'GET /api/v1/me/progress': json(200, { labs: [], tracks: [], subject: { displayName: '张三' } }) });
    expect(await screen.findByText('学员 张三 的学习进度')).toBeTruthy();
    await screen.findAllByText(/^必修 \d+\/\d+/);
    expect(screen.queryByRole('button', { name: '设为当前路径' })).toBeNull();
  });
});
