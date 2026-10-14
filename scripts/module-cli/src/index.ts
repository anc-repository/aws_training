#!/usr/bin/env node
/**
 * scripts/module-cli — implementation of `scripts/module` (modular-design.md §9.2, §10):
 *   bootstrap | base deploy | enable | disable | status | plan [--single] | profile apply|diff|gen-single | teardown
 *   (+ release-meta and nginx-internal-endpoints, used by scripts/release and CI)
 *
 * Runs on the operator machine (your computer or CloudShell) with the deployer identity; local state .cloudalbum/state.json.
 * Every AWS call goes through one gateway and can be printed instead of executed with --dry-run (no credentials needed).
 * Exit codes: 0 ok; 2 dependency / rule violation; 3 stack deployment failed; 4 migration failed (rolled back);
 * 5 health probe failed (rolled back). Application processes use 78 for configuration errors (separate scheme).
 *
 * ATL platform mode (docs/platform/06 PM-26～PM-36; --platform or CLOUDALBUM_PLATFORM_MODE=1): caller identity check, state.json in
 * the state bucket (S3 conditional writes), environment lock in the lock table, platform stack tags and permission boundaries,
 * SSM-only delivery, progress / result / module-operation reports; extra exit codes 6 (destroy partial), 7 (lock), 8 (state conflict).
 * Platform subcommands: plan --start-of / --profile, profile gen-atl, profile apply --mode, hooks run --pending, seed, tls-preview,
 * env destroy --fast | suspend | resume, wait-stable, iam revoke-older-sessions | refresh-instance-credentials.
 */
import { Command, Option } from 'commander';
import { createContext, findRepoRoot, type Ctx, type GlobalOptions } from './context.js';
import {
  envDestroy, envSuspendResume, genAtlProfiles, hooksRun, iamPlatformAction, planProfileCommand, planStartOfCommand, seedCommand, statusJson,
  tlsPreviewCommand, waitStable,
} from './platform-cmds.js';
import { finishPlatform, moduleOp, preparePlatform } from './platform/runtime.js';
import { ReportingPrinter } from './platform/report.js';
import { configurePlatformTags, SESSION_TAG_KEYS } from './stack.js';
import { enableCommand, type EnableOptions } from './enable.js';
import { disableCommand, type DisableOptions } from './disable.js';
import { statusCommand } from './status.js';
import { bootstrapCommand, baseDeploy, teardownCommand, type BaseDeployOptions } from './bootstrap.js';
import { genSingle, profileApply, profileDiff } from './profile-cmd.js';
import { generateSingleProfile } from './profiles.js';
import { internalEndpointsBlock, writeInternalEndpoints, writeReleaseMeta } from './meta.js';
import { CliError, EXIT } from './printer.js';
import { parseModuleId } from './registry.js';
import { SINGLE_TARGET_SETTINGS, planEnable, resolveTarget } from './deps.js';
import { parseAssignments } from './env-file.js';
import { hookFor } from './module-hooks/index.js';

export { EXIT };

const collect = (v: string, prev: string[] = []) => [...prev, v];

function globals(cmd: Command): GlobalOptions {
  return cmd.optsWithGlobals() as GlobalOptions;
}

interface RunSpec {
  /** changes the environment: platform mode takes the environment lock (06 PM-28) */
  mutating?: boolean;
  /** command line (lock item, history, result) */
  op?: string;
  /** bootstrap / base deploy may create state.json */
  mayCreateState?: boolean;
  /** module-operation report (06 PM-35) */
  moduleOp?: { command: string; module?: string | null; driver?: string | null; profile?: string | null };
  /** pure computation (plan --start-of / --profile): no identity check, no state, no AWS call (CI has no credentials) */
  pure?: boolean;
}

function printError(e: CliError, platform: boolean): void {
  process.stderr.write(`ERROR ${e.message}\n`);
  // platform mode: machine-readable error on stdout (for example ENV_LOCK_BUSY with the holder, 06 PM-28)
  if (platform && e.code) process.stdout.write(`${JSON.stringify({ error: { code: e.code, message: e.message, ...(e.details ?? {}) } })}\n`);
}

async function run(cmd: Command, fn: (ctx: Ctx) => Promise<number>, spec: RunSpec = {}): Promise<void> {
  const g = globals(cmd);
  let ctx: Ctx;
  try {
    ctx = createContext(g, { ...(spec.op ? { command: spec.op } : {}), ...(spec.pure ? { noPlatform: true } : {}) });
  } catch (e) {
    if (!(e instanceof CliError)) throw e;
    printError(e, true);
    process.exitCode = e.exitCode;
    return;
  }
  const p = ctx.platform;
  let code: number = EXIT.ok;
  let error: CliError | undefined;
  try {
    if (p) {
      ctx.out = new ReportingPrinter(ctx.out, p.reporter);
      await preparePlatform(ctx, p, { mutating: Boolean(spec.mutating), op: spec.op ?? cmd.name(), ...(g.lockWait !== undefined ? { lockWait: Number(g.lockWait) } : {}),
        ...(g.allowAnyIdentity ? { allowAnyIdentity: true } : {}), ...(spec.mayCreateState ? { mayCreateState: true } : {}) });
      configurePlatformTags({
        env: ctx.state.platform?.platformTags ?? {},
        session: Object.fromEntries(Object.entries(p.env.tags).filter(([k]) => (SESSION_TAG_KEYS as readonly string[]).includes(k))),
      });
      if (spec.moduleOp) await moduleOp(p, 'started', spec.moduleOp, ctx.dryRun);
    }
    code = await fn(ctx);
    await ctx.flush();
  } catch (e) {
    error = e instanceof CliError ? e : new CliError((e as Error)?.stack ?? String(e), EXIT.rules);
    code = error.exitCode;
    printError(error, Boolean(p));
  } finally {
    if (p) {
      try {
        await ctx.flush();
      } catch (e) {
        if (e instanceof CliError && !error) { error = e; code = e.exitCode; printError(e, true); }
      }
      if (spec.moduleOp) await moduleOp(p, code === EXIT.ok ? 'succeeded' : 'failed', { ...spec.moduleOp, exitCode: code }, ctx.dryRun);
      await finishPlatform(p, code, error);
      configurePlatformTags(null);
    }
  }
  process.exitCode = code;
}

const lockWaitOption = () => new Option('--lock-wait <sec>', 'platform mode: wait for a busy environment lock (workstation 0, runner 900)');

export function buildProgram(): Command {
  const program = new Command('scripts/module')
    .description('CloudAlbum module tool (scripts/module): enable / disable AWS modules on top of the L0 EC2 base')
    .option('--env <name>', 'environment name (stack names cloudalbum-<env>-<id>)', process.env.CLOUDALBUM_ENV ?? 'lab')
    .option('--region <region>', 'AWS region (default ap-northeast-1 or $AWS_REGION)')
    .option('--state <file>', 'state file (default .cloudalbum/state.json)')
    .option('--dry-run', 'print every AWS call and remote script instead of executing it')
    .option('-y, --yes', 'do not ask for confirmation')
    .option('--host <address>', 'instance address for the ssh delivery channel (default: EIP from state.json)')
    .option('--ssh-user <user>', 'ssh user', 'ec2-user')
    .option('--ssh-key <file>', 'ssh private key')
    .option('--skip-local-check', 'skip the staged check-config --plan on the operator machine')
    .option('--verbose', 'print AWS calls in real mode too')
    .option('--platform', 'ATL platform mode (also CLOUDALBUM_PLATFORM_MODE=1): state bucket, lock table, SSM delivery, tags (06 PM-26)')
    .addOption(new Option('--delivery <channel>', 'delivery channel (platform mode is always ssm, 06 PM-30)').choices(['ssh', 'ssm']))
    .option('--allow-any-identity', 'platform mode, development only: skip the caller identity check (recorded in state.json)')
    .addOption(lockWaitOption())
    .option('--progress-jsonl <file>', 'platform mode: progress events, one JSON per line (- = stdout)')
    .option('--result-json <file>', 'platform mode: cloudalbum.module-result/v1 for the runner')
    .showHelpAfterError();

  program.command('bootstrap').description('create the toolchain stack cloudalbum-<env>-toolchain (artifact bucket)')
    .option('--release-file <path>', 'platform mode: upload cloudalbum-<ver>-<arch>.tgz to the toolchain bucket releases/<ver>/<arch>.tgz')
    .action(async (o: { releaseFile?: string }, cmd: Command) => run(cmd, (ctx) => bootstrapCommand(ctx, o),
      { mutating: true, mayCreateState: true, op: 'bootstrap' }));

  const base = program.command('base').description('ec2 base stack');
  base.command('deploy').description('first deployment of cloudalbum-<env>-ec2 (default VPC, pinned AMI, key pair, operator IP /32)')
    .option('--ssh-cidr <cidr>', 'SSH source (auto = this machine /32)', 'auto')
    .option('--admin-email <email>', 'initial administrator')
    .option('--key-name <name>', 'EC2 key pair name')
    .addOption(new Option('--arch <arch>', 'architecture').choices(['arm64', 'x86_64']).default('arm64'))
    .option('--instance-type <type>', 'instance type')
    .option('--subnet-id <id>', 'subnet (default: default subnet of <region>a)')
    .option('--app-archive-url <url>', 'release archive (scripts/release)')
    .option('--app-archive-sha256 <sha>', 'SHA-256 of the release archive')
    .option('--param <K=V>', 'extra base stack parameter (repeatable)', collect)
    .option('--instance-profile <name>', 'platform mode: CloudAlbumAppRole (the management channel, 06 PM-05)')
    .option('--disable-rollback', 'keep a failed first deployment for diagnosis (SSH in and read /var/log/cloudalbum-bootstrap.log)')
    .option('--retry-az', 'platform mode: on InsufficientInstanceCapacity retry once in another default subnet')
    .action(async (o: BaseDeployOptions, cmd: Command) => run(cmd, (ctx) => baseDeploy(ctx, o), { mutating: true, mayCreateState: true, op: 'base deploy' }));

  program.command('enable <id>').description('enable a module: deploy the stack, Outputs -> modules.d, PolicyArn, deliver, restart, probe')
    .option('--driver <value>', 'switch value, including local tiers (e.g. --driver memory, --driver worker)')
    .addOption(new Option('--mode <mode>', 'iam: role (default) or keys (anti-pattern)').choices(['role', 'keys']))
    .option('--self-hosted', 'database / cache: self-hosted on the EC2 instead of a stack (local tier)')
    .option('--with-deps', 'enable missing hard dependencies first (credentials: iam role)')
    .option('--no-migrate', 'skip the data migration (scripts/migrate/<id>)')
    .option('--param <K=V>', 'stack parameter (repeatable)', collect)
    .option('--set <K=V>', 'modules.d/<id>.env setting within ownsEnv (repeatable)', collect)
    .option('--skip-health', 'do not wait for the health probes')
    // module-specific options, interpreted by the module hooks (scripts/module-cli/src/module-hooks/<id>.ts)
    .option('--domain <name>', 'dns / tls: your own domain (manual prerequisite "domain"), e.g. album.example.com')
    .option('--zone-id <id>', 'dns / tls: existing Route 53 public hosted zone')
    .addOption(new Option('--target <type>', 'dns: record target (default: cdn -> cloudfront, load-balancer -> alb, else eip)').choices(['eip', 'alb', 'cloudfront']))
    .option('--no-acme', 'tls: do not probe the ACM ACME endpoint; TLS_ACME=off (exam form: ACM only on CloudFront / ALB)')
    .action(async (id: string, o: EnableOptions, cmd: Command) => run(cmd, (ctx) => enableCommand(ctx, parseModuleId(id), o),
      { mutating: true, op: `enable ${id}`, moduleOp: { command: 'enable', module: id, driver: o.driver ?? o.mode ?? null } }));

  program.command('disable <id>').description('disable a module: migrate data back, remove env, undo injects / policies / baseParams, delete the stack')
    .option('--cascade', 'disable dependent modules first (reverse topological order)')
    .option('--abandon-data', 'do not migrate data back (it stays in Retain resources)')
    .option('--no-migrate', 'alias of --abandon-data for modules without data')
    .option('--purge', 'also delete retained data resources (not implemented in this round)')
    .option('--skip-health', 'do not wait for the health probes')
    .option('--param <K=V>', 'platform action arguments (card platformOps args; passed to the module hook)', collect)
    .option('--reopen-ssh', 'shell-access: restore SshIngressCidr (reopen port 22) instead of keeping it closed')
    .action(async (id: string, o: DisableOptions, cmd: Command) => run(cmd, (ctx) => disableCommand(ctx, parseModuleId(id), o),
      { mutating: true, op: `disable ${id}`, moduleOp: { command: 'disable', module: id } }));

  program.command('status [id]').description('module status (state.json; --refresh reads the stacks)')
    .option('--refresh', 'read stack status and base outputs from CloudFormation')
    .option('--repair', 'rewrite modules.d/<id>.env from the recorded Outputs (CFG-004 half-enabled)')
    .option('--json', 'JSON output (platform mode: cloudalbum.status/v1)')
    .action(async (id: string | undefined, o: { refresh?: boolean; repair?: boolean; json?: boolean }, cmd: Command) =>
      run(cmd, async (ctx) => {
        if (ctx.platform && o.json && !o.repair) {
          process.stdout.write(`${JSON.stringify(await statusJson(ctx, o), null, 2)}\n`);
          return EXIT.ok;
        }
        if (o.repair && !id) {
          // every enabled module: rewrite modules.d/<id>.env from the recorded Outputs (the runner's repair op, 02 §8.4)
          for (const mid of Object.keys(ctx.state.modules)) {
            const code = await statusCommand(ctx, mid as Parameters<typeof statusCommand>[1], { repair: true });
            if (code !== EXIT.ok) return code;
          }
          return EXIT.ok;
        }
        return statusCommand(ctx, id ? parseModuleId(id) : undefined, o);
      }, { mutating: Boolean(o.repair), op: `status${o.repair ? ' --repair' : ''}` }));

  program.command('plan [id]').description('plan check only: dependencies, credentials, staged check-config --plan, env preview; '
    + '--start-of <card> / --profile atl/<card>/<variant>: start-state derivation and its digest (06 PM-32, PM-33)')
    .option('--single', 'plan from L0 (single-module mode, total outline 10.4) and print profiles/single/<id>.env')
    .option('--driver <value>', 'switch value')
    .option('--with-deps', 'include missing dependencies')
    .option('--set <K=V>', 'settings (repeatable)', collect)
    .option('--param <K=V>', 'stack parameter (repeatable)', collect)
    .option('--domain <name>', 'dns / tls: your own domain (without it the plan prints the hint and skips the module)')
    .option('--zone-id <id>', 'dns / tls: existing Route 53 public hosted zone')
    .addOption(new Option('--target <type>', 'dns: record target').choices(['eip', 'alb', 'cloudfront']))
    .option('--no-acme', 'tls: TLS_ACME=off without probing')
    .option('--start-of <card>', 'derive the start state of a card (labs/<card>/lab.yaml)')
    .option('--variant <id>', 'start variant (default: default)')
    .option('--lab-file <path>', 'lab.yaml outside labs/')
    .option('--profile <name>', 're-check a generated start profile atl/<card>/<variant> (same digest algorithm)')
    .option('--then <targets>', 'with --profile: module[:K=V,…],… enabled in this order (04 DRV-6)')
    .option('--no-rules', 'with --start-of: do not run the staged rule engine (backend not built)')
    .option('--json', 'JSON output')
    .action(async (id: string | undefined, o: EnableOptions & { single?: boolean; startOf?: string; variant?: string; labFile?: string; profile?: string; then?: string; rules?: boolean; json?: boolean }, cmd: Command) => run(cmd, async (ctx) => {
      if (o.startOf) {
        const r = planStartOfCommand(ctx, o.startOf, { ...(o.variant ? { variant: o.variant } : {}), ...(o.labFile ? { labFile: o.labFile } : {}), ...(o.rules === false ? { noRules: true } : {}) });
        if (o.json) process.stdout.write(`${JSON.stringify(r, null, 2)}\n`);
        else {
          ctx.out.section(`start state of ${r.card} (${r.variant}) -> ${r.profileName}`);
          for (const e of r.start) ctx.out.info(`  ${e.id.padEnd(17)} ${e.kind.padEnd(7)} ${(e.basis ?? '').padEnd(11)} ${JSON.stringify(e.set ?? e.value ?? {})}${e.because ? ` because ${e.because.join(',')}` : ''}`);
          ctx.out.info(`  platform ${JSON.stringify(r.platform)}  baseParams ${JSON.stringify(r.baseParams)}  digest ${r.digest}`);
          for (const w of r.warnings) ctx.out.warn(`  ${w}`);
        }
        return EXIT.ok;
      }
      if (o.profile) {
        const r = planProfileCommand(ctx, o.profile, { ...(o.then ? { then: o.then } : {}) });
        process.stdout.write(`${JSON.stringify(r, null, 2)}\n`);
        return EXIT.ok;
      }
      if (!id) throw new CliError('plan needs a module id, --start-of <card> or --profile <name>', EXIT.rules, 'USAGE');
      const mid = parseModuleId(id);
      if (o.single) {
        ctx.state.modules = {};
        ctx.out.section(`single-module profile for ${mid} (L0 + ${mid} + minimal dependencies)`);
        for (const l of generateSingleProfile(mid).trimEnd().split('\n')) ctx.out.info(`  ${l}`);
        const own = Object.entries(SINGLE_TARGET_SETTINGS[mid] ?? {}).map(([k, v]) => `${k}=${v}`);
        const t = resolveTarget(mid, { ...(o.driver ? { driver: o.driver } : {}), settings: parseAssignments([...own, ...(o.set ?? [])], '--set') });
        for (const h of hookFor(mid)?.planHints?.(t) ?? []) ctx.out.warn(`  ${mid}: ${h}`);
        const p = planEnable({}, t, { withDeps: true });
        if (p.issues.length) for (const i of p.issues) ctx.out.warn(`  ${i.rule}: ${i.message}`);
        return enableCommand(ctx, mid, { ...o, set: [...own, ...(o.set ?? [])], withDeps: true, planOnly: true });
      }
      return enableCommand(ctx, mid, { ...o, planOnly: true });
    }, { pure: Boolean(o.startOf || o.profile), op: 'plan' }));

  const profile = program.command('profile').description('preset profiles (profiles/*.env)');
  profile.command('apply <name>').description('apply a profile: disable extra modules (reverse topological), enable missing ones (topological)')
    .option('--with-optional', 'also enable PROFILE_OPTIONAL modules')
    .option('--no-migrate', 'skip data migrations')
    .addOption(new Option('--mode <mode>', 'fresh: full diff; additive: never disable (reused environments, 06 PM-32)').choices(['fresh', 'additive']).default('fresh'))
    .option('--repair', 'status --repair (rewrite every modules.d env from the recorded Outputs) before applying')
    .action(async (name: string, o: { withOptional?: boolean; migrate?: boolean; mode?: 'fresh' | 'additive'; repair?: boolean }, cmd: Command) => run(cmd, async (ctx) => {
      if (o.repair) for (const id of Object.keys(ctx.state.modules)) await statusCommand(ctx, id as Parameters<typeof statusCommand>[1], { repair: true });
      return profileApply(ctx, name, o);
    }, { mutating: true, op: `profile apply ${name}`, moduleOp: { command: 'profile apply', profile: name } }));
  profile.command('diff <name>').description('print what `profile apply` would do')
    .option('--with-optional', 'also consider PROFILE_OPTIONAL modules')
    .action(async (name: string, o: { withOptional?: boolean }, cmd: Command) => run(cmd, (ctx) => profileDiff(ctx, name, o)));
  profile.command('gen-single [ids...]').description('(re)generate profiles/single/<id>.env (--all: every module implemented in this round)')
    .option('--all', 'every implemented module')
    .action((ids: string[], o: { all?: boolean }) => {
      if (!o.all && !ids.length) throw new CliError('gen-single needs module ids or --all', EXIT.rules);
      genSingle(findRepoRoot(), o.all ? ['--all'] : ids, (l) => process.stdout.write(`${l}\n`));
    });

  profile.command('gen-atl').description('(re)generate profiles/atl/<card>/<variant>.env for every card and variant (labs:build, 06 PM-32)')
    .option('--card <id>', 'only this card')
    .option('--out <dir>', 'output directory (default profiles/atl)')
    .option('--no-rules', 'do not run the staged rule engine (backend not built)')
    .action((o: { card?: string; out?: string; rules?: boolean }) => {
      genAtlProfiles({ repoRoot: findRepoRoot(), opts: {} }, { ...(o.card ? { card: o.card } : {}), ...(o.out ? { out: o.out } : {}), ...(o.rules === false ? { noRules: true } : {}) },
        (l) => process.stdout.write(`${l}\n`));
    });

  program.command('wait-stable').description('wait until no cloudalbum-<env>-* stack is *_IN_PROGRESS (UPDATE_ROLLBACK_FAILED: continue-update-rollback)')
    .option('--timeout <sec>', 'seconds (default 1800)')
    .option('--skip-failed', 'continue-update-rollback skips the failed resources')
    .action(async (o: { timeout?: string; skipFailed?: boolean }, cmd: Command) => run(cmd, (ctx) => waitStable(ctx, o), { op: 'wait-stable' }));

  const envCmd = program.command('env').description('platform mode: environment lifecycle (02 §6.5, §8.2)');
  envCmd.command('destroy').description('stack-level teardown with a ledger (platform mode)')
    .option('--fast', 'required: delete stacks, record physical IDs, skip instance-side steps')
    .option('--ledger-out <file>', 'cloudalbum.ledger/v1 output (the runner uploads it)')
    .action(async (o: { fast?: boolean; ledgerOut?: string }, cmd: Command) => run(cmd, (ctx) => envDestroy(ctx, o), { mutating: true, op: 'env destroy' }));
  envCmd.command('suspend').description('stop the single instance and RDS (retained environments; platform mode)')
    .action(async (_o, cmd: Command) => run(cmd, (ctx) => envSuspendResume(ctx, 'suspend'), { mutating: true, op: 'env suspend' }));
  envCmd.command('resume').description('start them again, wait for running / PingStatus=Online, then cloudalbum platform-status')
    .action(async (_o, cmd: Command) => run(cmd, (ctx) => envSuspendResume(ctx, 'resume'), { mutating: true, op: 'env resume' }));

  program.command('seed <id>').description('test data seed (06 §11): cognito-test-users | gps-sample-photos (platform mode; idempotent)')
    .option('--owner <username>', 'gps-sample-photos: owner (default atl-test-1, else the administrator)')
    .action(async (id: string, o: { owner?: string }, cmd: Command) => run(cmd, (ctx) => seedCommand(ctx, id, o),
      { mutating: true, op: `seed ${id}`, moduleOp: { command: 'seed', module: null, profile: null } }));

  program.command('tls-preview <mode>').description('platform preview scheme B (06 PM-21): on | off')
    .action(async (mode: string, _o, cmd: Command) => run(cmd, (ctx) => {
      if (mode !== 'on' && mode !== 'off') throw new CliError('tls-preview on|off', EXIT.rules, 'USAGE');
      return tlsPreviewCommand(ctx, mode);
    }, { mutating: true, op: `tls-preview ${mode}`, moduleOp: { command: 'tls-preview', module: 'tls' } }));

  const hooks = program.command('hooks').description('platform hooks (06 PM-36)');
  hooks.command('run').description('run the pending hooks that need the learner identity (cognito-passwords)')
    .option('--pending', 'required')
    .action(async (o: { pending?: boolean }, cmd: Command) => run(cmd, (ctx) => hooksRun(ctx, o), { mutating: true, op: 'hooks run' }));

  const iam = program.command('iam').description('iam platform actions (runner only, ATL_OP=module-op; 06 PM-31)');
  iam.command('revoke-older-sessions').description('deny sessions issued before now on CloudAlbumAppRole (interrupts the management channel)')
    .option('--param <K=V>', 'platform action arguments (card platformOps args; none are used)', collect)
    .action(async (_o, cmd: Command) => run(cmd, (ctx) => iamPlatformAction(ctx, 'revoke-older-sessions'), { mutating: true, op: 'iam revoke-older-sessions' }));
  iam.command('refresh-instance-credentials').description('ReplaceIamInstanceProfileAssociation with the same profile (reboot otherwise), wait for PingStatus=Online')
    .option('--param <K=V>', 'platform action arguments (card platformOps args; none are used)', collect)
    .action(async (_o, cmd: Command) => run(cmd, (ctx) => iamPlatformAction(ctx, 'refresh-instance-credentials'), { mutating: true, op: 'iam refresh-instance-credentials' }));

  program.command('teardown').description('disable every module (reverse topological), delete toolchain and base stacks')
    .option('--purge-data', 'also delete retained data (not implemented in this round)')
    .action(async (o: { purgeData?: boolean }, cmd: Command) => run(cmd, (ctx) => {
      // platform mode: scripts/teardown is only an alias of env destroy (06 PM-32)
      if (ctx.platform) return envDestroy(ctx, { fast: true });
      return teardownCommand(ctx, o);
    }, { mutating: true, op: 'teardown' }));

  program.command('release-meta').description('write registry.json and hostsetup-order.txt for the release archive')
    .requiredOption('--out <dir>', 'output directory')
    .action((o: { out: string }) => { for (const f of writeReleaseMeta(o.out)) process.stdout.write(`wrote ${f}\n`); });

  program.command('nginx-internal-endpoints').description('check / regenerate the internalEndpoints locations of cloudalbum_locations.conf')
    .option('--write', 'rewrite the generated block')
    .action((o: { write?: boolean }) => {
      const root = findRepoRoot();
      if (o.write) { process.stdout.write(writeInternalEndpoints(root) ? 'updated\n' : 'up to date\n'); return; }
      const b = internalEndpointsBlock(root);
      if (b.current !== b.expected) { process.stderr.write(`stale block, expected:\n${b.expected}\n`); process.exitCode = EXIT.rules; }
      else process.stdout.write('up to date\n');
    });

  return program;
}

export async function main(argv: string[]): Promise<void> {
  try {
    await buildProgram().parseAsync(argv);
  } catch (e) {
    if (e instanceof CliError) {
      process.stderr.write(`ERROR ${e.message}\n`);
      process.exitCode = e.exitCode;
      return;
    }
    process.stderr.write(`ERROR ${(e as Error)?.stack ?? String(e)}\n`);
    process.exitCode = EXIT.rules;
  }
}

if (process.argv[1] && /module-cli[\\/](src|dist)[\\/]index\.(ts|js)$/.test(process.argv[1])) {
  await main(process.argv);
}
