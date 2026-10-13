/**
 * `ATL_OP` → steps (02 §4.3 command table, `base-deploy` steps 1–6, `profile-apply` steps ⓪–⑤, 06 PM-32 commands).
 * Pure: the executor (`execute.ts`) runs them. `module` steps run `scripts/module … --platform` with progress and result
 * files; `task` steps are the runner's own direct calls (key pair, admin password, profile download, card stacks …).
 */
import { keyPairName, SsmParams, type AtlOp } from '@atl/shared';
import type { RunnerContext } from './context.js';

/** Phase names of the progress lines and result.json (06 PM-35). */
export type Phase = 'plan' | 'lock' | 'deploy-stack' | 'injects' | 'policy' | 'migrate' | 'deliver' | 'check-config' | 'restart' | 'health' | 'finalize' | 'destroy' | 'seed' | 'preview';

export type TaskName =
  | 'create-key-pair'
  | 'apply-platform-env'
  | 'probe-token'
  | 'admin-init'
  | 'download-profile'
  | 'verify-profile-digest'
  | 'seeds'
  | 'archive-state'
  | 'extra-stacks'
  | 'workstation-up'
  | 'workstation-down'
  | 'diagnose';

export type Step =
  | {
      kind: 'module';
      id: string;
      phase: Phase;
      /** arguments after `scripts/module` (without `--platform` and the report options) */
      args: string[];
      /** the command takes the environment operation lock (`--lock-wait 900`, 06 PM-28) */
      lock: boolean;
      /** exit codes that do not fail the build (destroy: 6 = partly deleted, continue with the reclaimer) */
      okExit?: number[];
    }
  | { kind: 'task'; id: string; phase: Phase; task: TaskName; params?: Record<string, unknown> };

const m = (id: string, phase: Phase, args: string[], lock = true, okExit?: number[]): Step => ({ kind: 'module', id, phase, args, lock, ...(okExit ? { okExit } : {}) });
const t = (id: string, phase: Phase, task: TaskName, params?: Record<string, unknown>): Step => ({ kind: 'task', id, phase, task, ...(params ? { params } : {}) });

export const LEDGER_FILE = 'ledger.json';

/** `extras.actionArgs`: the card's `platformOps[].args` of the module-op action (from the published lab JSON). */
export function planOp(ctx: RunnerContext, extras: { actionArgs?: Record<string, unknown> } = {}): Step[] {
  const env = ctx.envName;
  const op: AtlOp = ctx.input.op;
  switch (op) {
    case 'base-deploy':
      return [
        // 1. toolchain stack + release package (PM-30)
        m('bootstrap', 'deploy-stack', ['bootstrap', '--env', env, '--release-file', '${RELEASE_FILE}']),
        // 2. session key pair (not AWS::EC2::KeyPair: its private key would land in /ec2/keypair/*)
        t('key-pair', 'deploy-stack', 'create-key-pair', { keyName: keyPairName(env), param: SsmParams.sshKey(env) }),
        // 3. base stack with SSM delivery, instance profile CloudAlbumAppRole, AZ retry on capacity
        m('base', 'deploy-stack', ['base', 'deploy', '--env', env, '--delivery', 'ssm', '--instance-profile', 'CloudAlbumAppRole', '--key-name', keyPairName(env), '--disable-rollback', '--retry-az']),
        // 4.–6. platform.env, probe key, admin (hash only)
        t('platform-env', 'deliver', 'apply-platform-env'),
        t('probe-token', 'deliver', 'probe-token'),
        t('admin', 'deliver', 'admin-init', { param: SsmParams.appAdminPassword(env), email: 'atl-admin@example.com' }),
      ];
    case 'resume':
      return [m('resume', 'deploy-stack', ['env', 'resume'])];
    case 'profile-apply': {
      const profile = ctx.input.profile!;
      const steps: Step[] = [];
      if (ctx.input.applyMode === 'additive') steps.push(t('apply-env', 'deliver', 'apply-platform-env')); // ⓪ reused environment
      steps.push(t('profile', 'plan', 'download-profile', { profile }));
      steps.push(m('plan', 'plan', ['plan', '--profile', profile, '--json'], false));
      steps.push(t('digest', 'plan', 'verify-profile-digest', { profile }));
      steps.push(m('apply', 'deploy-stack', ['profile', 'apply', profile, '--mode', ctx.input.applyMode ?? 'fresh', ...(ctx.input.repair ? ['--repair'] : []), '--yes']));
      steps.push(t('seeds', 'seed', 'seeds', { profile }));
      return steps;
    }
    case 'workstation-up':
      return [t('workstation', 'deploy-stack', 'workstation-up')];
    case 'workstation-down':
      return [t('workstation', 'destroy', 'workstation-down')];
    case 'module-op':
      return moduleOpSteps(ctx, extras.actionArgs ?? {});
    case 'suspend':
      return [m('suspend', 'deploy-stack', ['env', 'suspend'])];
    case 'destroy':
      return [
        t('archive', 'finalize', 'archive-state'),
        t('card-stacks-before', 'destroy', 'extra-stacks', { action: 'destroy', phase: 'before-modules' }),
        m('destroy', 'destroy', ['env', 'destroy', '--fast', '--ledger-out', LEDGER_FILE], true, [6]),
        t('card-stacks-after', 'destroy', 'extra-stacks', { action: 'destroy', phase: 'after-modules' }),
      ];
    case 'repair':
      return [
        m('status-repair', 'finalize', ['status', '--repair']),
        t('apply-env', 'deliver', 'apply-platform-env'),
        ...(ctx.input.profile ? [t('profile', 'plan', 'download-profile', { profile: ctx.input.profile }), m('reapply', 'deploy-stack', ['profile', 'apply', ctx.input.profile, '--mode', 'additive', '--repair', '--yes'])] : []),
      ];
    case 'diagnose':
      return [m('status', 'health', ['status', '--json'], false), t('diagnose', 'health', 'diagnose')];
    case 'extra-stack': {
      const a = ctx.input.args as { action: 'deploy' | 'destroy'; stackIds: string[] };
      return [t('card-stacks', a.action === 'deploy' ? 'deploy-stack' : 'destroy', 'extra-stacks', { action: a.action, stackIds: a.stackIds })];
    }
    default: {
      const never: never = op;
      throw new Error(`unknown ATL_OP ${String(never)}`);
    }
  }
}

/**
 * module-op: the action must be one of the card's platform actions (the registry `platformActions` whitelist is enforced
 * again by scripts/module). `op: enable|disable` → `scripts/module <op> <module>`; any other op is a module command
 * (`scripts/module iam revoke-older-sessions`, PM-31). Card `args` become `--param K=V`.
 */
export function moduleOpSteps(ctx: RunnerContext, cardArgs: Record<string, unknown> = {}): Step[] {
  const actionId = String(ctx.input.args?.actionId ?? '');
  const action = ctx.card.platformActions.find((a) => a.id === actionId);
  if (!action || !action.module) throw new Error(`platform action ${actionId} is not on the card`);
  const params = Object.entries(cardArgs).flatMap(([k, v]) => ['--param', `${k}=${typeof v === 'string' ? v : JSON.stringify(v)}`]);
  const args = action.op === 'enable' || action.op === 'disable' ? [action.op, action.module, ...params] : [action.module, action.op, ...params];
  return [m('module-op', 'deploy-stack', args)];
}
