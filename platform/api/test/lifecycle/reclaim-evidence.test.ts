/**
 * Reclaim evidence (02 §7.2 rule 1, §7.3): create-or-overwrite writes (PutMetricAlarm, PutRule, Route 53 UPSERT,
 * Put*Config*, inspector2 Enable) are no creation evidence — such resources are listed for review, marked “possibly
 * pre-existing”, and never deleted automatically; the baseline inventory (Preflight's InventorySnapshot) keeps resources
 * that existed before the environment out of the ledger, whichever shape the snapshot has.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { ExecutionNames, Keys } from '@atl/shared';
import { createHarness, type Harness } from './support/harness.js';
import { extractRefs, parseTrailEvent } from '../../src/functions/reaper/reclaimer/extractors.js';
import { baselineKeys } from '../../src/functions/reaper/reclaimer/discovery.js';

let h: Harness;
afterEach(async () => {
  await h?.close();
});

const REGION = 'ap-northeast-1';
const ACCT = '000000000000';

async function readySession() {
  const r = await h.start();
  expect((await h.sim.waitFor(r.startArn)).status).toBe('SUCCEEDED');
  await h.lifecycle({ action: 'Heartbeat', sessionId: r.sid, workbench: true });
  return r.sid;
}

function learnerEvent(sid: string, o: { eventId: string; source: string; name: string; atMs: number; request: Record<string, unknown>; response?: Record<string, unknown>; region?: string }) {
  const at = new Date(o.atMs).toISOString();
  const region = o.region ?? REGION;
  h.trail.inject({
    eventId: o.eventId,
    eventName: o.name,
    eventTime: at,
    eventSource: `${o.source}.amazonaws.com`,
    region,
    username: `atl-${sid}-console`,
    readOnly: false,
    resources: [],
    cloudTrailEvent: JSON.stringify({
      eventID: o.eventId,
      eventName: o.name,
      eventSource: `${o.source}.amazonaws.com`,
      awsRegion: region,
      eventTime: at,
      userIdentity: { type: 'AssumedRole', arn: `arn:aws:sts::${ACCT}:assumed-role/ATLLearnerRole/atl-${sid}-console`, sessionContext: { sessionIssuer: { arn: `arn:aws:iam::${ACCT}:role/ATLLearnerRole` } } },
      requestParameters: o.request,
      responseElements: o.response ?? null,
    }),
  });
}

async function endAndWait(sid: string) {
  await h.lifecycle({ action: 'RequestEnd', sessionId: sid, disposition: 'destroy', when: 'now' });
  await h.waitExecution('atl-session-end', ExecutionNames.endFirst(sid));
  return h.session(sid);
}

describe('overwrite-style writes are no creation evidence (02 §7.2 rule 1, §7.3)', () => {
  it('extractor flags: PutMetricAlarm / PutRule / UPSERT / Put*Config* / inspector2 Enable overwrite, CREATE does not', () => {
    const ev = (source: string, name: string, request: Record<string, unknown>) =>
      parseTrailEvent({ eventId: 'e', eventName: name, eventTime: '2026-10-14T01:00:00Z', eventSource: `${source}.amazonaws.com`, region: REGION, cloudTrailEvent: JSON.stringify({ eventName: name, eventSource: `${source}.amazonaws.com`, requestParameters: request }) } as never);
    expect(extractRefs(ev('monitoring', 'PutMetricAlarm', { alarmName: 'a' }))).toEqual([expect.objectContaining({ type: 'AWS::CloudWatch::Alarm', id: 'a', overwrite: true })]);
    expect(extractRefs(ev('monitoring', 'PutDashboard', { dashboardName: 'd' }))![0]!.overwrite).toBe(true);
    expect(extractRefs(ev('events', 'PutRule', { name: 'r' }))![0]!.overwrite).toBe(true);
    expect(extractRefs(ev('config', 'PutConfigurationRecorder', { configurationRecorder: { name: 'default' } }))![0]!.overwrite).toBe(true);
    expect(extractRefs(ev('config', 'PutDeliveryChannel', { deliveryChannel: { name: 'default' } }))![0]!.overwrite).toBe(true);
    expect(extractRefs(ev('config', 'PutConfigRule', { configRule: { configRuleName: 'x' } }))![0]!.overwrite).toBe(true);
    expect(extractRefs(ev('inspector2', 'Enable', { resourceTypes: ['EC2'] }))![0]!.overwrite).toBe(true);
    const r53 = extractRefs(
      ev('route53', 'ChangeResourceRecordSets', {
        hostedZoneId: 'Z1',
        changeBatch: { changes: [{ action: 'CREATE', resourceRecordSet: { name: 'new.example.com.', type: 'A' } }, { action: 'UPSERT', resourceRecordSet: { name: 'www.example.com.', type: 'A' } }, { action: 'DELETE', resourceRecordSet: { name: 'old.example.com.', type: 'A' } }] },
      }),
    )!;
    expect(r53.map((r) => [r.id, r.overwrite === true])).toEqual([
      ['Z1|new.example.com.|A', false],
      ['Z1|www.example.com.|A', true],
    ]);
    expect(extractRefs(ev('sqs', 'CreateQueue', {}))).toEqual([]); // no queueUrl in the response → nothing
  });

  it('an alarm and a rule the learner overwrote are listed for review (possibly pre-existing) and are not deleted', async () => {
    h = await createHarness();
    const sid = await readySession();
    // the account owner's alarm and rule, existing before the session
    h.dev.reclaim.addResource({ type: 'AWS::CloudWatch::Alarm', region: REGION, id: 'billing-alarm' });
    h.dev.reclaim.addResource({ type: 'AWS::Events::Rule', region: REGION, id: 'default|nightly-backup' });
    // a queue the learner really created (control: deleted)
    h.dev.reclaim.addResource({ type: 'AWS::SQS::Queue', region: REGION, id: `https://sqs.${REGION}.amazonaws.com/${ACCT}/learner-queue` });
    const t = h.clock.nowMs() - 60_000;
    learnerEvent(sid, { eventId: 'ev-alarm', source: 'monitoring', name: 'PutMetricAlarm', atMs: t, request: { alarmName: 'billing-alarm', threshold: 5 } });
    learnerEvent(sid, { eventId: 'ev-rule', source: 'events', name: 'PutRule', atMs: t, request: { name: 'nightly-backup', scheduleExpression: 'rate(1 day)' }, response: { ruleArn: `arn:aws:events:${REGION}:${ACCT}:rule/nightly-backup` } });
    learnerEvent(sid, { eventId: 'ev-queue', source: 'sqs', name: 'CreateQueue', atMs: t, request: { queueName: 'learner-queue' }, response: { queueUrl: `https://sqs.${REGION}.amazonaws.com/${ACCT}/learner-queue` } });
    const s = await endAndWait(sid);
    // never deleted
    expect(h.dev.reclaim.has('AWS::CloudWatch::Alarm', REGION, 'billing-alarm')).toBe(true);
    expect(h.dev.reclaim.has('AWS::Events::Rule', REGION, 'default|nightly-backup')).toBe(true);
    expect(h.dev.reclaim.deleteCalls.map((c) => c.ref.id)).not.toEqual(expect.arrayContaining(['billing-alarm']));
    expect(h.dev.reclaim.deleteCalls.map((c) => c.ref.id)).not.toEqual(expect.arrayContaining(['default|nightly-backup']));
    expect(h.dev.reclaim.has('AWS::SQS::Queue', REGION, `https://sqs.${REGION}.amazonaws.com/${ACCT}/learner-queue`)).toBe(false);
    // listed for review with the “possibly pre-existing” note, without creation evidence
    const items = await h.query(`ENV#${s.envId}`, 'RES#');
    for (const id of ['billing-alarm', 'default|nightly-backup']) {
      const it = items.find((i) => i.id === id)!;
      expect(it, id).toMatchObject({ cleanupState: 'REVIEW', severity: 'REVIEW', discoveredBy: 'CLOUDTRAIL', eventId: null, meta: expect.objectContaining({ possiblyPreexisting: true }) });
      expect(String(it.lastError)).toContain('可能是会话前已存在的资源');
    }
  }, 30_000);
});

describe('baseline inventory (02 §3.5, §7.1 INVENTORY)', () => {
  it('reads both snapshot shapes: items [{ type, id, arn, region }] and resourceArns', () => {
    const snap = {
      region: REGION,
      items: [
        { type: 'AWS::EC2::Instance', id: 'i-0aaa', arn: `arn:aws:ec2:${REGION}:${ACCT}:instance/i-0aaa`, region: REGION },
        { type: 'AWS::EC2::Instance', id: 'i-0use1', region: 'us-east-1' },
      ],
      resourceArns: [`arn:aws:rds:${REGION}:${ACCT}:db:owner-db`, `arn:aws:elasticloadbalancing:${REGION}:${ACCT}:loadbalancer/app/owner-alb/123`],
    };
    const keys = baselineKeys(snap, REGION);
    expect(keys.has('AWS::EC2::Instance|i-0aaa')).toBe(true);
    expect(keys.has('AWS::EC2::Instance|i-0use1')).toBe(false);
    expect(keys.has('AWS::RDS::DBInstance|owner-db')).toBe(true);
    expect(keys.has(`arn:aws:elasticloadbalancing:${REGION}:${ACCT}:loadbalancer/app/owner-alb/123`)).toBe(true);
    expect(baselineKeys(snap, 'us-east-1').has('AWS::EC2::Instance|i-0use1')).toBe(true);
    expect(baselineKeys(null, REGION).size).toBe(0);
  });

  it('resources that existed before the environment never enter the ledger; a new unattributed one is REVIEW', async () => {
    h = await createHarness();
    const sid = await readySession();
    const envId = (await h.session(sid)).envId!;
    // what Preflight recorded (both shapes: the current writer, and ARNs only)
    const at = new Date(h.clock.nowMs()).toISOString();
    await h.deps.db.send(
      new (await import('@aws-sdk/lib-dynamodb')).PutCommand({
        TableName: h.env.tableName,
        Item: {
          ...Keys.inventorySnapshot(envId),
          type: 'InventorySnapshot',
          ver: 1,
          createdAt: at,
          updatedAt: at,
          envId,
          region: REGION,
          items: [{ type: 'AWS::EC2::Instance', id: 'i-0owner00000000001', arn: `arn:aws:ec2:${REGION}:${ACCT}:instance/i-0owner00000000001`, region: REGION }],
          resourceArns: [`arn:aws:rds:${REGION}:${ACCT}:db:owner-db`],
        },
      }),
    );
    h.dev.reclaim.addResource({ type: 'AWS::EC2::Instance', region: REGION, id: 'i-0owner00000000001', inventory: true });
    h.dev.reclaim.addResource({ type: 'AWS::RDS::DBInstance', region: REGION, id: 'owner-db', arn: `arn:aws:rds:${REGION}:${ACCT}:db:owner-db`, inventory: true });
    h.dev.reclaim.addResource({ type: 'AWS::EC2::NatGateway', region: REGION, id: 'nat-0appeared000001', inventory: true });
    const s = await endAndWait(sid);
    const items = await h.query(`ENV#${s.envId}`, 'RES#');
    expect(items.find((i) => i.id === 'i-0owner00000000001')).toBeUndefined();
    expect(items.find((i) => i.id === 'owner-db')).toBeUndefined();
    expect(items.find((i) => i.id === 'nat-0appeared000001')).toMatchObject({ discoveredBy: 'INVENTORY', cleanupState: 'REVIEW' });
    expect(h.dev.reclaim.has('AWS::EC2::Instance', REGION, 'i-0owner00000000001')).toBe(true);
    expect(h.dev.reclaim.has('AWS::RDS::DBInstance', REGION, 'owner-db')).toBe(true);
  }, 30_000);
});
