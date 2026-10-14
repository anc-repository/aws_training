/**
 * Start-state derivation with the built-in reference deriver (no subprocess, no AWS): the digest, the generated profile
 * and the derive rules (DRV-*) on the repository content and on a mutated card.
 */
import { describe, expect, it } from 'vitest';
import { loadContent } from '../src/content.js';
import { deriveAll, deriveCard, warningRuleId } from '../src/derive/index.js';
import { digestObject, planDigest, profileDigest, renderProfile, type PlanOutput } from '../src/derive/plan.js';
import { labsPaths } from '../src/paths.js';
import { ownerOfKey, registryVersion } from '../src/registry.js';

const paths = labsPaths();

describe('plan digest and profile', () => {
  it('registryVersion is <version>+<12 hex> like scripts/module toolkitRegistryVersion()', () => {
    expect(registryVersion(paths)).toMatch(/^\d+\+[0-9a-f]{12}$/);
  });

  it('the digest ignores explanatory fields and changes with the start state', () => {
    const base = {
      card: 'svc-x', variant: 'default', registryVersion: '2+000000000000',
      start: [{ id: 'ec2', kind: 'module' as const, basis: 'base' as const }, { id: 'iam', kind: 'module' as const, basis: 'credential' as const, set: { IAM_CREDENTIALS: 'role' } }],
      platform: { 'preview.directHttps': 'on' as const }, baseParams: {}, extraStacks: [],
    };
    const d1 = planDigest(base);
    expect(d1).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(planDigest({ ...base, start: [base.start[0]!, { ...base.start[1]!, basis: 'closure' as const, because: ['X'] }] })).toBe(d1);
    expect(planDigest({ ...base, platform: { 'preview.directHttps': 'off' } })).not.toBe(d1);
    expect(planDigest({ ...base, start: [base.start[0]!] })).not.toBe(d1);
  });

  it('the rendered profile reproduces the plan digest (DRV-10)', async () => {
    const set = loadContent(paths);
    const card = set.byId.get('svc-queue')!;
    const { derivation } = await deriveCard(set, card, 'reference');
    const plan = derivation.variants[0]!.plan as PlanOutput;
    const text = renderProfile(plan, String(card.lab.version));
    expect(text).toContain('PROFILE_NAME=atl/svc-queue/default');
    expect(text).toContain('PROFILE_LOCAL_SETTINGS=');
    expect(text).toContain(`PROFILE_PLAN_DIGEST=${plan.digest}`);
    const round = profileDigest(text, registryVersion(paths), (k) => ownerOfKey(paths, k));
    expect(round.digest).toBe(plan.digest);
    expect(round.declared).toBe(plan.digest);
  });
});

describe('labs:derive (reference deriver)', () => {
  it('derives the 22 full cards without errors', async () => {
    const set = loadContent(paths);
    const r = await deriveAll(set, 'reference');
    expect(r.cards.map((c) => c.card).sort()).toHaveLength(22);
    expect(r.issues.filter((i) => i.severity === 'error')).toEqual([]);
    const byId = new Map(r.cards.map((c) => [c.card, c]));
    const startOf = (id: string) => byId.get(id)!.variants[0]!.plan!.start.filter((e) => e.basis !== 'base').map((e) => `${e.kind}:${e.id}`);
    expect(startOf('svc-ec2')).toEqual([]);
    expect(startOf('svc-iam')).toEqual([]);
    expect(startOf('svc-image-processing')).toEqual(['module:iam', 'module:storage']);
    expect(startOf('svc-queue')).toEqual(expect.arrayContaining(['module:iam', 'local:queue', 'local:image-processing']));
    expect(byId.get('svc-database')!.variants[0]!.cost?.required).toBe('high');
    expect(byId.get('svc-image-processing')!.variants[0]!.cost?.withOptional).toBe('medium');
  }, 60_000);

  it('reports a provision that the plan does not produce (DRV-2)', async () => {
    const set = loadContent(paths);
    const card = set.byId.get('svc-cache')!;
    const lab = structuredClone(card.lab);
    lab.startProfile.provisions = [
      ...lab.startProfile.provisions,
      { item: 'queue', kind: 'module', basis: 'closure', set: { QUEUE_DRIVER: 'sqs' }, reason: '多余的预置（测试）' },
    ];
    const { issues } = await deriveCard(set, { ...card, lab }, 'reference');
    expect(issues.some((i) => i.rule.startsWith('DRV-') && i.severity === 'error' && i.message.includes('queue'))).toBe(true);
  });
});

describe('wave 1 integration: DRV-6 and runtime values', () => {
  it('DRV-6 compares rule IDs only; hook planHints are free text', () => {
    expect(warningRuleId('DEP-018')).toBe('DEP-018');
    expect(warningRuleId('rules: DEP-013')).toBe('DEP-013');
    expect(warningRuleId('waf: DEP-018 entry not locked')).toBe('DEP-018');
    expect(warningRuleId('DRV-5: target cdn appears in the start state (aws)')).toBe('DRV-5');
    expect(warningRuleId('email: manual prerequisite "ses-identity": a verified SES sender identity')).toBeNull();
    expect(warningRuleId('waf: lock the origin (CDN_DIRECT_ACCESS=admin-ip|closed) or … (DEP-018)')).toBeNull();
    expect(warningRuleId('rules: not evaluated (backend not built)')).toBeNull();
  });

  it('a runtime value is digested typed, the way scripts/module parses PROFILE_RUNTIME (true, not "true")', () => {
    const base = {
      card: 'svc-x', variant: 'default', registryVersion: '2+000000000000',
      platform: { 'preview.directHttps': 'on' as const }, baseParams: {}, extraStacks: [],
    };
    const rt = { id: 'featureFlags.lab.faults', kind: 'runtime' as const, basis: 'single' as const, value: 'true' };
    const typed = digestObject({ ...base, start: [rt] }) as { modules: { value: unknown }[] };
    expect(typed.modules[0]!.value).toBe(true);
    const local = { id: 'queue', kind: 'local' as const, basis: 'single' as const, set: { QUEUE_DRIVER: 'memory' }, value: '1' };
    expect((digestObject({ ...base, start: [local] }) as { modules: { value: unknown }[] }).modules[0]!.value).toBe('1');
  });

  it('declared runtime keys of service cards are part of the reference plan (svc-logging, svc-monitoring)', async () => {
    const set = loadContent(paths);
    for (const id of ['svc-logging', 'svc-monitoring']) {
      const { derivation, issues } = await deriveCard(set, set.byId.get(id)!, 'reference');
      expect(issues.filter((i) => i.severity === 'error')).toEqual([]);
      expect(derivation.variants[0]!.plan!.start).toEqual(expect.arrayContaining([expect.objectContaining({ kind: 'runtime', id: 'featureFlags.lab.faults', value: 'true' })]));
    }
  });
});
