// cost hook (module-hooks/cost.ts) + the generic flow with the real infra/modules/cost.yaml (dry-run only; no amounts suggested)
import { describe, expect, it } from 'vitest';
import type { AwsCall, AwsGateway } from '../src/aws.js';
import { disableCommand } from '../src/disable.js';
import { enableCommand } from '../src/enable.js';
import { COST_PREREQ_NOTES, COST_TAG_KEYS, activateCostAllocationTags, costHook, mayActivateTags } from '../src/module-hooks/cost.js';
import { loadLab, planStartOf } from '../src/plan-start.js';
import { loadTemplate, staticOutputValue } from '../src/template.js';
import type { Ctx } from '../src/context.js';
import { REPO_ROOT, dryContext } from './helpers.js';

const AMOUNTS = ['ProjectBudgetLimit=20', 'AccountBudgetLimit=30'];

describe('cost: enable / disable (dry-run)', () => {
  it('without the two amounts: enable exits 2 with the hint and deploys nothing; plan only notes it (exit 0)', async () => {
    const a = dryContext();
    expect(await enableCommand(a.ctx, 'cost', {})).toBe(2);
    expect(a.out.text()).toContain('manual prerequisite "budget-amounts" is not met');
    expect(a.out.text()).toContain('--param ProjectBudgetLimit=<amount> --param AccountBudgetLimit=<amount>');
    expect(a.out.text()).toContain('this project quotes no price');
    expect(a.aws.calls.filter((c) => c.op === 'CreateOrUpdateStack')).toEqual([]);
    const b = dryContext();
    expect(await enableCommand(b.ctx, 'cost', { planOnly: true })).toBe(0);
    expect(b.out.text()).toContain('enable needs them');
    expect(b.out.text()).toContain('COST_MODE=budgets');
  });

  it('invalid amounts or e-mail: exit 2 (CliError) before anything is deployed', async () => {
    const { ctx, aws } = dryContext();
    await expect(enableCommand(ctx, 'cost', { param: ['ProjectBudgetLimit=lots', 'AccountBudgetLimit=30'] })).rejects.toMatchObject({ exitCode: 2 });
    await expect(enableCommand(ctx, 'cost', { param: [...AMOUNTS, 'AlertEmail=x'] })).rejects.toMatchObject({ exitCode: 2 });
    expect(aws.calls.filter((c) => c.op === 'CreateOrUpdateStack')).toEqual([]);
  });

  it('with the amounts: preflight reads the tag status, the stack gets the amounts, the tags are activated out of band; disable keeps them active', async () => {
    const { ctx, out, aws } = dryContext();
    expect(await enableCommand(ctx, 'cost', { param: [...AMOUNTS, 'AlertEmail=ops@example.com'] })).toBe(0);
    const ops = aws.calls.map((c) => `${c.service}:${c.op}`);
    expect(ops.indexOf('ce:ListCostAllocationTags')).toBeLessThan(ops.indexOf('cloudformation:CreateOrUpdateStack'));
    const deploy = aws.calls.find((c) => c.op === 'CreateOrUpdateStack' && c.input.StackName === 'cloudalbum-lab-cost')!;
    const params = Object.fromEntries((deploy.input.Parameters as Array<{ ParameterKey: string; ParameterValue: string }>).map((p) => [p.ParameterKey, p.ParameterValue]));
    expect(params).toMatchObject({ ProjectBudgetLimit: '20', AccountBudgetLimit: '30', AlertEmail: 'ops@example.com' });
    const activate = aws.calls.find((c) => c.op === 'UpdateCostAllocationTagsStatus')!;
    expect(activate.input).toEqual({ CostAllocationTagsStatus: [{ TagKey: 'Project', Status: 'Active' }, { TagKey: 'Module', Status: 'Active' }] });
    expect(ctx.state.modules.cost?.env).toMatchObject({ MODULE_COST: 'on', COST_MODE: 'budgets', COST_TAG_KEY: 'Project', COST_CE_QUERY: 'manual' });
    expect(out.text()).toContain('preflight cost-allocation-tag-active');

    const before = aws.calls.length;
    expect(await disableCommand(ctx, 'cost', {})).toBe(0);
    const after = aws.calls.slice(before);
    expect(after.filter((c) => c.op === 'DeleteStack').map((c) => c.input.StackName)).toEqual(['cloudalbum-lab-cost']);
    expect(after.some((c) => c.op === 'UpdateCostAllocationTagsStatus')).toBe(false);   // never deactivated (06 convention 8)
    expect(out.text()).toContain('cost allocation tags stay active');
  });

  it('platform mode: the learner may not activate tags (skipped with the platform action); the runner may', async () => {
    expect(mayActivateTags({ platform: undefined })).toBe(true);
    expect(mayActivateTags({ platform: { identity: { kind: 'learner' } } } as unknown as Ctx)).toBe(false);
    expect(mayActivateTags({ platform: { identity: { kind: 'provisioner' } } } as unknown as Ctx)).toBe(true);
    const calls: AwsCall[] = [];
    const gateway: AwsGateway = { dryRun: false, send: async <T>(c: AwsCall) => { calls.push(c); return { Errors: [{ TagKey: 'Module', Code: 'TagKeysNotFoundException', Message: 'not found' }] } as T; } };
    const learner = { platform: { identity: { kind: 'learner' } }, aws: gateway, dryRun: false, state: { outOfBand: [] } } as unknown as Ctx;
    expect(await activateCostAllocationTags(learner, COST_TAG_KEYS)).toEqual({
      activated: [], errors: [], skipped: { api: 'ce:UpdateCostAllocationTagsStatus', platformAction: 'cost-activate-tags' },
    });
    expect(calls).toEqual([]);
    const runner = { platform: { identity: { kind: 'provisioner' } }, aws: gateway, dryRun: false, state: { outOfBand: [] } } as unknown as Ctx;
    const r = await activateCostAllocationTags(runner, COST_TAG_KEYS);
    expect(r).toMatchObject({ activated: ['Project'], errors: [{ key: 'Module', code: 'TagKeysNotFoundException' }] });
    expect(runner.state.outOfBand).toEqual([expect.objectContaining({ module: 'cost', kind: 'cost-allocation-tags', id: 'Project' })]);
  });

  it('plan --start-of svc-cost: L0 + iam(role), no warnings (labs:derive DRV-6); the manual prerequisites are plan notes', async () => {
    const r = planStartOf(loadLab(REPO_ROOT, 'svc-cost'), { repoRoot: REPO_ROOT });
    expect(r.warnings).toEqual([]);
    expect(costHook.planHints).toBeUndefined();
    const { ctx, out } = dryContext();
    expect(await enableCommand(ctx, 'cost', { planOnly: true })).toBe(0);
    for (const n of COST_PREREQ_NOTES) expect(out.text()).toContain(n);
  });

  it('template: amounts without defaults; credits excluded; tag filter; budgets publish to the module topic; canary-only action', () => {
    const t = loadTemplate(REPO_ROOT, 'infra/modules/cost.yaml');
    expect(t.Parameters.ProjectBudgetLimit?.Default).toBeUndefined();
    expect(t.Parameters.AccountBudgetLimit?.Default).toBeUndefined();
    const project = t.Resources.ProjectBudget!.Properties as { Budget: { CostTypes: unknown; CostFilters: unknown } };
    expect(project.Budget.CostTypes).toEqual({ IncludeCredit: false });
    expect(JSON.stringify(project.Budget.CostFilters)).toContain('user:${TagKey}$${TagValue}');
    expect(JSON.stringify(t.Resources.CostTopicPolicy)).toContain('budgets.amazonaws.com');
    expect(t.Resources.CanaryBudgetAction?.Condition).toBe('EnableAction');
    expect(JSON.stringify(t.Resources.CanaryBudgetAction?.Properties)).toContain('AWSDenyAll');
    expect(JSON.stringify(t.Resources.CanaryBudgetAction?.Properties)).not.toContain('CloudAlbumAppRole');
    expect(staticOutputValue(t, 'EnvCostMode')).toBe('budgets');
    expect(staticOutputValue(t, 'EnvCostCeQuery')).toBe('manual');
    expect(JSON.stringify(t.Resources.AppPolicy?.Properties)).not.toMatch(/budgets:(Modify|Create|Delete)/);
  });
});
