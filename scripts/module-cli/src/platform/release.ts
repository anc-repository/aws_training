/**
 * Release archive in platform mode (06 PM-30):
 *   bootstrap --platform --release-file <cloudalbum-<ver>-<arch>.tgz>  uploads it to the toolchain bucket releases/<ver>/<arch>.tgz
 *   base deploy --platform                                            AppArchiveUrl = presigned HTTPS GET URL of that object
 *     (validity = min(3600 s, remaining lifetime of the caller credentials)); later stack updates use UsePreviousValue, so the
 *     User Data never changes; instance replacements generate a new URL.
 */
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import type { Ctx } from '../context.js';
import { CliError, EXIT } from '../printer.js';
import { nowIso } from '../state.js';

const RELEASE_RE = /^cloudalbum-([A-Za-z0-9._-]+)-(arm64|x86_64)\.tgz$/;

export function parseReleaseName(file: string): { version: string; arch: 'arm64' | 'x86_64' } {
  const m = RELEASE_RE.exec(path.basename(file));
  if (!m) throw new CliError(`--release-file must be named cloudalbum-<version>-<arm64|x86_64>.tgz (scripts/release)`, EXIT.rules, 'RELEASE_INVALID');
  return { version: m[1]!, arch: m[2] as 'arm64' | 'x86_64' };
}

export async function uploadRelease(ctx: Ctx, file: string, bucket: string): Promise<NonNullable<NonNullable<Ctx['state']['toolchain']>['release']>> {
  const { version, arch } = parseReleaseName(file);
  const body = ctx.dryRun ? Buffer.alloc(0) : readFileSync(file);
  const sha256 = ctx.dryRun ? '<sha256>' : createHash('sha256').update(body).digest('hex');
  const key = `releases/${version}/${arch}.tgz`;
  await ctx.aws.send({ service: 's3', op: 'PutObject', input: { Bucket: bucket, Key: key, Body: body, ContentType: 'application/gzip', Metadata: { sha256 } },
    display: { Bucket: bucket, Key: key, Body: `<${path.basename(file)}>` } });
  return { version, arch, key, sha256, at: nowIso() };
}

/** presigned GET URL (dry-run: a recognizable placeholder) */
export async function presignRelease(ctx: Ctx, bucket: string, key: string, maxSec = 3600): Promise<string> {
  if (ctx.dryRun) return `https://${bucket}.s3.${ctx.region}.amazonaws.com/${key}?X-Amz-Expires=${maxSec}&X-Amz-Signature=<dry-run>`;
  type S3Mod = { S3Client: new (o: Record<string, unknown>) => { config: { credentials: () => Promise<{ expiration?: Date }> } }; GetObjectCommand: new (i: Record<string, unknown>) => unknown };
  type Presigner = { getSignedUrl: (c: unknown, cmd: unknown, o: { expiresIn: number }) => Promise<string> };
  const s3 = (await import('@aws-sdk/client-s3' as string)) as S3Mod;
  const presigner = (await import('@aws-sdk/s3-request-presigner' as string)) as Presigner;
  const client = new s3.S3Client({ region: ctx.region });
  let expiresIn = maxSec;
  try {
    const creds = await client.config.credentials();
    if (creds.expiration) expiresIn = Math.max(60, Math.min(maxSec, Math.floor((creds.expiration.getTime() - Date.now()) / 1000) - 30));
  } catch {
    /* static credentials: keep maxSec */
  }
  return presigner.getSignedUrl(client, new s3.GetObjectCommand({ Bucket: bucket, Key: key }), { expiresIn });
}
