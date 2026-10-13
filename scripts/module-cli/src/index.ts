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
 */
import { Command, Option } from 'commander';
import { createContext, findRepoRoot, type GlobalOptions } from './context.js';
import { enableCommand, type EnableOptions } from './enable.js';
import { disableCommand, type DisableOptions } from './disable.js';
import { statusCommand } from './status.js';
import { bootstrapCommand, baseDeploy, teardownCommand, type BaseDeployOptions } from './bootstrap.js';
import { genSingle, profileApply, profileDiff } from './profile-cmd.js';
import { generateSingleProfile } from './profiles.js';
import { internalEndpointsBlock, writeInternalEndpoints, writeReleaseMeta } from './meta.js';
import { CliError, EXIT } from './printer.js';
import { parseModuleId } from './registry.js';
import { planEnable, resolveTarget } from './deps.js';

export { EXIT };

const collect = (v: string, prev: string[] = []) => [...prev, v];

function globals(cmd: Command): GlobalOptions {
  return cmd.optsWithGlobals() as GlobalOptions;
}

async function run(cmd: Command, fn: (ctx: ReturnType<typeof createContext>) => Promise<number>): Promise<void> {
  const ctx = createContext(globals(cmd));
  process.exitCode = await fn(ctx);
}

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
    .showHelpAfterError();

  program.command('bootstrap').description('create the toolchain stack cloudalbum-<env>-toolchain (artifact bucket)')
    .action(async (_o, cmd: Command) => run(cmd, (ctx) => bootstrapCommand(ctx)));

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
    .action(async (o: BaseDeployOptions, cmd: Command) => run(cmd, (ctx) => baseDeploy(ctx, o)));

  program.command('enable <id>').description('enable a module: deploy the stack, Outputs -> modules.d, PolicyArn, deliver, restart, probe')
    .option('--driver <value>', 'switch value, including local tiers (e.g. --driver memory, --driver worker)')
    .addOption(new Option('--mode <mode>', 'iam: role (default) or keys (anti-pattern)').choices(['role', 'keys']))
    .option('--self-hosted', 'database / cache: self-hosted on the EC2 instead of a stack (local tier)')
    .option('--with-deps', 'enable missing hard dependencies first (credentials: iam role)')
    .option('--no-migrate', 'skip the data migration (scripts/migrate/<id>)')
    .option('--param <K=V>', 'stack parameter (repeatable)', collect)
    .option('--set <K=V>', 'modules.d/<id>.env setting within ownsEnv (repeatable)', collect)
    .option('--skip-health', 'do not wait for the health probes')
    .action(async (id: string, o: EnableOptions, cmd: Command) => run(cmd, (ctx) => enableCommand(ctx, parseModuleId(id), o)));

  program.command('disable <id>').description('disable a module: migrate data back, remove env, undo injects / policies / baseParams, delete the stack')
    .option('--cascade', 'disable dependent modules first (reverse topological order)')
    .option('--abandon-data', 'do not migrate data back (it stays in Retain resources)')
    .option('--no-migrate', 'alias of --abandon-data for modules without data')
    .option('--purge', 'also delete retained data resources (not implemented in this round)')
    .option('--skip-health', 'do not wait for the health probes')
    .action(async (id: string, o: DisableOptions, cmd: Command) => run(cmd, (ctx) => disableCommand(ctx, parseModuleId(id), o)));

  program.command('status [id]').description('module status (state.json; --refresh reads the stacks)')
    .option('--refresh', 'read stack status and base outputs from CloudFormation')
    .option('--repair', 'rewrite modules.d/<id>.env from the recorded Outputs (CFG-004 half-enabled)')
    .option('--json', 'JSON output')
    .action(async (id: string | undefined, o: { refresh?: boolean; repair?: boolean; json?: boolean }, cmd: Command) =>
      run(cmd, (ctx) => statusCommand(ctx, id ? parseModuleId(id) : undefined, o)));

  program.command('plan <id>').description('plan check only: dependencies, credentials, staged check-config --plan, env preview')
    .option('--single', 'plan from L0 (single-module mode, total outline 10.4) and print profiles/single/<id>.env')
    .option('--driver <value>', 'switch value')
    .option('--with-deps', 'include missing dependencies')
    .option('--set <K=V>', 'settings (repeatable)', collect)
    .action(async (id: string, o: EnableOptions & { single?: boolean }, cmd: Command) => run(cmd, async (ctx) => {
      const mid = parseModuleId(id);
      if (o.single) {
        ctx.state.modules = {};
        ctx.out.section(`single-module profile for ${mid} (L0 + ${mid} + minimal dependencies)`);
        for (const l of generateSingleProfile(mid).trimEnd().split('\n')) ctx.out.info(`  ${l}`);
        const p = planEnable({}, resolveTarget(mid, o.driver ? { driver: o.driver } : {}), { withDeps: true });
        if (p.issues.length) for (const i of p.issues) ctx.out.warn(`  ${i.rule}: ${i.message}`);
        return enableCommand(ctx, mid, { ...o, withDeps: true, planOnly: true });
      }
      return enableCommand(ctx, mid, { ...o, planOnly: true });
    }));

  const profile = program.command('profile').description('preset profiles (profiles/*.env)');
  profile.command('apply <name>').description('apply a profile: disable extra modules (reverse topological), enable missing ones (topological)')
    .option('--with-optional', 'also enable PROFILE_OPTIONAL modules')
    .option('--no-migrate', 'skip data migrations')
    .action(async (name: string, o: { withOptional?: boolean; migrate?: boolean }, cmd: Command) => run(cmd, (ctx) => profileApply(ctx, name, o)));
  profile.command('diff <name>').description('print what `profile apply` would do')
    .option('--with-optional', 'also consider PROFILE_OPTIONAL modules')
    .action(async (name: string, o: { withOptional?: boolean }, cmd: Command) => run(cmd, (ctx) => profileDiff(ctx, name, o)));
  profile.command('gen-single [ids...]').description('(re)generate profiles/single/<id>.env (--all: every module implemented in this round)')
    .option('--all', 'every implemented module')
    .action((ids: string[], o: { all?: boolean }) => {
      if (!o.all && !ids.length) throw new CliError('gen-single needs module ids or --all', EXIT.rules);
      genSingle(findRepoRoot(), o.all ? ['--all'] : ids, (l) => process.stdout.write(`${l}\n`));
    });

  program.command('teardown').description('disable every module (reverse topological), delete toolchain and base stacks')
    .option('--purge-data', 'also delete retained data (not implemented in this round)')
    .action(async (o: { purgeData?: boolean }, cmd: Command) => run(cmd, (ctx) => teardownCommand(ctx, o)));

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
