/**
 * Card facts the API derives from the expanded card (04 §3, 02 §3.6, §5.4, §8.1, 05 §8.8): start variants, card facts
 * copied into `LabSession`, per-card time / extension / keep limits and their combination with the platform limits.
 */
import { AtlError, DEFAULT_VARIANT, INSTALL_DEFAULTS, startProfileName, type PlatformConfigItem, type ProvisionItem, type StartVariant, type TargetModule } from '@atl/shared';
import type { LabContent } from './store.js';

export interface ResolvedVariant {
  variant: string;
  select: 'default' | 'learner';
  profileName: string;
  provisions: ProvisionItem[];
  targetModules: TargetModule[];
  /** `select: preflight` variants that the account preflight may switch to (02 §3.6); quotes take the costlier one. */
  preflightAlternatives: StartVariant[];
}

/** Resolve the learner's variant (02 §3.3 step 1): `default` or a `select: learner` variant; anything else → VARIANT_UNKNOWN. */
export function resolveVariant(lab: LabContent, requested?: string | null): ResolvedVariant {
  const variants = lab.startProfile?.variants ?? [];
  const preflightAlternatives = variants.filter((v) => v.select === 'preflight');
  if (!requested || requested === DEFAULT_VARIANT) {
    return {
      variant: DEFAULT_VARIANT,
      select: 'default',
      profileName: startProfileName(lab.id, DEFAULT_VARIANT),
      provisions: lab.startProfile?.provisions ?? [],
      targetModules: lab.targetModules ?? [],
      preflightAlternatives,
    };
  }
  const v = variants.find((x) => x.id === requested && x.select === 'learner');
  if (!v) throw new AtlError('VARIANT_UNKNOWN', `card ${lab.id} has no learner-selectable variant ${requested}`);
  return {
    variant: v.id,
    select: 'learner',
    profileName: startProfileName(lab.id, v.id),
    provisions: v.provisions ?? lab.startProfile?.provisions ?? [],
    targetModules: v.targetModules ?? lab.targetModules ?? [],
    preflightAlternatives,
  };
}

export interface CardFacts {
  platformActions: string[];
  sshFromWorkstation: boolean;
  sshUser: string | null;
  /** The start profile seeds `cognito-test-users` (06 PM-44) → agent context `testUsersParam` (platform-scaffold note 11). */
  testUsersSeeded: boolean;
}

/** `LabSession.cardFacts` (01 §7.3), copied at CreateSession so that atl-agent never reads the content package. */
export function cardFactsOf(lab: LabContent, v: ResolvedVariant): CardFacts {
  const ssh = !!lab.workstation?.sshFromWorkstation;
  const seeds = [...v.provisions, ...(lab.startProfile?.provisions ?? [])].filter((p) => p.kind === 'seed').map((p) => p.item);
  return {
    platformActions: (lab.platformOps ?? []).map((o) => o.id),
    sshFromWorkstation: ssh,
    sshUser: ssh ? 'ec2-user' : null,
    testUsersSeeded: seeds.includes('cognito-test-users'),
  };
}

export interface CardLimits {
  timeLimitMinutes: number;
  extensions: { maxCount: number; minutesEach: number };
  retain: { allowed: boolean; maxHours: number | null };
  provision: { class: string; budgetMinutes: number | null; cleanupBudgetMinutes: number | null };
  workstationRequired: boolean;
}

/** Per-card timing copied into the session (`LabSession.cardLimits`, pinned with `catalogVersion`). */
export function cardLimitsOf(lab: LabContent): CardLimits {
  return {
    timeLimitMinutes: lab.timeLimitMinutes,
    extensions: { maxCount: lab.extensions?.maxCount ?? INSTALL_DEFAULTS.MaxExtensions, minutesEach: lab.extensions?.minutesEach ?? INSTALL_DEFAULTS.ExtensionMinutes },
    retain: { allowed: lab.retain?.allowed !== false, maxHours: lab.retain?.maxHours ?? null },
    provision: { class: lab.provision?.class ?? 'A', budgetMinutes: lab.provision?.budgetMinutes ?? null, cleanupBudgetMinutes: lab.provision?.cleanupBudgetMinutes ?? null },
    workstationRequired: !!lab.workstation?.required,
  };
}

export interface EffectiveLimits {
  timeLimitMinutes: number;
  extensionMinutes: number;
  extensionMaxCount: number;
  maxSessionMinutes: number;
  keepAllowed: boolean;
  keepMaxHours: number;
  envMaxAgeDays: number;
  readyIdleMinutes: number;
}

/** Card limits can only tighten the platform limits (02 §5.4, §8.1, §10.3). */
export function effectiveLimits(card: CardLimits, platform: Pick<PlatformConfigItem, 'limits'> | null | undefined): EffectiveLimits {
  const p = platform?.limits;
  const platformKeep = Math.min(p?.maxKeepHours ?? INSTALL_DEFAULTS.MaxKeepHours, p?.keepHardMaxHours ?? INSTALL_DEFAULTS.KeepHardMaxHours);
  return {
    timeLimitMinutes: card.timeLimitMinutes,
    extensionMinutes: Math.min(card.extensions.minutesEach, p?.extension?.minutes ?? INSTALL_DEFAULTS.ExtensionMinutes),
    extensionMaxCount: Math.min(card.extensions.maxCount, p?.extension?.maxCount ?? INSTALL_DEFAULTS.MaxExtensions),
    maxSessionMinutes: p?.maxSessionMinutes ?? INSTALL_DEFAULTS.MaxSessionMinutes,
    keepAllowed: card.retain.allowed,
    keepMaxHours: card.retain.maxHours === null ? platformKeep : Math.min(card.retain.maxHours, platformKeep),
    envMaxAgeDays: p?.envMaxAgeDays ?? INSTALL_DEFAULTS.EnvMaxAgeDays,
    readyIdleMinutes: p?.readyIdleMinutes ?? INSTALL_DEFAULTS.ReadyIdleMinutes,
  };
}

/** Default card limits when a session item predates `cardLimits` (falls back to the platform defaults). */
export function cardLimitsFromSession(session: Record<string, unknown>): CardLimits {
  const cl = session.cardLimits as CardLimits | undefined;
  if (cl && typeof cl.timeLimitMinutes === 'number') return cl;
  return {
    timeLimitMinutes: 60,
    extensions: { maxCount: INSTALL_DEFAULTS.MaxExtensions, minutesEach: INSTALL_DEFAULTS.ExtensionMinutes },
    retain: { allowed: true, maxHours: null },
    provision: { class: 'A', budgetMinutes: null, cleanupBudgetMinutes: null },
    workstationRequired: false,
  };
}

/** Learner inputs required by the card (`prerequisites.learnerInputs[].required`, default true). */
export function requiredLearnerInputs(lab: LabContent): string[] {
  return (lab.prerequisites?.learnerInputs ?? []).filter((i) => i.required !== false).map((i) => i.id);
}

/** Experiments declared by the card and their labels (04 §3.2.10). */
export function experimentLabels(lab: LabContent, module: string, experiment: string): { label: string; role: 'baseline' | 'treatment' | 'single' }[] | null {
  const e = (lab.experiments ?? []).find((x) => x.module === module && x.id === experiment);
  if (!e) return null;
  return e.labels.map((l) => {
    if (typeof l === 'string') return { label: l, role: l === 'before' ? 'baseline' : l === 'after' ? 'treatment' : 'single' };
    return { label: l.id, role: l.role };
  });
}
