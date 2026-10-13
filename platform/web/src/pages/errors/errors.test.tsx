import { act, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { ApiError } from '../../api/errors';
import { json, problem } from '../../test/helpers';
import { mountAt, sessionView } from '../sessions/testHarness';
import { InlineProblem } from './InlineProblem';
import NotFoundPage from './NotFoundPage';
import { describeProblem, problemReasons } from './problems';
import { useAction } from './useAction';

const err = (status: number, code: string, extra: Partial<ConstructorParameters<typeof ApiError>[0]> = {}) => new ApiError({ status, code, title: code, requestId: 'req-9', ...extra });

describe('describeProblem (08 P13 table)', () => {
  it('maps the P13 conditions to what the screen does', () => {
    expect(describeProblem(err(0, 'NETWORK'))).toMatchObject({ kind: 'network', retry: true });
    expect(describeProblem(err(503, 'UPSTREAM_UNAVAILABLE'))).toMatchObject({ kind: 'unavailable', retry: true, message: '平台服务暂时不可用（503）。' });
    expect(describeProblem(err(503, 'UPSTREAM_THROTTLED'))).toMatchObject({ kind: 'throttled', message: 'AWS 接口繁忙，平台已重试。请稍后再试。' });
    expect(describeProblem(err(429, 'RATE_LIMITED', { retryAfterSec: 12 }))).toMatchObject({ kind: 'rate-limited', retryAfterSec: 12, message: '操作太频繁，请在 12 秒后重试。' });
    expect(describeProblem(err(429, 'RATE_LIMITED'))!.retryAfterSec).toBe(30);
    expect(describeProblem(err(403, 'FORBIDDEN_ROLE'), { role: 'O' })!.message).toBe('你的角色（观察者）只能查看，不能执行这个操作。');
    expect(describeProblem(err(412, 'PRECONDITION_FAILED'))).toMatchObject({ kind: 'precondition', refreshView: true });
    expect(describeProblem(err(409, 'INVALID_STATE'))).toMatchObject({ kind: 'state', refreshView: true });
    expect(describeProblem(err(409, 'PLATFORM_UNINSTALLING'))).toMatchObject({ kind: 'blocked', message: '平台正在卸载' });
    expect(describeProblem(err(409, 'REUSE_IN_PROGRESS'))).toMatchObject({ kind: 'known', message: '该环境正在被新会话接管，不能立即释放' });
    expect(describeProblem(err(500, 'INTERNAL'))!.message).toBe('平台内部错误（错误 ID：req-9）');
    expect(describeProblem(err(409, 'OBJECT_LOCKED', { title: 'Locked', detail: 'record is locked' }))).toMatchObject({ kind: 'unknown', message: 'Locked：record is locked' });
    expect(describeProblem(null)).toBeNull();
    expect(problemReasons(new ApiError({ status: 422, code: 'CERT_NOT_ELIGIBLE', problem: { type: 'x', title: 't', status: 422, code: 'CERT_NOT_ELIGIBLE', reasons: [1, 2] } }))).toEqual([1, 2]);
  });
});

describe('InlineProblem', () => {
  it('rate limit: countdown, then ready', async () => {
    vi.useFakeTimers();
    const onReady = vi.fn();
    mountAt('/x', { routes: [{ path: '/x', element: <InlineProblem error={err(429, 'RATE_LIMITED', { retryAfterSec: 2 })} onReady={onReady} /> }] });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(50);
    });
    expect(screen.getByText('操作太频繁，请在 2 秒后重试。')).toBeTruthy();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2100);
    });
    expect(screen.getByText('可以重试了。')).toBeTruthy();
    expect(onReady).toHaveBeenCalledTimes(1);
    vi.useRealTimers();
  });

  it('unknown codes: title, request id and copy diagnostics; known codes are inline notes', async () => {
    mountAt('/x', {
      routes: [
        {
          path: '/x',
          element: (
            <>
              <InlineProblem error={err(409, 'OBJECT_LOCKED', { title: 'Locked' })} onRetry={() => undefined} />
              <InlineProblem error={err(412, 'PRECONDITION_FAILED')} />
            </>
          ),
        },
      ],
    });
    expect(await screen.findByText('Locked')).toBeTruthy();
    expect(screen.getByText(/req-9/)).toBeTruthy();
    expect(screen.getByRole('button', { name: '复制诊断信息' })).toBeTruthy();
    expect(screen.getByText('数据刚刚被修改，已刷新，请重新操作').closest('[data-problem]')!.getAttribute('data-problem')).toBe('precondition');
  });
});

describe('P13 #33 页面不存在', () => {
  it('inside the frame, address kept, two exits', async () => {
    const { loc } = mountAt('/no/such/page', { routes: [{ path: '/labs', element: <div /> }] });
    expect(await screen.findByRole('heading', { level: 1, name: '页面不存在' })).toBeTruthy();
    expect(screen.getByText('/no/such/page', { selector: '.mono' })).toBeTruthy();
    const main = screen.getByRole('main');
    expect(within(main).getByRole('link', { name: '回到卡片目录' }).getAttribute('href')).toBe('/labs');
    expect(within(main).getByRole('link', { name: '我的实验' }).getAttribute('href')).toBe('/sessions');
    expect(loc()).toBe('/no/such/page');
    expect(screen.getByRole('banner')).toBeTruthy();
    expect(NotFoundPage).toBeTypeOf('function');
  });
});

function ActionProbe() {
  const a = useAction<{ ok: boolean }>('retryCleanup', { sid: 's4k7m2q9x1abc' });
  return (
    <div>
      <button type="button" onClick={() => void a.run({ params: { sid: 's4k7m2q9x1abc' } })}>
        run
      </button>
      <button type="button" onClick={() => void a.retry()}>
        retry
      </button>
      <span data-testid="err">{a.error?.code ?? ''}</span>
    </div>
  );
}

describe('useAction', () => {
  it('retries reuse the Idempotency-Key; a new run gets a new key; state conflicts refresh the session view', async () => {
    let n = 0;
    const { f } = mountAt('/x', {
      routes: [{ path: '/x', element: <ActionProbe /> }],
      api: {
        'POST /api/v1/sessions/s4k7m2q9x1abc/cleanup/retry': () => (n++ < 2 ? problem(409, 'INVALID_STATE') : json(202, sessionView({ state: 'CLEANING' }))),
        'GET /api/v1/sessions/s4k7m2q9x1abc': json(200, sessionView({ state: 'CLEANING' })),
      },
    });
    fireEvent.click(await screen.findByRole('button', { name: 'run' }));
    await waitFor(() => expect(screen.getByTestId('err').textContent).toBe('INVALID_STATE'));
    await waitFor(() => expect(f.calls.some((c) => c.method === 'GET' && c.url.endsWith('/sessions/s4k7m2q9x1abc'))).toBe(true));
    fireEvent.click(screen.getByRole('button', { name: 'retry' }));
    await waitFor(() => expect(f.calls.filter((c) => c.method === 'POST')).toHaveLength(2));
    fireEvent.click(screen.getByRole('button', { name: 'run' }));
    await waitFor(() => expect(f.calls.filter((c) => c.method === 'POST')).toHaveLength(3));
    const keys = f.calls.filter((c) => c.method === 'POST').map((c) => c.headers['idempotency-key']);
    expect(keys[0]).toBe(keys[1]);
    expect(keys[2]).not.toBe(keys[0]);
    await waitFor(() => expect(screen.getByTestId('err').textContent).toBe(''));
  });
});
