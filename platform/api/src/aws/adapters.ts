/**
 * Production implementations of the shared ports (01 §13 `platform/api/src/aws/`). Thin wrappers: they translate SDK
 * errors into `PortError` codes and nothing else. Behaviour that 07 still has to verify on real AWS (Scheduler `at()` in
 * the past, `.sync` cancellation, LookupEvents latency, KMS DIGEST) is noted where it matters.
 */
import { createHash, createPublicKey } from 'node:crypto';
import { CognitoJwtVerifier } from 'aws-jwt-verify';
import {
  atExpression,
  AtlError,
  COGNITO_GROUPS,
  derToP1363,
  encodeJsonArgs,
  isPortError,
  PortError,
  RUNNER_ENV,
  SCHEDULE_GROUPS,
  SWEEPER_SCHEDULE,
  type AuthPort,
  type ClockPort,
  type CognitoGroup,
  type CommandInvocation,
  type CommandInvocationStatus,
  type EcPublicJwkLike,
  type EventPublisherPort,
  type ExecutionDescription,
  type InvokerPort,
  type JwtPrincipal,
  type LambdaFunctionName,
  type ObjectStorePort,
  type OrchestratorPort,
  type RunCommandPort,
  type RunnerBuild,
  type RunnerBuildRequest,
  type RunnerBuildStatus,
  type RunnerPort,
  type ScheduleGroup,
  type SchedulerPort,
  type SignerPort,
  type StateMachineName,
  type TrailLookupPort,
  type TimerPayload,
} from '@atl/shared';
import type { PlatformEnv } from '../runtime/env.js';
import { aws, awsErrorName, isThrottle } from './clients.js';

function mapError(e: unknown, notFound: RegExp | null = /NotFound|DoesNotExist|NoSuchKey/): never {
  if (isPortError(e)) throw e;
  const name = awsErrorName(e);
  if (isThrottle(e)) throw new PortError('Throttled', name || 'throttled', { cause: e });
  if (/AccessDenied|UnauthorizedOperation|NotAuthorized/.test(name)) throw new PortError('AccessDenied', name, { cause: e });
  if (notFound?.test(name)) throw new PortError('NotFound', name, { cause: e });
  if (/ServiceUnavailable|InternalServer|InternalFailure/.test(name)) throw new PortError('Unavailable', name, { cause: e });
  throw e;
}

// ---------------------------------------------------------------------------------------------------------------

export class SystemClock implements ClockPort {
  now(): Date {
    return new Date();
  }
  nowMs(): number {
    return Date.now();
  }
  sleep(ms: number, signal?: AbortSignal): Promise<void> {
    return new Promise((resolve, reject) => {
      if (signal?.aborted) return reject(signal.reason);
      const t = setTimeout(() => {
        signal?.removeEventListener('abort', onAbort);
        resolve();
      }, ms);
      const onAbort = () => {
        clearTimeout(t);
        reject(signal!.reason);
      };
      signal?.addEventListener('abort', onAbort, { once: true });
    });
  }
  setTimer(ms: number, fn: () => void) {
    const t = setTimeout(fn, ms);
    return { cancel: () => clearTimeout(t) };
  }
}

// ---------------------------------------------------------------------------------------------------------------

export class SfnOrchestrator implements OrchestratorPort {
  constructor(private readonly env: PlatformEnv) {}

  executionArn(stateMachine: StateMachineName, name: string): string {
    return `arn:aws:states:${this.env.region}:${this.env.accountId}:execution:${stateMachine}:${name}`;
  }

  async startExecution(req: { stateMachine: StateMachineName; name: string; input: unknown }) {
    const { StartExecutionCommand } = await import('@aws-sdk/client-sfn');
    const c = await aws.sfn(this.env.region);
    try {
      const r = await c.send(
        new StartExecutionCommand({
          stateMachineArn: this.env.stateMachineArnPrefix + req.stateMachine,
          name: req.name,
          input: JSON.stringify(req.input ?? {}),
        }),
      );
      return { executionArn: r.executionArn!, startDate: (r.startDate ?? new Date()).toISOString() };
    } catch (e) {
      if (awsErrorName(e) === 'ExecutionAlreadyExists') throw new PortError('ExecutionAlreadyExists', `execution already exists: ${req.name}`, { cause: e });
      return mapError(e, /StateMachineDoesNotExist/);
    }
  }

  async describeExecution(executionArn: string): Promise<ExecutionDescription> {
    const { DescribeExecutionCommand } = await import('@aws-sdk/client-sfn');
    const c = await aws.sfn(this.env.region);
    try {
      const r = await c.send(new DescribeExecutionCommand({ executionArn }));
      const sm = r.stateMachineArn?.slice(r.stateMachineArn.lastIndexOf(':') + 1) as StateMachineName;
      return {
        executionArn,
        stateMachine: sm,
        name: r.name ?? '',
        status: (r.status ?? 'RUNNING') as ExecutionDescription['status'],
        input: r.input ? JSON.parse(r.input) : {},
        ...(r.output ? { output: JSON.parse(r.output) } : {}),
        ...(r.error ? { error: r.error } : {}),
        ...(r.cause ? { cause: r.cause } : {}),
        startDate: (r.startDate ?? new Date(0)).toISOString(),
        ...(r.stopDate ? { stopDate: r.stopDate.toISOString() } : {}),
      };
    } catch (e) {
      if (awsErrorName(e) === 'ExecutionDoesNotExist') throw new PortError('ExecutionDoesNotExist', executionArn, { cause: e });
      return mapError(e);
    }
  }

  async stopExecution(executionArn: string, opts: { error?: string; cause?: string } = {}) {
    const { StopExecutionCommand } = await import('@aws-sdk/client-sfn');
    const c = await aws.sfn(this.env.region);
    try {
      await c.send(new StopExecutionCommand({ executionArn, error: opts.error, cause: opts.cause }));
    } catch (e) {
      if (awsErrorName(e) === 'ExecutionDoesNotExist') throw new PortError('ExecutionDoesNotExist', executionArn, { cause: e });
      mapError(e);
    }
  }
}

// ---------------------------------------------------------------------------------------------------------------

const BUILD_STATUS: Readonly<Record<string, RunnerBuildStatus>> = {
  IN_PROGRESS: 'IN_PROGRESS',
  SUCCEEDED: 'SUCCEEDED',
  FAILED: 'FAILED',
  FAULT: 'FAULT',
  TIMED_OUT: 'TIMED_OUT',
  STOPPED: 'STOPPED',
};

/** `ATL_*` environment overrides of a runner build (01 §3.4). Region etc. are read by the buildspec from `Environment`. */
export function runnerEnvironment(req: RunnerBuildRequest, env: Pick<PlatformEnv, 'region'>, release: string): Record<string, string> {
  const vars: Record<string, string> = {
    [RUNNER_ENV.op]: req.op,
    [RUNNER_ENV.runId]: req.runId,
    [RUNNER_ENV.sessionId]: req.sessionId,
    [RUNNER_ENV.envId]: req.envId,
    [RUNNER_ENV.labId]: req.labId,
    [RUNNER_ENV.release]: release,
    [RUNNER_ENV.region]: env.region,
  };
  if (req.args !== undefined) vars[RUNNER_ENV.args] = encodeJsonArgs(req.args);
  if (req.profile) vars[RUNNER_ENV.profile] = req.profile;
  if (req.applyMode) vars[RUNNER_ENV.applyMode] = req.applyMode;
  if (req.repair !== undefined) vars[RUNNER_ENV.repair] = req.repair ? '1' : '0';
  return vars;
}

export class CodeBuildRunner implements RunnerPort {
  constructor(
    private readonly env: PlatformEnv,
    private readonly release: string = process.env.ATL_PLATFORM_VERSION ?? 'dev',
  ) {}

  async startBuild(req: RunnerBuildRequest): Promise<RunnerBuild> {
    const { StartBuildCommand } = await import('@aws-sdk/client-codebuild');
    const c = await aws.codebuild(this.env.region);
    try {
      const vars = runnerEnvironment(req, this.env, this.release);
      const r = await c.send(
        new StartBuildCommand({
          projectName: this.env.runnerProject,
          environmentVariablesOverride: Object.entries(vars).map(([name, value]) => ({ name, value, type: 'PLAINTEXT' })),
          ...(req.timeoutMinutes ? { timeoutInMinutesOverride: req.timeoutMinutes } : {}),
        }),
      );
      return this.toBuild(r.build ?? {}, req);
    } catch (e) {
      return mapError(e);
    }
  }

  async getBuild(buildId: string): Promise<RunnerBuild> {
    const { BatchGetBuildsCommand } = await import('@aws-sdk/client-codebuild');
    const c = await aws.codebuild(this.env.region);
    const r = await c.send(new BatchGetBuildsCommand({ ids: [buildId] })).catch((e: unknown) => mapError(e));
    const b = r.builds?.[0];
    if (!b) throw new PortError('NotFound', `build not found: ${buildId}`);
    const vars = Object.fromEntries((b.environment?.environmentVariables ?? []).map((v) => [v.name, v.value]));
    return this.toBuild(b, { op: vars[RUNNER_ENV.op] as RunnerBuildRequest['op'], runId: String(vars[RUNNER_ENV.runId] ?? '') });
  }

  async stopBuild(buildId: string): Promise<void> {
    const { StopBuildCommand } = await import('@aws-sdk/client-codebuild');
    const c = await aws.codebuild(this.env.region);
    await c.send(new StopBuildCommand({ id: buildId })).catch((e: unknown) => mapError(e));
  }

  private toBuild(
    b: { id?: string; buildStatus?: string; startTime?: Date; endTime?: Date; exportedEnvironmentVariables?: { name?: string; value?: string }[] },
    req: Pick<RunnerBuildRequest, 'op' | 'runId'>,
  ): RunnerBuild {
    const exit = b.exportedEnvironmentVariables?.find((v) => v.name === 'ATL_EXIT_CODE')?.value;
    return {
      buildId: b.id ?? '',
      runId: req.runId,
      op: req.op,
      status: BUILD_STATUS[b.buildStatus ?? 'IN_PROGRESS'] ?? 'FAILED',
      exitCode: exit === undefined ? null : Number(exit),
      startTime: (b.startTime ?? new Date()).toISOString(),
      ...(b.endTime ? { endTime: b.endTime.toISOString() } : {}),
      resultKey: `runs/${req.runId}/result.json`,
    };
  }
}

// ---------------------------------------------------------------------------------------------------------------

export class SsmRunCommand implements RunCommandPort {
  constructor(private readonly env: PlatformEnv) {}

  async sendCommand(req: Parameters<RunCommandPort['sendCommand']>[0]) {
    const { SendCommandCommand } = await import('@aws-sdk/client-ssm');
    const c = await aws.ssm(this.env.region);
    try {
      const r = await c.send(
        new SendCommandCommand({
          DocumentName: req.documentName,
          InstanceIds: req.instanceIds,
          Parameters: Object.fromEntries(Object.entries(req.parameters).map(([k, v]) => [k, [v]])),
          ...(req.timeoutSeconds ? { TimeoutSeconds: req.timeoutSeconds } : {}),
          ...(req.comment ? { Comment: req.comment.slice(0, 100) } : {}),
          ...(req.documentVersion ? { DocumentVersion: req.documentVersion } : {}),
          ...(req.documentHash ? { DocumentHash: req.documentHash, DocumentHashType: 'Sha256' as const } : {}),
        }),
      );
      return { commandId: r.Command!.CommandId! };
    } catch (e) {
      return mapError(e, /InvalidInstanceId|InvalidDocument/);
    }
  }

  async getInvocation(commandId: string, instanceId: string): Promise<CommandInvocation> {
    const { GetCommandInvocationCommand } = await import('@aws-sdk/client-ssm');
    const c = await aws.ssm(this.env.region);
    try {
      const r = await c.send(new GetCommandInvocationCommand({ CommandId: commandId, InstanceId: instanceId }));
      return {
        commandId,
        instanceId,
        status: (r.Status ?? 'Pending') as CommandInvocationStatus,
        responseCode: r.ResponseCode ?? null,
        stdout: r.StandardOutputContent ?? '',
        stderr: r.StandardErrorContent ?? '',
      };
    } catch (e) {
      return mapError(e, /InvocationDoesNotExist/);
    }
  }
}

// ---------------------------------------------------------------------------------------------------------------

export class EventBridgeScheduler implements SchedulerPort {
  constructor(private readonly env: PlatformEnv) {}

  private target(payload: TimerPayload) {
    if (!this.env.timerFunctionArn || !this.env.schedulerRoleArn) throw new PortError('InvalidInput', 'ATL_TIMER_FUNCTION_ARN / ATL_SCHEDULER_ROLE_ARN are not set');
    return {
      Arn: this.env.timerFunctionArn,
      RoleArn: this.env.schedulerRoleArn,
      Input: JSON.stringify(payload),
      ...(this.env.timerDlqArn ? { DeadLetterConfig: { Arn: this.env.timerDlqArn } } : {}),
      RetryPolicy: { MaximumRetryAttempts: 5, MaximumEventAgeInSeconds: 3600 },
    };
  }

  async createOneTime(req: Parameters<SchedulerPort['createOneTime']>[0]) {
    const { CreateScheduleCommand } = await import('@aws-sdk/client-scheduler');
    const c = await aws.scheduler(this.env.region);
    try {
      await c.send(
        new CreateScheduleCommand({
          Name: req.name,
          GroupName: req.group,
          ScheduleExpression: atExpression(req.at),
          ScheduleExpressionTimezone: 'UTC',
          FlexibleTimeWindow: { Mode: 'OFF' },
          ActionAfterCompletion: 'DELETE',
          Target: this.target(req.payload),
        }),
      );
      return { created: true };
    } catch (e) {
      if (awsErrorName(e) === 'ConflictException') return { created: false };
      return mapError(e);
    }
  }

  async delete(name: string, group: ScheduleGroup) {
    const { DeleteScheduleCommand } = await import('@aws-sdk/client-scheduler');
    const c = await aws.scheduler(this.env.region);
    try {
      await c.send(new DeleteScheduleCommand({ Name: name, GroupName: group }));
    } catch (e) {
      if (awsErrorName(e) === 'ResourceNotFoundException') return;
      mapError(e);
    }
  }

  async get(name: string, group: ScheduleGroup) {
    const { GetScheduleCommand } = await import('@aws-sdk/client-scheduler');
    const c = await aws.scheduler(this.env.region);
    try {
      const r = await c.send(new GetScheduleCommand({ Name: name, GroupName: group }));
      const at = /^at\((.+)\)$/.exec(r.ScheduleExpression ?? '')?.[1];
      return {
        name,
        group,
        state: (r.State ?? 'ENABLED') as 'ENABLED' | 'DISABLED',
        ...(at ? { at: `${at}Z` } : {}),
        ...(r.Target?.Input ? { payload: JSON.parse(r.Target.Input) as TimerPayload } : {}),
      };
    } catch (e) {
      if (awsErrorName(e) === 'ResourceNotFoundException') return null;
      return mapError(e);
    }
  }

  /** UpdateSchedule needs the full definition: GetSchedule first, then update with the new State (01 §3.5). */
  async setSweeperEnabled(enabled: boolean) {
    const { GetScheduleCommand, UpdateScheduleCommand } = await import('@aws-sdk/client-scheduler');
    const c = await aws.scheduler(this.env.region);
    const group: ScheduleGroup = SCHEDULE_GROUPS[1];
    const cur = await c.send(new GetScheduleCommand({ Name: SWEEPER_SCHEDULE, GroupName: group })).catch((e: unknown) => mapError(e, /ResourceNotFound/));
    if ((cur.State === 'ENABLED') === enabled) return;
    await c
      .send(
        new UpdateScheduleCommand({
          Name: SWEEPER_SCHEDULE,
          GroupName: group,
          ScheduleExpression: cur.ScheduleExpression!,
          ScheduleExpressionTimezone: cur.ScheduleExpressionTimezone,
          FlexibleTimeWindow: cur.FlexibleTimeWindow!,
          Target: cur.Target!,
          State: enabled ? 'ENABLED' : 'DISABLED',
          ...(cur.Description ? { Description: cur.Description } : {}),
        }),
      )
      .catch((e: unknown) => mapError(e));
  }
}

// ---------------------------------------------------------------------------------------------------------------

export class KmsSigner implements SignerPort {
  constructor(private readonly env: PlatformEnv) {}

  /** 04 §10.3: SHA-256 locally, `MessageType=DIGEST`, `ECDSA_SHA_256`, DER → P1363. */
  async sign(req: { keyId: string; message: Uint8Array }) {
    const { SignCommand } = await import('@aws-sdk/client-kms');
    const c = await aws.kms(this.env.region);
    const digest = createHash('sha256').update(req.message).digest();
    const r = await c
      .send(new SignCommand({ KeyId: req.keyId, Message: digest, MessageType: 'DIGEST', SigningAlgorithm: 'ECDSA_SHA_256' }))
      .catch((e: unknown) => mapError(e));
    if (!r.Signature || !r.KeyId) throw new PortError('Unavailable', 'KMS Sign returned no signature');
    if (!r.KeyId.endsWith(req.keyId)) throw new PortError('InvalidInput', `KMS signed with ${r.KeyId}, expected ${req.keyId}`);
    return { keyId: req.keyId, signature: derToP1363(r.Signature, 32) };
  }

  async getPublicKey(keyId: string) {
    const { GetPublicKeyCommand } = await import('@aws-sdk/client-kms');
    const c = await aws.kms(this.env.region);
    const r = await c.send(new GetPublicKeyCommand({ KeyId: keyId })).catch((e: unknown) => mapError(e));
    if (!r.PublicKey) throw new PortError('Unavailable', 'KMS GetPublicKey returned no key');
    const spkiDer = new Uint8Array(r.PublicKey);
    const jwk = createPublicKey({ key: Buffer.from(spkiDer), format: 'der', type: 'spki' }).export({ format: 'jwk' }) as EcPublicJwkLike;
    return { keyId, spkiDer, jwk: { kty: 'EC', crv: 'P-256', x: jwk.x, y: jwk.y } as EcPublicJwkLike };
  }
}

// ---------------------------------------------------------------------------------------------------------------

export class CloudTrailLookup implements TrailLookupPort {
  async lookupEvents(req: Parameters<TrailLookupPort['lookupEvents']>[0]) {
    const { LookupEventsCommand } = await import('@aws-sdk/client-cloudtrail');
    const c = await aws.cloudtrail(req.region);
    const r = await c
      .send(
        new LookupEventsCommand({
          LookupAttributes: [{ AttributeKey: req.attribute.key, AttributeValue: req.attribute.value }],
          StartTime: req.startTime,
          EndTime: req.endTime,
          ...(req.nextToken ? { NextToken: req.nextToken } : {}),
          ...(req.maxResults ? { MaxResults: req.maxResults } : {}),
        }),
      )
      .catch((e: unknown) => mapError(e));
    return {
      events: (r.Events ?? []).map((e) => ({
        eventId: e.EventId ?? '',
        eventName: e.EventName ?? '',
        eventTime: (e.EventTime ?? new Date(0)).toISOString(),
        eventSource: e.EventSource ?? '',
        region: req.region,
        ...(e.Username ? { username: e.Username } : {}),
        ...(e.ReadOnly ? { readOnly: e.ReadOnly === 'true' } : {}),
        ...(e.AccessKeyId ? { accessKeyId: e.AccessKeyId } : {}),
        resources: (e.Resources ?? []).map((x) => ({ resourceType: x.ResourceType, resourceName: x.ResourceName })),
        ...(e.CloudTrailEvent ? { cloudTrailEvent: e.CloudTrailEvent } : {}),
      })),
      ...(r.NextToken ? { nextToken: r.NextToken } : {}),
    };
  }
}

// ---------------------------------------------------------------------------------------------------------------

export class CognitoAuth implements AuthPort {
  private verifier: { verify(token: string): Promise<Record<string, unknown>> } | null = null;

  constructor(private readonly env: PlatformEnv) {}

  async verifyAccessToken(token: string): Promise<JwtPrincipal> {
    if (!this.env.userPoolId || !this.env.webClientId) throw new AtlError('UNAUTHENTICATED', 'user pool is not configured');
    this.verifier ??= CognitoJwtVerifier.create({ userPoolId: this.env.userPoolId, tokenUse: 'access', clientId: this.env.webClientId }) as unknown as {
      verify(token: string): Promise<Record<string, unknown>>;
    };
    let claims: Record<string, unknown>;
    try {
      claims = await this.verifier.verify(token);
    } catch {
      throw new AtlError('UNAUTHENTICATED', 'invalid or expired access token');
    }
    const groups = (Array.isArray(claims['cognito:groups']) ? claims['cognito:groups'] : []).filter((g): g is CognitoGroup =>
      (COGNITO_GROUPS as readonly string[]).includes(String(g)),
    );
    return {
      sub: String(claims.sub),
      username: String(claims.username ?? claims.sub),
      groups,
      authTime: Number(claims.auth_time ?? 0),
      ...(claims.client_id ? { clientId: String(claims.client_id) } : {}),
    };
  }
}

// ---------------------------------------------------------------------------------------------------------------

export class LambdaInvoker implements InvokerPort {
  constructor(private readonly env: PlatformEnv) {}

  async invoke<T = unknown>(fn: LambdaFunctionName, payload: unknown): Promise<T> {
    const { InvokeCommand } = await import('@aws-sdk/client-lambda');
    const c = await aws.lambda(this.env.region);
    const r = await c
      .send(new InvokeCommand({ FunctionName: fn, InvocationType: 'RequestResponse', Payload: Buffer.from(JSON.stringify(payload ?? null)) }))
      .catch((e: unknown) => mapError(e, /ResourceNotFound/));
    const text = r.Payload ? Buffer.from(r.Payload).toString('utf8') : 'null';
    const body = text ? (JSON.parse(text) as unknown) : null;
    if (r.FunctionError) {
      const err = new Error(String((body as { errorMessage?: string } | null)?.errorMessage ?? r.FunctionError));
      err.name = String((body as { errorType?: string } | null)?.errorType ?? 'Error');
      throw err;
    }
    return body as T;
  }

  async invokeAsync(fn: LambdaFunctionName, payload: unknown): Promise<void> {
    const { InvokeCommand } = await import('@aws-sdk/client-lambda');
    const c = await aws.lambda(this.env.region);
    await c
      .send(new InvokeCommand({ FunctionName: fn, InvocationType: 'Event', Payload: Buffer.from(JSON.stringify(payload ?? null)) }))
      .catch((e: unknown) => mapError(e, /ResourceNotFound/));
  }
}

// ---------------------------------------------------------------------------------------------------------------

export class EventBridgePublisher implements EventPublisherPort {
  constructor(private readonly env: PlatformEnv) {}

  async publish(events: Parameters<EventPublisherPort['publish']>[0]) {
    if (events.length === 0) return;
    const { PutEventsCommand } = await import('@aws-sdk/client-eventbridge');
    const c = await aws.eventbridge(this.env.region);
    for (let i = 0; i < events.length; i += 10) {
      const batch = events.slice(i, i + 10);
      const r = await c
        .send(
          new PutEventsCommand({
            Entries: batch.map((e) => ({ EventBusName: this.env.eventBusName, Source: e.source, DetailType: e.detailType, Detail: JSON.stringify(e.detail) })),
          }),
        )
        .catch((e: unknown) => mapError(e));
      if (r.FailedEntryCount) throw new PortError('Unavailable', `PutEvents: ${r.FailedEntryCount} entries failed`);
    }
  }
}

// ---------------------------------------------------------------------------------------------------------------

export class S3ObjectStore implements ObjectStorePort {
  constructor(private readonly env: PlatformEnv) {}

  async put(bucket: string, key: string, body: Uint8Array | string, opts: { contentType?: string } = {}) {
    const { PutObjectCommand } = await import('@aws-sdk/client-s3');
    const c = await aws.s3(this.env.region);
    await c.send(new PutObjectCommand({ Bucket: bucket, Key: key, Body: body, ContentType: opts.contentType })).catch((e: unknown) => mapError(e));
  }

  async get(bucket: string, key: string) {
    const { GetObjectCommand } = await import('@aws-sdk/client-s3');
    const c = await aws.s3(this.env.region);
    try {
      const r = await c.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
      return r.Body ? new Uint8Array(await r.Body.transformToByteArray()) : new Uint8Array();
    } catch (e) {
      if (/NoSuchKey|NotFound/.test(awsErrorName(e))) return null;
      return mapError(e);
    }
  }

  async delete(bucket: string, key: string) {
    const { DeleteObjectCommand } = await import('@aws-sdk/client-s3');
    const c = await aws.s3(this.env.region);
    await c.send(new DeleteObjectCommand({ Bucket: bucket, Key: key })).catch((e: unknown) => mapError(e));
  }

  async list(bucket: string, prefix: string) {
    const { ListObjectsV2Command } = await import('@aws-sdk/client-s3');
    const c = await aws.s3(this.env.region);
    const keys: string[] = [];
    let token: string | undefined;
    do {
      const r = await c
        .send(new ListObjectsV2Command({ Bucket: bucket, Prefix: prefix, ContinuationToken: token }))
        .catch((e: unknown) => mapError(e));
      for (const o of r.Contents ?? []) if (o.Key) keys.push(o.Key);
      token = r.IsTruncated ? r.NextContinuationToken : undefined;
    } while (token);
    return keys;
  }

  async presign(bucket: string, key: string, opts: { method: 'GET' | 'PUT'; expiresInSeconds: number }) {
    const [{ GetObjectCommand, PutObjectCommand }, { getSignedUrl }] = await Promise.all([
      import('@aws-sdk/client-s3'),
      import('@aws-sdk/s3-request-presigner'),
    ]);
    const c = await aws.s3(this.env.region);
    const cmd = opts.method === 'GET' ? new GetObjectCommand({ Bucket: bucket, Key: key }) : new PutObjectCommand({ Bucket: bucket, Key: key });
    return getSignedUrl(c, cmd, { expiresIn: opts.expiresInSeconds });
  }
}
