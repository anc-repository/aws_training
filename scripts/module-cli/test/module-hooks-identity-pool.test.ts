// wave1-identity-pool: module hook of identity-pool (module-hooks/identity-pool.ts) — auth injects, developer provider,
// platform preview origin in the staging bucket CORS, emptying the staging bucket before the stack deletion.
// Dry-run / scripted gateways only (no AWS call is executed).
import { describe, expect, it } from 'vitest';
import type { AwsCall, AwsGateway } from '../src/aws.js';
import type { Ctx } from '../src/context.js';
import { disableCommand } from '../src/disable.js';
import { enableCommand } from '../src/enable.js';
import type { PlanStep } from '../src/deps.js';
import type { HookArgs } from '../src/module-hooks/index.js';
import { emptyStagingBucket, identityPoolHook, previewOrigin, unionOrigins } from '../src/module-hooks/identity-pool.js';
import { deployedState, dryContext } from './helpers.js';

const step: PlanStep = { module: 'identity-pool', value: 'aws', tier: 'aws', settings: {}, reason: 'requested', isTarget: true };
const args = (params: Record<string, string> = {}): HookArgs => ({ params, planOnly: false, isTarget: true });

function stackParams(calls: Array<{ op: string; input: Record<string, unknown> }>, stack: string): Record<string, string> {
  const deploy = calls.find((c) => c.op === 'CreateOrUpdateStack' && c.input.StackName === stack)!;
  return Object.fromEntries((deploy.input.Parameters as Array<{ ParameterKey: string; ParameterValue: string }>).map((p) => [p.ParameterKey, p.ParameterValue]));
}

describe('identity-pool hook', () => {
  it('enable --with-deps (dry-run): iam, auth, storage first; UserPoolId / UserPoolClientId from the auth injects; env from the outputs', async () => {
    const { ctx, out, aws } = dryContext();
    expect(await enableCommand(ctx, 'identity-pool', { withDeps: true, migrate: false })).toBe(0);
    expect(Object.keys(ctx.state.modules)).toEqual(['iam', 'auth', 'storage', 'identity-pool']);
    const p = stackParams(aws.calls, 'cloudalbum-lab-identity-pool');
    expect(p).toMatchObject({
      UserPoolId: '<cloudalbum-lab-auth:InfoUserPoolId>', UserPoolClientId: '<cloudalbum-lab-auth:EnvCognitoClientId>',
      AppOrigins: 'http://203.0.113.10', KmsKeyArn: '',
    });
    expect(p.DeveloperProviderName).toBeUndefined();
    expect(ctx.state.modules['identity-pool']?.env).toMatchObject({
      MODULE_IDENTITY_POOL: 'on', IDENTITY_UPLOAD_PREFIX: 'private/', IDENTITY_DEV_PROVIDER: '',
    });
    expect(Object.keys(ctx.state.modules['identity-pool']!.env).sort()).toEqual([
      'IDENTITY_DEV_PROVIDER', 'IDENTITY_POOL_ID', 'IDENTITY_STAGING_BUCKET', 'IDENTITY_UPLOAD_PREFIX', 'MODULE_IDENTITY_POOL', 'MODULE_IDENTITY_POOL_VERSION',
    ]);
    expect(out.text()).toContain('DEP-030 (warn)');
    expect(out.text()).toContain('identity-pool=cognito:sts');
    expect(aws.calls.some((c) => c.op === 'AttachRolePolicy' && String(c.input.PolicyArn).includes('identity-pool'))).toBe(true);
  });

  it('without iam / storage / auth: CRED-001 and both DEP-002 needs, exit 2 before anything is deployed', async () => {
    const { ctx, out, aws } = dryContext();
    expect(await enableCommand(ctx, 'identity-pool', { migrate: false })).toBe(2);
    expect(out.text()).toContain('DEP-002: identity-pool needs STORAGE_DRIVER=s3');
    expect(out.text()).toContain('DEP-002: identity-pool needs AUTH_DRIVER=cognito');
    expect(aws.calls.some((c) => c.op === 'CreateOrUpdateStack')).toBe(false);
  });

  it('--param DeveloperProviderName: auth=local is accepted (IDENTITY_DEV_PROVIDER in the plan); an invalid name is refused', async () => {
    const { ctx, aws } = dryContext();
    expect(await enableCommand(ctx, 'identity-pool', { withDeps: true, migrate: false, param: ['DeveloperProviderName=login.cloudalbum'] })).toBe(0);
    expect(Object.keys(ctx.state.modules)).toEqual(['iam', 'storage', 'identity-pool']);
    expect(stackParams(aws.calls, 'cloudalbum-lab-identity-pool')).toMatchObject({ DeveloperProviderName: 'login.cloudalbum', UserPoolId: '' });
    expect(ctx.state.modules['identity-pool']?.env.IDENTITY_DEV_PROVIDER).toBe('login.cloudalbum');
    expect(() => identityPoolHook.plan!(ctx, step, args({ DeveloperProviderName: 'bad name!' }))).toThrow(/DeveloperProviderName/);
  });

  it('platform preview scheme B on: the staging bucket CORS also allows https://<EIP>', async () => {
    const state = deployedState();
    state.platform = { envId: 'e7k2m9qx', platformTags: {}, sessionChain: [], pendingHooks: [], seeds: {}, preview: { directHttps: 'on', status: 'issued', ip: '203.0.113.10' } };
    const { ctx, aws } = dryContext(state);
    expect(await enableCommand(ctx, 'identity-pool', { withDeps: true, migrate: false })).toBe(0);
    expect(stackParams(aws.calls, 'cloudalbum-lab-identity-pool').AppOrigins).toBe('http://203.0.113.10,https://203.0.113.10');
    // wave1-integration: the generic injection (ops.ts injectedParams) adds the preview origin to every browser-facing CORS list
    expect(stackParams(aws.calls, 'cloudalbum-lab-storage').AppOrigins).toBe('http://203.0.113.10,https://203.0.113.10');
    state.platform.preview = { directHttps: 'on', status: 'failed', reason: 'x' };
    expect(previewOrigin(ctx)).toBeNull();
    expect(unionOrigins('a,b', 'b, c', undefined, '')).toBe('a,b,c');
  });

  it('disable (dry-run): the staging bucket is emptied (multipart uploads, objects) before the stack is deleted', async () => {
    const { ctx, out, aws } = dryContext();
    expect(await enableCommand(ctx, 'identity-pool', { withDeps: true, migrate: false })).toBe(0);
    const before = aws.calls.length;
    expect(await disableCommand(ctx, 'identity-pool', {})).toBe(0);
    const ops = aws.calls.slice(before).map((c) => c.op);
    expect(ops.indexOf('ListMultipartUploads')).toBeGreaterThanOrEqual(0);
    expect(ops.indexOf('ListObjectsV2')).toBeGreaterThan(ops.indexOf('ListMultipartUploads'));
    expect(ops.indexOf('DeleteStack')).toBeGreaterThan(ops.indexOf('ListObjectsV2'));
    expect(out.text()).toContain('users.identity_id is kept');
    expect(ctx.state.modules['identity-pool']).toBeUndefined();
  });

  it('emptyStagingBucket: aborts every unfinished multipart upload and deletes every object page by page', async () => {
    const calls: AwsCall[] = [];
    const pages: Record<string, unknown[]> = {
      ListMultipartUploads: [
        { Uploads: [{ Key: 'private/a/1.jpg', UploadId: 'u1' }], IsTruncated: true, NextKeyMarker: 'private/a/1.jpg', NextUploadIdMarker: 'u1' },
        { Uploads: [{ Key: 'private/b/2.jpg', UploadId: 'u2' }], IsTruncated: false },
      ],
      ListObjectsV2: [
        { Contents: [{ Key: 'private/a/1.jpg' }, { Key: 'private/a/3.jpg' }], IsTruncated: true, NextContinuationToken: 't2' },
        { Contents: [{ Key: 'private/b/4.jpg' }], IsTruncated: false },
      ],
    };
    const gateway: AwsGateway = {
      dryRun: false,
      async send<T>(call: AwsCall) {
        calls.push(call);
        const q = pages[call.op];
        return (q?.shift() ?? {}) as T;
      },
    };
    const r = await emptyStagingBucket({ aws: gateway } as unknown as Ctx, 'cloudalbum-lab-upload-staging-123456789012', 'ap-northeast-1');
    expect(r).toEqual({ aborted: 2, deleted: 3 });
    expect(calls.filter((c) => c.op === 'AbortMultipartUpload').map((c) => c.input.UploadId)).toEqual(['u1', 'u2']);
    expect(calls.find((c) => c.op === 'ListMultipartUploads' && c.input.KeyMarker)?.input).toMatchObject({ KeyMarker: 'private/a/1.jpg', UploadIdMarker: 'u1' });
    expect(calls.filter((c) => c.op === 'DeleteObjects').map((c) => (c.input.Delete as { Objects: unknown[] }).Objects.length)).toEqual([2, 1]);
    expect(calls.find((c) => c.op === 'ListObjectsV2' && c.input.ContinuationToken)?.input.ContinuationToken).toBe('t2');
  });
});
