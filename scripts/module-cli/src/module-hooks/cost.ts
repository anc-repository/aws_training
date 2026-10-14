/**
 * scripts/module hook of cost. Contract: ./types.ts.
 * Design: docs/modules/06-governance-cost.md#cost (section 6 "切换、数据迁移与回滚", section 0 registry entry, section 12 platform
 * mode; convention 8 "谁创建谁清理"). What this module needs beyond the generic flow:
 *   - ProjectBudgetLimit / AccountBudgetLimit are required stack parameters WITHOUT defaults: enable stops with exit 2 and a hint
 *     when they are missing; this project never suggests an amount (D14: "金额请根据自己的承受能力决定；本项目不提供参考价格").
 *     `scripts/module plan` only prints the hint (read-only preview).
 *   - preflight cost-allocation-tag-active (ce:ListCostAllocationTags): only warns — the project budget stays at 0 until the tag
 *     is active, which is itself a comparison point. preflight policy-quota is generic (policy.ts).
 *   - out of band after the deployment: activate the cost allocation tags Project and Module (ce:UpdateCostAllocationTagsStatus,
 *     deployer identity). Platform mode: the learner boundary does not allow it — the step is skipped with the platform action
 *     cost-activate-tags (registry operation activateCostAllocationTags, 06 PM-30 / PM-34); the runner may perform it.
 *     The tags are never deactivated on disable (convention 8: deactivating breaks the history grouped by the tag).
 *   - disable: the budgets, the optional Budgets Action, the canary role and the topic are deleted with the stack.
 */
import type { Ctx } from '../context.js';
import { CliError, EXIT } from '../printer.js';
import type { ModuleHook } from './types.js';

const AMOUNT_RE = /^[0-9]{1,6}(\.[0-9]{1,2})?$/;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
/** cost allocation tags activated by enable cost (all module stacks carry them as stack-level tags, modular-design 9.1) */
export const COST_TAG_KEYS = ['Project', 'Module'] as const;
export const PLATFORM_ACTION = 'cost-activate-tags';

/**
 * Manual prerequisites, printed by plan() (enable / plan / plan --single). Deliberately not returned by planHints(): hints become
 * `plan --start-of` warnings, which labs:derive (DRV-6) only accepts when they are rule ids listed in expectedWarnings.
 */
export const COST_PREREQ_NOTES = [
  'manual prerequisite cost-allocation-tag: the Project tag must be active (new keys appear after some time and activation takes effect later, per the official documentation; platform mode: platform action cost-activate-tags, ahead of time)',
  'manual prerequisite confirm-email: confirm the SNS subscription of the cost topic',
] as const;

const AMOUNT_HINT = 'scripts/module enable cost --param ProjectBudgetLimit=<amount> --param AccountBudgetLimit=<amount> [--param AlertEmail=<address>]'
  + ' (choose the amounts yourself; this project quotes no price)';

export interface TagActivation {
  activated: string[];
  errors: Array<{ key: string; code: string; message: string }>;
  skipped?: { api: string; platformAction: string };
}

/** Is the caller allowed to activate cost allocation tags? Platform mode: only the runner (provisioner), never the learner. */
export function mayActivateTags(ctx: Pick<Ctx, 'platform'>): boolean {
  const kind = ctx.platform?.identity?.kind;
  return !ctx.platform || kind === 'provisioner' || kind === 'any';
}

/**
 * ce:UpdateCostAllocationTagsStatus (out of band, deployer identity; also the body of the platform action
 * `cost activate-allocation-tags --keys Project,atl:lab-id`). Tag keys appear in the activation list only some time after the
 * first tagged resource exists, and activation takes effect only later (both per the official documentation); errors per key
 * are reported, not thrown. Recorded in state.json outOfBand (never deactivated).
 */
export async function activateCostAllocationTags(ctx: Ctx, keys: readonly string[]): Promise<TagActivation> {
  if (!mayActivateTags(ctx)) {
    return { activated: [], errors: [], skipped: { api: 'ce:UpdateCostAllocationTagsStatus', platformAction: PLATFORM_ACTION } };
  }
  const r = await ctx.aws.send<{ Errors?: Array<{ TagKey?: string; Code?: string; Message?: string }> }>({
    service: 'ce', op: 'UpdateCostAllocationTagsStatus',
    input: { CostAllocationTagsStatus: keys.map((k) => ({ TagKey: k, Status: 'Active' })) },
  });
  if (ctx.dryRun) return { activated: [...keys], errors: [] };
  const errors = (r?.Errors ?? []).map((e) => ({ key: e.TagKey ?? '?', code: e.Code ?? 'Error', message: e.Message ?? '' }));
  const failed = new Set(errors.map((e) => e.key));
  const activated = keys.filter((k) => !failed.has(k));
  if (activated.length) {
    const id = activated.join(',');
    ctx.state.outOfBand = ctx.state.outOfBand.filter((x) => !(x.module === 'cost' && x.kind === 'cost-allocation-tags'));
    ctx.state.outOfBand.push({
      module: 'cost', kind: 'cost-allocation-tags', id, at: new Date().toISOString(), region: 'us-east-1',
      detail: { note: 'never deactivated by disable cost (06 convention 8)' },
    });
  }
  return { activated, errors };
}

export const costHook: ModuleHook = {
  id: 'cost',

  plan(_ctx, step, args) {
    if (step.tier !== 'aws' || !args.isTarget) return {};
    const p = args.params;
    for (const k of ['ProjectBudgetLimit', 'AccountBudgetLimit'] as const) {
      if (p[k] !== undefined && !AMOUNT_RE.test(p[k]!)) {
        throw new CliError(`cost: --param ${k} must be an amount like 20 or 12.50 in the billing currency (got "${p[k]}")`, EXIT.rules, 'PARAM_INVALID');
      }
    }
    if (p.AlertEmail && !EMAIL_RE.test(p.AlertEmail)) throw new CliError(`cost: --param AlertEmail is not an e-mail address ("${p.AlertEmail}")`, EXIT.rules, 'PARAM_INVALID');
    if (p.EnableBudgetAction !== undefined && !['true', 'false'].includes(p.EnableBudgetAction)) {
      throw new CliError('cost: --param EnableBudgetAction must be true | false', EXIT.rules, 'PARAM_INVALID');
    }
    const notes: string[] = [
      'the amounts are yours to decide; this project quotes no price (D14). Budgets monitoring and notifications are free; a budget with Actions and Cost Explorer API requests are billed (official pricing page)',
      ...COST_PREREQ_NOTES,
    ];
    if (p.EnableBudgetAction === 'true') notes.push('EnableBudgetAction=true: the action only attaches AWSDenyAll to the canary role cloudalbum-<env>-cost-canary (used by nothing)');
    const missingAmounts = ['ProjectBudgetLimit', 'AccountBudgetLimit'].filter((k) => !p[k]);
    if (!missingAmounts.length) return { notes };
    if (args.planOnly) {
      // read-only preview: the env preview does not need the amounts; enable will ask for them
      notes.push(`${missingAmounts.join(' / ')} not given: enable needs them -> ${AMOUNT_HINT}`);
      return { notes };
    }
    return {
      notes,
      missing: [{ prerequisite: 'budget-amounts', message: `${missingAmounts.join(' and ')} have no default (this project quotes no price)`, hint: AMOUNT_HINT }],
    };
  },

  async prepare(ctx, step, _args, prep) {
    if (step.tier !== 'aws') return;
    // preflight cost-allocation-tag-active: warn only (the project budget shows 0 until the tag is active)
    const r = await ctx.aws.send<{ CostAllocationTags?: Array<{ TagKey?: string; Status?: string }> }>({
      service: 'ce', op: 'ListCostAllocationTags', input: { TagKeys: [...COST_TAG_KEYS], MaxResults: 10 },
    }).catch((e: unknown) => {
      prep.notes.push(`preflight cost-allocation-tag-active: cannot read the tag status (${(e as Error).message}); continuing`);
      return null;
    });
    if (r === undefined) {
      prep.notes.push('preflight cost-allocation-tag-active: not checked in --dry-run (ce:ListCostAllocationTags)');
      return;
    }
    if (!r) return;
    const status = new Map((r.CostAllocationTags ?? []).map((t) => [t.TagKey ?? '', t.Status ?? '']));
    const inactive = COST_TAG_KEYS.filter((k) => status.get(k) !== 'Active');
    if (inactive.length) {
      prep.notes.push(`preflight cost-allocation-tag-active: ${inactive.join(', ')} not active yet — the project budget will show 0 until it is (comparison point, not an error)`);
    } else {
      prep.notes.push('preflight cost-allocation-tag-active: Project and Module are active');
    }
  },

  async afterDeploy(ctx, step, args) {
    if (step.tier !== 'aws' || args.planOnly) return;
    const r = await activateCostAllocationTags(ctx, COST_TAG_KEYS);
    if (r.skipped) {
      ctx.out.warn(`      cost: skipped ${r.skipped.api} (learner identity) -> platform action ${r.skipped.platformAction}`);
      ctx.out.info(`      ${JSON.stringify({ skipped: [r.skipped] })}`);
      return;
    }
    if (r.activated.length) ctx.out.info(`      cost allocation tags activated: ${r.activated.join(', ')} (never deactivated by disable cost)`);
    for (const e of r.errors) {
      ctx.out.warn(`      cost: tag ${e.key} not activated (${e.code}: ${e.message}) — new tag keys appear in the activation list only some time after the first tagged resource exists; re-run scripts/module enable cost later. In AWS Organizations only the management account can activate them.`);
    }
    ctx.out.warn('      cost: confirm the SNS subscription e-mail of the cost topic (manual prerequisite confirm-email)');
  },

  beforeDisable() {
    return {
      notes: [
        'the two budgets, the optional Budgets Action, the canary role and the cost topic are deleted with the stack',
        'the cost allocation tags stay active (06 convention 8); the local estimate keeps running',
      ],
    };
  },
};
