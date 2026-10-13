/**
 * TypeScript types of `lab.yaml` v2 (`atl.lab/v2`) — hand-written from the JSON Schema in 04 §3.3
 * (`lab-schema.generated.ts`). Structure only; cross-field rules are enforced by `labs:lint` (04 §3.5).
 */

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

export interface LabV2 {
  schema: 'atl.lab/v2';
  id: CardId;
  kind: 'service' | 'scenario';
  service?: string;
  function?: string;
  version: string;
  status?: 'draft' | 'beta' | 'stable' | 'deprecated';
  title: string;
  subtitle?: string;
  summary: string;
  story?: string;
  scenario?: { question: string; constraints?: string[]; antiPatterns?: string[] };
  objectives?: { text: string; domain: SaaDomain; relatesTo?: StepId }[];
  difficulty: 'intro' | 'beginner' | 'intermediate' | 'advanced';
  estimatedMinutes: number;
  timeLimitMinutes: number;
  extensions: { maxCount: number; minutesEach: number };
  retain: { allowed: boolean; maxHours?: number; reason?: string };
  regions?: { supported?: string[]; alsoUses?: ('global' | 'us-east-1')[]; extra?: 'dr-region'[] };
  services: LabService[];
  modules: { target: ModuleId[]; start: ModuleId[]; context?: ModuleId[]; related?: ModuleId[] };
  prerequisites?: {
    cards?: { id: CardId; kind: 'soft' | 'hard' }[];
    learnerInputs?: { id: LearnerInputId; required?: boolean }[];
    knowledge?: string[];
  };
  startProfile: StartProfile;
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
      resource: string;
      preexisting?: 'adopt-readonly' | 'not-applicable';
      revert: 'delete' | 'restore' | 'keep' | 'manual';
      note?: string;
    }[];
  };
  variables?: Record<string, LabVariable>;
  cost: LabCost;
  provision: { class: 'A' | 'B' | 'C' | 'D'; budgetMinutes?: number; cleanupBudgetMinutes?: number };
  steps: LabStep[];
  finalChecks?: CheckRef[];
  experiments?: LabExperiment[];
  quiz?: { file: 'quiz.yaml'; draw?: number };
  badge: { title: string; short?: string; icon?: string };
  tracks: string[];
  cleanup: LabCleanup;
  saa: LabSaa;
  tags: string[];
  permissions?: { learner?: string[]; notes?: string };
  platformOps?: PlatformOp[];
  keepablePrerequisites?: ('route53-hosted-zone' | 'ses-identity' | 'acm-certificate')[];
  extraStacks?: ExtraStack[];
  certificate?: { enabled?: boolean; title?: string; maxManualChecks?: number };
  owners?: string[];
}

export type LearnerInputId =
  | 'domain'
  | 'hosted-zone'
  | 'ses-identity'
  | 'notify-email'
  | 'recipient-emails'
  | 'alert-email'
  | 'budget-amounts'
  | 'cost-tags-active';

export interface LabService {
  id: ServiceId;
  name?: string;
  role: 'primary' | 'supporting' | 'observed' | 'context';
  module?: ModuleId;
  featureOf?: ServiceId;
  optional?: boolean;
  creditBy?: StepId[];
}

export interface ProvisionItem {
  item: string;
  kind: 'module' | 'local' | 'runtime' | 'seed' | 'platform';
  basis?: 'credential' | 'closure' | 'precursor' | 'context';
  set?: EnvMap;
  params?: ParamMap;
  value?: Scalar;
  rule?: RuleId | RuleId[];
  contextKind?: 'https-entry' | 'protected-data' | 'shorten-wait' | 'realism';
  reason: string;
}

export interface PlatformStart {
  preview: { directHttps: 'on' | 'off' };
}

export type Branches = Record<RuleId, { choose: ModuleId; reason: string }>;

export interface StartProfile {
  base?: 'l0-ec2';
  provisions: ProvisionItem[];
  branches?: Branches;
  platform: PlatformStart;
  variants?: StartVariant[];
  reason: string;
}

export interface StartVariant {
  id: string;
  title: string;
  select: 'learner' | 'preflight';
  when?: Expr;
  provisions: ProvisionItem[];
  branches?: Branches;
  platform?: PlatformStart;
  targetModules?: TargetModule[];
  reason: string;
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

export type LabVariable =
  | { label: string; from: 'input'; pattern: string; fillFrom?: string; example?: string; help?: string }
  | { label: string; from: 'derived'; fillFrom: string; pattern?: string; example?: string; help?: string };

export interface LabCost {
  currency?: 'USD';
  tier: 'low' | 'medium' | 'high';
  tierWithOptional?: 'low' | 'medium' | 'high';
  mainDrivers?: string[];
  basis: CostItem[];
  assumptions?: string[];
}

export type CostItem =
  | { ref: 'start-profile' | 'workstation' | 'target-modules' | 'extra-stacks'; note?: string }
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
      note?: string;
    };

export type StepType = 'console' | 'cli' | 'script' | 'code' | 'observe' | 'experiment';

export interface LabStep {
  id: StepId;
  type: StepType;
  title: string;
  manual: string;
  from?: GuideRef;
  wire?: boolean;
  optional?: boolean | { reason: string; when?: Expr };
  when?: Expr;
  requires?: { steps?: StepId[]; runtime?: ModuleId[] };
  supersedes?: StepId[];
  estMinutes?: number;
  methods?: ('console' | 'cli' | 'script' | 'code')[];
  panel?: 'terminal-lab' | 'terminal-workstation' | 'console' | 'preview';
  startsBilling?: { class: 'hourly' | 'usage' | 'fixed-monthly'; pricingKeys: string[]; note?: string };
  wait?: { typicalMinutes: number; maxMinutes: number; text?: string };
  expectedOutage?: { channel: 'lab' | 'workstation' | 'both'; maxMinutes: number; reason: string };
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

export type ExperimentLabel =
  | 'before'
  | 'after'
  | 'run'
  | { id: LabelId; role: 'baseline' | 'treatment' | 'single'; title?: string; requires?: Record<ModuleId, string> };

export interface LabExperiment {
  module: ModuleId;
  id: string;
  labels: ExperimentLabel[];
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

export interface PlatformOp {
  id: string;
  op: 'enable' | 'disable';
  module: ModuleId;
  args?: Record<string, string | number | boolean>;
  title: string;
  confirm?: string;
  optional?: boolean;
  interruptsManagementChannel?: boolean;
}

export interface LabCleanup {
  summary: string;
  autoReclaim: true;
  dataRisk?: string[];
  learnerCreatedHints?: { resourceType: string; how: string }[];
  verify?: CheckRef[];
}

export interface LabSaa {
  domains: SaaDomain[];
  topics?: ({ ref: GuideRef } | { id: string; title: string; domain: SaaDomain; relatesTo?: StepId })[];
  confusables?: ({ ref: GuideRef } | { a: string; b: string; rule: string })[];
}
