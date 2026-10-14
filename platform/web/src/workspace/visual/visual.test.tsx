/**
 * 工作台视觉化（09 I6 e）的纯函数与小组件：步骤相关服务的推导、示例输出的高亮切分、长说明折叠、P04 阶段图示。
 */
import { fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { setLocale } from '../../i18n';
import type { LabDoc, LabStep } from '../model/lab';
import type { PhaseRowModel } from '../model/phases';
import { moduleOfCli, moduleOfConsoleLink, modulesInCommand, stepModules } from '../model/stepServices';
import { PhaseDiagram } from '../provision/PhaseDiagram';
import { Clamp } from './Clamp';
import { ExpectedOutput, segmentLine } from './ExpectedOutput';

const code = (value: string, runsOn = 'workstation') => ({ type: 'code', lang: 'bash', attributes: { runsOn }, value });

function lab(step: LabStep, extra: Partial<LabDoc> = {}, children: unknown[] = []): LabDoc {
  return {
    id: 'svc-x',
    kind: 'service',
    title: 'x',
    steps: [step],
    manuals: { 'manual/10.md': { frontMatter: { step: step.id }, ast: { type: 'root', children: children as never } } },
    ...extra,
  };
}

describe('stepModules（步骤顶部的服务图标）', () => {
  it('maps CLI service names, scripts/module and console links to registry modules', () => {
    expect(moduleOfCli('s3')).toBe('storage');
    expect(moduleOfCli('s3api')).toBe('storage');
    expect(moduleOfCli('elbv2')).toBe('load-balancer');
    expect(moduleOfCli('logs')).toBe('logging');
    expect(moduleOfCli('ssm', 'get-parameter')).toBe('config');
    expect(moduleOfCli('ssm', 'start-session')).toBe('shell-access');
    expect(moduleOfCli('configure')).toBeNull();
    expect(moduleOfCli('not-a-service')).toBeNull();
    expect(moduleOfConsoleLink('cloudfront.distribution')).toBe('cdn');
    expect(moduleOfConsoleLink('ec2.securityGroup')).toBe('ec2');
    expect(modulesInCommand('scripts/module enable cdn && aws cloudfront get-distribution --id E1 | jq .\nN=1; aws sqs send-message')).toEqual({ script: ['cdn'], cli: ['cdn', 'queue'] });
    // “atl-aws foo” 不是 aws CLI
    expect(modulesInCommand('atl-aws s3 ls').cli).toEqual([]);
  });

  it('orders wire target, experiment, scripts, checks, console links, CLI and pricing keys; dedupes; caps', () => {
    const step: LabStep = {
      id: 'enable',
      type: 'script',
      title: 'enable',
      checks: ['cap', 'ro', 'hdr', { ref: 'exp', as: 'exp2' }],
      experiment: { module: 'queue', id: 'burst', label: 'after' },
      startsBilling: { pricingKeys: ['cloudfront.requests.https', 'sns.publish'] },
    };
    const doc = lab(
      step,
      {
        targetModules: [{ id: 'cdn', wireStep: 'enable' }, { id: 'waf', wireStep: 'other' }],
        checks: {
          cap: { id: 'cap', title: 'c', type: 'capability', module: 'cache' },
          ro: { id: 'ro', title: 'r', type: 'aws-readonly', service: 'rds' },
          hdr: { id: 'hdr', title: 'h', type: 'http-header', target: 'public-ip' },
          exp2: { id: 'exp2', title: 'e', type: 'experiment', module: 'queue', reproduce: { run: 'aws dynamodb scan --table-name t', runsOn: 'workstation' } },
        },
      },
      [code('scripts/module enable storage'), code('aws iam get-role --role-name r'), { type: 'leafDirective', name: 'console-link', attributes: { link: 'ec2.instance' } }],
    );
    expect(stepModules(doc, step, 10)).toEqual(['cdn', 'queue', 'storage', 'cache', 'database', 'ec2', 'iam', 'social-store', 'notification']);
    expect(stepModules(doc, step)).toHaveLength(6);
    expect(stepModules(null, step)).toEqual([]);
  });
});

describe('ExpectedOutput（预期结果的视觉提示）', () => {
  it('highlights header names, JSON keys and HTTP status codes only', () => {
    expect(segmentLine('x-cache: Hit from cloudfront')).toEqual([{ text: 'x-cache', kind: 'key' }, { text: ': ' }, { text: 'Hit from cloudfront', kind: 'value' }]);
    expect(segmentLine('  "driver": "s3",')).toEqual([{ text: '  ' }, { text: '"driver"', kind: 'key' }, { text: ': ' }, { text: '"s3",', kind: 'value' }]);
    expect(segmentLine('HTTP/2 403 ')).toEqual([{ text: 'HTTP/2 ' }, { text: '403', kind: 'key' }, { text: ' ' }]);
    expect(segmentLine('https://example.com/a')).toEqual([{ text: 'https://example.com/a' }]);
    expect(segmentLine('C:\\temp')).toEqual([{ text: 'C:\\temp' }]);
    expect(segmentLine('plain output')).toEqual([{ text: 'plain output' }]);
  });

  it('keeps the text intact (marks are visual only) and redacts account ids', () => {
    const { container } = render(<ExpectedOutput text={'age: 1\narn:aws:iam::123456789012:role/x\n'} />);
    const pre = container.querySelector('pre[data-expected-output]')!;
    expect(pre.textContent).not.toContain('123456789012');
    expect(pre.textContent!.startsWith('age: 1\n')).toBe(true);
    expect(pre.querySelectorAll('mark').length).toBe(1);
  });
});

describe('Clamp（超过 3 行的说明默认折叠）', () => {
  afterEach(() => vi.restoreAllMocks());

  it('hides the toggle when the laid-out text fits in three lines', () => {
    vi.spyOn(HTMLElement.prototype, 'clientHeight', 'get').mockReturnValue(60);
    vi.spyOn(HTMLElement.prototype, 'scrollHeight', 'get').mockReturnValue(60);
    render(<Clamp>短い説明</Clamp>);
    expect(screen.queryByRole('button')).toBeNull();
  });

  it('shows “詳しく” in Japanese when it overflows, toggles aria-expanded and the clamp class', () => {
    setLocale('ja', { persist: false });
    vi.spyOn(HTMLElement.prototype, 'clientHeight', 'get').mockReturnValue(60);
    vi.spyOn(HTMLElement.prototype, 'scrollHeight', 'get').mockReturnValue(140);
    const { container } = render(<Clamp>長い説明</Clamp>);
    const btn = screen.getByRole('button', { name: '詳しく' });
    expect(container.querySelector('p')!.className).toBe('clamp3');
    fireEvent.click(btn);
    expect(screen.getByRole('button', { name: '閉じる' }).getAttribute('aria-expanded')).toBe('true');
    expect(container.querySelector('p')!.className).toBe('');
    setLocale('zh-CN', { persist: false });
  });
});

describe('PhaseDiagram（P04 阶段图示）', () => {
  const row = (key: PhaseRowModel['key'], status: PhaseRowModel['status'], p: Partial<PhaseRowModel> = {}): PhaseRowModel => ({ key, title: key, status, startedAt: null, endedAt: null, details: [], slowHint: null, ...p });

  it('marks the current stage, shows status text for screen readers and the current details only', () => {
    const now = Date.parse('2026-10-14T10:10:00Z');
    render(
      <PhaseDiagram
        now={now}
        near
        rows={[
          row('validate', 'done', { startedAt: now - 300_000, endedAt: now - 240_000, details: ['起始档位 default'] }),
          row('base', 'running', { startedAt: now - 65_000, details: ['模块 1/2 · iam'], slowHint: 'RDS 通常是最慢的一步' }),
          row('profile', 'todo'),
          row('connect', 'todo'),
          row('health', 'todo'),
          row('ready', 'todo'),
        ]}
      />,
    );
    const list = screen.getByRole('list', { name: '准备阶段' });
    const items = within(list).getAllByRole('listitem');
    expect(items.map((li) => li.getAttribute('data-status'))).toEqual(['done', 'running', 'todo', 'todo', 'todo', 'todo']);
    expect(items[1]!.getAttribute('aria-current')).toBe('step');
    expect(items[0]!.textContent).toContain('完成');
    expect(items[0]!.getAttribute('title')).toBe('起始档位 default');
    expect(items[1]!.querySelector('.phd-tm')!.textContent).toBe('1:05');
    expect(items[1]!.querySelector('[data-phase-icon="base"]')).not.toBeNull();
    const detail = document.querySelector('[data-phase-detail="base"]')!;
    expect(Array.from(detail.querySelectorAll('li')).map((li) => li.textContent)).toEqual(['模块 1/2 · iam', 'RDS 通常是最慢的一步', '比通常更久。平台会在超时前自动停止并释放已创建的资源。']);
  });
});
