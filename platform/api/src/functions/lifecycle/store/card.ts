/**
 * Card facts for a session (02 §13.5): from the expanded card of the content release
 * (`atl-web/content/<catalogVersion>/labs/<cardId>.json`, 04 §2.5) and the start profile file
 * (`…/profiles/atl/<cardId>/<variant>.env`, `PROFILE_PLAN_DIGEST`). atl-api may pass the snapshot itself.
 */
import { DEFAULT_VARIANT, Keys, startProfileName, WebKeys, type LabV2 } from '@atl/shared';
import type { Ctx } from '../context.js';
import { WorkflowError } from '../errors.js';
import type { CardSnapshot } from './model.js';

export function variantExists(lab: Pick<LabV2, 'startProfile'>, variant: string): boolean {
  return variant === DEFAULT_VARIANT || (lab.startProfile?.variants ?? []).some((v) => v.id === variant);
}

/** Pure mapping lab.yaml v2 → the snapshot kept on LabSession (`cardSnapshot`). */
export function toCardSnapshot(lab: LabV2, opts: { variant: string; catalogVersion: string; startProfileDigest: string | null }): CardSnapshot {
  if (!variantExists(lab, opts.variant)) throw new WorkflowError('Atl.VariantUnknown', `card ${lab.id} has no variant ${opts.variant}`, { failureCode: 'VARIANT_UNKNOWN' });
  const variant = (lab.startProfile.variants ?? []).find((v) => v.id === opts.variant) ?? null;
  const provisions = variant?.provisions ?? lab.startProfile.provisions ?? [];
  const targets = variant?.targetModules ?? lab.targetModules ?? [];
  const stepStacks = (lab.extraStacks ?? []).filter((x) => x.deploy.startsWith('step:'));
  return {
    labId: lab.id,
    labKind: lab.kind,
    labVersion: lab.version,
    catalogVersion: opts.catalogVersion,
    variant: opts.variant,
    startProfile: startProfileName(lab.id, opts.variant),
    startProfileDigest: opts.startProfileDigest ?? '',
    timeLimitMinutes: lab.timeLimitMinutes,
    extensions: { maxCount: lab.extensions?.maxCount ?? 2, minutesEach: lab.extensions?.minutesEach ?? 30 },
    retain: { allowed: lab.retain?.allowed !== false, maxHours: lab.retain?.maxHours ?? null },
    provision: { class: lab.provision?.class ?? 'A', budgetMinutes: lab.provision?.budgetMinutes ?? null, cleanupBudgetMinutes: lab.provision?.cleanupBudgetMinutes ?? null },
    workstation: { required: lab.workstation?.required === true, sshFromWorkstation: lab.workstation?.sshFromWorkstation === true, sshUser: null },
    regions: { extra: [...(lab.regions?.extra ?? [])], alsoUses: [...(lab.regions?.alsoUses ?? [])] },
    extraStacks: (lab.extraStacks ?? []).map((x) => ({ id: x.id, region: x.region, deploy: x.deploy, reclaimPhase: x.reclaim?.phase ?? 'after-modules' })),
    platformActions: [
      ...(lab.platformOps ?? []).map((p) => ({
        id: p.id,
        op: p.op,
        module: p.module,
        title: p.title,
        interruptsManagementChannel: p.interruptsManagementChannel === true,
      })),
      ...stepStacks.map((x) => ({ id: `xstk-${x.id}`, op: 'extra-stack', module: null, title: `deploy ${x.id}`, interruptsManagementChannel: false })),
    ],
    targetModules: targets.filter((t) => !t.optional).map((t) => ({ id: t.id, from: t.fromDriver ?? null, to: t.driver })),
    expectedWarnings: [...(lab.expectedWarnings ?? [])],
    keepablePrerequisites: [...(lab.keepablePrerequisites ?? [])],
    requiredLearnerInputs: (lab.prerequisites?.learnerInputs ?? []).filter((i) => i.required !== false).map((i) => i.id),
    preflightVariants: (lab.startProfile.variants ?? []).filter((v) => v.select === 'preflight').map((v) => ({ id: v.id, when: v.when ?? null })),
    testUsersSeeded: provisions.some((p) => p.kind === 'seed' && p.item === 'cognito-test-users'),
    costTier: lab.cost?.tier ?? null,
  };
}

/** `PROFILE_PLAN_DIGEST=…` of a profile file (06 PM-33). */
export function profileDigest(envFile: string): string | null {
  const m = /^PROFILE_PLAN_DIGEST=(.+)$/m.exec(envFile);
  return m ? m[1]!.trim() : null;
}

const text = (b: Uint8Array | null): string | null => (b ? new TextDecoder().decode(b) : null);

export async function currentCatalogVersion(ctx: Ctx): Promise<string | null> {
  const cur = await ctx.main.get(Keys.catalogCurrent());
  const v = cur?.catalogVersion;
  return typeof v === 'string' && v ? v : null;
}

/** Load and map the card of a content release. */
export async function loadCardSnapshot(ctx: Ctx, labId: string, variant: string, catalogVersion?: string | null): Promise<CardSnapshot> {
  const cv = catalogVersion ?? (await currentCatalogVersion(ctx));
  if (!cv) throw new WorkflowError('Atl.NotFound', 'no current catalog release (CATALOG / CURRENT)');
  const raw = text(await ctx.ports.objects.get(ctx.env.buckets.web, `${WebKeys.content(cv)}labs/${labId}.json`));
  if (!raw) throw new WorkflowError('Atl.NotFound', `card ${labId} is not in content release ${cv}`);
  const parsed = JSON.parse(raw) as Record<string, unknown>;
  const lab = (parsed.schema === 'atl.lab/v2' ? parsed : (parsed.lab ?? parsed.card ?? parsed)) as unknown as LabV2;
  if (!lab || lab.id !== labId) throw new WorkflowError('Atl.NotFound', `content release ${cv} has a malformed card ${labId}`);
  const prof = text(await ctx.ports.objects.get(ctx.env.buckets.web, WebKeys.profile(cv, labId, variant)));
  const digests = parsed.startProfileDigests as Record<string, string> | undefined;
  return toCardSnapshot(lab, { variant, catalogVersion: cv, startProfileDigest: (prof && profileDigest(prof)) ?? digests?.[variant] ?? null });
}
