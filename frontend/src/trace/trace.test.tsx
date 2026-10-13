import { act, fireEvent, render, screen, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { parsePathHeader, parseServerTiming } from '@cloudalbum/contracts';
import { renderWithProviders, capsWith, installMockFetch } from '../test/helpers';
import { setPrefs } from '../prefs';
import { PathChips, segmentTone } from './PathChips';
import { cdnStateFrom } from './resourceTiming';
import { TraceDrawer, TracePanel } from './TraceDrawer';
import { getTraceSnapshot, latestTrace, recordTrace, timingCount } from './TraceStore';
import { buildWaterfall, compareSegments } from './Waterfall';

function trace(label: string, pathRaw: string, timing: string, url = 'http://localhost/api/feed') {
  return recordTrace({
    startTime: 0, method: 'GET', url, status: 200, durationMs: 30,
    serverTiming: parseServerTiming(timing), pathRaw, label,
  });
}

describe('TraceStore', () => {
  it('最多保留 100 条，最新在前；latestTrace 与 timingCount', () => {
    for (let i = 0; i < 105; i += 1) trace(`t${i}`, 'entry=nginx', 'total;dur=1');
    const { entries } = getTraceSnapshot();
    expect(entries).toHaveLength(100);
    expect(entries[0]!.label).toBe('t104');
    const e = trace('x', 'entry=nginx;database=sqlite', 'total;dur=3, database;dur=2;desc="sqlite x3"');
    expect(latestTrace(getTraceSnapshot().entries, 'get', '/api/feed')).toBe(e);
    expect(timingCount(e, 'database')).toBe(3);
    expect(timingCount(e, 'cache')).toBe(0);
  });
});

describe('路径芯片色调（灰 = 本地，橙 = AWS，绿 = 命中，红 = 错误，紫 = 旁路）', () => {
  it('按 outcome 与 capabilities 判定', () => {
    const caps = capsWith({ database: { driver: 'postgres', status: 'ok' } });
    const p = parsePathHeader('entry=nginx;database=postgres@rds;cache=redis@elasticache:hit;storage=local:accel;queue=sqs:bypass-inline;tagging=rekognition:error-basic;image-processing=inline:fault');
    const tones = Object.fromEntries(p.modules.map((m) => [m.module, segmentTone(m, caps)]));
    expect(tones).toEqual({
      database: 'aws', cache: 'hit', storage: 'local', queue: 'bypass', tagging: 'degraded', 'image-processing': 'error',
    });
  });

  it('没有 capabilities 时按主机类别 / 驱动推断', () => {
    expect(segmentTone({ module: 'database', driver: 'postgres', hostClass: 'rds' })).toBe('aws');
    expect(segmentTone({ module: 'storage', driver: 's3', outcome: 'presign' })).toBe('aws');
    expect(segmentTone({ module: 'database', driver: 'sqlite' })).toBe('local');
  });

  it('PathChips 渲染入口链与模块段', () => {
    render(<PathChips path={parsePathHeader('entry=cloudfront>alb>nginx;inst=i-1;cache=redis@elasticache:miss;bypass=cache')} />);
    expect(screen.getByText('entry=cloudfront→alb→nginx')).toBeTruthy();
    expect(screen.getByText('cache=redis@elasticache:miss')).toBeTruthy();
    expect(screen.getByText('bypass=cache')).toBeTruthy();
    expect(screen.getByText('i-1')).toBeTruthy();
  });
});

describe('瀑布图与两两对比', () => {
  it('服务端各段来自 Server-Timing，入口来自路径头', () => {
    const e = trace('a', 'entry=nginx;database=sqlite;cache=none', 'total;dur=12, database;dur=8;desc="sqlite x2", cache;dur=0.1;desc="none"');
    const rows = buildWaterfall(e, null);
    expect(rows.map((r) => r.key)).toEqual(['browser', 'entry', 'total', 'st-database', 'st-cache']);
    expect(rows.find((r) => r.key === 'st-database')).toMatchObject({ dur: 8, tone: 'local', note: 'sqlite x2' });
  });

  it('compareSegments 计算 B − A', () => {
    const a = trace('A', 'entry=nginx;cache=redis@elasticache:hit', 'total;dur=5, cache;dur=1');
    const b = trace('B', 'entry=nginx;cache=redis@elasticache:bypass;bypass=cache', 'total;dur=20, cache;dur=0.1, database;dur=15');
    const rows = compareSegments(a, b);
    expect(rows.find((r) => r.name === 'total')).toMatchObject({ a: 5, b: 20, delta: 15 });
    expect(rows.find((r) => r.name === 'database')).toEqual({ name: 'database', b: 15 });
  });

  it('cdn-* 项推断 CloudFront 缓存状态，拿不到依据时为 null', () => {
    expect(cdnStateFrom([{ name: 'cdn-cache-hit', description: '' }])).toBe('HIT');
    expect(cdnStateFrom([{ name: 'cdn-cache-miss', description: '' }])).toBe('MISS');
    expect(cdnStateFrom([{ name: 'cdn-cache-refresh', description: '' }])).toBe('RefreshHit');
    expect(cdnStateFrom([{ name: 'cdn-pop', description: 'NRT57' }])).toBeNull();
  });
});

describe('TraceDrawer / TracePanel', () => {
  it('普通用户默认看不到；?trace=1（traceEnabled）后出现，可展开并点行看详情', async () => {
    installMockFetch();
    const { unmount } = renderWithProviders(<TraceDrawer />);
    await act(async () => { await Promise.resolve(); });
    expect(screen.queryByRole('button', { name: /路径追踪/ })).toBeNull();
    unmount();

    setPrefs({ traceEnabled: true });
    trace('A', 'entry=nginx;cache=none;database=sqlite', 'total;dur=4, database;dur=3;desc="sqlite"');
    renderWithProviders(<TraceDrawer />);
    const toggle = await screen.findByRole('button', { name: /路径追踪 · \d+/ });
    fireEvent.click(toggle);
    const drawer = screen.getByRole('region', { name: '路径追踪' });
    const row = within(drawer).getAllByRole('listitem').find((li) => li.textContent?.includes('/api/feed') && li.textContent.includes('A'));
    expect(row).toBeTruthy();
    fireEvent.click(row!);
    expect(within(drawer).getByRole('table', { name: '请求瀑布图' })).toBeTruthy();
    expect(within(drawer).getAllByText('database=sqlite').length).toBeGreaterThan(0);
  });

  it('勾选两行进入两两对比', async () => {
    installMockFetch();
    trace('A', 'entry=nginx;cache=redis@elasticache:hit', 'total;dur=5');
    trace('B', 'entry=nginx;cache=redis@elasticache:bypass', 'total;dur=25');
    renderWithProviders(<TracePanel full />);
    const boxes = await screen.findAllByRole('checkbox', { name: '选中以对比' });
    // 列表最新在前：先勾 A（第二行）再勾 B（第一行），差值 = B − A
    fireEvent.click(boxes[1]!);
    fireEvent.click(boxes[0]!);
    expect(screen.getByText('两两对比')).toBeTruthy();
    expect(screen.getByText('▲ 20.0')).toBeTruthy();
  });
});
