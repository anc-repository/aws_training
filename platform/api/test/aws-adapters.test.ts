/**
 * Production adapters against mocked SDK clients (aws-sdk-client-mock) — no network, no credentials.
 */
import { generateKeyPairSync, sign as nodeSign, verify as nodeVerify } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import { mockClient } from 'aws-sdk-client-mock';
import { SFNClient, StartExecutionCommand } from '@aws-sdk/client-sfn';
import { CreateScheduleCommand, GetScheduleCommand, SchedulerClient } from '@aws-sdk/client-scheduler';
import { KMSClient, SignCommand } from '@aws-sdk/client-kms';
import { CodeBuildClient, StartBuildCommand } from '@aws-sdk/client-codebuild';
import { decodeJsonArgs } from '@atl/shared';
import { CodeBuildRunner, EventBridgeScheduler, KmsSigner, SfnOrchestrator } from '../src/aws/adapters.js';
import { loadPlatformEnv } from '../src/runtime/env.js';

const env = {
  ...loadPlatformEnv({ AWS_REGION: 'ap-northeast-1', ATL_ACCOUNT_ID: '111122223333' }),
  timerFunctionArn: 'arn:aws:lambda:ap-northeast-1:111122223333:function:atl-timer',
  schedulerRoleArn: 'arn:aws:iam::111122223333:role/ATLSchedulerRole',
  timerDlqArn: 'arn:aws:sqs:ap-northeast-1:111122223333:atl-timer-dlq',
};

const mocks: { restore(): void }[] = [];
afterEach(() => mocks.splice(0).forEach((m) => m.restore()));

function named(name: string): Error {
  return Object.assign(new Error(name), { name });
}

describe('SfnOrchestrator', () => {
  it('starts executions by name and maps ExecutionAlreadyExists to a PortError', async () => {
    const sfn = mockClient(SFNClient);
    mocks.push(sfn);
    sfn.on(StartExecutionCommand).resolvesOnce({ executionArn: 'arn:x', startDate: new Date(0) }).rejectsOnce(named('ExecutionAlreadyExists'));
    const o = new SfnOrchestrator(env);
    expect(await o.startExecution({ stateMachine: 'atl-session-end', name: 'end-s4k7m2q9x1abc-1', input: { a: 1 } })).toEqual({
      executionArn: 'arn:x',
      startDate: new Date(0).toISOString(),
    });
    expect(sfn.commandCalls(StartExecutionCommand)[0]!.args[0].input).toEqual({
      stateMachineArn: 'arn:aws:states:ap-northeast-1:111122223333:stateMachine:atl-session-end',
      name: 'end-s4k7m2q9x1abc-1',
      input: '{"a":1}',
    });
    await expect(o.startExecution({ stateMachine: 'atl-session-end', name: 'end-s4k7m2q9x1abc-1', input: {} })).rejects.toMatchObject({
      code: 'ExecutionAlreadyExists',
    });
    expect(o.executionArn('atl-session-start', 'start-s4k7m2q9x1abc')).toBe(
      'arn:aws:states:ap-northeast-1:111122223333:execution:atl-session-start:start-s4k7m2q9x1abc',
    );
  });
});

describe('EventBridgeScheduler', () => {
  it('creates at() schedules with DELETE after completion and treats ConflictException as already created', async () => {
    const sch = mockClient(SchedulerClient);
    mocks.push(sch);
    sch.on(CreateScheduleCommand).resolvesOnce({}).rejectsOnce(named('ConflictException'));
    sch.on(GetScheduleCommand).rejects(named('ResourceNotFoundException'));
    const s = new EventBridgeScheduler(env);
    const req = {
      name: 'atl-s4k7m2q9x1abc-exp-v1',
      group: 'atl-sessions' as const,
      at: new Date('2026-10-13T07:00:00Z'),
      payload: { kind: 'EXPIRE' as const, sessionId: 's4k7m2q9x1abc', deadlineVersion: 1 },
    };
    expect(await s.createOneTime(req)).toEqual({ created: true });
    expect(await s.createOneTime(req)).toEqual({ created: false });
    const input = sch.commandCalls(CreateScheduleCommand)[0]!.args[0].input;
    expect(input).toMatchObject({
      Name: 'atl-s4k7m2q9x1abc-exp-v1',
      GroupName: 'atl-sessions',
      ScheduleExpression: 'at(2026-10-13T07:00:00)',
      ScheduleExpressionTimezone: 'UTC',
      ActionAfterCompletion: 'DELETE',
      FlexibleTimeWindow: { Mode: 'OFF' },
      Target: { Arn: env.timerFunctionArn, RoleArn: env.schedulerRoleArn, DeadLetterConfig: { Arn: env.timerDlqArn } },
    });
    expect(JSON.parse(input.Target!.Input!)).toEqual(req.payload);
    expect(await s.get('missing', 'atl-sessions')).toBeNull();
  });
});

describe('KmsSigner', () => {
  it('signs the SHA-256 digest (MessageType=DIGEST) and converts DER to P1363', async () => {
    const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
    const kms = mockClient(KMSClient);
    mocks.push(kms);
    const message = new TextEncoder().encode('header.payload');
    kms.on(SignCommand).callsFake(async (input: { Message: Uint8Array; KeyId: string }) => {
      // KMS signs the given digest; emulate with node's sign over the original message (same ECDSA input)
      expect(input.Message).toHaveLength(32);
      return { KeyId: `arn:aws:kms:ap-northeast-1:111122223333:key/${input.KeyId}`, Signature: nodeSign('sha256', message, { key: privateKey, dsaEncoding: 'der' }) };
    });
    const r = await new KmsSigner(env).sign({ keyId: 'k-123', message });
    expect(kms.commandCalls(SignCommand)[0]!.args[0].input).toMatchObject({ KeyId: 'k-123', MessageType: 'DIGEST', SigningAlgorithm: 'ECDSA_SHA_256' });
    expect(r.signature).toHaveLength(64);
    expect(nodeVerify('sha256', message, { key: publicKey, dsaEncoding: 'ieee-p1363' }, r.signature)).toBe(true);
  });
});

describe('CodeBuildRunner', () => {
  it('passes the ATL_* variables (01 §3.4) with base64url ATL_ARGS', async () => {
    const cb = mockClient(CodeBuildClient);
    mocks.push(cb);
    cb.on(StartBuildCommand).resolves({ build: { id: 'atl-runner:1', buildStatus: 'IN_PROGRESS', startTime: new Date(0) } });
    const b = await new CodeBuildRunner(env, '1.2.3').startBuild({
      op: 'module-op',
      runId: 's4k7m2q9x1abc-modop-1',
      sessionId: 's4k7m2q9x1abc',
      envId: '01jc9x3k9cq4m2x8n5b6c0d1e2',
      labId: 'svc-iam',
      args: { actionId: 'iam-revoke-sessions' },
      timeoutMinutes: 30,
    });
    expect(b).toMatchObject({ buildId: 'atl-runner:1', status: 'IN_PROGRESS', resultKey: 'runs/s4k7m2q9x1abc-modop-1/result.json' });
    const input = cb.commandCalls(StartBuildCommand)[0]!.args[0].input;
    expect(input.projectName).toBe('atl-runner');
    expect(input.timeoutInMinutesOverride).toBe(30);
    const vars = Object.fromEntries(input.environmentVariablesOverride!.map((v) => [v.name, v.value]));
    expect(vars).toMatchObject({ ATL_OP: 'module-op', ATL_RUN_ID: 's4k7m2q9x1abc-modop-1', ATL_RELEASE: '1.2.3', ATL_REGION: 'ap-northeast-1' });
    expect(decodeJsonArgs(vars.ATL_ARGS!)).toEqual({ actionId: 'iam-revoke-sessions' });
  });
});
