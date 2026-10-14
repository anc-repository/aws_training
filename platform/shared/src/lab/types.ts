/**
 * TypeScript types of `lab.yaml` v2 (`atl.lab/v2`) — hand-written from the JSON Schema in 04 §3.3
 * (`lab-schema.generated.ts`). Structure only; cross-field rules are enforced by `labs:lint` (04 §3.5).
 *
 * Learner-facing text is generic over `S`: `LabV2` (S = string) is a card resolved to one language — what labs:build
 * writes and what the API, the checks and the web read; `LabV2Source` (S = LocalizedText) is lab.yaml as written, where
 * every text field may be `{ zh-CN, ja?, en? }` (09-i18n-and-visual.md §2, decision I4).
 */
import type { LocalizedText } from './l10n.js';

export type CardId = string;
export type StepId = string;
export type CheckId = string;
export type CheckKey = string;
export type ModuleId = string;
export type ServiceId = string;
export type RuleId = string;
export type LabelId = string;
export type GuideRef = string;
export type Expr = string;
export type Scalar = string | number | boolean;
export type EnvMap = Record<string, Scalar>;
export type ParamMap = Record<string, Scalar>;
export type SaaDomain = 'secure' | 'resilient' | 'performance' | 'cost';

export interface LabV2<S = string> {
  schema: 'atl.lab/v2';
  id: CardId;
  kind: 'service' | 'scenario';
  service?: S;
  function?: S;
  version: string;
  status?: 'draft' | 'beta' | 'stable' | 'deprecated';
  title: S;
  subtitle?: S;
  summary: S;
  story?: S;
  scenario?: { question: S; constraints?: S[]; antiPatterns?: S[] };
  objectives?: { text: S; domain: SaaDomain; relatesTo?: StepId }[];
  difficulty: 'intro' | 'beginner' | 'intermediate' | 'advanced';
  estimatedMinutes: number;
  timeLimitMinutes: number;
  extensions: { maxCount: number; minutesEach: number };
  retain: { allowed: boolean; maxHours?: number; reason?: S };
  regions?: { supported?: string[]; alsoUses?: ('global' | 'us-east-1')[]; extra?: 'dr-region'[] };
  services: LabService<S>[];
  modules: { target: ModuleId[]; start: ModuleId[]; context?: ModuleId[]; related?: ModuleId[] };
  prerequisites?: {
    cards?: { id: CardId; kind: 'soft' | 'hard' }[];
    learnerInputs?: { id: LearnerInputId; required?: boolean }[];
    knowledge?: S[];
  };
  startProfile: StartProfile<S>;
  targetModules: TargetModule[];
  expectedWarnings?: RuleId[];
  acceptedDrift?: string[];
  workstation?: {
    required?: boolean;
    sshFromWorkstation?: boolean;
    savingsMode?: 'ok' | 'degraded' | 'unsupported';
    tools?: ('aws-cli' | 'node' | 'k6' | 'git' | 'jq' | 'psql' | 'redis-cli' | 'session-manager-plugin')[];
  };
  platform?: {
    consoleLinks?: string[];
    accountImpact?: {
      id: string;
      scope: 'account' | 'region';
      resource: S;
      preexisting?: 'adopt-readonly' | 'not-applicable';
      revert: 'delete' | 'restore' | 'keep' | 'manual';
      note?: S;
    }[];
  };
  variables?: Record<string, LabVariable<S>>;
  cost: LabCost<S>;
  provision: { class: 'A' | 'B' | 'C' | 'D'; budgetMinutes?: number; cleanupBudgetMinutes?: number };
  steps: LabStep<S>[];
  finalChecks?: CheckRef[];
  experiments?: LabExperiment<S>[];
  quiz?: { file: 'quiz.yaml'; draw?: number };
  badge: { title: S; short?: S; icon?: string };
  tracks: string[];
  cleanup: LabCleanup<S>;
  saa: LabSaa<S>;
  tags: string[];
  permissions?: { learner?: string[]; notes?: string };
  platformOps?: PlatformOp<S>[];
  keepablePrerequisites?: ('route53-hosted-zone' | 'ses-identity' | 'acm-certificate')[];
  extraStacks?: ExtraStack[];
  certificate?: { enabled?: boolean; title?: S; maxManualChecks?: number };
  owners?: string[];
}

/** lab.yaml as written: text fields may be localized objects (04 §3.3 `$defs.l10n`). */
export type LabV2Source = LabV2<LocalizedText>;

export type LearnerInputId =
  | 'domain'
  | 'hosted-zone'
  | 'ses-identity'
  | 'notify-email'
  | 'recipient-emails'
  | 'alert-email'
  | 'budget-amounts'
  | 'cost-tags-active';

export interface LabService<S = string> {
  id: ServiceId;
  name?: S;
  role: 'primary' | 'supporting' | 'observed' | 'context';
  module?: ModuleId;
  featureOf?: ServiceId;
  optional?: boolean;
  creditBy?: StepId[];
}

export interface ProvisionItem<S = string> {
  item: string;
  kind: 'module' | 'local' | 'runtime' | 'seed' | 'platform';
  basis?: 'credential' | 'closure' | 'precursor' | 'context';
  set?: EnvMap;
  params?: ParamMap;
  value?: Scalar;
  rule?: RuleId | RuleId[];
  contextKind?: 'https-entry' | 'protected-data' | 'shorten-wait' | 'realism';
  reason: S;
}

export interface PlatformStart {
  preview: { directHttps: 'on' | 'off' };
}

export type Branches<S = string> = Record<RuleId, { choose: ModuleId; reason: S }>;

export interface StartProfile<S = string> {
  base?: 'l0-ec2';
  provisions: ProvisionItem<S>[];
  branches?: Branches<S>;
  platform: PlatformStart;
  variants?: StartVariant<S>[];
  reason: S;
}

export interface StartVariant<S = string> {
  id: string;
  title: S;
  select: 'learner' | 'preflight';
  when?: Expr;
  provisions: ProvisionItem<S>[];
  branches?: Branches<S>;
  platform?: PlatformStart;
  targetModules?: TargetModule[];
  reason: S;
}

export interface TargetModule {
  id: ModuleId;
  driver: string;
  fromDriver?: string;
  set?: EnvMap;
  params?: ParamMap;
  wireStep: StepId;
  adoptsExisting?: boolean;
  optional?: boolean;
}

export type LabVariable<S = string> =
  | { label: S; from: 'input'; pattern: string; fillFrom?: string; example?: string; help?: S }
  | { label: S; from: 'derived'; fillFrom: string; pattern?: string; example?: string; help?: S };

export interface LabCost<S = string> {
  currency?: 'USD';
  tier: 'low' | 'medium' | 'high';
  tierWithOptional?: 'low' | 'medium' | 'high';
  mainDrivers?: S[];
  basis: CostItem<S>[];
  assumptions?: S[];
}

export type CostItem<S = string> =
  | { ref: 'start-profile' | 'workstation' | 'target-modules' | 'extra-stacks'; note?: S }
  | {
      key: string;
      pricingKey: string;
      billing: 'hourly' | 'monthly' | 'usage' | 'one-time';
      quantity: number;
      unit?: string;
      assumedUsagePerHour?: number;
      source: 'start-profile' | 'workstation' | 'target' | 'learner-created' | 'extra-stack' | 'platform';
      optional?: boolean;
      whenRetained?: boolean;
      note?: S;
    };

export type StepType = 'console' | 'cli' | 'script' | 'code' | 'observe' | 'experiment';

export interface LabStep<S = string> {
  id: StepId;
  type: StepType;
  title: S;
  manual: string;
  from?: GuideRef;
  wire?: boolean;
  optional?: boolean | { reason: S; when?: Expr };
  when?: Expr;
  requires?: { steps?: StepId[]; runtime?: ModuleId[] };
  supersedes?: StepId[];
  estMinutes?: number;
  methods?: ('console' | 'cli' | 'script' | 'code')[];
  panel?: 'terminal-lab' | 'terminal-workstation' | 'console' | 'preview';
  startsBilling?: { class: 'hourly' | 'usage' | 'fixed-monthly'; pricingKeys: string[]; note?: S };
  wait?: { typicalMinutes: number; maxMinutes: number; text?: S };
  expectedOutage?: { channel: 'lab' | 'workstation' | 'both'; maxMinutes: number; reason: S };
  checks: CheckRef[];
  experiment?: { module: ModuleId; id: string; label: LabelId };
  pitfalls?: ({ ref: GuideRef } | { id: string; symptom: unknown; match: unknown; cause: unknown; fix: unknown })[];
  saa?: Record<string, unknown>[];
}

export type CheckRef =
  | CheckId
  | CheckKey
  | {
      ref: GuideRef | CheckId | CheckKey;
      as?: CheckId;
      required?: boolean;
      when?: Expr;
      timeoutMs?: number;
      expectedWarnings?: RuleId[];
      drift?: { policy?: 'must-hold' | 'once'; monitor?: boolean };
    };

export type ExperimentLabel<S = string> =
  | 'before'
  | 'after'
  | 'run'
  | { id: LabelId; role: 'baseline' | 'treatment' | 'single'; title?: S; requires?: Record<ModuleId, string> };

export interface LabExperiment<S = string> {
  module: ModuleId;
  id: string;
  labels: ExperimentLabel<S>[];
  pairs?: [LabelId, LabelId][];
  requiredLabels?: LabelId[];
  required: boolean;
  runner?: 'workstation' | 'browser';
  allowSimulatedBaseline?: boolean;
  validity?: 'traffic' | 'functional';
  corroborateWith?: CheckId[];
  compareAcross?: ('instanceType' | 'arch')[];
  scenarios?: string[];
  corroboration?: { minServerRatio?: number };
}

export interface ExtraStack {
  id: string;
  template: string;
  region: 'app' | 'us-east-1' | 'dr-region';
  deploy: string;
  when?: Expr;
  optional?: boolean;
  params?: Record<string, string>;
  outputs?: Record<string, string>;
  reclaim: { phase: 'before-modules' | 'after-modules'; notes?: string };
}

export interface PlatformOp<S = string> {
  id: string;
  op: 'enable' | 'disable';
  module: ModuleId;
  args?: Record<string, string | number | boolean>;
  title: S;
  confirm?: S;
  optional?: boolean;
  interruptsManagementChannel?: boolean;
}

export interface LabCleanup<S = string> {
  summary: S;
  autoReclaim: true;
  dataRisk?: S[];
  learnerCreatedHints?: { resourceType: string; how: S }[];
  verify?: CheckRef[];
}

export interface LabSaa<S = string> {
  domains: SaaDomain[];
  topics?: ({ ref: GuideRef } | { id: string; title: S; domain: SaaDomain; relatesTo?: StepId })[];
  confusables?: ({ ref: GuideRef } | { a: S; b: S; rule: S })[];
}
