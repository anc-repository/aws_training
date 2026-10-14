/**
 * 卡片内容（`atl.lab/v2`，04 §3；`labs:build` 输出到 `/content/<catalogVersion>/labs/<labId>.json`，经 CloudFront 提供，不走 API，
 * 03 §2.1）。这里只声明工作台用到的字段；手册是构建期编译好的 mdast（`manuals[<path>].ast`，04 §4.5），前端逐节点渲染。
 *
 * 规划中（`status: planned`）的卡片没有 `steps` 与 `manuals`：工作台显示“手册内容缺失”的空态（P05 文案示例）。
 */

import { msg } from '../../i18n';
import { contentUrl, fetchContentJson } from '../../i18n/content';
export type StepType = 'console' | 'cli' | 'script' | 'code' | 'observe' | 'experiment';
export type PanelId = 'terminal-lab' | 'terminal-workstation' | 'console' | 'preview';
export const PANELS: readonly PanelId[] = ['terminal-lab', 'terminal-workstation', 'console', 'preview'];

export interface MdNode {
  type: string;
  name?: string;
  value?: string;
  lang?: string | null;
  meta?: string | null;
  label?: string;
  depth?: number;
  ordered?: boolean;
  checked?: boolean | null;
  url?: string;
  attributes?: Record<string, string | boolean | number | null | undefined>;
  children?: MdNode[];
}

export interface ManualFile {
  frontMatter?: { step?: string; section?: string };
  ast: MdNode;
  /** 这份手册实际的语言（按语言构建的内容才有；与界面语言不同时显示“未翻訳”标记，09 §2.4）。 */
  lang?: string;
}

export type StepCheckRef = string | { ref: string; as?: string; required?: boolean };

export interface LabStep {
  id: string;
  type: StepType;
  title: string;
  manual?: string;
  estMinutes?: number;
  panel?: PanelId;
  checks?: StepCheckRef[];
  experiment?: { module: string; id: string; label: string };
  methods?: string[];
  requires?: { steps?: string[] };
  startsBilling?: { class?: string; pricingKeys?: string[]; note?: string };
  wait?: { typicalMinutes?: number; maxMinutes?: number; text?: string };
  optional?: boolean | { when?: string };
  expectedOutage?: { channel?: string; maxMinutes?: number; reason?: string };
  wire?: boolean;
}

export interface ManualSpecOption {
  value: string;
  label: string;
  expected?: boolean;
  fixHint?: string;
}

export interface ManualSpec {
  where?: Record<string, unknown>;
  confirm?: string;
  observed?: { question: string; options?: ManualSpecOption[] };
  input?: { pattern?: string; example?: string; label?: string } & Record<string, unknown>;
  evidence?: { command?: { run: string; runsOn: 'workstation' | 'lab' }; parse?: 'json' };
}

export interface CheckDecl {
  id: string;
  title: string;
  type: 'local' | 'capability' | 'http-header' | 'aws-readonly' | 'experiment' | 'manual';
  required?: boolean;
  wait?: { typicalMinutes: number; maxMinutes: number };
  reproduce?: { run: string; runsOn: 'workstation' | 'lab' };
  pitfalls?: string[];
  explain?: string;
  spec?: ManualSpec;
  manualFallback?: ManualSpec;
  module?: string;
  experiment?: string;
  label?: string;
}

export interface ExperimentLabel {
  id: string;
  role?: 'baseline' | 'treatment' | 'single';
  title?: string;
  description?: string;
  requires?: Record<string, string>;
}

export interface ExperimentDecl {
  module: string;
  id: string;
  title?: string;
  labels: (string | ExperimentLabel)[];
  pairs?: [string, string][];
  required?: boolean;
  runner?: string;
  validity?: 'traffic' | 'functional';
  corroborateWith?: string[];
  allowSimulatedBaseline?: boolean;
  metrics?: { key: string; label?: string; unit?: string; better?: 'lower' | 'higher' | 'neutral' }[];
}

export interface VariableDecl {
  label?: string;
  from?: string;
  fillFrom?: string;
  pattern?: string;
  example?: string;
}

export interface PlatformOp {
  id: string;
  title?: string;
  confirm?: string;
  interruptsManagementChannel?: boolean;
}

export interface Pitfall {
  id: string;
  title?: string;
  cause?: string;
  fix?: string;
}

export interface LabDoc {
  schema?: string;
  id: string;
  kind: 'service' | 'scenario';
  status?: string;
  title: string;
  subtitle?: string;
  service?: string;
  function?: string;
  timeLimitMinutes?: number;
  extensions?: { maxCount?: number; minutesEach?: number };
  retain?: { allowed?: boolean; maxHours?: number; reason?: string };
  provision?: { class?: 'A' | 'B' | 'C' | string };
  services?: { id: string; name?: string; role?: string; module?: string }[];
  targetModules?: { id: string; driver?: string; wireStep?: string }[];
  workstation?: { required?: boolean; tools?: string[]; savingsMode?: string };
  platform?: { consoleLinks?: string[] };
  platformOps?: PlatformOp[];
  keepablePrerequisites?: string[];
  variables?: Record<string, VariableDecl>;
  cost?: { tier?: string; mainDrivers?: string[] };
  steps?: LabStep[];
  experiments?: ExperimentDecl[];
  checks?: Record<string, CheckDecl>;
  pitfalls?: Record<string, Pitfall>;
  badge?: { title?: string };
  manuals?: Record<string, ManualFile>;
  catalogVersion?: string;
}

/** `/content/<catalogVersion>/labs/<labId>.json`（版本由会话固定，P05.11）。 */
export function labContentUrl(catalogVersion: string, labId: string): string {
  return `/content/${encodeURIComponent(catalogVersion)}/labs/${encodeURIComponent(labId)}.json`;
}

export function catalogIndexUrl(catalogVersion: string): string {
  return `/content/${encodeURIComponent(catalogVersion)}/catalog/index.json`;
}

const cache = new Map<string, Promise<unknown>>();

/** 读取静态内容（同一 URL 在本标签页只取一次；失败的不缓存）。 */
export function fetchContent<T>(url: string, fetchImpl: typeof fetch = (...a) => globalThis.fetch(...a)): Promise<T> {
  // 按当前界面语言读取（09 §2.4）；缓存键是改写后的地址
  const key = contentUrl(url);
  const hit = cache.get(key);
  if (hit) return hit as Promise<T>;
  const p = fetchContentJson<T>(url, fetchImpl).then((r) => {
    if (!r.ok) throw new Error(`content ${r.url}: HTTP ${r.status}`);
    return r.data as T;
  });
  cache.set(key, p);
  p.catch(() => cache.delete(key));
  return p;
}

/** 测试用。 */
export function clearContentCache(): void {
  cache.clear();
}

/** 步骤检查引用的本地 id（`{ref, as}` 时取 as）。 */
export function checkLocalId(ref: StepCheckRef): string {
  return typeof ref === 'string' ? ref : (ref.as ?? ref.ref);
}

export function checkRefRequired(ref: StepCheckRef, decl: CheckDecl | undefined): boolean {
  if (typeof ref !== 'string' && ref.required !== undefined) return ref.required;
  return decl?.required !== false;
}

export function stepManual(lab: LabDoc, step: LabStep): ManualFile | null {
  if (step.manual && lab.manuals?.[step.manual]) return lab.manuals[step.manual]!;
  const hit = Object.values(lab.manuals ?? {}).find((m) => m.frontMatter?.step === step.id);
  return hit ?? null;
}

export function sectionManual(lab: LabDoc, section: 'overview' | 'wrap-up' | 'cleanup'): ManualFile | null {
  return Object.values(lab.manuals ?? {}).find((m) => m.frontMatter?.section === section) ?? null;
}

/** 步骤激活时右侧默认标签（04 §4.1：console → 控制台；cli/script/experiment → 工作台终端；code → 实验机终端；observe → 预览）。 */
export function defaultPanelOf(step: Pick<LabStep, 'type' | 'panel'>): PanelId {
  if (step.panel && PANELS.includes(step.panel)) return step.panel;
  switch (step.type) {
    case 'console':
      return 'console';
    case 'code':
      return 'terminal-lab';
    case 'observe':
      return 'preview';
    default:
      return 'terminal-workstation';
  }
}

export function isOptional(step: LabStep): boolean {
  return !!step.optional;
}

export function experimentLabels(exp: ExperimentDecl): ExperimentLabel[] {
  return exp.labels.map((l, i) =>
    typeof l === 'string' ? { id: l, role: exp.labels.length === 1 ? 'single' : i === 0 ? 'baseline' : 'treatment' } : { ...l, role: l.role ?? (i === 0 ? 'baseline' : 'treatment') },
  );
}

export function findExperiment(lab: LabDoc | null, key: string): ExperimentDecl | null {
  if (!lab?.experiments) return null;
  const [module, id] = key.split('/');
  return lab.experiments.find((e) => e.module === module && e.id === id) ?? null;
}

export const STEP_TYPE_TEXT: Readonly<Record<StepType, string>> = msg.workspace.labText.stepType;

/**
 * 部署等级（02 §11.1）：定性说明（P04：没有历史耗时数据时只显示等级说明，§9.2 #10）与默认部署预算。
 * 预算只作内部上限（“接近部署预算”提示用 80%），界面不显示分钟数（08 P04 状态表）。
 */
const provisionClass = (k: 'A' | 'B' | 'C' | 'D', budgetMinutes: number) => ({
  get name() {
    return msg.workspace.labText.provisionName[k];
  },
  get note() {
    return msg.workspace.labText.provisionNote[k];
  },
  budgetMinutes,
});

export const PROVISION_CLASS: Readonly<Record<string, { readonly name: string; readonly note: string; budgetMinutes: number }>> = {
  A: provisionClass('A', 30),
  B: provisionClass('B', 45),
  C: provisionClass('C', 90),
  D: provisionClass('D', 120),
};
