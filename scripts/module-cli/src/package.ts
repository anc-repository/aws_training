/**
 * Lambda code packages for module stacks (image-processing; 9.1 "code packages and runtime"): build the bundle, add the
 * linux-arm64 sharp build, zip it and upload it to the toolchain artifact bucket under lambda/<function>/<sha256>.zip.
 * The template receives CodeS3Bucket / CodeS3Key (equivalent of `aws cloudformation package`, content-addressed).
 * The zip writer is a minimal deflate implementation (no extra dependency).
 */
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { crc32, deflateRawSync } from 'node:zlib';
import type { AwsGateway } from './aws.js';
import type { Printer } from './printer.js';
import { CliError, EXIT } from './printer.js';

export interface ZipEntry { name: string; data: Buffer; mode?: number }

/** Minimal ZIP (deflate) writer: enough for Lambda deployment packages. */
export function createZip(entries: readonly ZipEntry[]): Buffer {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  const dosTime = 0;        // fixed timestamps: identical input -> identical zip -> identical S3 key
  const dosDate = (1 << 5) | 1;
  for (const e of entries) {
    const name = Buffer.from(e.name.replace(/\\/g, '/'), 'utf8');
    const compressed = deflateRawSync(e.data, { level: 9 });
    const crc = crc32(e.data) >>> 0;
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(20, 4); local.writeUInt16LE(0x0800, 6); local.writeUInt16LE(8, 8);
    local.writeUInt16LE(dosTime, 10); local.writeUInt16LE(dosDate, 12); local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(compressed.length, 18); local.writeUInt32LE(e.data.length, 22);
    local.writeUInt16LE(name.length, 26); local.writeUInt16LE(0, 28);
    locals.push(local, name, compressed);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0); central.writeUInt16LE(0x031e, 4); central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0x0800, 8); central.writeUInt16LE(8, 10); central.writeUInt16LE(dosTime, 12); central.writeUInt16LE(dosDate, 14);
    central.writeUInt32LE(crc, 16); central.writeUInt32LE(compressed.length, 20); central.writeUInt32LE(e.data.length, 24);
    central.writeUInt16LE(name.length, 28); central.writeUInt16LE(0, 30); central.writeUInt16LE(0, 32);
    central.writeUInt16LE(0, 34); central.writeUInt16LE(0, 36);
    central.writeUInt32LE(((e.mode ?? 0o100644) << 16) >>> 0, 38); central.writeUInt32LE(offset, 42);
    centrals.push(central, name);
    offset += local.length + name.length + compressed.length;
  }
  const centralSize = centrals.reduce((n, b) => n + b.length, 0);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(entries.length, 8); end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralSize, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, ...centrals, end]);
}

function walk(dir: string, base = dir): ZipEntry[] {
  const out: ZipEntry[] = [];
  for (const name of readdirSync(dir).sort()) {
    const abs = path.join(dir, name);
    const st = statSync(abs);
    if (st.isDirectory()) out.push(...walk(abs, base));
    else out.push({ name: path.relative(base, abs), data: readFileSync(abs), mode: 0o100000 | (st.mode & 0o777) });
  }
  return out;
}

export interface LambdaPackage { file: string; bucket: string; key: string; sha256: string }

/**
 * Package lambdas/image-thumbnail: `npm run build` (esbuild -> dist/index.mjs) + sharp for linux-arm64 in dist/,
 * zip dist/ and upload. In --dry-run the commands are printed and a placeholder key is returned.
 */
export async function packageLambda(aws: AwsGateway, out: Printer, repoRoot: string, opts: { workspace: string; dir: string; functionId: string; bucket?: string }): Promise<LambdaPackage> {
  const bucket = opts.bucket ?? '<toolchain-bucket>';
  const dist = path.join(repoRoot, opts.dir, 'dist');
  const cmds = [
    `npm run build --workspace ${opts.workspace}`,
    `npm install --prefix ${path.relative(repoRoot, dist)} --no-save --os=linux --cpu=arm64 --libc=glibc sharp`,
  ];
  if (aws.dryRun) {
    for (const c of cmds) out.dry(c);
    out.dry(`zip ${path.relative(repoRoot, dist)} -> s3://${bucket}/lambda/${opts.functionId}/<sha256>.zip`);
    await aws.send({ service: 's3', op: 'PutObject', input: { Bucket: bucket, Key: `lambda/${opts.functionId}/<sha256>.zip` } });
    return { file: '<zip>', bucket, key: `lambda/${opts.functionId}/<sha256>.zip`, sha256: '<sha256>' };
  }
  if (!opts.bucket) throw new CliError('toolchain bucket unknown: run `scripts/module bootstrap` first (prerequisite toolchain)', EXIT.rules);
  for (const c of cmds) {
    out.info(`      $ ${c}`);
    execFileSync(process.platform === 'win32' ? 'npm.cmd' : 'npm', c.split(' ').slice(1), { cwd: repoRoot, stdio: 'inherit', shell: process.platform === 'win32' });
  }
  if (!existsSync(path.join(dist, 'index.mjs'))) throw new CliError(`${dist}/index.mjs missing after the build`, EXIT.stack);
  const zip = createZip(walk(dist).filter((e) => !e.name.endsWith('.tsbuildinfo')));
  const sha256 = createHash('sha256').update(zip).digest('hex');
  const key = `lambda/${opts.functionId}/${sha256}.zip`;
  await aws.send({ service: 's3', op: 'PutObject', input: { Bucket: opts.bucket, Key: key, Body: zip }, display: { Bucket: opts.bucket, Key: key, Body: `<zip ${zip.length} bytes>` } });
  return { file: key, bucket: opts.bucket, key, sha256 };
}
