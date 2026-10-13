/**
 * A scripted `atl-runner` for the lifecycle tests: builds take platform time on the (virtual) clock, write
 * `runs/<runId>/result.json` like the real buildspec, and have the side effects of their ATL_OP on the dev "account"
 * (DevReclaimCloud) and the dev environment registry: base-deploy creates the toolchain and base stacks, workstation-up
 * the workstation stack, profile-apply the module stacks of the card, destroy deletes the environment's stacks and
 * writes ledger.json. Failures are injected per op (exit codes of 06 PM-35, missing result.json, TIMED_OUT).
 */
import { envNameFromEnvId, PortError, type ClockPort, type RunnerBuild, type RunnerBuildRequest, type RunnerPort } from '@atl/shared';
import type { DevReclaimCloud, FakeResource } from '../../../src/orchestrator-dev/index.js';
import type { MemoryObjectStore } from './memory-objects.js';

export interface EnvRecord {
  envId: string;
  envName: string;
  baseUrl: string | null;
  instances: { lab: string; workstation: string };
}

export class MemoryEnvRegistry {
  readonly map = new Map<string, EnvRecord>();
  get(envId: string): EnvRecord | null {
    return this.map.get(envId) ?? null;
  }
}

export interface Failure {
  exitCode?: number;
  cfnFailures?: { stack: string; logicalId: string; status: string; reason: string }[];
  error?: string;
  status?: 'FAILED' | 'TIMED_OUT';
  noResult?: boolean;
  /** remaining injections */
  times?: number;
  classificationCode?: string;
}

export interface ScriptedRunnerOptions {
  clock: ClockPort;
  objects: MemoryObjectStore;
  dataBucket: string;
  region: string;
  envs: MemoryEnvRegistry;
  account: DevReclaimCloud;
  /** platform seconds per build (default 60) */
  seconds?: number;
  /** module stacks created by profile-apply: module id → resources */
  profileStacks?: Record<string, Omit<FakeResource, 'region' | 'stackName'>[]>;
}

interface State {
  build: RunnerBuild;
  req: RunnerBuildRequest;
}

export class ScriptedRunner implements RunnerPort {
  readonly builds = new Map<string, State>();
  readonly started: RunnerBuildRequest[] = [];
  private readonly failures = new Map<string, Failure[]>();
  private seq = 0;

  constructor(private readonly o: ScriptedRunnerOptions) {}

  /** Inject a failure for the next build(s) of `op` (or of a runId prefix). */
  fail(opOrRunPrefix: string, f: Failure): void {
    this.failures.set(opOrRunPrefix, [...(this.failures.get(opOrRunPrefix) ?? []), { times: 1, ...f }]);
  }

  list(): { buildId: string; runId: string; status: string }[] {
    return [...this.builds.values()].map((s) => ({ buildId: s.build.buildId, runId: s.build.runId, status: s.build.status }));
  }

  ops(): string[] {
    return this.started.map((r) => `${r.op}:${r.runId}`);
  }

  async startBuild(req: RunnerBuildRequest): Promise<RunnerBuild> {
    const buildId = `atl-runner:${String(++this.seq).padStart(4, '0')}`;
    const build: RunnerBuild = { buildId, runId: req.runId, op: req.op, status: 'IN_PROGRESS', exitCode: null, startTime: this.o.clock.now().toISOString(), resultKey: `runs/${req.runId}/result.json` };
    this.builds.set(buildId, { build, req });
    this.started.push(req);
    const seconds = this.o.seconds ?? 60;
    this.o.clock.setTimer(seconds * 1000, () => void this.finish(buildId, seconds));
    return { ...build };
  }

  async getBuild(buildId: string): Promise<RunnerBuild> {
    const s = this.builds.get(buildId);
    if (!s) throw new PortError('NotFound', buildId);
    return { ...s.build };
  }

  async stopBuild(buildId: string): Promise<void> {
    const s = this.builds.get(buildId);
    if (s && s.build.status === 'IN_PROGRESS') {
      s.build.status = 'STOPPED';
      s.build.endTime = this.o.clock.now().toISOString();
    }
  }

  private takeFailure(req: RunnerBuildRequest): Failure | null {
    for (const k of [req.runId, req.op]) {
      const list = this.failures.get(k);
      const f = list?.[0];
      if (f) {
        f.times = (f.times ?? 1) - 1;
        if (f.times <= 0) list!.shift();
        return f;
      }
    }
    for (const [k, list] of this.failures) {
      if (req.runId.startsWith(k) && list[0]) {
        const f = list[0];
        f.times = (f.times ?? 1) - 1;
        if (f.times <= 0) list.shift();
        return f;
      }
    }
    return null;
  }

  private async finish(buildId: string, seconds: number): Promise<void> {
    const s = this.builds.get(buildId);
    if (!s || s.build.status !== 'IN_PROGRESS') return;
    const req = s.req;
    const failure = this.takeFailure(req);
    let exitCode = 0;
    const result: Record<string, unknown> = { runId: req.runId, command: req.op, sessionId: req.sessionId, envId: req.envId, durationSeconds: seconds };
    if (failure) {
      exitCode = failure.exitCode ?? 3;
      Object.assign(result, {
        exitCode,
        phase: 'deploy-stack',
        cfnFailures: failure.cfnFailures ?? [],
        error: failure.error ?? null,
        classification: failure.classificationCode ? { code: failure.classificationCode } : null,
      });
    } else {
      this.effects(req);
      result.exitCode = 0;
    }
    if (req.op === 'destroy') await this.writeLedger(req);
    if (!failure?.noResult) await this.o.objects.put(this.o.dataBucket, `runs/${req.runId}/result.json`, JSON.stringify(result));
    s.build.exitCode = failure?.noResult ? null : exitCode;
    s.build.status = failure?.status ?? (exitCode === 0 ? 'SUCCEEDED' : 'FAILED');
    s.build.endTime = this.o.clock.now().toISOString();
  }

  private tags(req: RunnerBuildRequest): Record<string, string> {
    return { 'atl:env-id': req.envId, 'atl:session-id': req.sessionId, 'atl:lab-id': req.labId, 'atl:component': 'env', Project: 'CloudAlbum' };
  }

  private effects(req: RunnerBuildRequest): void {
    const envName = envNameFromEnvId(req.envId);
    const region = this.o.region;
    const acct = this.o.account;
    switch (req.op) {
      case 'base-deploy': {
        this.o.envs.map.set(req.envId, { envId: req.envId, envName, baseUrl: `http://${envName}.dev.invalid`, instances: { lab: `i-dev-${envName}-lab`, workstation: `i-dev-${envName}-ws` } });
        acct.addStack({ name: `cloudalbum-${envName}-toolchain`, region, status: 'CREATE_COMPLETE', tags: this.tags(req) }, [
          { type: 'AWS::S3::Bucket', id: `cloudalbum-${envName}-toolchain-000000000000-${region}`, logicalId: 'ArtifactsBucket' },
        ]);
        acct.addStack({ name: `cloudalbum-${envName}-ec2`, region, status: 'CREATE_COMPLETE', tags: this.tags(req) }, [
          { type: 'AWS::EC2::Instance', id: `i-dev-${envName}-lab`, logicalId: 'Instance' },
          { type: 'AWS::EC2::SecurityGroup', id: `sg-${envName}`, logicalId: 'SecurityGroup' },
        ]);
        acct.addResource({ type: 'AWS::EC2::KeyPair', region, id: `cloudalbum-${envName}-key`, tags: this.tags(req) });
        acct.addResource({ type: 'AWS::SSM::Parameter', region, id: `/cloudalbum/${envName}/atl/ssh-key` });
        acct.addResource({ type: 'AWS::SSM::Parameter', region, id: `/cloudalbum/${envName}/atl/app-admin-password` });
        return;
      }
      case 'workstation-up':
        acct.addStack({ name: `atl-ws-${req.sessionId}`, region, status: 'CREATE_COMPLETE', tags: { ...this.tags(req), 'atl:component': 'workstation' } }, [
          { type: 'AWS::EC2::Instance', id: `i-dev-${envName}-ws`, logicalId: 'Workstation' },
        ]);
        return;
      case 'workstation-down':
        acct.deleteStack(region, `atl-ws-${req.sessionId}`);
        return;
      case 'profile-apply':
        for (const [module, resources] of Object.entries(this.o.profileStacks ?? {})) {
          if (!acct.stacks.has(`${region}|cloudalbum-${envName}-${module}`) || acct.stacks.get(`${region}|cloudalbum-${envName}-${module}`)!.status === 'DELETE_COMPLETE') {
            acct.addStack({ name: `cloudalbum-${envName}-${module}`, region, status: 'CREATE_COMPLETE', tags: this.tags(req) }, resources);
          }
        }
        return;
      case 'extra-stack': {
        const args = (req.args ?? {}) as { stackIds?: string[] };
        for (const id of args.stackIds ?? []) acct.addStack({ name: `cloudalbum-${envName}-x-${id}`, region, status: 'CREATE_COMPLETE', tags: { ...this.tags(req), 'atl:card-stack': id } }, []);
        return;
      }
      case 'destroy':
        for (const st of [...acct.stacks.values()]) if (st.name.startsWith(`cloudalbum-${envName}-`) && st.status !== 'DELETE_COMPLETE') acct.deleteStack(st.region, st.name);
        return;
      default:
        return;
    }
  }

  /** The 06 ledger (`cloudalbum.ledger/v1`) of what destroy deleted / kept. */
  private async writeLedger(req: RunnerBuildRequest): Promise<void> {
    const envName = envNameFromEnvId(req.envId);
    const acct = this.o.account;
    const stacks = [...acct.stacks.values()].filter((s) => s.name.startsWith(`cloudalbum-${envName}-`));
    const ledger = {
      schema: 'cloudalbum.ledger/v1',
      env: envName,
      envId: req.envId,
      generatedAt: this.o.clock.now().toISOString(),
      stacks: stacks.map((s) => ({ name: s.name, region: s.region, result: s.status === 'DELETE_COMPLETE' ? 'DELETED' : 'DELETE_FAILED', resources: [] })),
      outOfBand: [{ type: 'ec2-key-pair', id: `cloudalbum-${envName}-key`, region: this.o.region, createdBy: `atl-${req.sessionId}-prov-base-deploy` }],
      policyAttachments: [{ policyArn: `arn:aws:iam::000000000000:policy/cloudalbum-${envName}-iam`, principal: 'role/CloudAlbumAppRole', detached: true }],
      backups: [],
    };
    await this.o.objects.put(this.o.dataBucket, `runs/${req.runId}/ledger.json`, JSON.stringify(ledger));
  }
}
