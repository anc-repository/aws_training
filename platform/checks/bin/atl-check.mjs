#!/usr/bin/env node
// Node port of /opt/atl/bin/atl-check for ATL_DEV_MODE=1 and tests on hosts without bash (Windows): the same parameter
// checks and digest selection, then the pinned bundle's runner. Point ATL_DEV_CHECK_RUNNER at
// platform/checks/dist/atl/bin/atl-check.mjs (written by `node platform/checks/build.mjs`). Not installed on instances.
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PATTERNS = {
  CheckId: /^(batch|[a-z][a-z0-9-]{1,31}(\.[a-z][a-z0-9-]{1,31})?)$/,
  ArgsB64: /^[A-Za-z0-9_-]{2,6000}$/,
  RunToken: /^[A-Za-z0-9_-]{22,64}$/,
  SessionId: /^s[0-9a-hjkmnp-tv-z]{12}$/,
  BundleDigest: /^[a-f0-9]{64}$/,
  TimeoutSec: /^([1-9]|[1-7][0-9]|80)$/,
};

function fail(code, message) {
  const env = process.env;
  const ok = (k) => (env[`SSM_${k}`] && PATTERNS[k].test(env[`SSM_${k}`]) ? env[`SSM_${k}`] : null);
  const json = JSON.stringify({
    schema: 'atl.runcheck.result/v1',
    key: 'launcher',
    checkId: ok('CheckId'),
    runToken: ok('RunToken'),
    sessionId: ok('SessionId'),
    bundle: { version: null, digest: ok('BundleDigest') },
    host: { instanceId: env.ATL_DEV_INSTANCE_ID ?? null, role: null },
    startedAt: new Date().toISOString(),
    durationMs: 0,
    status: 'error',
    errorCode: code,
    message,
    observed: null,
    truncated: false,
  });
  process.stdout.write(`ATL-RESULT-V1 ${Buffer.from(json).toString('base64url')}\n`);
  process.stderr.write(`atl-check: ${code}: ${message}\n`);
  process.exit(3);
}

for (const k of Object.keys(PATTERNS)) {
  const v = process.env[`SSM_${k}`];
  if (!v) fail('RUNNER_UNAVAILABLE', `missing SSM_${k} (SSM Agent too old for ENV_VAR?)`);
  if (!PATTERNS[k].test(v)) fail('RUNNER_INTEGRITY', `bad ${k} param`);
}
const dir = path.join(ROOT, 'checks', process.env.SSM_BundleDigest);
if (!fs.existsSync(dir)) fail('RUNNER_INTEGRITY', 'bundle not installed');
const actual = createHash('sha256').update(fs.readFileSync(path.join(dir, 'manifest.json'))).digest('hex');
if (actual !== process.env.SSM_BundleDigest) fail('RUNNER_INTEGRITY', 'manifest digest mismatch');
const runner = await import(pathToFileURL(path.join(dir, 'runner.mjs')).href);
process.exit(await runner.main());
