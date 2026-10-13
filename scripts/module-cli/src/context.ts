/**
 * Execution context of one scripts/module invocation: repository root, state.json, AWS gateway (real or dry-run),
 * printer and the delivery channel. --dry-run never writes state.json and never executes an AWS call or a remote script.
 */
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { ModuleId } from '@cloudalbum/contracts';
import { DryRunGateway, SdkGateway, type AwsGateway } from './aws.js';
import { SshDeliverer, SsmDeliverer, type Deliverer } from './deliver.js';
import { isPlatform, readPlatformEnv, type PlatformEnv } from './platform/env.js';
import { createPlatformRuntime, flushPlatform, queueSave, type PlatformRuntime } from './platform/runtime.js';
import { CliError, ConsolePrinter, EXIT, type Printer } from './printer.js';
import { defaultStatePath, loadState, newState, saveState, type CloudAlbumState } from './state.js';
import { describeStack } from './stack.js';
import { stackName } from './registry.js';

export interface GlobalOptions {
  env?: string;
  region?: string;
  state?: string;
  dryRun?: boolean;
  yes?: boolean;
  verbose?: boolean;
  host?: string;
  sshUser?: string;
  sshKey?: string;
  /** skip the local `check-config --plan` (backend not built) */
  skipLocalCheck?: boolean;
  /** platform mode (06 PM-26): also CLOUDALBUM_PLATFORM_MODE=1 */
  platform?: boolean;
  /** delivery channel override; platform mode accepts only ssm (06 PM-30) */
  delivery?: 'ssh' | 'ssm';
  /** development only: skip the PM-26 identity check (leaves a trace in state.json) */
  allowAnyIdentity?: boolean;
  /** seconds to wait for a busy environment lock (workstation 0, runner 900) */
  lockWait?: string;
  /** PM-35 */
  progressJsonl?: string;
  resultJson?: string;
}

export interface Ctx {
  repoRoot: string;
  env: string;
  region: string;
  stateFile: string;
  state: CloudAlbumState;
  aws: AwsGateway;
  out: Printer;
  dryRun: boolean;
  yes: boolean;
  opts: GlobalOptions;
  deliverer(): Deliverer;
  /** write state.json (standalone: local file; platform: queued S3 conditional write; never in --dry-run) */
  save(): void;
  /** wait for queued state writes (platform mode: throws STATE_CONFLICT, exit 8) */
  flush(): Promise<void>;
  /** platform mode runtime (identity, state bucket, lock, reports) */
  platform?: PlatformRuntime;
  /** value or `<placeholder>` in dry-run when unknown */
  ph(value: string | undefined, name: string): string;
}

export function findRepoRoot(start = path.dirname(fileURLToPath(import.meta.url))): string {
  if (process.env.CLOUDALBUM_REPO_ROOT && existsSync(path.join(process.env.CLOUDALBUM_REPO_ROOT, 'modules', 'registry.yaml'))) {
    return path.resolve(process.env.CLOUDALBUM_REPO_ROOT);
  }
  let dir = start;
  for (let i = 0; i < 8; i += 1) {
    if (existsSync(path.join(dir, 'modules', 'registry.yaml')) && existsSync(path.join(dir, 'infra'))) return dir;
    dir = path.dirname(dir);
  }
  throw new CliError('cannot find the repository root (modules/registry.yaml); set CLOUDALBUM_REPO_ROOT', EXIT.rules);
}

export interface ContextDeps {
  aws?: AwsGateway; out?: Printer; deliverer?: Deliverer; repoRoot?: string; state?: CloudAlbumState;
  /** platform mode: the variables (tests); default readPlatformEnv(process.env) */
  platformEnv?: PlatformEnv;
  /** command line recorded in the result / history */
  command?: string;
  /** pure commands (plan --start-of / --profile) never need the platform variables, the identity or the state bucket */
  noPlatform?: boolean;
}

export function createContext(opts: GlobalOptions, deps: ContextDeps = {}): Ctx {
  const repoRoot = deps.repoRoot ?? findRepoRoot();
  const platformEnv = deps.noPlatform ? undefined : (deps.platformEnv ?? (isPlatform(opts) ? readPlatformEnv() : undefined));
  const env = platformEnv?.env ?? opts.env ?? process.env.CLOUDALBUM_ENV ?? 'lab';
  if (!/^[a-z][a-z0-9-]{1,15}$/.test(env)) throw new CliError(`invalid env name "${env}"`, EXIT.rules);
  const region = platformEnv?.region ?? opts.region ?? process.env.AWS_REGION ?? process.env.AWS_DEFAULT_REGION ?? 'ap-northeast-1';
  const stateFile = path.resolve(opts.state ?? defaultStatePath(repoRoot));
  // platform mode: state.json lives in the state bucket and is loaded by preparePlatform() (06 PM-27)
  const state = deps.state ?? (platformEnv ? newState(env, region, 'platform') : loadState(stateFile, env, region));
  const out = deps.out ?? new ConsolePrinter(Boolean(opts.verbose));
  const dryRun = Boolean(opts.dryRun);
  const aws = deps.aws ?? (dryRun ? new DryRunGateway(out) : new SdkGateway(state.region || region, out));
  let deliverer = deps.deliverer;
  const ctx: Ctx = {
    repoRoot, env, region: state.region || region, stateFile, state, aws, out, dryRun, yes: Boolean(opts.yes), opts,
    deliverer() {
      if (deliverer) return deliverer;
      if (ctx.platform) {
        // platform mode: always SSM, never ssh (06 PM-30), even when SshIngressCidr is set
        if (opts.delivery === 'ssh') throw new CliError('platform mode delivers only through SSM (--delivery ssm)', EXIT.rules, 'DELIVERY_SSH_FORBIDDEN');
        const pe = ctx.platform.env;
        deliverer = new SsmDeliverer(aws, undefined, out, {
          envName: pe.env, envId: pe.envId, region: pe.region, commentSuffix: pe.runId ?? ctx.platform.opId,
          handoffPrefix: `/cloudalbum/${pe.env}/handoff/${ctx.platform.opId.toLowerCase()}`,
        });
        return deliverer;
      }
      const channel = opts.delivery ?? (state.modules['shell-access' as ModuleId]?.tier === 'aws' ? 'ssm' : state.delivery.channel);
      deliverer = channel === 'ssm'
        ? new SsmDeliverer(aws, state.base?.instanceId, out)
        : new SshDeliverer(
          (opts.host ?? state.delivery.host ?? state.base?.publicIp)
            ? { host: (opts.host ?? state.delivery.host ?? state.base?.publicIp)!, user: opts.sshUser ?? state.delivery.sshUser,
              ...((opts.sshKey ?? state.delivery.sshKeyPath) ? { keyPath: opts.sshKey ?? state.delivery.sshKeyPath } : {}) }
            : undefined,
          dryRun, out);
      return deliverer;
    },
    save() {
      if (ctx.platform) { queueSave(ctx, ctx.platform, deps.command ?? 'scripts/module'); return; }
      if (!dryRun) saveState(stateFile, state);
    },
    async flush() {
      if (ctx.platform) await flushPlatform(ctx.platform);
    },
    ph(value, name) {
      if (value) return value;
      if (dryRun) return `<${name}>`;
      throw new CliError(`${name} is unknown (state.json has no value; run \`scripts/module status --refresh\`)`, EXIT.rules);
    },
  };
  if (platformEnv) {
    ctx.platform = createPlatformRuntime(ctx, platformEnv, {
      ...(opts.progressJsonl ? { progressFile: opts.progressJsonl } : {}), ...(opts.resultJson ? { resultFile: opts.resultJson } : {}),
      command: deps.command ?? 'scripts/module',
    });
  }
  return ctx;
}

/**
 * Base context from the ec2 stack (9.1): refreshed from DescribeStacks / DescribeSubnets in real mode when missing.
 * In --dry-run the known values of state.json are used and the rest becomes placeholders.
 */
export async function ensureBase(ctx: Ctx, opts: { refresh?: boolean } = {}): Promise<void> {
  const s = ctx.state;
  if (!opts.refresh && s.base?.instanceId && s.base.defaultSubnetIds?.length) return;
  const name = stackName(ctx.env, 'ec2');
  const info = await describeStack(ctx.aws, name);
  if (info === undefined) return;                       // dry-run
  if (info === null) throw new CliError(`base stack ${name} does not exist: run \`scripts/module base deploy\` first`, EXIT.rules);
  const o = info.outputs;
  s.base = {
    ...(s.base ?? { params: {} }),
    stackName: name,
    instanceId: o.InstanceId, publicIp: o.PublicIp, publicDnsName: o.InfoPublicDnsName, securityGroupId: o.InstanceSecurityGroupId,
    vpcId: o.VpcId, subnetId: o.SubnetId, availabilityZone: o.AvailabilityZone, dataVolumeId: o.DataVolumeId,
    params: { ...(s.base?.params ?? {}), ...info.parameters },
  };
  if (!s.base.defaultSubnetIds?.length && s.base.vpcId) {
    const r = await ctx.aws.send<{ Subnets?: Array<{ SubnetId?: string; AvailabilityZone?: string }> }>({
      service: 'ec2', op: 'DescribeSubnets',
      input: { Filters: [{ Name: 'vpc-id', Values: [s.base.vpcId] }, { Name: 'default-for-az', Values: ['true'] }] },
    });
    const subnets = (r?.Subnets ?? []).filter((x) => x.SubnetId).sort((a, b) => String(a.AvailabilityZone).localeCompare(String(b.AvailabilityZone)));
    s.base.defaultSubnetIds = subnets.map((x) => x.SubnetId!);
  }
}
