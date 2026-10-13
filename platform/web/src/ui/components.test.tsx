import { act, fireEvent, render, screen, within } from '@testing-library/react';
import { useState } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { subscribeAnnouncements } from '../lib/announce';
import { BannerStack, type BannerSpec } from './Banner';
import { Box, Section } from './Box';
import { Button } from './Button';
import { CheckResultRow, evidenceMix, SourceTag } from './CheckResultRow';
import { CostTierMark } from './CostTierMark';
import { Countdown } from './Countdown';
import { DataTable } from './DataTable';
import { Disclosure } from './Disclosure';
import { EmptyState } from './EmptyState';
import { ErrorPanel, problemMessage } from './ErrorPanel';
import { Field } from './Field';
import { Dialog, Drawer } from './Overlay';
import { ManualItemCard, ResourceRow } from './ResourceRow';
import { Skeleton } from './Skeleton';
import { SessionStatePill, Status } from './Status';
import { CHECK_RESULT_META, SESSION_STATE_META } from './semantics';

describe('Status / SessionStatePill (形状 + 文字 + 颜色)', () => {
  it('renders shape and text with the semantic tone class', () => {
    const { container } = render(<Status meta={CHECK_RESULT_META.fail} />);
    const el = container.querySelector('.st')!;
    expect(el.className).toContain('fail');
    expect(el.querySelector('svg[data-shape="xbox"]')).not.toBeNull();
    expect(el.textContent).toBe('未通过');
  });

  it('shape-only status keeps the text for screen readers', () => {
    render(<Status meta={CHECK_RESULT_META.pass} shapeOnly />);
    expect(screen.getByText('通过').className).toBe('sr');
  });

  it.each(Object.keys(SESSION_STATE_META) as (keyof typeof SESSION_STATE_META)[])('session pill for %s', (state) => {
    const { container } = render(<SessionStatePill state={state} />);
    const pill = container.querySelector('.pill')!;
    expect(pill.className).toContain(SESSION_STATE_META[state].pill);
    expect(pill.textContent).toBe(SESSION_STATE_META[state].text);
  });

  it('sm shape-only pill exposes the state as aria-label', () => {
    render(<SessionStatePill state="KEPT" size="sm" shapeOnly />);
    expect(screen.getByRole('img', { name: '环境保留中' })).toBeTruthy();
  });
});

describe('Button', () => {
  it('blocked buttons stay focusable, explain why via aria-describedby and swallow clicks', () => {
    const onClick = vi.fn();
    render(
      <Button onClick={onClick} disabledReason="即将到期，无法延长">
        延长 30 分钟
      </Button>,
    );
    const btn = screen.getByRole('button', { name: '延长 30 分钟' });
    expect(btn.getAttribute('aria-disabled')).toBe('true');
    const reason = document.getElementById(btn.getAttribute('aria-describedby')!)!;
    expect(reason.textContent).toBe('即将到期，无法延长');
    fireEvent.click(btn);
    expect(onClick).not.toHaveBeenCalled();
  });

  it('busy buttons show the progress text with aria-busy', () => {
    render(
      <Button busy busyText="正在开始…">
        开始实验
      </Button>,
    );
    const btn = screen.getByRole('button');
    expect(btn.textContent).toBe('正在开始…');
    expect(btn.getAttribute('aria-busy')).toBe('true');
  });

  it('variants map to the prototype classes', () => {
    render(
      <>
        <Button variant="primary">a</Button>
        <Button variant="danger-solid" size="sm">
          b
        </Button>
      </>,
    );
    expect(screen.getByText('a').className).toContain('btn primary');
    expect(screen.getByText('b').className).toBe('btn danger solid sm');
  });
});

describe('CostTierMark (08 §6.6)', () => {
  it('shows $ symbols and text, never amounts', () => {
    render(<CostTierMark tier="low" withOptional="medium" sources="ALB 小时" />);
    const el = screen.getByLabelText('费用档位低（选做 → 中）');
    expect(el.textContent).toBe('$ 低（选做 → 中）');
    expect(el.getAttribute('title')).toContain('具体金额在开始前按当前价格计算');
  });
});

describe('Box / Section / EmptyState / Field', () => {
  it('section heading carries the aside', () => {
    render(
      <Section title="资源" aside="23 项" headingId="res-h">
        <Box inset>x</Box>
      </Section>,
    );
    expect(screen.getByRole('heading', { name: /资源/ }).textContent).toBe('资源23 项');
    expect(screen.getByRole('region', { name: /资源/ })).toBeTruthy();
  });

  it('empty state: why + one next step; page variant renders h1', () => {
    render(<EmptyState page title="页面不存在" action={<a href="/labs">回到卡片目录</a>} />);
    expect(screen.getByRole('heading', { level: 1, name: '页面不存在' })).toBeTruthy();
    expect(screen.getByRole('link', { name: '回到卡片目录' })).toBeTruthy();
  });

  it('field wires label, hint and error (aria-invalid + aria-describedby)', () => {
    render(
      <Field label="显示名" hint="会显示在报告上" error="不能为空">
        <input className="input" />
      </Field>,
    );
    const input = screen.getByLabelText('显示名');
    expect(input.getAttribute('aria-invalid')).toBe('true');
    const ids = input.getAttribute('aria-describedby')!.split(' ');
    expect(ids.map((id) => document.getElementById(id)!.textContent)).toEqual(['会显示在报告上', '不能为空']);
  });
});

describe('Skeleton', () => {
  it('shows “仍在加载… [重试]” after 10 seconds', () => {
    vi.useFakeTimers();
    const onRetry = vi.fn();
    render(<Skeleton onRetry={onRetry} />);
    expect(screen.queryByText('仍在加载…')).toBeNull();
    act(() => {
      vi.advanceTimersByTime(10_000);
    });
    fireEvent.click(screen.getByRole('button', { name: '重试' }));
    expect(onRetry).toHaveBeenCalled();
  });
});

describe('ErrorPanel (P13)', () => {
  it('maps known codes to the default copy and shows the request id', () => {
    render(<ErrorPanel error={{ code: 'MAINTENANCE_MODE', status: 409, requestId: 'r-42' }} onRetry={() => undefined} />);
    expect(screen.getByRole('alert').textContent).toContain('平台处于维护模式');
    expect(screen.getByText(/r-42/)).toBeTruthy();
  });

  it('unknown codes fall back to title + detail; 5xx to the “暂时不可用” copy', () => {
    expect(problemMessage({ code: 'SOMETHING_NEW', title: '新错误', detail: '细节' })).toBe('新错误：细节');
    expect(problemMessage({ code: 'X', status: 503 })).toBe('平台服务暂时不可用（503）。');
    expect(problemMessage({ code: 'SESSION_ACTIVE_EXISTS', detail: 'svc-cdn' })).toBe('已有进行中的实验：svc-cdn');
  });
});

describe('CheckResultRow / SourceTag (08 §5.3)', () => {
  it('shows result shape, judging method, source, title and time; screen readers get the result once', () => {
    const onOpen = vi.fn();
    render(
      <div role="list">
        <CheckResultRow title="CloudFront 分配已部署" result="pass" how="auto" source="AWS" summary="期望 Deployed · 实际 Deployed" at="2026-10-13T01:02:00Z" onOpen={onOpen} focusKey="cdn-1" />
      </div>,
    );
    const row = screen.getByRole('listitem');
    expect(row.textContent).toContain('自动');
    expect(row.textContent).toContain('AWS');
    expect(within(row).getByText('，通过').className).toBe('sr');
    expect(row.querySelector('.res')!.getAttribute('aria-hidden')).toBe('true');
    fireEvent.keyDown(row, { key: 'Enter' });
    expect(onOpen).toHaveBeenCalledTimes(1);
  });

  it('reason codes, manual review and stale suffix', () => {
    render(
      <div role="list">
        <CheckResultRow title="a" result="pending" reason="OWNERSHIP_PENDING" how="auto" source="AWS" />
        <CheckResultRow title="b" result="manual_evidence" how="manual" source="MANUAL" sourceSub="evidence" review="pending" stale />
      </div>,
    );
    const [a, b] = screen.getAllByRole('listitem');
    expect(a!.textContent).toContain('归属确认中');
    expect(b!.textContent).toContain('等待助教复核');
    expect(b!.textContent).toContain('已手动确认（带证据）·过期');
    expect(b!.textContent).toContain('带证据');
  });

  it('SourceTag shows trust below high and evidenceMix summarises sources', () => {
    render(<SourceTag source="PROBE" trust="low" />);
    expect(screen.getByText(/探针/).textContent).toContain('低可信');
    expect(evidenceMix({ AWS: 6, LOCAL: 1, EXP: 1 })).toBe('◇本地 1 · □AWS 6 · △实验 1');
  });
});

describe('ResourceRow / ManualItemCard (08 §5.4)', () => {
  const base = { resourceKey: 'k1', resourceType: 'AWS::RDS::DBInstance', arn: 'arn:aws:rds:ap-northeast-1:111122223333:db:x', cleanupState: 'MANUAL_REQUIRED' as const };

  it('masks account ids in names and shows state + severity', () => {
    const { container } = render(<ResourceRow resource={{ ...base, severity: 'BLOCKING', billing: 'hourly' }} />);
    expect(container.textContent).toContain('••••3333');
    expect(container.textContent).not.toContain('111122223333');
    expect(container.textContent).toContain('需人工处理');
    expect(container.textContent).toContain('阻塞');
    expect(container.textContent).toContain('按小时');
  });

  it('manual card: console link opens in a new tab, CLI is copy-only, resolve button names the object', () => {
    const onResolve = vi.fn();
    render(
      <ManualItemCard
        resource={{ ...base, severity: 'BLOCKING', manualHint: { consoleUrl: 'https://console.aws.amazon.com/rds', cli: 'aws rds delete-db-instance --db-instance-identifier x', note: '先关闭删除保护' } }}
        onResolve={onResolve}
      />,
    );
    const link = screen.getByRole('link', { name: /在 AWS 控制台中打开/ });
    expect(link.getAttribute('target')).toBe('_blank');
    expect(link.getAttribute('rel')).toContain('noopener');
    expect(screen.queryByRole('button', { name: /粘贴/ })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: /我已处理 .*，重新核对/ }));
    expect(onResolve).toHaveBeenCalled();
  });

  it('accepts the 02 §7.9 legacy field names', () => {
    render(<ManualItemCard resource={{ ...base, resourceType: '', type: 'AWS::EC2::Instance', hint: { cli: 'aws ec2 terminate-instances' } }} />);
    expect(screen.getByText('AWS::EC2::Instance')).toBeTruthy();
    expect(screen.getByText('aws ec2 terminate-instances')).toBeTruthy();
  });
});

describe('DataTable', () => {
  const rows = [
    { id: 'a', n: 2 },
    { id: 'b', n: 1 },
  ];
  it('sortable headers expose aria-sort; rows are focusable and Enter opens', () => {
    const onRow = vi.fn();
    render(
      <DataTable
        caption="会话"
        rows={rows}
        rowKey={(r) => r.id}
        onRowClick={onRow}
        columns={[
          { key: 'id', header: '会话', render: (r) => r.id },
          { key: 'n', header: '时长', numeric: true, render: (r) => r.n, sortValue: (r) => r.n },
        ]}
      />,
    );
    const th = screen.getByRole('columnheader', { name: /时长/ });
    expect(th.getAttribute('aria-sort')).toBe('none');
    fireEvent.click(within(th).getByRole('button'));
    expect(th.getAttribute('aria-sort')).toBe('ascending');
    const bodyRows = screen.getAllByRole('row').slice(1);
    expect(bodyRows[0]!.textContent).toContain('b');
    fireEvent.keyDown(bodyRows[0]!, { key: 'Enter' });
    expect(onRow).toHaveBeenCalledWith(rows[1]);
    expect(screen.getAllByRole('cell')[0]!.getAttribute('data-label')).toBe('会话');
  });
});

describe('Dialog / Drawer (focus trap, Esc, focus return)', () => {
  function Harness({ alert }: { alert?: boolean }) {
    const [open, setOpen] = useState(false);
    return (
      <>
        <button type="button" onClick={() => setOpen(true)}>
          结束实验…
        </button>
        <Dialog
          open={open}
          onClose={() => setOpen(false)}
          title="结束实验"
          alert={alert}
          initialFocus="[data-cancel]"
          footer={
            <>
              <button type="button" data-cancel="" onClick={() => setOpen(false)}>
                取消
              </button>
              <button type="button">结束</button>
            </>
          }
        >
          <p>说明</p>
        </Dialog>
      </>
    );
  }

  it('opens with focus on the given element (danger actions default to 取消), closes on Esc and returns focus', async () => {
    const root = document.createElement('div');
    root.id = 'root';
    document.body.appendChild(root);
    render(<Harness />, { container: root });
    const trigger = screen.getByRole('button', { name: '结束实验…' });
    trigger.focus();
    fireEvent.click(trigger);
    const dlg = screen.getByRole('dialog', { name: '结束实验' });
    expect(dlg.getAttribute('aria-modal')).toBe('true');
    expect(document.activeElement?.textContent).toBe('取消');
    expect(root.hasAttribute('inert')).toBe(true);
    fireEvent.keyDown(dlg, { key: 'Escape' });
    expect(screen.queryByRole('dialog')).toBeNull();
    await act(async () => {
      await Promise.resolve();
    });
    expect(document.activeElement).toBe(trigger);
    expect(root.hasAttribute('inert')).toBe(false);
    root.remove();
  });

  it('Tab wraps inside the dialog; alert variant uses role=alertdialog', () => {
    render(<Harness alert />);
    fireEvent.click(screen.getByRole('button', { name: '结束实验…' }));
    const dlg = screen.getByRole('alertdialog');
    const buttons = within(dlg).getAllByRole('button');
    buttons[buttons.length - 1]!.focus();
    fireEvent.keyDown(dlg, { key: 'Tab' });
    expect(document.activeElement).toBe(buttons[0]);
  });

  it('drawer closes on scrim click', () => {
    const onClose = vi.fn();
    render(
      <Drawer open onClose={onClose} title="证据">
        x
      </Drawer>,
    );
    fireEvent.click(document.querySelector('.drawer-scrim')!);
    expect(onClose).toHaveBeenCalled();
  });
});

describe('Disclosure (08 §3.4)', () => {
  it('toggles aria-expanded, focuses the first item, Esc returns focus to the trigger', () => {
    render(
      <Disclosure label="会话菜单">
        <a href="/workspace/s1">回到工作台</a>
      </Disclosure>,
    );
    const btn = screen.getByRole('button', { name: '会话菜单' });
    expect(btn.getAttribute('aria-expanded')).toBe('false');
    fireEvent.click(btn);
    expect(btn.getAttribute('aria-expanded')).toBe('true');
    expect(document.activeElement?.textContent).toBe('回到工作台');
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(btn.getAttribute('aria-expanded')).toBe('false');
    expect(document.activeElement).toBe(btn);
  });

  it('focusContainer puts focus on the panel itself (account menu)', () => {
    render(
      <Disclosure label="账号" focusContainer panelRole="group" panelLabel="账号与区域">
        <button type="button">显示</button>
      </Disclosure>,
    );
    fireEvent.click(screen.getByRole('button', { name: '账号' }));
    expect(document.activeElement).toBe(screen.getByRole('group', { name: '账号与区域' }));
  });
});

describe('BannerStack (08 §3.6)', () => {
  const mk = (id: string, priority: number, tone: BannerSpec['tone']): BannerSpec => ({ id, priority, tone, shape: 'tri', text: `${id} 文案`, dismissible: true });

  it('shows at most 2 by priority, the rest behind “还有 n 条提醒”', () => {
    render(<BannerStack banners={[mk('c', 8, 'blue'), mk('a', 1, 'red'), mk('b', 4, 'amber')]} />);
    const shown = document.querySelectorAll('[data-banner]');
    expect([...shown].map((b) => b.getAttribute('data-banner'))).toEqual(['a', 'b']);
    fireEvent.click(screen.getByRole('button', { name: '还有 1 条提醒' }));
    expect(document.querySelectorAll('[data-banner]').length).toBe(3);
  });

  it('red banners cannot be dismissed; others are dismissed for this tab only', () => {
    const { rerender } = render(<BannerStack banners={[mk('red', 1, 'red'), mk('warn', 7, 'amber')]} />);
    const red = document.querySelector('[data-banner="red"]')!;
    expect(within(red as HTMLElement).queryByRole('button', { name: '关闭提醒' })).toBeNull();
    fireEvent.click(within(document.querySelector('[data-banner="warn"]') as HTMLElement).getByRole('button', { name: '关闭提醒' }));
    expect(document.querySelector('[data-banner="warn"]')).toBeNull();
    expect(sessionStorage.getItem('atl.banners.dismissed.v1')).toContain('warn|');
    // 内容变化后重新出现
    rerender(<BannerStack banners={[mk('red', 1, 'red'), { ...mk('warn', 7, 'amber'), text: '新内容' }]} />);
    expect(document.querySelector('[data-banner="warn"]')).not.toBeNull();
  });

  it('red / amber banners announce with role=alert only on first appearance', () => {
    const spec = [mk('a', 1, 'red')];
    const first = render(<BannerStack banners={spec} />);
    expect(first.container.querySelector('[data-banner="a"]')!.getAttribute('role')).toBe('alert');
    first.unmount();
    const second = render(<BannerStack banners={spec} />);
    expect(second.container.querySelector('[data-banner="a"]')!.getAttribute('role')).toBeNull();
  });
});

describe('Countdown (08 §6.4)', () => {
  const deadline = '2026-10-14T08:00:00.000Z';
  const at = (msBefore: number) => () => Date.parse(deadline) - msBefore;

  it('computes the remaining time from deadlineAt and the server clock', () => {
    const { container } = render(<Countdown deadlineAt={deadline} now={at((1 * 3600 + 42 * 60 + 10) * 1000)} />);
    const timer = screen.getByRole('timer');
    expect(timer.textContent).toBe('1:42:10');
    expect(timer.getAttribute('aria-live')).toBe('off');
    expect(container.querySelector('[data-urgency="U0"]')).not.toBeNull();
  });

  it.each([
    [12 * 60_000, 'U1', 'cdbig u1'],
    [4 * 60_000, 'U2', 'cdbig u2'],
    [42_000, 'U3', 'cdbig u3'],
    [0, 'U4', 'cdbig u4'],
  ])('bar variant at %i ms → %s', (ms, u, cls) => {
    const { container } = render(<Countdown deadlineAt={deadline} now={at(ms)} variant="bar" />);
    expect(container.querySelector(`[data-urgency="${u}"]`)).not.toBeNull();
    expect(screen.getByRole('timer').className).toBe(cls);
  });

  it('before READY shows “倒计时未开始”; keep variant shows the release time', () => {
    render(<Countdown deadlineAt={null} now={() => 0} />);
    expect(screen.getByRole('timer').textContent).toBe('倒计时未开始');
  });

  it('keep variant switches to ▲ in the last 15 minutes', () => {
    const { container } = render(<Countdown deadlineAt={deadline} now={at(10 * 60_000)} variant="keep" />);
    expect(container.querySelector('[data-urgency="K2"]')).not.toBeNull();
    expect(screen.getByRole('timer').textContent).toContain('剩余 10:00');
  });
});

describe('announcements are only made through LiveRegion', () => {
  it('copy feedback goes through announce()', async () => {
    const got: string[] = [];
    const off = subscribeAnnouncements((a) => got.push(a.text));
    const { CommandBlock } = await import('./CommandBlock');
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: vi.fn().mockResolvedValue(undefined) } });
    render(<CommandBlock text="scripts/module enable cdn" />);
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /复制命令/ }));
    });
    expect(got).toContain('已复制');
    off();
  });
});
