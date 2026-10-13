/**
 * `atl-runner` entry, called by `platform/workflows/runner/buildspec.yml` (bundled to `runner/dist/atl-runner.mjs`):
 *
 *   pre          validate ATL_* variables, read LabSession / Environment / PlatformConfig from atl-main (service role),
 *                write the session policy and the `atl-prov` CLI profile (credential_process → `credentials`)
 *   build        run the steps of ATL_OP (never fails the phase; the exit code is kept for post)
 *   post         upload result.json, ledger.json, progress.jsonl to atl-data/runs/<runId>/ (service role), exit with
 *                the scripts/module exit code
 *   credentials  credential_process: AssumeRole ATLProvisionerRole as atl-<sid>-prov-<op> with the session policy, using
 *                the CodeBuild container credentials; the CLI / SDKs renew it automatically (role chaining: ≤ 1 h)
 *
 * The 01 §3.4 profile form `role_arn` + `credential_source = EcsContainer` cannot carry a session policy (01 §6.7 rule 6),
 * hence `credential_process` (platform-lifecycle note).
 */
import { spawn } from 'node:child_process';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ATL_MAIN_TABLE, INSTALL_DEFAULTS, Keys } from '@atl/shared';
import { buildRunnerContext, readRunnerInput, RunnerInputError, type RunnerContext, type RunnerRecords } from './context.js';
import { PROFILE_NAME, RunnerExecutor, type RunnerResult } from './execute.js';
import type { Host, RunOptions, RunResult } from './host.js';
import { inlineSessionPolicy, staticPolicyArn } from './policy.js';
import { LEDGER_FILE } from './plan.js';

const SRC = process.env.CODEBUILD_SRC_DIR ?? process.cwd();
const WORK = path.join(SRC, '.atl-run');
const files = {
  context: path.join(WORK, 'context.json'),
  policy: path.join(WORK, 'session-policy.json'),
  result: path.join(WORK, 'result.json'),
  exit: path.join(WORK, 'exit-code'),
  preFailed: path.join(WORK, 'pre-failed'),
};

export const realHost: Host = {
  run(cmd: string, args: string[], opts: RunOptions = {}): Promise<RunResult> {
    return new Promise((resolve) => {
      const env: Record<string, string> = {};
      for (const [k, v] of Object.entries({ ...process.env, ...(opts.env ?? {}) })) if (v !== undefined) env[k] = v;
      const child = spawn(cmd, args, { env, cwd: opts.cwd, stdio: ['ignore', 'pipe', 'pipe'] });
      let stdout = '';
      let stderr = '';
      child.stdout.on('data', (d: Buffer) => {
        stdout += d.toString();
        if (!opts.quiet) process.stdout.write(d);
      });
      child.stderr.on('data', (d: Buffer) => {
        stderr += d.toString();
        if (!opts.quiet) process.stderr.write(d);
      });
      child.on('error', (e) => resolve({ code: 127, stdout, stderr: stderr + String(e) }));
      child.on('close', (code) => resolve({ code: code ?? 1, stdout, stderr }));
    });
  },
  async readFile(p) {
    try {
      return await fs.readFile(p, 'utf8');
    } catch {
      return null;
    }
  },
  async writeFile(p, data, opts = {}) {
    await fs.mkdir(path.dirname(p), { recursive: true });
    if (opts.append) await fs.appendFile(p, data, { mode: opts.mode ?? 0o644 });
    else await fs.writeFile(p, data, { mode: opts.mode ?? 0o644 });
  },
  async removeFile(p) {
    await fs.rm(p, { force: true });
  },
  async listFiles(dir) {
    try {
      return await fs.readdir(dir);
    } catch {
      return [];
    }
  },
  async post(url, init) {
    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), 3000);
    try {
      const r = await fetch(url, { method: 'POST', headers: init.headers, body: init.body, signal: ctl.signal });
      return r.status;
    } finally {
      clearTimeout(t);
    }
  },
  now: () => new Date(),
  sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
  log: (line) => console.error(line),
};

// ---------------------------------------------------------------------------------------------------------------

type Ddb = Record<string, unknown>;

/** DynamoDB JSON → plain JSON (S, N, BOOL, NULL, M, L, SS, NS). */
export function unmarshall(v: unknown): unknown {
  const o = v as Ddb;
  if ('S' in o) return o.S;
  if ('N' in o) return Number(o.N);
  if ('BOOL' in o) return o.BOOL;
  if ('NULL' in o) return null;
  if ('M' in o) return Object.fromEntries(Object.entries(o.M as Ddb).map(([k, x]) => [k, unmarshall(x)]));
  if ('L' in o) return (o.L as unknown[]).map(unmarshall);
  if ('SS' in o) return [...(o.SS as string[])];
  if ('NS' in o) return (o.NS as string[]).map(Number);
  return null;
}

async function getItem(host: Host, region: string, key: { PK: string; SK: string }): Promise<Record<string, unknown> | null> {
  const r = await host.run(
    'aws',
    ['dynamodb', 'get-item', '--table-name', ATL_MAIN_TABLE, '--key', JSON.stringify({ PK: { S: key.PK }, SK: { S: key.SK } }), '--consistent-read', '--region', region, '--output', 'json'],
    { env: { AWS_PROFILE: undefined }, quiet: true },
  );
  if (r.code !== 0) throw new RunnerInputError(`GetItem ${key.PK}/${key.SK}: ${r.stderr.trim()}`);
  const item = (JSON.parse(r.stdout || '{}') as { Item?: Ddb }).Item;
  return item ? (unmarshall({ M: item }) as Record<string, unknown>) : null;
}

/** LabSession + Environment + PlatformConfig as the agent context builder needs them. */
export async function loadRecords(host: Host, input: ReturnType<typeof readRunnerInput>): Promise<RunnerRecords> {
  const [session, environment, platform] = await Promise.all([
    getItem(host, input.region, Keys.labSession(input.sessionId)),
    getItem(host, input.region, Keys.environment(input.envId)),
    getItem(host, input.region, Keys.platformConfig()),
  ]);
  if (!session) throw new RunnerInputError(`LabSession ${input.sessionId} not found`);
  if (!environment) throw new RunnerInputError(`Environment ${input.envId} not found`);
  if (!platform) throw new RunnerInputError('PlatformConfig not found');
  const limits = (platform.limits ?? {}) as Record<string, unknown>;
  const card = (session.cardSnapshot ?? {}) as Record<string, unknown>;
  return {
    session: session as unknown as RunnerRecords['session'],
    environment: environment as unknown as RunnerRecords['environment'],
    platform: {
      ...(platform as unknown as RunnerRecords['platform']),
      limits: { ...(limits as object), asgMaxSizeLimit: typeof limits.asgMaxSizeLimit === 'number' ? limits.asgMaxSizeLimit : INSTALL_DEFAULTS.AsgMaxSizeLimit } as RunnerRecords['platform']['limits'],
    },
    testUsersSeeded: card.testUsersSeeded === true,
  };
}

function cliProfile(region: string, runnerScript: string): string {
  return [`[profile ${PROFILE_NAME}]`, `credential_process = node ${runnerScript} credentials`, `region = ${region}`, ''].join('\n');
}

async function writeResult(host: Host, result: Partial<RunnerResult> & { exitCode: number }): Promise<void> {
  await host.writeFile(files.result, JSON.stringify(result, null, 2));
  await host.writeFile(files.exit, String(result.exitCode));
}

export async function pre(host: Host = realHost): Promise<void> {
  try {
    const input = readRunnerInput(process.env);
    const ctx = buildRunnerContext(input, await loadRecords(host, input));
    await host.writeFile(files.context, JSON.stringify(ctx, null, 2));
    await host.writeFile(files.policy, inlineSessionPolicy(ctx));
    await host.writeFile(path.join(os.homedir(), '.aws', 'config'), cliProfile(input.region, process.argv[1] ?? 'atl-runner.mjs'), { append: true });
    host.log(`atl-runner: ${input.op} ${input.runId} as ${ctx.roleSessionName}`);
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    host.log(`atl-runner pre_build: ${message}`);
    await host.writeFile(files.preFailed, message);
    await writeResult(host, { exitCode: 2, error: message, classification: { retryable: false, code: 'RUNNER_ERROR' }, runId: process.env.ATL_RUN_ID ?? '', command: process.env.ATL_OP ?? '' });
  }
}

export async function build(host: Host = realHost): Promise<number> {
  if (await host.readFile(files.preFailed)) return 2;
  const ctx = JSON.parse((await host.readFile(files.context)) ?? 'null') as RunnerContext;
  const exec = new RunnerExecutor(ctx, host, { srcDir: SRC, workDir: WORK });
  let result: RunnerResult;
  try {
    result = await exec.runAll();
  } catch (e) {
    exec.result.exitCode = exec.result.exitCode || 5;
    exec.result.error = e instanceof Error ? e.message : String(e);
    result = exec.result;
  }
  await writeResult(host, result);
  return result.exitCode;
}

export async function post(host: Host = realHost): Promise<number> {
  const runId = process.env.ATL_RUN_ID ?? '';
  const ctx = JSON.parse((await host.readFile(files.context)) ?? 'null') as RunnerContext | null;
  const code = Number((await host.readFile(files.exit)) ?? '5') || 0;
  if (!(await host.readFile(files.result))) await writeResult(host, { exitCode: 5, error: 'build produced no result', runId, command: process.env.ATL_OP ?? '' });
  const region = ctx?.input.region ?? process.env.ATL_REGION ?? process.env.AWS_REGION ?? '';
  const bucket = ctx?.buckets.data ?? (process.env.ATL_ACCOUNT_ID ? `atl-data-${process.env.ATL_ACCOUNT_ID}-${region}` : null);
  if (bucket && runId) {
    for (const name of ['result.json', LEDGER_FILE, 'progress.jsonl']) {
      const local = path.join(WORK, name);
      if (!(await host.readFile(local))) continue;
      const r = await host.run('aws', ['s3', 'cp', local, `s3://${bucket}/runs/${runId}/${name}`, '--region', region], { env: { AWS_PROFILE: undefined } });
      if (r.code !== 0) host.log(`upload ${name} failed: ${r.stderr.trim()}`);
    }
  }
  return code;
}

export async function credentials(host: Host = realHost): Promise<void> {
  const ctx = JSON.parse((await host.readFile(files.context)) ?? 'null') as RunnerContext | null;
  if (!ctx) throw new Error('no runner context (pre_build did not run)');
  const r = await host.run(
    'aws',
    [
      'sts',
      'assume-role',
      '--role-arn',
      ctx.provisionerRoleArn,
      '--role-session-name',
      ctx.roleSessionName,
      '--policy',
      `file://${files.policy}`,
      '--policy-arns',
      `arn=${staticPolicyArn(ctx.input.accountId)}`,
      '--duration-seconds',
      '3600',
      '--region',
      ctx.input.region,
      '--output',
      'json',
    ],
    { env: { AWS_PROFILE: undefined }, quiet: true },
  );
  if (r.code !== 0) throw new Error(`AssumeRole ${ctx.roleSessionName}: ${r.stderr.trim()}`);
  const c = (JSON.parse(r.stdout) as { Credentials: { AccessKeyId: string; SecretAccessKey: string; SessionToken: string; Expiration: string } }).Credentials;
  process.stdout.write(JSON.stringify({ Version: 1, AccessKeyId: c.AccessKeyId, SecretAccessKey: c.SecretAccessKey, SessionToken: c.SessionToken, Expiration: c.Expiration }));
}

async function main(cmd: string | undefined): Promise<number> {
  switch (cmd) {
    case 'pre':
      await pre();
      return 0;
    case 'build':
      await build();
      return 0; // the phase never fails: post_build uploads and exits with the code
    case 'post':
      return post();
    case 'credentials':
      await credentials();
      return 0;
    default:
      console.error('usage: atl-runner pre|build|post|credentials');
      return 2;
  }
}

const invoked = process.argv[1] && /atl-runner(\.mjs)?$|runner[\\/]main\.(ts|js)$/.test(process.argv[1]);
if (invoked) {
  main(process.argv[2]).then(
    (code) => process.exit(code),
    (e: unknown) => {
      console.error(e instanceof Error ? e.message : String(e));
      process.exit(5);
    },
  );
}
