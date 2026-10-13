import { act, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { describe, expect, it, vi } from 'vitest';
import type { CapabilitiesResponse } from '@cloudalbum/contracts';
import { setPrefs } from '../prefs';
import { capsWith, l0Caps, registry } from '../test/helpers';
import { applyTransitionTo, CapabilitiesProvider } from './CapabilitiesProvider';
import { Feature } from './Feature';
import { ModuleBadge } from './ModuleBadge';
import { useCapabilities } from './useCapability';

function Providers({ caps, children }: { caps: () => Promise<CapabilitiesResponse>; children: React.ReactNode }) {
  return (
    <CapabilitiesProvider fetchCapabilities={caps} fetchRegistry={async () => registry} fallback={<p>加载中</p>} pollMs={0}>
      <MemoryRouter>{children}</MemoryRouter>
    </CapabilitiesProvider>
  );
}

describe('CapabilitiesProvider', () => {
  it('加载期间显示骨架屏，加载完成后渲染子树', async () => {
    let resolve!: (c: CapabilitiesResponse) => void;
    const p = new Promise<CapabilitiesResponse>((r) => { resolve = r; });
    render(<Providers caps={() => p}><p>已加载</p></Providers>);
    expect(screen.getByText('加载中')).toBeTruthy();
    await act(async () => resolve(l0Caps()));
    expect(await screen.findByText('已加载')).toBeTruthy();
  });

  it('读取失败时显示错误与重试，而不是猜一个默认值', async () => {
    const fetchCaps = vi.fn().mockRejectedValueOnce(new Error('ECONNREFUSED')).mockResolvedValueOnce(l0Caps());
    render(<Providers caps={fetchCaps}><p>已加载</p></Providers>);
    expect(await screen.findByRole('alert')).toBeTruthy();
    expect(screen.getByText('ECONNREFUSED')).toBeTruthy();
    await act(async () => { screen.getByRole('button', { name: '重试' }).click(); });
    expect(await screen.findByText('已加载')).toBeTruthy();
  });

  it('refresh() 拉取新快照；SSE 的 transition 事件就地更新状态', async () => {
    let n = 0;
    const fetchCaps = vi.fn(async () => (n++ === 0 ? l0Caps() : capsWith({ cache: { driver: 'redis', status: 'ok', detail: 'PING ok' } })));
    let api!: ReturnType<typeof useCapabilities>;
    function Probe() {
      api = useCapabilities();
      return <span>{api.caps?.modules.cache.status}</span>;
    }
    render(<Providers caps={fetchCaps}><Probe /></Providers>);
    expect(await screen.findByText('off')).toBeTruthy();
    await act(async () => { await api.refresh(); });
    expect(screen.getByText('ok')).toBeTruthy();
    await act(async () => {
      api.applyTransition({ at: '2026-10-13T00:00:00Z', module: 'cache', from: 'ok', to: 'degraded', field: 'status', detail: '超时' });
    });
    expect(screen.getByText('degraded')).toBeTruthy();
  });

  it('applyTransitionTo：localHealth 事件只改本地健康', () => {
    const next = applyTransitionTo(l0Caps(), { at: 't', module: 'storage', from: 'ok', to: 'degraded', field: 'localHealth', detail: '剩余空间 10%' });
    expect(next.modules.storage).toMatchObject({ status: 'off', localHealth: 'degraded', detail: '剩余空间 10%' });
  });
});

describe('Feature 与 ModuleBadge', () => {
  it('Feature 按 features[id].enabled 显示子树或 fallback', async () => {
    render(
      <Providers caps={async () => l0Caps()}>
        <Feature id="F14.directUpload"><span>多文件直传</span></Feature>
        <Feature id="F12.albAuth" fallback={<span>应用层 RBAC</span>}><span>ALB 认证</span></Feature>
      </Providers>,
    );
    expect(await screen.findByText('多文件直传')).toBeTruthy();
    expect(screen.getByText('应用层 RBAC')).toBeTruthy();
    expect(screen.queryByText('ALB 认证')).toBeNull();
  });

  it('ModuleBadge：文案、色调与悬停说明来自 registry + capabilities', async () => {
    const caps = capsWith({ cache: { driver: 'redis', status: 'ok', detail: 'PING 0.4ms' } });
    render(
      <Providers caps={async () => caps}>
        <ModuleBadge module="cdn" />
        <ModuleBadge module="cache" outcome="hit" />
      </Providers>,
    );
    const cdn = await screen.findByText('图片由 EC2 Nginx 直出');
    expect(cdn.className).toContain('badge-gray');
    const cache = screen.getByText('时间线 · ElastiCache HIT');
    expect(cache.className).toContain('badge-green');
    expect(cache.getAttribute('title')).toBe('ok · PING 0.4ms');
    // 未登录：不是链接
    expect(cache.tagName).toBe('SPAN');
  });

  it('“显示架构徽章”关闭时不渲染（always 例外）', async () => {
    setPrefs({ showBadges: false });
    render(
      <Providers caps={async () => l0Caps()}>
        <p>ready</p>
        <ModuleBadge module="cdn" />
        <ModuleBadge module="auth" always />
      </Providers>,
    );
    await screen.findByText('ready');
    expect(screen.queryByText('图片由 EC2 Nginx 直出')).toBeNull();
    expect(screen.getByText('本地账号（EC2）')).toBeTruthy();
  });

  it('首次加载并行请求注册表与 capabilities', async () => {
    const reg = vi.fn(async () => registry);
    const caps = vi.fn(async () => l0Caps());
    render(<CapabilitiesProvider fetchCapabilities={caps} fetchRegistry={reg} pollMs={0}><p>x</p></CapabilitiesProvider>);
    await waitFor(() => expect(screen.getByText('x')).toBeTruthy());
    expect(reg).toHaveBeenCalledTimes(1);
    expect(caps).toHaveBeenCalledTimes(1);
  });
});
