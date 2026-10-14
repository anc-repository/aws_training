/**
 * scripts/module hook of identity-pool (wave1-identity-pool). Contract: ./types.ts.
 * Design: docs/modules/02-identity-security.md#identity-pool (section 6 "切换、数据迁移与回滚", section 0 registry entry, section 12 platform mode).
 *
 * What this module needs beyond the generic flow:
 *   - parameter switch: IDENTITY_POOL_ID comes from the stack output EnvIdentityPoolId; UserPoolId / UserPoolClientId arrive
 *     through the auth injects (never ImportValue), KmsKeyArn through the kms injects, AppOrigins through the generic
 *     "+" list (http://<EIP>, then dns / cdn / load-balancer).
 *   - --param DeveloperProviderName=login.cloudalbum (optional): developer authenticated identities for auth=local. The hook
 *     writes IDENTITY_DEV_PROVIDER into the planned settings, so DEP-002 accepts auth=local; validated here.
 *   - platform preview scheme B (06 PM-21): the browser runs on https://<EIP>, so that origin is added to the staging bucket
 *     CORS (AppOrigins) when state.platform.preview is on; later inject updates (dns / cdn / load-balancer) recompute the list.
 *   - DEP-030 (warn): APP_BASE_URL http:// -> the STS credentials travel in clear text; printed as a note (not a blocker).
 *   - disable: empty the staging bucket and abort unfinished multipart uploads BEFORE the stack is deleted (CloudFormation
 *     cannot delete a non-empty bucket); users.identity_id stays (re-enabling reuses it).
 * Platform mode: no out-of-band resources; emptying the staging bucket is an S3 data-plane call on a bucket of this session.
 */
import type { Ctx } from '../context.js';
import type { EnvMap } from '../env-file.js';
import { CliError, EXIT } from '../printer.js';
import { currentEnv } from '../state.js';
import type { ModuleRecord } from '../state.js';
import type { HookArgs, ModuleHook } from './types.js';

const DEV_PROVIDER_RE = /^[\w._-]{1,128}$/;
/** S3 DeleteObjects accepts at most 1000 keys per call */
const DELETE_BATCH = 1000;
/** safety stop for the emptying loop (pages of 1000) */
const MAX_PAGES = 1000;

/** https://<EIP> of the platform preview scheme B, when it is on (issued or being issued) */
export function previewOrigin(ctx: Ctx): string | null {
  const p = ctx.state.platform?.preview;
  if (!p || p.directHttps !== 'on' || p.status === 'off' || p.status === 'failed') return null;
  const ip = p.ip ?? ctx.state.base?.publicIp;
  return ip ? `https://${ip}` : null;
}

/** union of comma-separated origin lists, order kept, empty items dropped */
export function unionOrigins(...lists: Array<string | undefined>): string {
  const out: string[] = [];
  for (const l of lists) for (const o of (l ?? '').split(',').map((x) => x.trim()).filter(Boolean)) if (!out.includes(o)) out.push(o);
  return out.join(',');
}

function stagingBucketOf(ctx: Ctx, rec: ModuleRecord): string {
  return rec.env.IDENTITY_STAGING_BUCKET || rec.outputs.EnvIdentityStagingBucket || ctx.ph(undefined, 'identity-pool:EnvIdentityStagingBucket');
}

/** Abort every unfinished multipart upload, then delete every object (the bucket is not versioned). Dry-run: prints the calls. */
export async function emptyStagingBucket(ctx: Ctx, bucket: string, region: string): Promise<{ aborted: number; deleted: number }> {
  let aborted = 0;
  let deleted = 0;
  let keyMarker: string | undefined;
  let uploadIdMarker: string | undefined;
  for (let page = 0; page < MAX_PAGES; page += 1) {
    const r = await ctx.aws.send<{ Uploads?: Array<{ Key?: string; UploadId?: string }>; IsTruncated?: boolean; NextKeyMarker?: string; NextUploadIdMarker?: string }>({
      service: 's3', op: 'ListMultipartUploads', region,
      input: { Bucket: bucket, ...(keyMarker ? { KeyMarker: keyMarker } : {}), ...(uploadIdMarker ? { UploadIdMarker: uploadIdMarker } : {}) },
    });
    for (const u of r?.Uploads ?? []) {
      if (!u.Key || !u.UploadId) continue;
      await ctx.aws.send({ service: 's3', op: 'AbortMultipartUpload', region, input: { Bucket: bucket, Key: u.Key, UploadId: u.UploadId } });
      aborted += 1;
    }
    if (!r?.IsTruncated) break;
    keyMarker = r.NextKeyMarker;
    uploadIdMarker = r.NextUploadIdMarker;
  }
  let token: string | undefined;
  for (let page = 0; page < MAX_PAGES; page += 1) {
    const r = await ctx.aws.send<{ Contents?: Array<{ Key?: string }>; IsTruncated?: boolean; NextContinuationToken?: string }>({
      service: 's3', op: 'ListObjectsV2', region, input: { Bucket: bucket, MaxKeys: DELETE_BATCH, ...(token ? { ContinuationToken: token } : {}) },
    });
    const keys = (r?.Contents ?? []).map((o) => o.Key).filter((k): k is string => Boolean(k));
    if (keys.length) {
      await ctx.aws.send({ service: 's3', op: 'DeleteObjects', region, input: { Bucket: bucket, Delete: { Objects: keys.map((Key) => ({ Key })), Quiet: true } } });
      deleted += keys.length;
    }
    if (!r?.IsTruncated) break;
    token = r.NextContinuationToken;
  }
  return { aborted, deleted };
}

function devProviderOf(args: HookArgs): string {
  const v = (args.params.DeveloperProviderName ?? '').trim();
  if (v && !DEV_PROVIDER_RE.test(v)) {
    throw new CliError(`identity-pool: DeveloperProviderName=${v} is invalid (letters, digits, . _ -; up to 128 characters, e.g. login.cloudalbum)`, EXIT.rules, 'BAD_PARAM');
  }
  return v;
}

export const identityPoolHook: ModuleHook = {
  id: 'identity-pool',

  plan(ctx, step, args) {
    if (step.tier !== 'aws' || !args.isTarget) return {};
    const notes: string[] = [];
    const settings: EnvMap = {};
    const dev = devProviderOf(args);
    const env = currentEnv(ctx.state);
    if (dev) {
      settings.IDENTITY_DEV_PROVIDER = dev;
      notes.push(`developer authenticated identities (${dev}): the API exchanges the local user id with GetOpenIdTokenForDeveloperIdentity (needs AWS credentials)`);
    } else {
      notes.push('User Pool identities: UserPoolId / UserPoolClientId come from the auth stack (registry injects); auth must be cognito (DEP-002)');
    }
    const base = env.APP_BASE_URL ?? '';
    if (!base || base.startsWith('http://')) {
      notes.push('DEP-030 (warn): APP_BASE_URL is http:// - /api/uploads/credentials hands out STS credentials in clear text; identity-pool stays degraded '
        + 'until tls or cdn gives an https entry (platform preview scheme B: https://<EIP>)');
    }
    notes.push('after the restart F14 switches from the prefix token (identity-pool=none:token) to STS credentials (identity-pool=cognito:sts); '
      + 'F6 single-file uploads are unchanged');
    return { settings, notes };
  },

  async prepare(ctx, step, args, p) {
    if (step.tier !== 'aws' || !args.isTarget) return;
    const origin = previewOrigin(ctx);
    if (origin && args.params.AppOrigins === undefined) {
      // the generic injection gives http://<EIP> (+ dns / cdn / load-balancer entries); keep it and add the preview origin
      const { injectedParams, mergedEnv } = await import('../ops.js');
      const injected = injectedParams(ctx, 'identity-pool', ctx.state.modules, mergedEnv(ctx.state, ctx.state.modules)).AppOrigins;
      p.params.AppOrigins = unionOrigins(injected, origin);
      p.notes.push(`identity-pool: staging bucket CORS also allows the platform preview origin ${origin}`);
    }
    if (!args.params.DeveloperProviderName && ctx.state.modules['identity-pool']?.params.DeveloperProviderName) {
      p.params.DeveloperProviderName = ctx.state.modules['identity-pool'].params.DeveloperProviderName;   // re-enable keeps it
    }
  },

  afterDeploy(ctx, _step, _args, deployed) {
    const o = deployed.outputs;
    ctx.out.info(`      identity-pool: identity pool ${o.EnvIdentityPoolId ?? '<EnvIdentityPoolId>'}; uploader role ${o.InfoUploaderRoleName ?? '<InfoUploaderRoleName>'}; `
      + `staging bucket ${o.EnvIdentityStagingBucket ?? '<EnvIdentityStagingBucket>'} (CORS exposes ETag, 1-day expiration, no event notifications)`);
    ctx.out.info(`      identity-pool: uploader resource ${o.InfoUploaderResource ?? 'arn:aws:s3:::<bucket>/private/${cognito-identity.amazonaws.com:sub}/*'}`);
  },

  async beforeDisable(ctx, rec) {
    const bucket = stagingBucketOf(ctx, rec);
    const region = rec.stacks[0]?.region ?? ctx.region;
    ctx.out.info(`      identity-pool: emptying the staging bucket ${bucket} (abort unfinished multipart uploads, delete objects) before the stack is deleted`);
    const r = await emptyStagingBucket(ctx, bucket, region);
    if (!ctx.dryRun) ctx.out.info(`      identity-pool: ${r.aborted} multipart upload(s) aborted, ${r.deleted} object(s) deleted`);
    return {
      notes: [
        'F14 falls back to the prefix token (identity-pool=none:token) after the restart; photos already imported into the storage bucket stay readable (no data migration)',
        'users.identity_id is kept but bound to this identity pool (stored as <IdentityPoolId>|<identityId>): the pool is deleted with the stack, so a later enable creates a new pool and every user gets a new identity on the first credentials exchange (old values are ignored, no manual cleanup needed)',
        'if an upload lands in the staging bucket between this step and the stack deletion, the deletion fails: run `scripts/module disable identity-pool` again',
      ],
    };
  },

  afterDisable(ctx) {
    ctx.out.info('      identity-pool: identity pool, uploader role and staging bucket deleted with the stack; STS credentials already handed out stop working with the role');
  },
};
