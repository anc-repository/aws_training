/**
 * Executes the steps of one `ATL_OP` (02 §4.3) and assembles `result.json` — the only basis of the lifecycle's failure
 * classification. scripts/module runs with `--platform --progress-jsonl --result-json` (06 PM-35) under the
 * `atl-prov` CLI profile (`atl-<sid>-prov-<op>` with the session policy, auto-renewed through `credential_process`);
 * the runner's own direct calls use the same profile. Progress lines are forwarded to
 * `POST /api/v1/internal/runs/{runId}/events` (SigV4); reporting failures never change the result.
 */
import { createHash } from 'node:crypto';
import { RUNNER_ENV, SsmParams, utf8ToBase64Url } from '@atl/shared';
import { extraStackRegion, type RunnerContext } from './context.js';
import type { Host, RunResult } from './host.js';
import { LEDGER_FILE, planOp, type Phase, type Step, type TaskName } from './plan.js';
import { argon2idPhc, randomPassword } from './secrets.js';
import { signRequest, type SigV4Credentials } from './sigv4.js';

export const PROFILE_NAME = 'atl-prov';
export const CLOUDALBUM_CLI = '/opt/cloudalbum/bin/cloudalbum';
/** The workstation stack template in the source package (platform-infra #1: cloudalbum-infra.zip ships platform/workstation/templates/). */
export const WORKSTATION_TEMPLATE = 'platform/workstation/templates/atl-workstation.yaml';

export interface CfnFailure {
  stack: string;
  logicalId: string;
  status: string;
  reason: string;
}

export interface RunnerResult {
  schema: 'atl.runner-result/v1';
  runId: string;
  command: string;
  sessionId: string;
  envId: string;
  exitCode: number;
  phase: Phase | null;
  module: string | null;
  step: string | null;
  cfnFailures: CfnFailure[];
  error: string | null;
  classification: { retryable?: boolean; code: string; hint?: string | null } | null;
  warnings: string[];
  stateEtag: string | null;
  changed: Record<string, unknown> | null;
  variables: Record<string, string>;
  steps: { id: string; exitCode: number; durationSeconds: number }[];
  startedAt: string;
  finishedAt: string | null;
  durationSeconds: number | null;
  firstCreate?: boolean;
}

/** A failed step: exit code and optional classification (codes from 02 §4.3 / FailureCode). */
export class StepFailure extends Error {
  override readonly name = 'StepFailure';
  constructor(
    readonly exitCode: number,
    message: string,
    readonly extra: Partial<Pick<RunnerResult, 'classification' | 'cfnFailures' | 'module'>> = {},
  ) {
    super(message);
  }
}

export interface ExecOptions {
  /** source directory (CODEBUILD_SRC_DIR) */
  srcDir: string;
  /** working directory for result / progress / ledger files */
  workDir: string;
  /** seconds between SSM invocation polls (tests: 0) */
  pollSeconds?: number;
  /** `cloudalbum-<ver>-<arch>.tgz` architecture preference */
  arch?: string;
  /** the CodeBuild project's static variables (ATL_WORKSTATION_*; default process.env) */
  env?: NodeJS.ProcessEnv;
}

type Json = Record<string, unknown>;

export class RunnerExecutor {
  readonly result: RunnerResult;
  private readonly outputs = new Map<string, unknown>();
  private progressSent = 0;
  private creds: SigV4Credentials | null = null;
  private profileFile: string | null = null;

  constructor(
    private readonly ctx: RunnerContext,
    private readonly host: Host,
    private readonly opts: ExecOptions,
  ) {
    this.result = {
      schema: 'atl.runner-result/v1',
      runId: ctx.input.runId,
      command: ctx.input.op,
      sessionId: ctx.input.sessionId,
      envId: ctx.input.envId,
      exitCode: 0,
      phase: null,
      module: null,
      step: null,
      cfnFailures: [],
      error: null,
      classification: null,
      warnings: [],
      stateEtag: null,
      changed: null,
      variables: {},
      steps: [],
      startedAt: host.now().toISOString(),
      finishedAt: null,
      durationSeconds: null,
    };
  }

  private get region() {
    return this.ctx.input.region;
  }

  private path(name: string) {
    return `${this.opts.workDir}/${name}`;
  }

  /** Environment of child processes: scripts/module variables + the provisioner profile. */
  private childEnv(extra: Record<string, string> = {}): Record<string, string | undefined> {
    return { ...this.ctx.moduleEnv, AWS_PROFILE: PROFILE_NAME, AWS_SDK_LOAD_CONFIG: '1', [RUNNER_ENV.op]: this.ctx.input.op, ...extra };
  }

  /** `aws … --region <r> --output json` as atl-<sid>-prov-<op>. */
  async aws(args: string[], o: { region?: string; quiet?: boolean; serviceRole?: boolean } = {}): Promise<RunResult> {
    const env = o.serviceRole ? { AWS_PROFILE: undefined, AWS_REGION: this.region } : this.childEnv();
    return this.host.run('aws', [...args, '--region', o.region ?? this.region, '--output', 'json'], { env, cwd: this.opts.workDir, quiet: o.quiet ?? false });
  }

  private async awsJson(args: string[], o: { region?: string; quiet?: boolean; serviceRole?: boolean } = {}): Promise<Json> {
    const r = await this.aws(args, o);
    if (r.code !== 0) throw new StepFailure(3, `aws ${args.slice(0, 2).join(' ')}: ${r.stderr.trim() || r.stdout.trim()}`);
    return r.stdout.trim() ? (JSON.parse(r.stdout) as Json) : {};
  }

  async progress(phase: Phase, step: string, status: 'started' | 'progress' | 'succeeded' | 'failed', message: string | null = null): Promise<void> {
    const line = { ts: this.host.now().toISOString(), runId: this.ctx.input.runId, opId: null, phase, module: null, step, status, message, pct: null };
    await this.host.writeFile(this.path('progress.jsonl'), JSON.stringify(line) + '\n', { append: true });
    await this.forwardProgress();
  }

  /** Forward new progress lines (best effort, 01 §3.4 “上报”). */
  async forwardProgress(): Promise<void> {
    try {
      const all = (await this.host.readFile(this.path('progress.jsonl'))) ?? '';
      const lines = all.split('\n').filter((l) => l.trim());
      const fresh = lines.slice(this.progressSent);
      if (!fresh.length) return;
      this.progressSent = lines.length;
      const events = fresh.flatMap((l) => {
        try {
          return [JSON.parse(l) as unknown];
        } catch {
          return [];
        }
      });
      await this.internalPost(`/api/v1/internal/runs/${encodeURIComponent(this.ctx.input.runId)}/events`, { events });
    } catch (e) {
      this.host.log(`progress report failed (ignored): ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  private async internalPost(path: string, body: unknown): Promise<void> {
    this.creds ??= await this.exportCredentials();
    if (!this.creds) return;
    const signed = signRequest({ method: 'POST', url: `${this.ctx.agentApiBase.replace(/\/$/, '')}${path}`, body: JSON.stringify(body), headers: { 'content-type': 'application/json' } }, this.creds, {
      region: this.region,
      service: 'execute-api',
      now: this.host.now(),
    });
    const status = await this.host.post(signed.url, { headers: signed.headers, body: signed.body });
    if (status >= 300) throw new Error(`POST ${path} → ${status}`);
  }

  /** Credentials of the atl-prov profile (`aws configure export-credentials`, AWS CLI v2). */
  private async exportCredentials(): Promise<SigV4Credentials | null> {
    const r = await this.host.run('aws', ['configure', 'export-credentials', '--profile', PROFILE_NAME, '--format', 'process'], { env: { AWS_PROFILE: undefined }, quiet: true });
    if (r.code !== 0) return null;
    const c = JSON.parse(r.stdout) as { AccessKeyId: string; SecretAccessKey: string; SessionToken?: string };
    return { accessKeyId: c.AccessKeyId, secretAccessKey: c.SecretAccessKey, ...(c.SessionToken ? { sessionToken: c.SessionToken } : {}) };
  }

  // -------------------------------------------------------------------------------------------------------------

  async runAll(extras: { actionArgs?: Record<string, unknown> } = {}): Promise<RunnerResult> {
    let steps: Step[] = [];
    try {
      if (this.ctx.input.op === 'module-op' && extras.actionArgs === undefined) extras = { actionArgs: await this.loadActionArgs() };
      steps = planOp(this.ctx, extras);
    } catch (e) {
      this.fail(e instanceof StepFailure ? e : new StepFailure(2, e instanceof Error ? e.message : String(e)), null);
    }
    for (const step of steps) {
      if (this.result.exitCode !== 0 && !this.continuesAfter(this.result.exitCode)) break;
      const started = this.host.now().getTime();
      this.result.step = step.id;
      this.result.phase = step.phase;
      await this.progress(step.phase, step.id, 'started');
      let code = 0;
      try {
        code = step.kind === 'module' ? await this.runModule(step) : await this.runTask(step);
      } catch (e) {
        code = this.fail(e instanceof StepFailure ? e : new StepFailure(5, e instanceof Error ? e.message : String(e)), step);
      }
      this.result.steps.push({ id: step.id, exitCode: code, durationSeconds: Math.round((this.host.now().getTime() - started) / 1000) });
      await this.progress(step.phase, step.id, code === 0 ? 'succeeded' : 'failed', code === 0 ? null : this.result.error);
    }
    const end = this.host.now();
    this.result.finishedAt = end.toISOString();
    this.result.durationSeconds = Math.round((end.getTime() - Date.parse(this.result.startedAt)) / 1000);
    await this.forwardProgress();
    return this.result;
  }

  /** destroy continues after exit 6 (partly deleted, ledger written). */
  private continuesAfter(code: number): boolean {
    return this.ctx.input.op === 'destroy' && code === 6;
  }

  private fail(f: StepFailure, step: Step | null): number {
    if (this.result.exitCode === 0 || this.result.exitCode === 6) this.result.exitCode = f.exitCode;
    this.result.error = f.message.slice(0, 4000);
    if (f.extra.classification) this.result.classification = f.extra.classification;
    if (f.extra.cfnFailures?.length) this.result.cfnFailures.push(...f.extra.cfnFailures);
    if (f.extra.module) this.result.module = f.extra.module;
    if (step) this.result.step = step.id;
    return f.exitCode;
  }

  // -------------------------------------------------------------------------------------------------------------
  // scripts/module

  private async releaseFile(): Promise<string> {
    const arch = this.opts.arch ?? 'arm64';
    for (const dir of [this.opts.srcDir, `${this.opts.srcDir}/release`]) {
      const files = (await this.host.listFiles(dir)).filter((f) => /^cloudalbum-.+-(arm64|x86_64|amd64)\.tgz$/.test(f));
      const pick = files.find((f) => f.endsWith(`-${arch}.tgz`)) ?? files[0];
      if (pick) return `${dir}/${pick}`;
    }
    throw new StepFailure(2, 'the source package contains no cloudalbum-<ver>-<arch>.tgz');
  }

  async runModule(step: Extract<Step, { kind: 'module' }>, extraArgs: string[] = []): Promise<number> {
    const resultFile = this.path(`module-${step.id}.json`);
    let args = [...step.args, ...extraArgs];
    if (args.includes('${RELEASE_FILE}')) {
      const file = await this.releaseFile();
      args = args.map((a) => (a === '${RELEASE_FILE}' ? file : a));
    }
    const argv = [...args, '--platform', '--progress-jsonl', this.path('progress.jsonl'), '--result-json', resultFile, ...(step.lock ? ['--lock-wait', '900'] : [])];
    const r = await this.host.run(`${this.opts.srcDir}/scripts/module`, argv, { env: this.childEnv(), cwd: this.opts.workDir });
    await this.forwardProgress();
    const out = r.stdout.trim();
    if (out.startsWith('{')) {
      try {
        this.outputs.set(step.id, JSON.parse(out));
      } catch {
        // not JSON
      }
    }
    const mr = await this.readJson(resultFile);
    if (mr) {
      if (typeof mr.stateEtag === 'string') this.result.stateEtag = mr.stateEtag;
      if (mr.changed && typeof mr.changed === 'object') this.result.changed = mr.changed as Json;
      if (Array.isArray(mr.warnings)) this.result.warnings.push(...mr.warnings.map(String));
    }
    if (r.code === 0 || (step.okExit ?? []).includes(r.code)) {
      if (r.code !== 0) this.result.exitCode = r.code;
      return r.code;
    }
    // failure: phase / module / cfnFailures from the module's result (06 PM-35)
    if (mr) {
      if (typeof mr.phase === 'string') this.result.phase = mr.phase as Phase;
      if (typeof mr.module === 'string') this.result.module = mr.module;
      if (Array.isArray(mr.cfnFailures)) this.result.cfnFailures.push(...(mr.cfnFailures as CfnFailure[]));
    }
    this.fail(new StepFailure(r.code, `scripts/module ${args.slice(0, 3).join(' ')} exited ${r.code}: ${lastLines(r.stderr)}`), step);
    if (step.id === 'base') this.result.firstCreate = true;
    return r.code;
  }

  private async readJson(path: string): Promise<Json | null> {
    const raw = await this.host.readFile(path);
    if (!raw) return null;
    try {
      return JSON.parse(raw) as Json;
    } catch {
      return null;
    }
  }

  // -------------------------------------------------------------------------------------------------------------
  // runner tasks

  async runTask(step: Extract<Step, { kind: 'task' }>): Promise<number> {
    const p = step.params ?? {};
    const task: TaskName = step.task;
    switch (task) {
      case 'create-key-pair':
        await this.createKeyPair(String(p.keyName), String(p.param));
        return 0;
      case 'apply-platform-env':
        await this.onInstance('platform-env', [`${CLOUDALBUM_CLI} platform:apply-env --b64 ${utf8ToBase64Url(this.platformEnvFile())} --restart auto`], 1, 'BASE_BOOTSTRAP_FAILED');
        return 0;
      case 'probe-token':
        await this.onInstance('probe-token', [`${CLOUDALBUM_CLI} probe-token --init`], 1, 'BASE_BOOTSTRAP_FAILED');
        return 0;
      case 'admin-init':
        await this.adminInit(String(p.param), String(p.email));
        return 0;
      case 'download-profile':
        await this.downloadProfile(String(p.profile));
        return 0;
      case 'verify-profile-digest':
        await this.verifyDigestAndSubstitute(String(p.profile));
        return 0;
      case 'seeds':
        await this.seeds();
        return 0;
      case 'archive-state':
        await this.archiveState();
        return 0;
      case 'extra-stacks':
        return this.extraStacks(p as { action: 'deploy' | 'destroy'; stackIds?: string[]; phase?: 'before-modules' | 'after-modules' });
      case 'workstation-up':
        await this.workstationUp();
        return 0;
      case 'workstation-down':
        return this.workstationDown();
      case 'diagnose':
        await this.diagnose();
        return 0;
      default: {
        const never: never = task;
        throw new StepFailure(2, `unknown task ${String(never)}`);
      }
    }
  }

  /** base-deploy step 2: `cloudalbum-<env>-key` via ec2:CreateKeyPair, private key only in the SecureString. */
  private async createKeyPair(keyName: string, param: string): Promise<void> {
    const existing = await this.aws(['ec2', 'describe-key-pairs', '--key-names', keyName]);
    const paramExists = (await this.aws(['ssm', 'get-parameter', '--name', param], { quiet: true })).code === 0;
    if (existing.code === 0 && paramExists) return; // retried build
    if (existing.code === 0) await this.awsJson(['ec2', 'delete-key-pair', '--key-name', keyName]); // private key lost: recreate
    const tags = Object.entries(this.ctx.platformTags).map(([Key, Value]) => ({ Key, Value }));
    const created = await this.aws(
      ['ec2', 'create-key-pair', '--key-name', keyName, '--key-type', 'ed25519', '--key-format', 'pem', '--tag-specifications', JSON.stringify([{ ResourceType: 'key-pair', Tags: tags }])],
      { quiet: true },
    );
    if (created.code !== 0) throw new StepFailure(3, `CreateKeyPair: ${created.stderr.trim()}`);
    const material = String((JSON.parse(created.stdout) as Json).KeyMaterial ?? '');
    await this.putSecureParameter(param, material, tags, paramExists);
  }

  /** PutParameter through a 0600 input file (the secret never appears in a process argument list). */
  private async putSecureParameter(name: string, value: string, tags: { Key: string; Value: string }[], overwrite: boolean): Promise<void> {
    const file = this.path(`put-${createHash('sha256').update(name).digest('hex').slice(0, 8)}.json`);
    const input = overwrite ? { Name: name, Value: value, Type: 'SecureString', Overwrite: true } : { Name: name, Value: value, Type: 'SecureString', Tags: tags };
    await this.host.writeFile(file, JSON.stringify(input), { mode: 0o600 });
    try {
      const r = await this.aws(['ssm', 'put-parameter', '--cli-input-json', `file://${file}`], { quiet: true });
      if (r.code !== 0) throw new StepFailure(3, `PutParameter ${name}: ${r.stderr.trim()}`);
    } finally {
      await this.host.removeFile(file);
    }
  }

  private platformEnvFile(): string {
    const e = this.ctx.moduleEnv;
    const lines = {
      ATL_PLATFORM_MODE: 'on',
      ATL_SESSION_ID: e.ATL_SESSION_ID,
      ATL_ENV_ID: e.ATL_ENV_ID,
      ATL_ENV_NAME: e.CLOUDALBUM_ENV,
      ATL_LAB_ID: e.ATL_LAB_ID,
      ATL_VARIANT: e.ATL_VARIANT,
      ATL_PLATFORM_ORIGIN: (e.ATL_PLATFORM_ORIGIN ?? '').replace(/\/+$/, ''),
      ATL_RELEASE: this.ctx.input.release,
    };
    return Object.entries(lines)
      .map(([k, v]) => `${k}=${v ?? ''}`)
      .join('\n')
      .concat('\n');
  }

  /**
   * Run shell commands on the environment's lab-app instance(s) through SSM Run Command (targets by `atl:env-id` +
   * `atl:role=lab-app`, 01 §9.8), retrying `retries` times; failure → exit 5 with `code`.
   */
  async onInstance(label: string, commands: string[], retries: number, code: string): Promise<void> {
    let last = '';
    for (let attempt = 0; attempt <= retries; attempt++) {
      const sent = await this.aws(
        [
          'ssm',
          'send-command',
          '--document-name',
          'AWS-RunShellScript',
          '--comment',
          `atl ${this.ctx.input.runId} ${label}`.slice(0, 100),
          '--targets',
          `Key=tag:atl:env-id,Values=${this.ctx.input.envId}`,
          'Key=tag:atl:role,Values=lab-app',
          '--parameters',
          JSON.stringify({ commands }),
          '--timeout-seconds',
          '600',
        ],
        { quiet: true },
      );
      if (sent.code !== 0) {
        last = sent.stderr.trim();
        continue;
      }
      const commandId = String(((JSON.parse(sent.stdout) as Json).Command as Json | undefined)?.CommandId ?? '');
      const status = await this.waitCommand(commandId);
      if (status.ok) return;
      last = status.detail;
    }
    throw new StepFailure(5, `${label} on the lab instance failed: ${last}`, { classification: { retryable: true, code } });
  }

  private async waitCommand(commandId: string): Promise<{ ok: boolean; detail: string }> {
    const deadline = this.host.now().getTime() + 15 * 60_000;
    while (this.host.now().getTime() < deadline) {
      const out = await this.awsJson(['ssm', 'list-command-invocations', '--command-id', commandId, '--details']);
      const inv = (out.CommandInvocations ?? []) as { Status: string; StatusDetails?: string; CommandPlugins?: { Output?: string }[] }[];
      if (inv.length && inv.every((i) => ['Success', 'Failed', 'TimedOut', 'Cancelled', 'Undeliverable', 'Terminated'].includes(i.Status))) {
        const bad = inv.find((i) => i.Status !== 'Success');
        return bad ? { ok: false, detail: `${bad.Status}: ${lastLines(bad.CommandPlugins?.[0]?.Output ?? '')}` } : { ok: true, detail: 'Success' };
      }
      await this.host.sleep((this.opts.pollSeconds ?? 5) * 1000);
    }
    return { ok: false, detail: 'timed out waiting for the command' };
  }

  /** base-deploy step 6: plaintext only in the SecureString; the instance gets the argon2id PHC string. */
  private async adminInit(param: string, email: string): Promise<void> {
    const got = await this.aws(['ssm', 'get-parameter', '--name', param, '--with-decryption'], { quiet: true });
    let password: string;
    if (got.code === 0) {
      password = String(((JSON.parse(got.stdout) as Json).Parameter as Json).Value);
    } else {
      password = randomPassword();
      await this.putSecureParameter(param, password, Object.entries(this.ctx.platformTags).map(([Key, Value]) => ({ Key, Value })), false);
    }
    const phc = argon2idPhc(password);
    await this.onInstance('admin', [`${CLOUDALBUM_CLI} admin:ensure --email ${email} --password-hash '${phc}'`], 1, 'BASE_BOOTSTRAP_FAILED');
  }

  private profilePath(profile: string): string {
    return `${this.opts.srcDir}/profiles/${profile}.env`;
  }

  private contentKey(rel: string): string {
    if (!this.ctx.card.catalogVersion) throw new StepFailure(2, 'the session has no catalogVersion');
    return `content/${this.ctx.card.catalogVersion}/${rel}`;
  }

  /** Download one content file (service role) and check its SHA-256 against the content manifest. */
  private async contentFile(rel: string, dest: string): Promise<string> {
    const manifestFile = this.path('content-manifest.json');
    if (!(await this.host.readFile(manifestFile))) {
      const r = await this.aws(['s3', 'cp', `s3://${this.ctx.buckets.web}/${this.contentKey('manifest.json')}`, manifestFile], { serviceRole: true });
      if (r.code !== 0) throw new StepFailure(2, `content manifest: ${r.stderr.trim()}`, { classification: { retryable: false, code: 'PROFILE_DIGEST_MISMATCH' } });
    }
    const manifest = JSON.parse((await this.host.readFile(manifestFile)) ?? '{}') as unknown;
    const r = await this.aws(['s3', 'cp', `s3://${this.ctx.buckets.web}/${this.contentKey(rel)}`, dest], { serviceRole: true });
    if (r.code !== 0) throw new StepFailure(2, `${rel}: ${r.stderr.trim()}`, { classification: { retryable: false, code: 'PROFILE_DIGEST_MISMATCH' } });
    const body = (await this.host.readFile(dest)) ?? '';
    const want = manifestSha(manifest, rel);
    const got = createHash('sha256').update(body).digest('hex');
    if (!want || want.toLowerCase() !== got) {
      throw new StepFailure(2, `${rel}: SHA-256 ${got} does not match the content manifest (${want ?? 'missing'})`, { classification: { retryable: false, code: 'PROFILE_DIGEST_MISMATCH' } });
    }
    return body;
  }

  /** profile-apply ①: `profiles/atl/<card>/<variant>.env` from the content release (01 §3.4). */
  private async downloadProfile(profile: string): Promise<void> {
    const body = await this.contentFile(`profiles/${profile}.env`, this.profilePath(profile));
    this.profileFile = body;
  }

  /** ② digest check (plan --profile = PROFILE_PLAN_DIGEST = LabSession digest), then the `${atl:…}` placeholders. */
  private async verifyDigestAndSubstitute(profile: string): Promise<void> {
    const body = this.profileFile ?? (await this.host.readFile(this.profilePath(profile))) ?? '';
    const planned = (this.outputs.get('plan') as { digest?: string } | undefined)?.digest ?? null;
    const declared = envValue(body, 'PROFILE_PLAN_DIGEST');
    const session = this.ctx.card.startProfileDigest;
    if (!planned || planned !== declared || (session && session !== planned)) {
      throw new StepFailure(2, `PROFILE_DIGEST_MISMATCH: plan ${planned ?? 'none'}, profile ${declared ?? 'none'}, session ${session ?? 'none'}`, {
        classification: { retryable: false, code: 'PROFILE_DIGEST_MISMATCH', hint: 'content and toolkit versions do not match' },
      });
    }
    const values: Record<string, string | null> = {
      drRegion: this.ctx.drRegion,
      platformOrigin: (this.ctx.moduleEnv.ATL_PLATFORM_ORIGIN ?? '').replace(/\/+$/, '') || null,
      workstationPrivateCidr: null,
      workstationPublicCidr: null,
    };
    if (/\$\{atl:workstation(Private|Public)Cidr\}/.test(body)) {
      const ws = await this.workstationAddresses();
      values.workstationPrivateCidr = ws.privateIp ? `${ws.privateIp}/32` : null;
      values.workstationPublicCidr = ws.publicIp ? `${ws.publicIp}/32` : null;
    }
    const missing: string[] = [];
    const replaced = body.replace(/\$\{atl:([A-Za-z]+)\}/g, (all, name: string) => {
      const v = values[name];
      if (!v) {
        missing.push(name);
        return all;
      }
      return v;
    });
    if (missing.length) throw new StepFailure(2, `PROFILE_PLACEHOLDER: no value for ${[...new Set(missing)].join(', ')}`, { classification: { retryable: false, code: 'PROFILE_RULES' } });
    if (replaced !== body) await this.host.writeFile(this.profilePath(profile), replaced);
  }

  private async workstationAddresses(): Promise<{ privateIp: string | null; publicIp: string | null }> {
    const out = await this.awsJson([
      'ec2',
      'describe-instances',
      '--filters',
      `Name=tag:atl:env-id,Values=${this.ctx.input.envId}`,
      'Name=tag:atl:role,Values=workstation',
      'Name=instance-state-name,Values=pending,running',
    ]);
    const i = ((out.Reservations ?? []) as { Instances?: Json[] }[]).flatMap((r) => r.Instances ?? [])[0];
    return { privateIp: (i?.PrivateIpAddress as string | undefined) ?? null, publicIp: (i?.PublicIpAddress as string | undefined) ?? null };
  }

  /** ⑤ seeds in PROFILE_SEEDS order: one retry each, failures become warnings (06 PM-43). */
  private async seeds(): Promise<void> {
    const body = this.profileFile ?? '';
    const ids = (envValue(body, 'PROFILE_SEEDS') ?? '').split(/[\s,]+/).filter(Boolean);
    for (const id of ids) {
      let ok = false;
      for (let attempt = 0; attempt < 2 && !ok; attempt++) {
        const r = await this.host.run(
          `${this.opts.srcDir}/scripts/module`,
          ['seed', id, '--platform', '--progress-jsonl', this.path('progress.jsonl'), '--result-json', this.path(`seed-${id}.json`), '--lock-wait', '900'],
          { env: this.childEnv(), cwd: this.opts.workDir },
        );
        ok = r.code === 0;
      }
      if (!ok) this.result.warnings.push(`seed:${id}`);
    }
  }

  /** destroy: state.json copy to atl-data/archive/<sid>/ (02 §6.5). */
  private async archiveState(): Promise<void> {
    const uri = this.ctx.moduleEnv.CLOUDALBUM_STATE_URI!;
    const r = await this.aws(['s3', 'cp', uri, `s3://${this.ctx.buckets.data}/archive/${this.ctx.input.sessionId}/state-${this.ctx.input.runId}.json`]);
    if (r.code !== 0 && !/404|Not Found|NoSuchKey|does not exist/i.test(r.stderr)) this.result.warnings.push(`archive-state: ${lastLines(r.stderr)}`);
  }

  private stackName(stackId: string): string {
    return `cloudalbum-${this.ctx.envName}-x-${stackId}`;
  }

  /** Card stacks (01 §3.4 `extra-stack`): deploy in declaration order, or delete by `reclaim.phase` / ids. */
  private async extraStacks(p: { action: 'deploy' | 'destroy'; stackIds?: string[]; phase?: 'before-modules' | 'after-modules' }): Promise<number> {
    const declared = this.ctx.card.extraStacks;
    const ids = p.stackIds ?? declared.filter((s) => !p.phase || s.reclaimPhase === p.phase).map((s) => s.id);
    if (!ids.length) return 0;
    if (p.action === 'destroy') {
      let partial = false;
      for (const id of ids) {
        const spec = declared.find((s) => s.id === id);
        const region = extraStackRegion(this.ctx, spec?.region ?? 'app');
        const ok = await this.deleteStack(this.stackName(id), region);
        if (!ok) partial = true;
      }
      if (partial) {
        this.result.exitCode = this.result.exitCode || 6;
        return 6;
      }
      return 0;
    }
    const lab = await this.labJson();
    for (const id of ids) {
      const spec = declared.find((s) => s.id === id);
      if (!spec) throw new StepFailure(2, `stack ${id} is not an extraStack of ${this.ctx.input.labId}`, { classification: { retryable: false, code: 'PROFILE_RULES' } });
      const region = extraStackRegion(this.ctx, spec.region);
      const def = ((lab.extraStacks ?? []) as { id: string; params?: Record<string, string>; outputs?: Record<string, string> }[]).find((s) => s.id === id) ?? { id };
      const templateFile = this.path(`stack-${id}.yaml`);
      await this.contentFile(`stacks/${this.ctx.input.labId}/${id}.yaml`, templateFile);
      const params = await this.resolveParams(def.params ?? {});
      const tags = { ...this.ctx.platformTags, 'atl:card-stack': id };
      const r = await this.aws(
        [
          'cloudformation',
          'deploy',
          '--stack-name',
          this.stackName(id),
          '--template-file',
          templateFile,
          '--no-fail-on-empty-changeset',
          '--capabilities',
          'CAPABILITY_IAM',
          'CAPABILITY_NAMED_IAM',
          ...(Object.keys(params).length ? ['--parameter-overrides', ...Object.entries(params).map(([k, v]) => `${k}=${v}`)] : []),
          '--tags',
          ...Object.entries(tags).map(([k, v]) => `${k}=${v}`),
        ],
        { region },
      );
      if (r.code !== 0) {
        const failures = await this.stackFailures(this.stackName(id), region);
        throw new StepFailure(3, `card stack ${id}: ${lastLines(r.stderr)}`, { cfnFailures: failures, classification: classifyCardStack(failures, r.stderr) });
      }
      const outputs = await this.stackOutputs(this.stackName(id), region);
      for (const [outKey, target] of Object.entries(def.outputs ?? {})) {
        const m = /^var\.([A-Za-z][A-Za-z0-9_]*)$/.exec(target);
        if (m && outputs[outKey] !== undefined) this.result.variables[m[1]!] = outputs[outKey]!;
      }
    }
    return 0;
  }

  private async labJson(): Promise<Json> {
    const file = this.path('lab.json');
    const body = await this.contentFile(`labs/${this.ctx.input.labId}.json`, file);
    return JSON.parse(body) as Json;
  }

  /** module-op: `platformOps[].args` of the action from the published lab JSON. */
  private async loadActionArgs(): Promise<Record<string, unknown>> {
    const actionId = String(this.ctx.input.args?.actionId ?? '');
    const lab = await this.labJson();
    const op = ((lab.platformOps ?? []) as { id: string; args?: Record<string, unknown> }[]).find((o) => o.id === actionId);
    return op?.args ?? {};
  }

  /** `{{ stack.<module>.<Output> }}`, `{{ env.<name> }}`, `{{ session.<name> }}` (04 §3.2.15). */
  private async resolveParams(params: Record<string, string>): Promise<Record<string, string>> {
    const out: Record<string, string> = {};
    const cache = new Map<string, Record<string, string>>();
    for (const [k, raw] of Object.entries(params)) {
      let v = raw;
      for (const m of raw.matchAll(/\{\{\s*([a-z]+)\.([A-Za-z0-9_-]+)(?:\.([A-Za-z0-9_]+))?\s*\}\}/g)) {
        const [all, scope, a, b] = m as unknown as [string, string, string, string | undefined];
        let value: string | undefined;
        if (scope === 'stack' && b) {
          const name = `cloudalbum-${this.ctx.envName}-${a}`;
          if (!cache.has(name)) cache.set(name, await this.stackOutputs(name, this.region));
          value = cache.get(name)![b];
        } else if (scope === 'env') {
          value = ({ envName: this.ctx.envName, envId: this.ctx.input.envId, region: this.region, drRegion: this.ctx.drRegion ?? undefined } as Record<string, string | undefined>)[a];
        } else if (scope === 'session') {
          value = ({ sessionId: this.ctx.input.sessionId, labId: this.ctx.input.labId } as Record<string, string>)[a];
        }
        if (value === undefined) throw new StepFailure(2, `card stack parameter ${k}: ${all} has no value`, { classification: { retryable: false, code: 'EXTRA_STACK_FAILED' } });
        v = v.replace(all, value);
      }
      out[k] = v;
    }
    return out;
  }

  private async stackOutputs(name: string, region: string): Promise<Record<string, string>> {
    const r = await this.aws(['cloudformation', 'describe-stacks', '--stack-name', name], { region });
    if (r.code !== 0) return {};
    const st = ((JSON.parse(r.stdout) as Json).Stacks as Json[] | undefined)?.[0];
    return Object.fromEntries(((st?.Outputs ?? []) as { OutputKey: string; OutputValue: string }[]).map((o) => [o.OutputKey, o.OutputValue]));
  }

  private async stackFailures(name: string, region: string): Promise<CfnFailure[]> {
    const r = await this.aws(['cloudformation', 'describe-stack-events', '--stack-name', name, '--max-items', '50'], { region });
    if (r.code !== 0) return [];
    const events = ((JSON.parse(r.stdout) as Json).StackEvents ?? []) as Json[];
    return events
      .filter((e) => /_FAILED$/.test(String(e.ResourceStatus)) && e.ResourceStatusReason && !/Resource creation cancelled/.test(String(e.ResourceStatusReason)))
      .slice(0, 10)
      .map((e) => ({ stack: name, logicalId: String(e.LogicalResourceId), status: String(e.ResourceStatus), reason: String(e.ResourceStatusReason) }));
  }

  /** Delete a stack and wait; missing = success. false (and a ledger entry) when it ends DELETE_FAILED. */
  private async deleteStack(name: string, region: string): Promise<boolean> {
    const d = await this.aws(['cloudformation', 'describe-stacks', '--stack-name', name], { region });
    if (d.code !== 0) return true; // does not exist
    await this.awsJson(['cloudformation', 'delete-stack', '--stack-name', name], { region });
    const w = await this.aws(['cloudformation', 'wait', 'stack-delete-complete', '--stack-name', name], { region });
    if (w.code === 0) return true;
    const failures = await this.stackFailures(name, region);
    await this.appendLedger({ name, region, result: 'DELETE_FAILED', resources: failures.map((f) => ({ logicalId: f.logicalId, status: f.status, reason: f.reason })) });
    this.result.cfnFailures.push(...failures);
    return false;
  }

  private async appendLedger(stack: Json): Promise<void> {
    const file = this.path(LEDGER_FILE);
    const cur = (await this.readJson(file)) ?? { schema: 'cloudalbum.ledger/v1', env: this.ctx.envName, envId: this.ctx.input.envId, generatedAt: this.host.now().toISOString(), stacks: [], outOfBand: [], policyAttachments: [], backups: [] };
    (cur.stacks as Json[]).push(stack);
    await this.host.writeFile(file, JSON.stringify(cur, null, 2));
  }

  /** The default VPC and its default subnet with the smallest AZ name (the workstation's placement, 03 §4.4). */
  private async defaultPlacement(): Promise<{ vpcId: string; subnetId: string }> {
    const vpcs = await this.awsJson(['ec2', 'describe-vpcs', '--filters', 'Name=is-default,Values=true']);
    const vpcId = String(((vpcs.Vpcs ?? []) as Json[])[0]?.VpcId ?? '');
    if (!vpcId) throw new StepFailure(3, 'workstation: the region has no default VPC (Preflight PREFLIGHT_NO_DEFAULT_VPC)');
    const subnets = await this.awsJson(['ec2', 'describe-subnets', '--filters', `Name=vpc-id,Values=${vpcId}`, 'Name=default-for-az,Values=true']);
    const list = ((subnets.Subnets ?? []) as Json[]).sort((a, b) => String(a.AvailabilityZone).localeCompare(String(b.AvailabilityZone)));
    const subnetId = String(list[0]?.SubnetId ?? '');
    if (!subnetId) throw new StepFailure(3, `workstation: the default VPC ${vpcId} has no default subnet`);
    return { vpcId, subnetId };
  }

  /** `atl-ws-<sid>` from the platform's workstation template (03; `--on-failure DELETE`). */
  private async workstationUp(): Promise<void> {
    const sid = this.ctx.input.sessionId;
    const name = `atl-ws-${sid}`;
    const tags = Object.entries({ ...this.ctx.platformTags, 'atl:component': 'workstation' }).map(([Key, Value]) => ({ Key, Value }));
    const env = this.opts.env ?? process.env;
    const bundleUri = env.ATL_WORKSTATION_BUNDLE_URI ?? '';
    const bundleSha = env.ATL_WORKSTATION_BUNDLE_SHA256 ?? '';
    if (!bundleUri || !bundleSha) throw new StepFailure(2, 'workstation: ATL_WORKSTATION_BUNDLE_URI / ATL_WORKSTATION_BUNDLE_SHA256 are not set (CodeBuild project variables)');
    const { vpcId, subnetId } = await this.defaultPlacement();
    // the template's parameters (platform/workstation/templates/atl-workstation.src.yaml); InstanceProfile keeps its default
    const params: Record<string, string> = {
      SessionId: sid,
      EnvName: this.ctx.envName,
      EnvId: this.ctx.input.envId,
      LabId: this.ctx.input.labId,
      VpcId: vpcId,
      SubnetId: subnetId,
      BundleUri: bundleUri,
      BundleSha256: bundleSha,
      ...(env.ATL_WORKSTATION_INSTANCE_TYPE ? { InstanceType: env.ATL_WORKSTATION_INSTANCE_TYPE } : {}),
    };
    const create = await this.aws([
      'cloudformation',
      'create-stack',
      '--stack-name',
      name,
      '--template-body',
      `file://${this.opts.srcDir}/${WORKSTATION_TEMPLATE}`,
      '--parameters',
      ...Object.entries(params).map(([k, v]) => `ParameterKey=${k},ParameterValue=${v}`),
      '--tags',
      JSON.stringify(tags),
      '--client-request-token',
      `${sid}-ws-create`,
      '--on-failure',
      'DELETE',
      '--capabilities',
      'CAPABILITY_IAM',
      'CAPABILITY_NAMED_IAM',
    ]);
    if (create.code !== 0 && !/AlreadyExistsException/.test(create.stderr)) throw new StepFailure(3, `workstation stack: ${lastLines(create.stderr)}`);
    const w = await this.aws(['cloudformation', 'wait', 'stack-create-complete', '--stack-name', name]);
    if (w.code !== 0) {
      const failures = await this.stackFailures(name, this.region);
      throw new StepFailure(3, `workstation stack ${name} did not reach CREATE_COMPLETE`, { cfnFailures: failures });
    }
  }

  private async workstationDown(): Promise<number> {
    const ok = await this.deleteStack(`atl-ws-${this.ctx.input.sessionId}`, this.region);
    if (ok) return 0;
    this.result.exitCode = this.result.exitCode || 6;
    return 6;
  }

  /** Read-only diagnosis: SSM state and the console output of the lab instance(s). */
  private async diagnose(): Promise<void> {
    const out = await this.awsJson(['ec2', 'describe-instances', '--filters', `Name=tag:atl:env-id,Values=${this.ctx.input.envId}`]);
    const ids = ((out.Reservations ?? []) as { Instances?: Json[] }[]).flatMap((r) => r.Instances ?? []).map((i) => String(i.InstanceId));
    for (const id of ids) {
      const c = await this.aws(['ec2', 'get-console-output', '--instance-id', id, '--latest']);
      if (c.code === 0) {
        const text = Buffer.from(String((JSON.parse(c.stdout) as Json).Output ?? ''), 'base64').toString('utf8');
        await this.host.writeFile(this.path(`console-${id}.txt`), text);
      }
    }
    this.result.warnings.push(`diagnose: ${ids.length} instance(s) inspected`);
  }
}

function lastLines(s: string, n = 5): string {
  return s.trim().split('\n').slice(-n).join(' | ').slice(0, 1000);
}

/** `KEY=value` of an env-style profile file (value may be quoted). */
export function envValue(body: string, key: string): string | null {
  const m = new RegExp(`^${key}=(.*)$`, 'm').exec(body);
  if (!m) return null;
  return m[1]!.trim().replace(/^(['"])(.*)\1$/, '$2');
}

/** The content manifest's SHA-256 of `rel` (accepts `{files: {path: sha | {sha256}}}`, `{files: [{path, sha256}]}` or a flat map). */
export function manifestSha(manifest: unknown, rel: string): string | null {
  const m = manifest as { files?: unknown } | null;
  const files = m && typeof m === 'object' && 'files' in m ? m.files : m;
  if (Array.isArray(files)) {
    const hit = files.find((f: { path?: string }) => f?.path === rel) as { sha256?: string } | undefined;
    return hit?.sha256 ?? null;
  }
  if (files && typeof files === 'object') {
    const v = (files as Record<string, unknown>)[rel];
    if (typeof v === 'string') return v.replace(/^sha256:/, '');
    if (v && typeof v === 'object' && typeof (v as { sha256?: unknown }).sha256 === 'string') return ((v as { sha256: string }).sha256).replace(/^sha256:/, '');
  }
  return null;
}

function classifyCardStack(failures: CfnFailure[], stderr: string): RunnerResult['classification'] {
  const text = [stderr, ...failures.map((f) => f.reason)].join('\n');
  if (/Rate exceeded|Throttl|InternalFailure|ServiceUnavailable/i.test(text)) return { retryable: true, code: 'EXTRA_STACK_FAILED' };
  return { retryable: false, code: 'EXTRA_STACK_FAILED' };
}

export const ADMIN_PARAM = SsmParams.appAdminPassword;
