// ATL check runner (04 §6.2–§6.5). Started by /opt/atl/bin/atl-check (production) or by the dev launcher
// bin/atl-check.mjs / LocalRunCommand (ATL_DEV_MODE=1). Node built-ins only.
//
//  1. re-validate the SSM_* parameters with the ATL-RunCheck allowedPattern (third gate after SSM and the launcher);
//  2. verify SHA-256(manifest.json) = SSM_BundleDigest and the SHA-256 of every file listed in the manifest;
//  3. decode ArgsB64, resolve aliases, validate each item's args with schemas/<checkId>.args.json;
//  4. run each checkId (read-only, fixed argv, no shell) and print one `ATL-RESULT-V1 <base64url(JSON)>` line per item.
// Exit code 0 whenever the runner itself completed (whatever the observations); non-zero only for runner failures.
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { CheckError, createContext } from './lib/context.mjs';
import { emitResult, nowIso } from './lib/result.mjs';
import { validateArgs } from './lib/validate.mjs';

const PATTERNS = {
  CheckId: /^(batch|[a-z][a-z0-9-]{1,31}(\.[a-z][a-z0-9-]{1,31})?)$/,
  ArgsB64: /^[A-Za-z0-9_-]{2,6000}$/,
  RunToken: /^[A-Za-z0-9_-]{22,64}$/,
  SessionId: /^s[0-9a-hjkmnp-tv-z]{12}$/,
  BundleDigest: /^[a-f0-9]{64}$/,
  TimeoutSec: /^([1-9]|[1-7][0-9]|80)$/,
};
const MAX_BATCH = 10;
const BUNDLE_DIR = path.dirname(fileURLToPath(import.meta.url));

function sha256(buf) {
  return createHash('sha256').update(buf).digest('hex');
}

function base64UrlDecode(s) {
  return Buffer.from(s.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8');
}

export async function main(env = process.env, out = process.stdout) {
  const params = {};
  const base = { runToken: null, sessionId: null, bundle: { version: null, digest: null } };
  const failAll = (code, message, checkId = null) => {
    emitResult(out, { ...base, key: 'runner', checkId, host: { instanceId: null, role: null }, startedAt: nowIso(), durationMs: 0, status: 'error', errorCode: code, message, observed: null });
    return 3;
  };
  for (const name of Object.keys(PATTERNS)) {
    const v = env[`SSM_${name}`];
    if (v === undefined || v === '') return failAll('RUNNER_UNAVAILABLE', `missing SSM_${name} (SSM Agent too old for ENV_VAR?)`);
    if (!PATTERNS[name].test(v)) return failAll('RUNNER_INTEGRITY', `SSM_${name} does not match its allowedPattern`);
    params[name] = v;
  }
  base.runToken = params.RunToken;
  base.sessionId = params.SessionId;
  base.bundle.digest = params.BundleDigest;

  // 2. integrity of the pinned bundle
  let manifest;
  try {
    const raw = fs.readFileSync(path.join(BUNDLE_DIR, 'manifest.json'));
    if (sha256(raw) !== params.BundleDigest) return failAll('RUNNER_INTEGRITY', 'manifest digest mismatch');
    manifest = JSON.parse(raw.toString('utf8'));
    if (manifest.purpose !== 'atl-checkbundle/v1') return failAll('RUNNER_INTEGRITY', 'unexpected manifest purpose');
    for (const [rel, digest] of Object.entries(manifest.files ?? {})) {
      if (!/^[a-z0-9][a-z0-9._/-]*$/i.test(rel) || rel.includes('..')) return failAll('RUNNER_INTEGRITY', `bad file name in manifest: ${rel}`);
      const buf = fs.readFileSync(path.join(BUNDLE_DIR, rel));
      if (`sha256:${sha256(buf)}` !== digest) return failAll('RUNNER_INTEGRITY', `file digest mismatch: ${rel}`);
    }
  } catch (e) {
    return failAll('RUNNER_INTEGRITY', `bundle unreadable: ${e instanceof Error ? e.message : String(e)}`);
  }
  base.bundle.version = manifest.version ?? null;

  // 3. items
  let args;
  try {
    args = JSON.parse(base64UrlDecode(params.ArgsB64));
  } catch {
    return failAll('RUNNER_INTEGRITY', 'ArgsB64 is not base64url(JSON)', params.CheckId);
  }
  let items;
  if (params.CheckId === 'batch') {
    if (!args || !Array.isArray(args.items) || args.items.length === 0 || args.items.length > MAX_BATCH) {
      return failAll('RUNNER_INTEGRITY', `batch needs 1..${MAX_BATCH} items`, 'batch');
    }
    items = args.items.map((it, i) => ({ key: typeof it.key === 'string' && /^[A-Za-z0-9_.-]{1,40}$/.test(it.key) ? it.key : `c${i + 1}`, checkId: it.checkId, args: it.args ?? {} }));
  } else {
    items = [{ key: 'c1', checkId: params.CheckId, args: args ?? {} }];
  }

  const ctx = createContext({ env, bundleDir: BUNDLE_DIR });
  const deadline = Date.now() + Number(params.TimeoutSec) * 1000;
  const host = { instanceId: await ctx.instanceId().catch(() => null), role: ctx.hostRole };
  for (const item of items) {
    const startedAt = nowIso();
    const t0 = Date.now();
    const res = { ...base, key: item.key, checkId: typeof item.checkId === 'string' ? item.checkId : null, host, startedAt };
    try {
      if (typeof item.checkId !== 'string' || !PATTERNS.CheckId.test(item.checkId) || item.checkId === 'batch') throw new CheckError('NOT_ALLOWED', 'bad checkId');
      const id = manifest.aliases?.[item.checkId] ?? item.checkId;
      if (!manifest.checks.includes(id)) throw new CheckError('NOT_ALLOWED', `checkId ${item.checkId} is not in this bundle`);
      const schemaRel = `schemas/${id}.args.json`;
      if (!manifest.files[schemaRel] || !manifest.files[`checks/${id}.mjs`]) throw new CheckError('RUNNER_INTEGRITY', `bundle lacks files for ${id}`);
      const schema = JSON.parse(fs.readFileSync(path.join(BUNDLE_DIR, schemaRel), 'utf8'));
      const problems = validateArgs(schema, item.args);
      if (problems.length) throw new CheckError('NOT_ALLOWED', `args rejected: ${problems.join('; ')}`);
      const mod = await import(pathToFileURL(path.join(BUNDLE_DIR, 'checks', `${id}.mjs`)).href);
      const remaining = deadline - Date.now();
      if (remaining <= 0) throw new CheckError('TIMEOUT', 'runner time budget exhausted');
      const observed = await withTimeout(mod.default(item.args, ctx), remaining);
      emitResult(out, { ...res, checkId: id, durationMs: Date.now() - t0, status: 'ok', errorCode: null, observed });
    } catch (e) {
      const code = e instanceof CheckError ? e.code : 'INTERNAL';
      const message = e instanceof Error ? e.message : String(e);
      emitResult(out, { ...res, durationMs: Date.now() - t0, status: 'error', errorCode: code, message: message.slice(0, 300), observed: e instanceof CheckError ? (e.observed ?? null) : null });
      if (!(e instanceof CheckError)) process.stderr.write(`atl-check: ${item.checkId}: ${message}\n`);
    }
  }
  writeState(ctx, { at: nowIso(), checkIds: items.map((i) => i.checkId), runToken: params.RunToken.slice(0, 6) });
  return 0;
}

function withTimeout(p, ms) {
  let t;
  return Promise.race([
    p,
    new Promise((_, reject) => {
      t = setTimeout(() => reject(new CheckError('TIMEOUT', `check exceeded ${ms} ms`)), ms);
    }),
  ]).finally(() => clearTimeout(t));
}

/** Last execution summary for troubleshooting (/opt/atl/state, 0600); never fails the run. */
function writeState(ctx, summary) {
  if (ctx.dev) return;
  try {
    const dir = '/opt/atl/state';
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    fs.writeFileSync(path.join(dir, 'last-run.json'), JSON.stringify(summary), { mode: 0o600 });
  } catch {
    /* read-only host or non-root: ignore */
  }
}

const invokedDirectly = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) {
  main().then(
    (code) => process.exit(code),
    (e) => {
      process.stderr.write(`atl-check: runner crashed: ${e instanceof Error ? e.stack : String(e)}\n`);
      process.exit(5);
    },
  );
}
