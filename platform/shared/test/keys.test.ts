import { describe, expect, it } from 'vitest';
import {
  auditMonth,
  eventRange,
  Gsi1,
  Gsi2,
  Keys,
  MANUAL_GSI2_PARTITIONS,
  SkPrefix,
  SWEEP_GSI2_PARTITIONS,
  ttlAfterHours,
  ttlEpochSeconds,
} from '../src/index.js';
import { resourceKey } from '../src/node.js';

const SID = 's4k7m2q9x1abc';
const ENV = '01jc9x3k9cq4m2x8n5b6c0d1e2';
const RK = 'a'.repeat(32);

describe('primary keys (01 §7.2)', () => {
  it('platform singletons', () => {
    expect(Keys.platformConfig()).toEqual({ PK: 'PLATFORM', SK: 'CONFIG' });
    expect(Keys.schemaVersion()).toEqual({ PK: 'PLATFORM', SK: 'SCHEMA' });
    expect(Keys.activeEnvironmentLock()).toEqual({ PK: 'PLATFORM', SK: 'LOCK#ACTIVE_ENV' });
    expect(Keys.rateBucket('cloudtrail-lookup', 'us-east-1')).toEqual({ PK: 'PLATFORM', SK: 'RATE#cloudtrail-lookup#us-east-1' });
  });

  it('catalog, prices, quotes, users', () => {
    expect(Keys.catalogRelease('2026.10.1')).toEqual({ PK: 'CATALOG', SK: 'REL#2026.10.1' });
    expect(Keys.catalogCurrent()).toEqual({ PK: 'CATALOG', SK: 'CURRENT' });
    expect(Keys.priceCache('ap-northeast-1', 'AmazonEC2', 'BoxUsage:t3.micro#Linux')).toEqual({
      PK: 'PRICE#ap-northeast-1',
      SK: 'AmazonEC2#BoxUsage:t3.micro#Linux',
    });
    expect(Keys.costQuote('sub-1', 'q1')).toEqual({ PK: 'USER#sub-1', SK: 'QUOTE#q1' });
    expect(Keys.userProfile('sub-1')).toEqual({ PK: 'USER#sub-1', SK: 'PROFILE' });
    expect(Keys.labProgress('sub-1', 'svc-cdn')).toEqual({ PK: 'USER#sub-1', SK: 'LAB#svc-cdn' });
    expect(Keys.quizAttempt('sub-1', 'svc-cdn', '01ULID')).toEqual({ PK: 'USER#sub-1', SK: 'QUIZ#svc-cdn#01ULID' });
  });

  it('session partition', () => {
    const P = `SESSION#${SID}`;
    expect(Keys.labSession(SID)).toEqual({ PK: P, SK: 'META' });
    expect(Keys.sessionEvent(SID, 'E1')).toEqual({ PK: P, SK: 'EVT#E1' });
    expect(Keys.stepResult(SID, 'enable-cdn')).toEqual({ PK: P, SK: 'STEP#enable-cdn' });
    expect(Keys.checkRun(SID, 'R1')).toEqual({ PK: P, SK: 'RUN#R1' });
    expect(Keys.manualConfirmation(SID, 'st', 'ck', 'U')).toEqual({ PK: P, SK: 'MANUAL#st#ck#U' });
    expect(Keys.experimentRun(SID, 'X')).toEqual({ PK: P, SK: 'EXP#X' });
    expect(Keys.moduleOp(SID, 'U')).toEqual({ PK: P, SK: 'MODOP#U' });
    expect(Keys.runnerRun(SID, `${SID}-apply-1-0`)).toEqual({ PK: P, SK: `BUILD#${SID}-apply-1-0` });
    expect(Keys.credentialGrant(SID, 'ws', 'U')).toEqual({ PK: P, SK: 'CRED#ws#U' });
    expect(Keys.credentialGrant(SID, 'prov-base-deploy', 'U')).toEqual({ PK: P, SK: 'CRED#prov-base-deploy#U' });
    expect(Keys.terminalSession(SID, 'U')).toEqual({ PK: P, SK: 'TERM#U' });
    expect(Keys.labAttempt(SID)).toEqual({ PK: P, SK: 'ATTEMPT' });
    expect(Keys.report(SID, 2)).toEqual({ PK: P, SK: 'REPORT#v2' });
    expect(Keys.reportShare(SID, 'sh1')).toEqual({ PK: P, SK: 'SHARE#sh1' });
    expect(() => Keys.labSession('not-a-sid')).toThrow();
    expect(() => Keys.report(SID, 0)).toThrow();
  });

  it('environment partition, certificates, keys, audit, idempotency', () => {
    expect(Keys.environment(ENV)).toEqual({ PK: `ENV#${ENV}`, SK: 'META' });
    expect(Keys.sessionResource(ENV, RK)).toEqual({ PK: `ENV#${ENV}`, SK: `RES#${RK}` });
    expect(Keys.reclaimPass(ENV, 3)).toEqual({ PK: `ENV#${ENV}`, SK: 'PASS#0003' });
    expect(Keys.inventorySnapshot(ENV)).toEqual({ PK: `ENV#${ENV}`, SK: 'INV' });
    expect(Keys.certificate('ATL-7K2M-9Q4X-1ABZ-C3DE')).toEqual({ PK: 'CERT#ATL-7K2M-9Q4X-1ABZ-C3DE', SK: 'META' });
    expect(Keys.revocationList(12)).toEqual({ PK: 'CERT#REVOCATIONS', SK: 'SEQ#00000012' });
    expect(Keys.signingKey('kid1')).toEqual({ PK: 'KEY#kid1', SK: 'META' });
    expect(Keys.auditEvent('2026-10-13T05:00:00Z', 'U')).toEqual({ PK: 'AUDIT#2026-10', SK: 'U' });
    expect(Keys.idempotencyRecord('sub-1', 'abc#1')).toEqual({ PK: 'IDEMP#sub-1#abc#1', SK: 'META' });
    expect(() => Keys.sessionResource(ENV, 'short')).toThrow();
    expect(() => Keys.reclaimPass(ENV, 10000)).toThrow();
    expect(() => Keys.stepResult(SID, 'a#b')).toThrow();
  });

  it('auditMonth is UTC', () => {
    expect(auditMonth('2026-10-31T23:59:59Z')).toBe('2026-10');
    expect(auditMonth(new Date(Date.UTC(2026, 0, 1)))).toBe('2026-01');
  });
});

describe('GSI1 (01 §7.2)', () => {
  it('builds the documented keys', () => {
    expect(Gsi1.learner('a@b.c')).toEqual({ GSI1PK: 'MEMBERS', GSI1SK: 'learner#a@b.c' });
    expect(Gsi1.member('assistant', 'a@b.c')).toEqual({ GSI1PK: 'MEMBERS', GSI1SK: 'assistant#a@b.c' });
    expect(Gsi1.labSession('sub-1', '2026-10-13T05:00:00Z', SID)).toEqual({
      GSI1PK: 'USER#sub-1',
      GSI1SK: `SESSION#2026-10-13T05:00:00Z#${SID}`,
    });
    expect(Gsi1.experimentRun('sub-1', 'cdn', 'edge-latency', 'T')).toEqual({ GSI1PK: 'USER#sub-1', GSI1SK: 'EXP#cdn#edge-latency#T' });
    expect(Gsi1.report('sub-1', 'T', SID)).toEqual({ GSI1PK: 'USER#sub-1', GSI1SK: `REPORT#T#${SID}` });
    expect(Gsi1.environment('T', ENV)).toEqual({ GSI1PK: 'ENVS', GSI1SK: `T#${ENV}` });
    expect(Gsi1.sessionResource(SID, 'T', RK)).toEqual({ GSI1PK: `SESRES#${SID}`, GSI1SK: `T#${RK}` });
    expect(Gsi1.certificate('sub-1', 'T', 'C')).toEqual({ GSI1PK: 'USER#sub-1', GSI1SK: 'CERT#T#C' });
    expect(Gsi1.signingKey('T')).toEqual({ GSI1PK: 'KEYS', GSI1SK: 'T' });
    expect(Gsi1.auditEvent(SID, 'U')).toEqual({ GSI1PK: `AUDIT#SESSION#${SID}`, GSI1SK: 'U' });
  });
});

describe('GSI2 (sparse, 01 §7.2)', () => {
  const base = { sid: SID, stateEnteredAt: '2026-10-13T05:00:00Z' };

  it('non-terminal sessions are indexed by state; deadlineAt while the countdown runs', () => {
    expect(Gsi2.labSession({ ...base, state: 'RUNNING', deadlineAt: '2026-10-13T07:00:00Z' })).toEqual({
      GSI2PK: 'STATE#RUNNING',
      GSI2SK: `2026-10-13T07:00:00Z#${SID}`,
    });
    expect(Gsi2.labSession({ ...base, state: 'CLEANING', deadlineAt: '2026-10-13T07:00:00Z' })).toEqual({
      GSI2PK: 'STATE#CLEANING',
      GSI2SK: `2026-10-13T05:00:00Z#${SID}`,
    });
    expect(Gsi2.labSession({ ...base, state: 'CLEANUP_FAILED' })?.GSI2PK).toBe('STATE#CLEANUP_FAILED');
  });

  it('terminal sessions are indexed only inside the rescan window', () => {
    expect(Gsi2.labSession({ ...base, state: 'ENDED', revokedAt: 'R', reclaim: { followUp: 'PENDING' } })).toEqual({
      GSI2PK: 'FOLLOWUP#PENDING',
      GSI2SK: `R#${SID}`,
    });
    expect(Gsi2.labSession({ ...base, state: 'ENDED', reclaim: { followUp: 'DONE' } })).toBeNull();
    expect(Gsi2.labSession({ ...base, state: 'FAILED' })).toBeNull();
  });

  it('manual confirmations, environments, ledger', () => {
    expect(Gsi2.manualConfirmation(true, 'T', SID)).toEqual({ GSI2PK: 'REVIEW#PENDING', GSI2SK: `T#${SID}` });
    expect(Gsi2.manualConfirmation(false, 'T', SID)).toBeNull();
    expect(Gsi2.environment('KEPT', ENV, 'C', 'K')).toEqual({ GSI2PK: 'ENVSTATE#KEPT', GSI2SK: `K#${ENV}` });
    expect(Gsi2.environment('ACTIVE', ENV, 'C')).toEqual({ GSI2PK: 'ENVSTATE#ACTIVE', GSI2SK: `C#${ENV}` });
    expect(Gsi2.environment('RELEASED', ENV, 'C')).toBeNull();
    expect(Gsi2.sessionResource('MANUAL_REQUIRED', ENV, RK)).toEqual({ GSI2PK: 'RES#MANUAL_REQUIRED', GSI2SK: `${ENV}#${RK}` });
    expect(Gsi2.sessionResource('DELETED', ENV, RK)).toBeNull();
    expect(Gsi2.sessionResource('TRACKED', ENV, RK)).toBeNull();
  });

  it('sweep partitions = 9 states + FOLLOWUP#PENDING (AP12); manual partitions (AP13)', () => {
    expect(SWEEP_GSI2_PARTITIONS).toHaveLength(10);
    expect(SWEEP_GSI2_PARTITIONS).toContain('STATE#KEPT');
    expect(SWEEP_GSI2_PARTITIONS).toContain('FOLLOWUP#PENDING');
    expect(SWEEP_GSI2_PARTITIONS).not.toContain('STATE#ENDED');
    expect(MANUAL_GSI2_PARTITIONS).toEqual(['RES#MANUAL_REQUIRED', 'RES#REVIEW', 'RES#FAILED']);
  });
});

describe('queries, TTL, resourceKey', () => {
  it('event range (AP5)', () => {
    expect(eventRange()).toEqual({ lowerExclusive: 'EVT#', upperInclusive: 'EVT#~' });
    expect(eventRange('01ABC')).toEqual({ lowerExclusive: 'EVT#01ABC', upperInclusive: 'EVT#~' });
    expect(SkPrefix.credentialChannel('ws')).toBe('CRED#ws#');
    expect(SkPrefix.quizForLab('svc-cdn')).toBe('QUIZ#svc-cdn#');
  });

  it('TTL is Unix seconds', () => {
    expect(ttlEpochSeconds('2026-10-13T00:00:00Z')).toBe(Date.UTC(2026, 9, 13) / 1000);
    expect(ttlAfterHours('2026-10-13T00:00:00Z', 24)).toBe(Date.UTC(2026, 9, 14) / 1000);
  });

  it('resourceKey = first 32 hex of SHA-256(region|ARN or type:id)', () => {
    const a = resourceKey('ap-northeast-1', { arn: 'arn:aws:s3:::bucket' });
    expect(a).toMatch(/^[0-9a-f]{32}$/);
    expect(resourceKey('ap-northeast-1', { arn: 'arn:aws:s3:::bucket' })).toBe(a);
    expect(resourceKey('us-east-1', { arn: 'arn:aws:s3:::bucket' })).not.toBe(a);
    expect(resourceKey('ap-northeast-1', { resourceType: 'AWS::EC2::KeyPair', id: 'cloudalbum-e1234567-key' })).toMatch(/^[0-9a-f]{32}$/);
    expect(Keys.sessionResource(ENV, a).SK).toBe(`RES#${a}`);
  });
});
