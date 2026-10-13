import { describe, expect, it } from 'vitest';
import { preflightTitle, verdictOf } from '../setup/preflight';
import { allowedTabs, canDeleteStack, fieldErrorsFrom, formFromSettings, manualJson, manualMarkdown, readOnlyTab, settingsPatch } from './model';

describe('settings tabs (08 P12)', () => {
  it('learners see all tabs, assistants profile + audit, observers profile only', () => {
    expect(allowedTabs('L')).toHaveLength(9);
    expect(allowedTabs('A')).toEqual(['profile', 'audit']);
    expect(allowedTabs('O')).toEqual(['profile']);
    expect(allowedTabs(null)).toEqual([]);
  });

  it('while uninstalling only uninstall, profile and audit stay writable', () => {
    expect(readOnlyTab('workspace', true)).toBe(true);
    expect(readOnlyTab('uninstall', true)).toBe(false);
    expect(readOnlyTab('profile', true)).toBe(false);
    expect(readOnlyTab('workspace', false)).toBe(false);
  });
});

describe('platform settings form', () => {
  const view = { ver: 3, limits: { readyIdleMinutes: 60, extension: { minutes: 30, maxCount: 2 } }, reclaim: { blockStartOnResidual: 'ack' as const }, console: { longSession: false } };

  it('patches only what changed, nested by path; numbers must be non-negative integers', () => {
    const before = formFromSettings(view);
    expect(before.readyIdleMinutes).toBe('60');
    expect(before.blockStartOnResidual).toBe('ack');
    const r = settingsPatch(before, { ...before, extCount: '3', blockStartOnResidual: 'block', longSession: true });
    expect(r.errors).toEqual({});
    expect(r.patch).toEqual({ limits: { extension: { maxCount: 3 } }, reclaim: { blockStartOnResidual: 'block' }, console: { longSession: true } });
    expect(settingsPatch(before, { ...before, readyIdleMinutes: '-1' }).errors.readyIdleMinutes).toBeTruthy();
    expect(settingsPatch(before, before).patch).toEqual({});
  });

  it('maps server field errors back to fields', () => {
    expect(fieldErrorsFrom([{ path: 'limits.extension.maxCount', message: 'too big' }, { path: 'x', message: 'y' }])).toEqual({ extCount: 'too big' });
  });
});

describe('uninstall', () => {
  it('step 3 appears only when ready and termination protection is off', () => {
    expect(canDeleteStack(null)).toBe(false);
    expect(canDeleteStack({ ready: true, mode: 'UNINSTALLING', terminationProtection: true, blockers: [], rescanWarning: null })).toBe(false);
    expect(canDeleteStack({ ready: true, mode: 'UNINSTALLING', terminationProtection: false, blockers: [], rescanWarning: null })).toBe(true);
  });

  it('exports the manual list as Markdown (with CLI commands) and JSON', () => {
    const items = [{ resourceKey: 'k1', resourceType: 'AWS::EC2::NatGateway', name: 'nat-1', cleanupState: 'MANUAL_REQUIRED' as const, severity: 'BLOCKING' as const, billing: 'hourly' as const, manualHint: { cli: 'aws ec2 delete-nat-gateway --nat-gateway-id nat-1', consoleUrl: 'https://console.aws.amazon.com/vpc' } }];
    const md = manualMarkdown(items, '2026-10-14T00:00:00Z');
    expect(md).toContain('## 1. AWS::EC2::NatGateway nat-1');
    expect(md).toContain('aws ec2 delete-nat-gateway --nat-gateway-id nat-1');
    expect(JSON.parse(manualJson(items, 'now'))).toMatchObject({ schema: 'atl.manual-resources/v1', items: [{ resourceKey: 'k1' }] });
  });
});

describe('preflight items (P00 step 2)', () => {
  it('maps install-time statuses to 需处理 / 提示 / 通过 / 无法检测', () => {
    expect(verdictOf({ id: 'default-vpc', status: 'warn' })).toBe('fix');
    expect(verdictOf({ id: 'vcpu-quota', status: 'warn' })).toBe('warn');
    expect(verdictOf({ id: 'existing-trail', status: 'info' })).toBe('warn');
    expect(verdictOf({ id: 'x', status: 'fail' })).toBe('fix');
    expect(verdictOf({ id: 'x', status: 'ok' })).toBe('pass');
    expect(verdictOf({ id: 'x', status: 'unknown' })).toBe('unknown');
    expect(preflightTitle({ id: 'default-vpc', status: 'warn' })).toBe('默认 VPC：这个区域中没有默认 VPC');
    expect(preflightTitle({ id: 'default-vpc', status: 'ok' })).toBe('默认 VPC 与默认子网');
    expect(preflightTitle({ id: 'new-check', status: 'warn', detail: 'something odd' })).toBe('something odd');
  });
});
