import { describe, expect, it } from 'vitest';
import { endStages } from './phases';
import { offsetText, rescanTimeline } from './rescan';
import { countLedger, groupByStage, isOpen, normalizeResource, slowHint, sortManual } from './resources';

describe('end stages (08 P07 结束阶段与数据映射, §9.2 #8)', () => {
  it('maps phase names to the visible stages; stages without records before a started one count as done', () => {
    const stages = endStages({
      state: 'CLEANING',
      phases: [
        { name: 'end.disarm', status: 'DONE', at: '2026-10-13T10:02:00Z' },
        { name: 'end.revoke', status: 'DONE', at: '2026-10-13T10:02:30Z' },
        { name: 'end.finalize', status: 'DONE', at: '2026-10-13T10:05:00Z' },
        { name: 'end.seal', status: 'DONE', at: '2026-10-13T10:06:00Z' },
        { name: 'end.suspend', status: 'SKIPPED', at: '2026-10-13T10:06:00Z' },
        { name: 'clean.destroy', status: 'RUNNING', at: '2026-10-13T10:09:00Z', detail: 'cloudalbum-e7k2m9qx-cdn' },
      ],
    });
    expect(stages.map((s) => s.def.id)).toEqual(['stop', 'revoke', 'finalize', 'workstation', 'destroy', 'reclaim', 'conclude']);
    expect(stages.find((s) => s.def.id === 'workstation')!.status).toBe('done');
    const destroy = stages.find((s) => s.def.id === 'destroy')!;
    expect(destroy).toMatchObject({ status: 'running', current: true, details: ['cloudalbum-e7k2m9qx-cdn'] });
    expect(stages.find((s) => s.def.id === 'reclaim')!.status).toBe('todo');
  });

  it('keep branch shows “进入节省模式”; settled sessions conclude; CLEANUP_FAILED concludes as failed', () => {
    const kept = endStages({ state: 'KEPT', phases: [{ name: 'end.suspend', status: 'DONE', at: 'x' }] });
    expect(kept.some((s) => s.def.id === 'suspend')).toBe(true);
    const ended = endStages({ state: 'ENDED', phases: [] });
    expect(ended.every((s) => s.status === 'done')).toBe(true);
    expect(ended.some((s) => s.current)).toBe(false);
    const cf = endStages({ state: 'CLEANUP_FAILED', phases: [{ name: 'clean.verify', status: 'FAILED', at: 'x' }] });
    expect(cf.find((s) => s.def.id === 'conclude')!.status).toBe('failed');
    expect(cf.find((s) => s.def.id === 'reclaim')).toMatchObject({ status: 'failed', current: true });
  });

  it('unknown end.* / clean.* phases go to the current stage details', () => {
    const s = endStages({ state: 'ENDING', phases: [{ name: 'end.revoke', status: 'RUNNING', at: 'x' }, { name: 'end.something', status: 'RUNNING', at: 'x', detail: '额外的细节' }] });
    expect(s.find((x) => x.current)!.details).toContain('额外的细节');
  });
});

describe('rescan timeline (02 §7.7)', () => {
  const rescanAt = ['2026-10-13T10:22:00Z', '2026-10-13T11:02:00Z', '2026-10-13T16:02:00Z'];
  it('offsets from revokedAt', () => {
    expect(rescanAt.map((t) => offsetText('2026-10-13T10:02:00Z', t))).toEqual(['+20 分钟', '+60 分钟', '+6 小时']);
  });
  it('done / running / pending from RESCAN passes; follow-up DONE marks all done; observers only see time', () => {
    const passes = [
      { mode: 'PRIMARY', startedAt: '2026-10-13T10:09:00Z', finishedAt: '2026-10-13T10:20:00Z' },
      { mode: 'RESCAN', startedAt: '2026-10-13T10:22:00Z', finishedAt: '2026-10-13T10:24:00Z', manual: 0 },
      { mode: 'RESCAN', startedAt: '2026-10-13T11:02:00Z', finishedAt: null },
    ];
    const now = Date.parse('2026-10-13T11:03:00Z');
    expect(rescanTimeline({ followUp: 'PENDING', rescanAt }, '2026-10-13T10:02:00Z', passes, now).map((r) => r.status)).toEqual(['done', 'running', 'pending']);
    expect(rescanTimeline({ followUp: 'DONE', rescanAt }, null, passes, now).map((r) => r.status)).toEqual(['done', 'done', 'done']);
    expect(rescanTimeline({ followUp: 'PENDING', rescanAt }, null, null, now).map((r) => r.status)).toEqual(['due', 'due', 'pending']);
    const found = [{ mode: 'RESCAN', startedAt: 'a', finishedAt: '2026-10-13T10:24:00Z', manual: 1 }];
    expect(rescanTimeline({ followUp: 'PENDING', rescanAt }, null, found, now)[0]!.status).toBe('found');
    expect(rescanTimeline(null, null, null, now)).toEqual([]);
  });
});

describe('ledger normalisation (§9.2 #32: 01 and 02 field names)', () => {
  it('accepts the 02 §7.9 names returned by the API today', () => {
    const r = normalizeResource({
      resourceKey: 'k1',
      severity: 'BLOCKING',
      type: 'AWS::RDS::DBInstance',
      region: 'ap-northeast-1',
      id: 'cloudalbum-e7k2m9qx-db',
      source: 'CLOUDTRAIL',
      createdBy: 'atl-s4k7m2q9x1abc-console',
      billing: 'hourly',
      stage: 'S2',
      cleanupState: 'MANUAL_REQUIRED',
      reason: 'DeletionProtection',
      hint: { consoleUrl: 'https://console.aws.amazon.com/rds', cli: 'aws rds delete-db-instance …' },
      attempts: 4,
      lastTriedAt: '2026-10-13T10:30:00Z',
    });
    expect(r).toMatchObject({
      resourceType: 'AWS::RDS::DBInstance',
      name: 'cloudalbum-e7k2m9qx-db',
      discoveredBy: 'CloudTrail（你在控制台或 CLI 创建）',
      creatorSessionName: 'atl-s4k7m2q9x1abc-console',
      lastAttemptAt: '2026-10-13T10:30:00Z',
      manualHint: { consoleUrl: 'https://console.aws.amazon.com/rds', cli: 'aws rds delete-db-instance …', note: null },
      stage: 'S2',
    });
    expect(isOpen(r)).toBe(true);
  });

  it('accepts the 01 names; createdBy enums are not session names; unknown states are TRACKED', () => {
    const r = normalizeResource({ resourceKey: 'k', resourceType: 'AWS::S3::Bucket', name: 'b', discoveredBy: 'TAG', createdBy: 'learner', manualHint: { note: 'n' }, cleanupState: 'WHATEVER' });
    expect(r.creatorSessionName).toBeNull();
    expect(r.discoveredBy).toBe('标签（仅凭标签发现）');
    expect(r.cleanupState).toBe('TRACKED');
    expect(r.stage).toBe('other');
  });

  it('groups by stage S0～S6 with counts and default-open rules; manual sorting; slow hints', () => {
    const items = [
      normalizeResource({ resourceKey: 'a', type: 'AWS::CloudFront::Distribution', stage: 'S0', cleanupState: 'DELETING' }),
      normalizeResource({ resourceKey: 'b', type: 'AWS::EC2::Instance', stage: 'S1', cleanupState: 'DELETED' }),
      normalizeResource({ resourceKey: 'c', type: 'AWS::S3::Bucket', stage: 'S2', cleanupState: 'REVIEW', severity: 'REVIEW' }),
      normalizeResource({ resourceKey: 'd', type: 'AWS::RDS::DBInstance', stage: 'S2', cleanupState: 'MANUAL_REQUIRED', severity: 'BLOCKING', billing: 'hourly' }),
      normalizeResource({ resourceKey: 'e', type: 'AWS::EC2::Volume', stage: 'S4', cleanupState: 'MANUAL_REQUIRED', severity: 'BLOCKING', billing: 'storage' }),
    ];
    const g = groupByStage(items);
    expect(g.map((x) => [x.stage, x.done, x.total, x.defaultOpen])).toEqual([
      ['S0', 0, 1, true],
      ['S1', 1, 1, false],
      ['S2', 0, 2, true],
      ['S4', 0, 1, true],
    ]);
    expect(countLedger(items)).toMatchObject({ deleted: 1, deleting: 1, attention: 3, total: 5 });
    expect(sortManual(items.slice(2)).map((x) => x.resourceKey)).toEqual(['d', 'e', 'c']);
    expect(slowHint(items[0]!)).toContain('正在禁用');
    expect(slowHint(items[1]!)).toBeNull();
  });
});
