/**
 * 目录、路径、简介页、小测与学习进度用到的数据结构（05 §8.4 构建产物、§8.8 API；tracks-and-catalog §4、§5；04 §3.2.11）。
 * 字段名以 platform/api 当前实现与 labs:build 的产物为准（routes/catalog.ts、routes/platform.ts、dist/content/<v>/catalog/*），
 * 契约 `@atl/contracts` 的 openapi.yaml 尚未生成，这里只声明画面用到的字段，其余保留为可选。
 */
import type { SessionState } from '@atl/shared';
import type { CostTier } from '../../ui';

export type Difficulty = 'intro' | 'beginner' | 'intermediate' | 'advanced';
export type SaaDomain = 'secure' | 'resilient' | 'performance' | 'cost';
export type CardKind = 'service' | 'scenario';
export type ProvisionClass = 'A' | 'B' | 'C' | 'D';
/** `status: planned`：目录占位（“即将推出”），只显示，不能开始、不能报价（platform/api isPlannedCard）。 */
export type CardStatus = 'beta' | 'stable' | 'deprecated' | 'planned' | (string & {});

// ---------------------------------------------------------------------------------------------------------------
// 静态目录索引 /content/<catalogVersion>/catalog/index.json（CatalogIndex，05 §8.4）

export interface TaxonomyCategory {
  id: string;
  label: string;
  token?: string;
  symbol?: string;
}

export interface TaxonomyService {
  id: string;
  abbr: string;
  name: string;
  short?: string;
  function?: string;
  category?: string;
  module?: string;
  featureOf?: string;
}

export interface Taxonomy {
  categories: TaxonomyCategory[];
  services: TaxonomyService[];
  domains?: { id: SaaDomain; label: string; weight?: number; track?: string }[];
  durationBuckets?: { id: string; label: string; maxMinutes?: number }[];
  provisionClasses?: { id: ProvisionClass; label: string; hint?: string }[];
}

export interface CatalogCard {
  id: string;
  kind: CardKind;
  version: string;
  status: CardStatus;
  startable?: boolean;
  title: string;
  subtitle?: string;
  service?: string;
  function?: string;
  summary: string;
  category?: string;
  services: { id: string; role: 'primary' | 'supporting'; optional?: boolean }[];
  servicesCount?: number;
  domains?: SaaDomain[];
  difficulty: Difficulty;
  estimatedMinutes: number;
  timeLimitMinutes: number;
  durationBucket?: 'short' | 'medium' | 'long';
  costTier: { required: CostTier; withOptional?: CostTier };
  costSources?: { hourly: string[]; usage: string[]; monthly: string[] };
  mainDrivers?: string[];
  provisionClass: ProvisionClass;
  variants?: { id: string; title?: string; select: 'default' | 'learner' | 'preflight'; provisionClass?: ProvisionClass; costTier?: CostTier }[];
  targets?: { module: string; from?: string; to: string; optional?: boolean }[];
  learnerInputs?: { id: string; required: boolean }[];
  accountImpact?: { id: string; resource: string; revert: string }[];
  platformOps?: { id: string; title: string; optional: boolean }[];
  saa?: { domains: SaaDomain[]; primaryDomain: SaaDomain; topicTitles: string[] };
  tags?: string[];
  tracks?: { trackId: string; stageId: string; role: 'required' | 'elective' | 'optional'; groupId?: string }[];
  legacyLabs?: number[];
  flags?: string[];
  credits?: string[];
  badge?: { title: string; short?: string };
  prerequisites?: { id: string; kind: 'soft' | 'hard' }[];
  workstation?: { required?: boolean; savingsMode?: 'ok' | 'degraded' | 'unsupported' | (string & {}) };
  reuseFrom?: { labId: string; extraModules?: string[]; warn?: 'hourly' | 'baseline' }[];
  searchText?: string;
}

export interface TrackItem {
  card?: string;
  role?: 'required' | 'optional' | 'elective';
  group?: string;
  title?: string;
  pick?: number;
  cards?: string[];
  note?: string;
  legacyLab?: number;
}

export interface TrackStageDef {
  id: string;
  title?: string;
  legacyLabs?: number[];
  note?: string;
  items: TrackItem[];
}

export interface TrackDef {
  id: string;
  title?: string;
  version?: string;
  summary?: string;
  audience?: string;
  domain?: string;
  stages: TrackStageDef[];
  completion?: { allowManual?: boolean; minAutoRatio?: number; excludeSelfReported?: boolean };
  certificate?: { enabled?: boolean; title?: string };
  /** 最少完成卡片数（必修 + 各选修组的 pick，构建计算）。 */
  requiredCards?: number;
  totalCards?: number;
  requiredMinutes?: number;
  totalMinutes?: number;
}

export interface ServiceCellDef {
  id: string;
  module?: string;
  category?: string;
  abbr?: string;
  serviceCard?: string;
  creditedBy?: string[];
  appearsIn?: string[];
}

export interface CatalogIndex {
  schema?: string;
  catalogVersion: string;
  contentDigest?: string;
  generatedAt?: string;
  taxonomy: Taxonomy;
  defaults?: { view?: string; group?: string; sort?: string; track?: string };
  cards: CatalogCard[];
  tracks: TrackDef[];
  serviceMap: ServiceCellDef[];
}

// ---------------------------------------------------------------------------------------------------------------
// 简介页静态数据 /content/<v>/catalog/cards/<id>.json（CardIntro）

export interface MdNode {
  type: string;
  value?: string;
  depth?: number;
  ordered?: boolean;
  url?: string;
  name?: string;
  lang?: string;
  children?: MdNode[];
  [k: string]: unknown;
}

export interface CardIntro {
  id: string;
  status?: CardStatus;
  startable?: boolean;
  overview?: MdNode | null;
  story?: string | null;
  scenario?: { question: string; constraints?: string[]; antiPatterns?: string[] } | null;
  objectives?: { text: string; domain: SaaDomain; relatesTo?: string }[];
  resources?: {
    provisions?: { item: string; kind: 'module' | 'local' | 'runtime' | 'seed' | 'platform' | (string & {}); displayName: string; reason: string; variant?: string; basis?: string }[];
    extraStacks?: { id: string; title: string }[];
    targets?: { moduleId: string; displayName: string; from?: string; to: string; optional?: boolean }[];
    expectedWarnings?: { rule: string; text: string }[];
  };
  steps?: {
    id: string;
    type: string;
    title: string;
    optional?: boolean;
    wire?: boolean;
    wait?: { typicalMinutes: number; maxMinutes?: number };
    startsBilling?: { class: string };
    expectedOutage?: boolean;
  }[];
  experiments?: { module: string; id: string; title: string; required: boolean; labels?: string[] }[];
  saa?: { topics: { title: string; domain: SaaDomain }[]; confusables?: { a: string; b: string; rule: string }[] };
  cleanupSummary?: string;
  timing?: { extensions?: { maxCount: number; minutesEach: number }; retain?: { allowed: boolean; maxHours?: number; reason?: string } };
  workstation?: { required?: boolean; savingsMode?: string; tools?: string[] };
  keepablePrerequisites?: unknown[];
  prerequisites?: { cards?: { id: string; kind: 'soft' | 'hard' }[]; knowledge?: string[]; learnerInputs?: { id: string; required?: boolean }[] };
  accountImpact?: { id: string; scope?: string; resource: string; revert: string; note?: string }[];
  platformOps?: { id: string; title: string; optional?: boolean }[];
}

// ---------------------------------------------------------------------------------------------------------------
// API

export interface CatalogRef {
  catalogVersion: string;
  contentDigest?: string | null;
  publishedAt?: string | null;
  defective?: unknown;
  indexUrl?: string;
  cardIntroUrlTemplate?: string;
  labUrlTemplate?: string;
  region?: string;
  drRegion?: string | null;
}

export type BadgeLevel = 'verified' | 'attested' | 'self-reported';
export type BadgeStatus = 'valid' | 'pending' | 'withdrawn';

export interface BadgeView {
  level?: BadgeLevel | (string & {});
  status?: BadgeStatus | (string & {});
  earnedAt?: string;
  attemptId?: string;
  labVersion?: string;
  catalogVersion?: string;
  variant?: string;
  evidenceScore?: number;
  quiz?: { bestScore?: number; attempts?: number; byDomain?: Record<string, number> };
}

export type LabProgressStatus = 'not_started' | 'attempted' | 'completed' | 'completed_manual' | (string & {});

/** `GET /labs` 的 items[]（只含有记录的卡片）。 */
export interface LabItem {
  labId: string;
  status: LabProgressStatus;
  attempts: number;
  bestAttemptId?: string | null;
  firstCompletedAt?: string | null;
  completedMajorVersion?: number | null;
  badge?: BadgeView | null;
  lastSession?: { sessionId: string; state: SessionState } | null;
}

export interface EnvironmentStrip {
  holderLabId: string;
  sessionId: string;
  envId?: string | null;
  state: SessionState;
  deadlineAt?: string | null;
  keepUntil?: string | null;
  reservedBy?: string | null;
  costTier?: CostTier;
}

export interface LabsView {
  catalogVersion: string | null;
  currentTrackId: string;
  environment: EnvironmentStrip | null;
  items: LabItem[];
  serverNow?: string;
}

export interface StartReason {
  code: string;
  detail?: string;
  ackable?: boolean;
  sessionId?: string;
  state?: SessionState;
  labId?: string;
  residues?: { resourceKey?: string | null; type?: string | null; name?: string | null; sessionId?: string | null }[];
  [k: string]: unknown;
}

export interface Startability {
  canStart: boolean;
  reasons: StartReason[];
  reuse: { environmentId: string; fromLabId: string; sessionId?: string; compatible: boolean; reason?: string } | null;
  variants: { id: string; select: string; title?: string }[];
}

/** `GET /labs/{labId}`：简介页的个人部分。 */
export interface LabDetail {
  labId: string;
  catalogVersion: string;
  labVersion?: string;
  status?: CardStatus;
  progress: { status: LabProgressStatus; attempts: number; badge?: BadgeView | null };
  attempts: { sessionId: string; state: SessionState; variant?: string; createdAt: string; readyAt?: string | null; endedAt?: string | null; endReason?: string | null }[];
  startability: Startability;
  serverNow?: string;
}

export type MasteryLevel = 'proficient' | 'mastered' | 'touched' | 'not_started';

export interface ServiceMasteryView {
  id: string;
  level: MasteryLevel;
  viaScenarios?: boolean;
  score: number;
  needsReview: boolean;
  serviceCard?: { labId: string; badgeLevel: string | null } | null;
  scenarioCredits?: string[];
  quiz?: { ratio: number | null; correct?: number; total?: number };
}

export interface MasteryView {
  catalogVersion: string | null;
  services: ServiceMasteryView[];
}

/** `GET /me/progress`。 */
export interface ProgressRecordView {
  labId: string;
  kind?: CardKind;
  status?: LabProgressStatus;
  attempts?: number;
  badge?: BadgeView | null;
  credits?: { serviceId: string }[];
  regressions?: { serviceId: string; foundInSession?: string; at?: string }[];
}

export interface MyProgressView {
  labs: ProgressRecordView[];
  tracks: { trackId: string; title: string | null; requiredDone: number; requiredTotal: number; completed: boolean; eligible: boolean }[];
  subject?: { displayName: string | null };
}

/** `GET /tracks/{trackId}`。 */
export interface TrackDetailView {
  track: TrackDef;
  progress: {
    trackId: string;
    required: { labId: string; done: boolean; badge: BadgeView | null }[];
    optional: { labId: string; done: boolean }[];
    groups: { groupId: string; title?: string; pick: number; cards: string[]; done: number }[];
    requiredDone: number;
    requiredTotal: number;
    verifiedRatio: number | null;
    completed: boolean;
    certificate: { eligible: boolean; reasons: { code: string; [k: string]: unknown }[] };
  };
  certificate: { eligible: boolean; reasons: { code: string; [k: string]: unknown }[]; current: { certId: string; status: string } | null };
}

export interface TracksListView {
  catalogVersion: string;
  items: (Omit<TrackDef, 'stages'> & { stageCount?: number; progress?: { requiredDone: number; requiredTotal: number; completed: boolean; eligible: boolean } })[];
}

export interface CertificateItem {
  certId: string;
  status: string;
  trackId?: string | null;
  labId?: string | null;
  scope?: string;
  issuedAt?: string | null;
  createdAt?: string | null;
  revokedAt?: string | null;
  revocationReason?: string | null;
  reason?: string | null;
  public?: boolean;
  [k: string]: unknown;
}

export interface SessionListItem {
  sessionId: string;
  labId: string;
  variant?: string;
  state: SessionState;
  endReason?: string | null;
  createdAt: string;
  readyAt?: string | null;
  endedAt?: string | null;
  deadlineAt?: string | null;
  durationMinutes?: number | null;
  cleanup?: { status?: string; manual?: number; hourlyBlocking?: number } | null;
  attemptStatus?: string | null;
  terminal?: boolean;
}

// ---------------------------------------------------------------------------------------------------------------
// 报价 CostQuote（01 §7.3、02 §3.2；08 §9.2 #6 回写前按已有字段渲染）

export interface Range {
  low: number;
  high: number;
  typical?: number;
}

export interface QuoteLine {
  group: 'start' | 'target' | 'extra-stack' | 'step' | 'monthly' | 'usage' | 'platform' | 'workstation' | 'environment' | (string & {});
  service?: string;
  dimension?: string;
  detail?: string;
  ref?: string;
  key?: string;
  pricingKey?: string;
  billing?: string;
  quantity?: number;
  unit?: string;
  optional?: boolean;
  whenRetained?: boolean;
  perHourLow?: number;
  perHourHigh?: number;
  unknown?: boolean;
}

export interface CostQuote {
  quoteId: string;
  purpose: 'START' | 'REUSE' | 'EXTEND' | 'KEEP' | (string & {});
  labId?: string;
  labVersion?: string;
  catalogVersion?: string;
  variant?: string;
  region?: string;
  currency?: string;
  priceAsOf?: string | null;
  lines?: QuoteLine[];
  hourly?: { start: Range | null; completed: Range | null } | null;
  retainHourly?: number | null;
  platformOverhead?: {
    low: number | null;
    high: number | null;
    notes?: string[];
    perHour?: { low: number; high: number } | null;
    perSession?: { low: number; high: number; basis?: 'history' | 'class' } | null;
    qualitative?: string[];
  } | null;
  maxSession?: Range | null;
  incomplete?: string[];
  freeTierNote?: boolean;
  notes?: string[];
  /** `fixture`：开发模式的示例单价（不是 AWS 价格）。 */
  pricing?: 'price-list' | 'fixture' | 'unavailable' | (string & {});
  durationMinutes?: number;
  maxTotalMinutes?: number;
  reuseEnvironmentId?: string | null;
  reusePlan?: {
    environmentId: string;
    compatible: boolean;
    reason?: string;
    enable: string[];
    change: { module: string; replacesInstance: boolean | null; downtime: boolean | null }[];
    extraModules: string[];
    manualResources: number;
    failureNote?: string;
  } | null;
  issuedAt?: string;
  expiresAt: string;
  disclaimer?: string;
}

// ---------------------------------------------------------------------------------------------------------------
// 小测（04 §3.2.11；routes/catalog.ts quizRoutes）

export interface QuizQuestion {
  id: string;
  type: 'single' | 'multiple' | (string & {});
  domain?: SaaDomain | string;
  stem: string;
  options: { id: string; text: string }[];
}

export interface QuizAttemptStart {
  attemptId: string;
  labId: string;
  deadlineAt?: string | null;
  questions: QuizQuestion[];
  /** 题库按语言（09 §2）：请求的语言，以及显示了其他语言的题目 */
  i18n?: { lang: string; untranslated?: string[] };
}

export interface QuizResult {
  attemptId: string;
  labId: string;
  score: number;
  correct: number;
  total: number;
  byDomain: Record<string, { correct: number; total: number }>;
  results: { id: string; correct: boolean; given: string[]; answer: string[]; explain: string | null; relatesTo: string | null }[];
}
