/**
 * Dev `atl-runner`: a build is a local child process (or nothing) instead of CodeBuild.
 *  - `noop` (default): the build “runs” for ATL_DEV_RUNNER_NOOP_SECONDS of platform time and succeeds.
 *  - `dry-run`: runs `scripts/module … --dry-run` commands per ATL_OP (prints the AWS calls, needs no credentials).
 *  - `local-l0`: `base-deploy` starts a local CloudAlbum (LocalL0Launcher), `destroy` stops it, other ops are no-ops.
 * Each build writes `runs/<runId>/result.json` and `progress.jsonl` into the dev `atl-data` bucket like the real runner.
 * With an `account` (the dev reclaimer's in-memory AWS account), every mode also has the AWS side effects of its op, like
 * the real runner would: base-deploy registers the toolchain / ec2 stacks (the lab instance `i-dev-<envName>-lab` is the
 * local CloudAlbum in `local-l0` mode), the key pair and the `/cloudalbum/<envName>/atl/*` parameters; workstation-up /
 * -down the workstation stack; destroy deletes the environment's stacks and writes `ledger.json` (06 PM-36).
 * Commands can be overridden with a JSON file (ATL_DEV_RUNNER_COMMANDS): `{ "<op>": [["arg", …], …] }`, placeholders
 * `{envName}`, `{profile}`, `{runId}`, `{stateFile}`.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import {
  envNameFromEnvId,
  newUlid,
  PortError,
  RUNNER_ENV,
  encodeJsonArgs,
  type AtlOp,
  type ClockPort,
  type ObjectStorePort,
  type RunnerBuild,
  type RunnerBuildRequest,
  type RunnerPort,
} from '@atl/shared';
import type { DevRunnerMode } from '../config.js';
import type { DevEnvRegistry } from './envs.js';
import type { LocalL0Launcher } from './local-l0.js';

export type RunnerCommandTable = Partial<Record<AtlOp, string[][]>>;

/** Default dry-run commands (scripts/module global options are prepended). */
export const DEFAULT_DRY_RUN_COMMANDS: RunnerCommandTable = {
  'base-deploy': [['bootstrap'], ['base', 'deploy']],
  resume: [['status']],
  'profile-apply': [['profile', 'diff', '{profile}']],
  'module-op': [['status']],
  suspend: [['status']],
  destroy: [['status']],
  repair: [['status']],
  diagnose: [['status']],
  'extra-stack': [['status']],
  'workstation-up': [],
  'workstation-down': [],
};

export interface LocalProcessRunnerOptions {
  clock: ClockPort;
  mode: DevRunnerMode;
  noopSeconds: number;
  repoRoot: string;
  dataDir: string;
  objects: ObjectStorePort;
  dataBucket: string;
  envs: DevEnvRegistry;
  l0?: LocalL0Launcher;
  commands?: RunnerCommandTable;
  /** The dev reclaimer's in-memory account (structural: DevReclaimCloud of src/orchestrator-dev). */
  account?: DevAccount;
  region?: string;
  /** `ATL_PLATFORM_ORIGIN` written to the local L0's platform.env (06 PM-01; must be https). */
  platformOrigin?: string;
}

/** The parts of DevReclaimCloud the dev runner writes (src/orchestrator-dev/reclaim-cloud.ts). */
export interface DevAccount {
  addStack(s: { name: string; region: string; status: string; tags: Record<string, string> }, resources?: { type: string; id: string; logicalId?: string | null; tags?: Record<string, string> }[]): void;
  addResource(r: { type: string; region: string; id: string; tags?: Record<string, string> }): void;
  deleteStack(region: string, name: string): void;
  readonly stacks: Map<string, { name: string; region: string; status: string }>;
}

interface BuildState {
  build: RunnerBuild;
  child?: ChildProcess;
  abort: AbortController;
}

export class LocalProcessRunner implements RunnerPort {
  private readonly builds = new Map<string, BuildState>();

  constructor(private readonly o: LocalProcessRunnerOptions) {}

  async startBuild(req: RunnerBuildRequest): Promise<RunnerBuild> {
    const buildId = `atl-runner:${newUlid(this.o.clock.nowMs()).toLowerCase()}`;
    const build: RunnerBuild = {
      buildId,
      runId: req.runId,
      op: req.op,
      status: 'IN_PROGRESS',
      exitCode: null,
      startTime: this.o.clock.now().toISOString(),
      resultKey: `runs/${req.runId}/result.json`,
    };
    const st: BuildState = { build, abort: new AbortController() };
    this.builds.set(buildId, st);
    void this.execute(st, req);
    return { ...build };
  }

  async getBuild(buildId: string): Promise<RunnerBuild> {
    const st = this.builds.get(buildId);
    if (!st) throw new PortError('NotFound', `build not found: ${buildId}`);
    return { ...st.build };
  }

  async stopBuild(buildId: string): Promise<void> {
    const st = this.builds.get(buildId);
    if (!st || st.build.status !== 'IN_PROGRESS') return;
    st.abort.abort(new Error('stopped'));
    st.child?.kill();
    this.finish(st, 'STOPPED', null);
  }

  list(): RunnerBuild[] {
    return [...this.builds.values()].map((s) => ({ ...s.build }));
  }

  private finish(st: BuildState, status: RunnerBuild['status'], exitCode: number | null): void {
    if (st.build.status !== 'IN_PROGRESS') return;
    st.build.status = status;
    st.build.exitCode = exitCode;
    st.build.endTime = this.o.clock.now().toISOString();
  }

  private async progress(req: RunnerBuildRequest, line: Record<string, unknown>): Promise<void> {
    const key = `runs/${req.runId}/progress.jsonl`;
    const prev = (await this.o.objects.get(this.o.dataBucket, key)) ?? new Uint8Array();
    const next = Buffer.concat([Buffer.from(prev), Buffer.from(JSON.stringify({ at: this.o.clock.now().toISOString(), ...line }) + '\n')]);
    await this.o.objects.put(this.o.dataBucket, key, next);
  }

  private async execute(st: BuildState, req: RunnerBuildRequest): Promise<void> {
    const envName = envNameFromEnvId(req.envId);
    let exitCode = 0;
    const result: Record<string, unknown> = { runId: req.runId, op: req.op, mode: this.o.mode, sessionId: req.sessionId, envId: req.envId };
    try {
      await this.progress(req, { status: 'STARTED', op: req.op });
      this.o.envs.upsert(req.envId, { envName });
      if (this.o.mode === 'noop' || (this.o.mode === 'local-l0' && req.op !== 'base-deploy' && req.op !== 'destroy')) {
        await this.o.clock.sleep(this.o.noopSeconds * 1000, st.abort.signal);
      } else if (this.o.mode === 'local-l0') {
        if (!this.o.l0) throw new Error('local-l0 mode needs a LocalL0Launcher');
        if (req.op === 'base-deploy') {
          const inst = await this.o.l0.start(req.envId, envName, {
            sessionId: req.sessionId,
            labId: req.labId,
            ...(this.o.platformOrigin ? { origin: this.o.platformOrigin } : {}),
          });
          this.o.envs.upsert(req.envId, { baseUrl: inst.baseUrl, root: inst.root });
          result.endpoints = { baseUrl: inst.baseUrl, https: { trusted: false } };
        } else {
          await this.o.l0.stop(req.envId);
          this.o.envs.upsert(req.envId, { baseUrl: null });
        }
      } else {
        exitCode = await this.dryRun(st, req, envName, result);
      }
      if (exitCode === 0) await this.accountEffects(req, envName, result);
      result.ok = exitCode === 0;
      result.exitCode = exitCode;
    } catch (e) {
      if (st.abort.signal.aborted) return;
      exitCode = 1;
      result.ok = false;
      result.exitCode = 1;
      result.error = e instanceof Error ? e.message : String(e);
    }
    result.finishedAt = this.o.clock.now().toISOString();
    await this.o.objects.put(this.o.dataBucket, st.build.resultKey, JSON.stringify(result, null, 2));
    await this.progress(req, { status: exitCode === 0 ? 'SUCCEEDED' : 'FAILED', op: req.op, exitCode });
    this.finish(st, exitCode === 0 ? 'SUCCEEDED' : 'FAILED', exitCode);
  }

  private tags(req: RunnerBuildRequest): Record<string, string> {
    return { 'atl:env-id': req.envId, 'atl:session-id': req.sessionId, 'atl:lab-id': req.labId, 'atl:component': 'env', Project: 'CloudAlbum' };
  }

  /** The AWS side effects of the op on the dev account (what the real runner leaves in the account). */
  private async accountEffects(req: RunnerBuildRequest, envName: string, result: Record<string, unknown>): Promise<void> {
    const acct = this.o.account;
    if (!acct) return;
    const region = this.o.region ?? 'ap-northeast-1';
    const live = (name: string) => {
      const st = acct.stacks.get(`${region}|${name}`);
      return !!st && st.status !== 'DELETE_COMPLETE';
    };
    switch (req.op) {
      case 'base-deploy':
      case 'resume':
        if (!live(`cloudalbum-${envName}-toolchain`)) {
          acct.addStack({ name: `cloudalbum-${envName}-toolchain`, region, status: 'CREATE_COMPLETE', tags: this.tags(req) }, [
            { type: 'AWS::S3::Bucket', id: `cloudalbum-${envName}-toolchain-000000000000-${region}`, logicalId: 'ArtifactsBucket' },
          ]);
        }
        if (!live(`cloudalbum-${envName}-ec2`)) {
          acct.addStack({ name: `cloudalbum-${envName}-ec2`, region, status: 'CREATE_COMPLETE', tags: this.tags(req) }, [
            { type: 'AWS::EC2::Instance', id: `i-dev-${envName}-lab`, logicalId: 'Instance' },
            { type: 'AWS::EC2::SecurityGroup', id: `sg-dev-${envName}`, logicalId: 'SecurityGroup' },
          ]);
        }
        acct.addResource({ type: 'AWS::EC2::KeyPair', region, id: `cloudalbum-${envName}-key`, tags: this.tags(req) });
        acct.addResource({ type: 'AWS::SSM::Parameter', region, id: `/cloudalbum/${envName}/atl/ssh-key` });
        acct.addResource({ type: 'AWS::SSM::Parameter', region, id: `/cloudalbum/${envName}/atl/app-admin-password` });
        return;
      case 'workstation-up':
        if (!live(`atl-ws-${req.sessionId}`)) {
          acct.addStack({ name: `atl-ws-${req.sessionId}`, region, status: 'CREATE_COMPLETE', tags: { ...this.tags(req), 'atl:component': 'workstation' } }, [
            { type: 'AWS::EC2::Instance', id: `i-dev-${envName}-ws`, logicalId: 'Workstation' },
          ]);
        }
        return;
      case 'workstation-down':
        acct.deleteStack(region, `atl-ws-${req.sessionId}`);
        return;
      case 'destroy': {
        const stacks = [...acct.stacks.values()].filter((st) => st.name.startsWith(`cloudalbum-${envName}-`));
        for (const st of stacks) if (st.status !== 'DELETE_COMPLETE') acct.deleteStack(st.region, st.name);
        const ledger = {
          schema: 'cloudalbum.ledger/v1',
          env: envName,
          envId: req.envId,
          generatedAt: this.o.clock.now().toISOString(),
          stacks: stacks.map((st) => ({ name: st.name, region: st.region, result: 'DELETED', resources: [] })),
          outOfBand: [{ type: 'ec2-key-pair', id: `cloudalbum-${envName}-key`, region, createdBy: `atl-${req.sessionId}-prov-base-deploy` }],
          policyAttachments: [],
          backups: [],
        };
        await this.o.objects.put(this.o.dataBucket, `runs/${req.runId}/ledger.json`, JSON.stringify(ledger, null, 2));
        result.ledgerKey = `runs/${req.runId}/ledger.json`;
        return;
      }
      default:
        return;
    }
  }

  private async dryRun(st: BuildState, req: RunnerBuildRequest, envName: string, result: Record<string, unknown>): Promise<number> {
    const table = this.o.commands ?? DEFAULT_DRY_RUN_COMMANDS;
    const commands = table[req.op] ?? [];
    const stateFile = path.join(this.o.dataDir, 'state', envName, 'state.json');
    fs.mkdirSync(path.dirname(stateFile), { recursive: true });
    const cli = path.join(this.o.repoRoot, 'scripts', 'module-cli', 'dist', 'index.js');
    if (!fs.existsSync(cli)) throw new Error('scripts/module-cli/dist/index.js is missing: run npm run build first');
    const subst = (a: string) =>
      a
        .replaceAll('{envName}', envName)
        .replaceAll('{profile}', req.profile ?? 'l0')
        .replaceAll('{runId}', req.runId)
        .replaceAll('{stateFile}', stateFile);
    const outputs: { argv: string[]; exitCode: number; output: string }[] = [];
    for (const cmd of commands) {
      const argv = ['--env', envName, '--state', stateFile, '--dry-run', '-y', ...cmd.map(subst)];
      const { code, output } = await this.spawnNode(st, req, [cli, ...argv]);
      outputs.push({ argv, exitCode: code, output: output.slice(-8000) });
      await this.progress(req, { status: code === 0 ? 'STEP_DONE' : 'STEP_FAILED', command: argv.join(' ') });
      if (code !== 0) {
        result.commands = outputs;
        return code;
      }
    }
    result.commands = outputs;
    return 0;
  }

  private spawnNode(st: BuildState, req: RunnerBuildRequest, args: string[]): Promise<{ code: number; output: string }> {
    return new Promise((resolve, reject) => {
      const env: NodeJS.ProcessEnv = { ...process.env };
      for (const k of Object.keys(env)) if (/^AWS_/i.test(k)) delete env[k]; // never pick up real credentials
      Object.assign(env, {
        [RUNNER_ENV.op]: req.op,
        [RUNNER_ENV.runId]: req.runId,
        [RUNNER_ENV.sessionId]: req.sessionId,
        [RUNNER_ENV.envId]: req.envId,
        [RUNNER_ENV.labId]: req.labId,
        ...(req.args === undefined ? {} : { [RUNNER_ENV.args]: encodeJsonArgs(req.args) }),
        CLOUDALBUM_REPO_ROOT: this.o.repoRoot,
        ATL_DEV_MODE: '1',
      });
      const child = spawn(process.execPath, args, { cwd: this.o.repoRoot, env, stdio: ['ignore', 'pipe', 'pipe'] });
      st.child = child;
      let output = '';
      child.stdout.on('data', (d: Buffer) => (output += d.toString('utf8')));
      child.stderr.on('data', (d: Buffer) => (output += d.toString('utf8')));
      child.on('error', reject);
      child.on('close', (code) => resolve({ code: code ?? 1, output }));
    });
  }
}
