/**
 * Platform state backend (06 PM-27): state.json in the state bucket, optimistic concurrency with S3 conditional writes.
 *   read  : GetObject, remember the ETag. Missing object: only `bootstrap` and `base deploy` may create it (others exit 2 STATE_MISSING)
 *   write : PutObject + If-Match: <ETag> (update) or If-None-Match: * (create); 412 -> exit 8 STATE_CONFLICT
 *           ("another operation bypassed the environment lock; run scripts/module status --repair")
 *           metadata x-amz-meta-writer=<role session name>, x-amz-meta-op=<command>
 *   when  : after every environment-changing phase (ctx.save()), always while holding the environment lock
 *   cache : ~/.cloudalbum/cache/<envName>/state.json for offline `status` only; every write goes to the bucket
 * The S3 conditional write semantics are verified on real AWS by 07 (V1-15).
 */
import { mkdirSync, renameSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { AwsGateway } from '../aws.js';
import { isAwsError } from '../aws.js';
import { CliError, EXIT } from '../printer.js';
import { nowIso, upgradeState, type CloudAlbumState } from '../state.js';

type Body = { transformToString?: (enc?: string) => Promise<string> } | string | Uint8Array | undefined;

async function bodyText(b: Body): Promise<string> {
  if (b === undefined) return '';
  if (typeof b === 'string') return b;
  if (b instanceof Uint8Array) return Buffer.from(b).toString('utf8');
  if (typeof b.transformToString === 'function') return b.transformToString('utf-8');
  return String(b);
}

export class S3StateStore {
  etag: string | null = null;
  constructor(private readonly aws: AwsGateway, readonly bucket: string, readonly key: string) {}

  /** undefined in --dry-run (nothing is read), null when the object does not exist */
  async load(): Promise<CloudAlbumState | null | undefined> {
    try {
      const r = await this.aws.send<{ Body?: Body; ETag?: string }>({ service: 's3', op: 'GetObject', input: { Bucket: this.bucket, Key: this.key } });
      if (r === undefined) return undefined;
      this.etag = r.ETag ?? null;
      return upgradeState(JSON.parse(await bodyText(r.Body)) as Record<string, unknown>, `s3://${this.bucket}/${this.key}`);
    } catch (e) {
      if (isAwsError(e, 'NoSuchKey', 'NotFound')) {
        this.etag = null;
        return null;
      }
      throw e;
    }
  }

  async save(state: CloudAlbumState, meta: { writer: string; op: string }): Promise<void> {
    state.updatedAt = nowIso();
    const body = `${JSON.stringify(state, null, 2)}\n`;
    const input: Record<string, unknown> = {
      Bucket: this.bucket, Key: this.key, Body: body, ContentType: 'application/json',
      Metadata: { writer: meta.writer.slice(0, 128), op: meta.op.replace(/[^A-Za-z0-9 ._:/-]/g, '').slice(0, 128) },
      ...(this.etag ? { IfMatch: this.etag } : { IfNoneMatch: '*' }),
    };
    try {
      const r = await this.aws.send<{ ETag?: string }>({ service: 's3', op: 'PutObject', input,
        display: { Bucket: this.bucket, Key: this.key, ...(this.etag ? { IfMatch: this.etag } : { IfNoneMatch: '*' }), Body: '<state.json>' } });
      if (r?.ETag) this.etag = r.ETag;
    } catch (e) {
      if (isAwsError(e, 'PreconditionFailed', 'ConditionalRequestConflict', '412')) {
        throw new CliError(`state.json changed under us (s3://${this.bucket}/${this.key}): another operation bypassed the environment lock; `
          + 'run `scripts/module status --repair`', EXIT.stateConflict, 'STATE_CONFLICT');
      }
      throw e;
    }
    writeLocalCache(state);
  }
}

/** ~/.cloudalbum/cache/<envName>/state.json (offline `status`; never authoritative) */
export function writeLocalCache(state: CloudAlbumState, home = os.homedir()): void {
  try {
    const file = path.join(home, '.cloudalbum', 'cache', state.env, 'state.json');
    mkdirSync(path.dirname(file), { recursive: true });
    const tmp = `${file}.${process.pid}.tmp`;
    writeFileSync(tmp, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
    renameSync(tmp, file);
  } catch {
    /* the cache is best effort */
  }
}
