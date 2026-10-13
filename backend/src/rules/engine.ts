// backend/src/rules/engine.ts —— 规则执行、registry 表达式求值、覆盖（CLOUDALBUM_ALLOW_UNSAFE）、报告输出（总纲 §5）
//
// 同一份规则表在三个时刻运行：部署前计划（scripts/module，phases = startup + deploy）、进程启动（buildContainer /
// cli check-config，phase = startup）、运行中（探针循环，phase = runtime，只产生 warn）。
//
// registry 表达式（§5.1）：
//   - need 项：模块 id（= 该模块的 AWS 实现已启用）、`a | b`（任选其一）、`VAR=value`、`VAR!=value`、`VAR!=`（非空）、
//     `VAR=`（为空）、`VAR=loopback` / `VAR!=loopback`（主机部分是否为回环地址）。
//   - when：全部键值相等时触发；省略 when 表示“本模块开关取 AWS 值时”。
//   - 实现细化：如果一个 when 在“全部默认值”（纯 L0）下就成立、且没有引用本模块自己的开关变量（例如 cdn 的
//     `CDN_MEDIA_ORIGIN: ec2`、identity-pool 的 `IDENTITY_DEV_PROVIDER: ""`），它只在本模块离开本地默认值时生效——
//     否则 L0 本身就会违反这些规则。
//   - need: [] 表示没有启动期条件；条件由 rules.ts 中同 ID 规则的 check() / deployCheck() 给出。
import { MODULE_IDS, isModuleId, type ModuleId } from '@cloudalbum/contracts';
import { parseConfig, type AppConfig, type ConfigIssue } from '../config/schema.js';
import type { EnvLayers } from '../config/load-env.js';
import { isLoopback } from '../config/net.js';
import {
  REGISTRY, enabledModules, isActive, isEnabled, moduleFlagOn, switchOf, type Registry,
} from '../modules/registry.js';

export type Severity = 'error' | 'warn';
export type RuleCategory = 'CFG' | 'CRED' | 'DEP' | 'MUTEX' | 'ASG' | 'SEC';
export type RuleScope = 'startup' | 'deploy' | 'runtime';
export type ProcessRole = 'api' | 'worker' | 'cli';

/** 运行期规则的输入：感知器观测结果（SEC-001～005、DEP-018） */
export type RuntimeObservations = Partial<Record<ModuleId, Record<string, unknown>>>;

export interface RuleContext {
  cfg: AppConfig;
  /** 有效 env（parseConfig().effective）：原始值 + 默认值，全部为字符串 */
  env: Readonly<Record<string, string>>;
  layers: EnvLayers;
  role: ProcessRole;
  registry: Registry;
  phase: RuleScope;
  /** 开关取 AWS 值的模块（= MODULE_<ID>=on，CFG-004 保证两者一致） */
  enabled(): ModuleId[];
  isEnabled(id: ModuleId): boolean;
  /** 开关离开本地默认值（AWS 实现、本地档或自建档） */
  isActive(id: ModuleId): boolean;
  /** env 文件中是否写了 MODULE_<ID>=on（“声明启用”） */
  flagOn(id: ModuleId): boolean;
  /** LockPort 的作用域（container 按 postgres > redis > 文件锁选择；ASG-006） */
  lockScope(): 'host' | 'cluster';
  observed?: RuntimeObservations;
}

export interface RuleHit { severity?: Severity; message?: string; modules?: ModuleId[] }
export type CheckResult = boolean | RuleHit | RuleHit[] | null | undefined;

export interface Rule {
  id: string;
  category: RuleCategory;
  severity: Severity;
  /** 可以用 CLOUDALBUM_ALLOW_UNSAFE 降级为警告（教学用） */
  overridable: boolean;
  scope: RuleScope | readonly RuleScope[];
  modules: readonly ModuleId[];
  /** 条件取自 registry 中同 ID 的 requires / conflicts 表达式 */
  fromRegistry?: boolean;
  /** 仅 DEPLOY_MODE=asg 时检查（ASG 类） */
  asgOnly?: boolean;
  /** 条件（启动期 / 运行期）：返回 true 或 RuleHit 表示违规 */
  check?: (ctx: RuleContext) => CheckResult;
  /** 部署范围、需要读取云端状态的检查（scripts/module 调用；进程启动时不运行） */
  deployCheck?: (ctx: RuleContext, cloud: unknown) => Promise<CheckResult>;
  /** 由其他组件负责（例如 CFG-007 由 container 的密钥指纹比对、CFG-009 由 ConfigPort）；引擎不求值 */
  enforcedBy?: string;
  /** 已废止（编号保留，不复用） */
  abolished?: boolean;
  message: (ctx: RuleContext) => string;
  fix?: string;
}

export interface Finding {
  rule: string;
  category: RuleCategory;
  severity: Severity;
  modules: ModuleId[];
  message: string;
  fix?: string;
}

export interface Verdict {
  errors: Finding[];
  warnings: Finding[];
  /** CLOUDALBUM_ALLOW_UNSAFE 降级的规则 */
  overridden: Finding[];
}

export interface RunInput {
  cfg: AppConfig;
  env: Readonly<Record<string, string>>;
  layers: EnvLayers;
  role: ProcessRole;
  registry?: Registry;
  observed?: RuntimeObservations;
  lockScope?: 'host' | 'cluster';
}

export function emptyVerdict(): Verdict {
  return { errors: [], warnings: [], overridden: [] };
}

/** container 的 pickLock 规则：postgres > redis > 文件锁 */
export function deriveLockScope(env: Readonly<Record<string, string>>): 'host' | 'cluster' {
  if ((env.DB_DRIVER ?? 'sqlite') === 'postgres') return 'cluster';
  if ((env.CACHE_DRIVER ?? 'none') === 'redis') return 'cluster';
  return 'host';
}

export function createContext(input: RunInput, phase: RuleScope): RuleContext {
  const registry = input.registry ?? REGISTRY;
  const env = input.env;
  let enabledCache: ModuleId[] | undefined;
  return {
    cfg: input.cfg,
    env,
    layers: input.layers,
    role: input.role,
    registry,
    phase,
    enabled: () => (enabledCache ??= enabledModules(env, registry)),
    isEnabled: (id) => isEnabled(env, id, registry),
    isActive: (id) => isActive(env, id, registry),
    flagOn: (id) => moduleFlagOn(env, id),
    lockScope: () => input.lockScope ?? deriveLockScope(env),
    ...(input.observed ? { observed: input.observed } : {}),
  };
}

// ---------------------------------------------------------------------------------------------
// registry 表达式求值
// ---------------------------------------------------------------------------------------------

/** 求值单个 need 项（可含 `|`）。返回 true = 满足。 */
export function evaluateNeed(item: string, ctx: Pick<RuleContext, 'env' | 'isEnabled'>): boolean {
  return item.split('|').map((s) => s.trim()).filter(Boolean).some((alt) => evaluateAtom(alt, ctx));
}

function evaluateAtom(atom: string, ctx: Pick<RuleContext, 'env' | 'isEnabled'>): boolean {
  const ne = atom.indexOf('!=');
  const eq = atom.indexOf('=');
  if (ne === -1 && eq === -1) {
    if (isModuleId(atom)) return ctx.isEnabled(atom);
    throw new Error(`无法求值的依赖表达式：${atom}`);
  }
  const negate = ne !== -1 && ne === eq - 1;
  const key = negate ? atom.slice(0, ne).trim() : atom.slice(0, eq).trim();
  const expected = (negate ? atom.slice(ne + 2) : atom.slice(eq + 1)).trim();
  const actual = ctx.env[key] ?? '';
  let match: boolean;
  if (expected === 'loopback') match = isLoopback(actual);
  else match = actual === expected;
  return negate ? !match : match;
}

/** when 是否成立（省略 when = 模块启用时） */
export function evaluateWhen(
  when: Record<string, string> | undefined,
  module: ModuleId,
  ctx: Pick<RuleContext, 'env' | 'isEnabled' | 'isActive' | 'registry'>,
  defaults?: Readonly<Record<string, string>>,
): boolean {
  if (!when || Object.keys(when).length === 0) return ctx.isEnabled(module);
  const holds = Object.entries(when).every(([k, v]) => (ctx.env[k] ?? '') === String(v));
  if (!holds) return false;
  if (defaults) {
    const ownVar = switchOf(module, ctx.registry)?.var;
    const referencesOwnSwitch = ownVar ? Object.prototype.hasOwnProperty.call(when, ownVar) : false;
    const holdsAtDefaults = Object.entries(when).every(([k, v]) => (defaults[k] ?? '') === String(v));
    if (holdsAtDefaults && !referencesOwnSwitch) return ctx.isActive(module);
  }
  return true;
}

interface RegistryExpr {
  module: ModuleId;
  kind: 'requires' | 'conflicts';
  when?: Record<string, string>;
  need?: string[];
  conflictModule?: ModuleId;
  severity?: Severity;
}

export function registryExpressionsByRule(registry: Registry = REGISTRY): Map<string, RegistryExpr[]> {
  const map = new Map<string, RegistryExpr[]>();
  const add = (rule: string, e: RegistryExpr) => {
    const list = map.get(rule) ?? [];
    list.push(e);
    map.set(rule, list);
  };
  for (const id of MODULE_IDS) {
    const m = registry[id];
    for (const r of m.requires ?? []) {
      add(r.rule, { module: id, kind: 'requires', ...(r.when ? { when: r.when } : {}), need: r.need, ...(r.severity ? { severity: r.severity } : {}) });
    }
    for (const c of m.conflicts ?? []) {
      add(c.rule, {
        module: id, kind: 'conflicts',
        ...(c.when ? { when: c.when } : {}),
        ...(c.need ? { need: c.need } : {}),
        ...(c.module ? { conflictModule: c.module } : {}),
      });
    }
  }
  return map;
}

function describeWhen(e: RegistryExpr): string {
  if (!e.when || Object.keys(e.when).length === 0) return `${e.module} 已启用`;
  return Object.entries(e.when).map(([k, v]) => `${k}=${v}`).join('、');
}

function evaluateRegistryExpr(e: RegistryExpr, ctx: RuleContext, defaults: Readonly<Record<string, string>>): RuleHit | null {
  if (e.conflictModule) {
    const a = ctx.flagOn(e.module) || ctx.isEnabled(e.module);
    const b = ctx.flagOn(e.conflictModule) || ctx.isEnabled(e.conflictModule);
    return a && b ? { modules: [e.module, e.conflictModule], message: `${e.module} 与 ${e.conflictModule} 同时启用` } : null;
  }
  if (!e.need || e.need.length === 0) return null;          // 条件在 rules.ts 的 check() / deployCheck()
  if (!evaluateWhen(e.when, e.module, ctx, defaults)) return null;
  const missing = e.need.filter((n) => !evaluateNeed(n, ctx));
  if (!missing.length) return null;
  return {
    modules: [e.module, ...missing.flatMap((n) => n.split('|').map((s) => s.trim()).filter(isModuleId))],
    message: `条件：${describeWhen(e)}；不满足：${missing.join('、')}`,
  };
}

// ---------------------------------------------------------------------------------------------
// 运行规则
// ---------------------------------------------------------------------------------------------

function scopesOf(rule: Rule): readonly RuleScope[] {
  return typeof rule.scope === 'string' ? [rule.scope] : rule.scope;
}

function normalizeHits(r: CheckResult): RuleHit[] {
  if (!r) return [];
  if (r === true) return [{}];
  return Array.isArray(r) ? r : [r];
}

let DEFAULTS_CACHE: Readonly<Record<string, string>> | undefined;
/** 纯 L0（全部默认值）下的有效 env，用于 evaluateWhen 的“默认即成立”细化。 */
export function defaultEnv(): Readonly<Record<string, string>> {
  return (DEFAULTS_CACHE ??= Object.freeze(parseConfig({ CLOUDALBUM_ROLE: 'cli' }).effective));
}

export interface RunOptions {
  /** 默认 ['startup'] */
  phases?: readonly RuleScope[];
  /** 纯默认配置的有效 env（默认 defaultEnv()） */
  defaults?: Readonly<Record<string, string>>;
}

export function runRules(rules: readonly Rule[], input: RunInput, opts: RunOptions = {}): Verdict {
  const phases = opts.phases ?? ['startup'];
  const defaults = opts.defaults ?? defaultEnv();
  const verdict = emptyVerdict();
  const exprs = registryExpressionsByRule(input.registry ?? REGISTRY);
  const allow = new Set(input.cfg.core.CLOUDALBUM_ALLOW_UNSAFE ?? []);
  const asg = (input.env.DEPLOY_MODE ?? 'single') === 'asg';

  for (const phase of phases) {
    const ctx = createContext(input, phase);
    for (const rule of rules) {
      if (rule.abolished || rule.enforcedBy) continue;
      if (!scopesOf(rule).includes(phase)) continue;
      if (rule.asgOnly && !asg) continue;
      const hits: RuleHit[] = [];
      if (rule.fromRegistry) {
        for (const e of exprs.get(rule.id) ?? []) {
          const h = evaluateRegistryExpr(e, ctx, defaults);
          if (h) hits.push(h);
        }
      }
      if (rule.check) hits.push(...normalizeHits(rule.check(ctx)));
      if (!hits.length) continue;

      const base = rule.message(ctx);
      for (const h of hits) {
        const severity: Severity = phase === 'runtime' ? 'warn' : (h.severity ?? rule.severity);
        const finding: Finding = {
          rule: rule.id,
          category: rule.category,
          severity,
          modules: [...new Set(h.modules ?? [...rule.modules])],
          message: h.message ? `${base}（${h.message}）` : base,
          ...(rule.fix ? { fix: rule.fix } : {}),
        };
        if (severity === 'error' && rule.overridable && allow.has(rule.id)) {
          verdict.overridden.push({ ...finding, severity: 'warn' });
        } else if (severity === 'error') {
          verdict.errors.push(finding);
        } else {
          verdict.warnings.push(finding);
        }
      }
    }
  }
  // 同一条发现在多个阶段重复出现时去重
  const dedupe = (list: Finding[]) => {
    const seen = new Set<string>();
    return list.filter((f) => {
      const k = `${f.rule}|${f.message}`;
      if (seen.has(k)) return false;
      seen.add(k);
      return true;
    });
  };
  verdict.errors = dedupe(verdict.errors);
  verdict.warnings = dedupe(verdict.warnings);
  verdict.overridden = dedupe(verdict.overridden);
  return verdict;
}

// ---------------------------------------------------------------------------------------------
// 报告
// ---------------------------------------------------------------------------------------------

/** 把 zod 结构错误（含未实现驱动）转成 CFG-001 的发现 */
export function parseErrorsToFindings(errors: readonly ConfigIssue[]): Finding[] {
  return errors.map((e) => ({
    rule: 'CFG-001',
    category: 'CFG' as const,
    severity: 'error' as const,
    modules: [],
    message: e.section === 'implementation' ? e.message : `[${e.section}] ${e.path || '(section)'}: ${e.message}`,
    fix: e.section === 'implementation'
      ? '把该开关改回本地实现，或等待后续版本实现该驱动'
      : '重新执行 scripts/module enable <id> 生成完整 env（或修正手工改过的 env 文件）',
  }));
}

/**
 * 总纲 5.3 的输出格式：
 * ```
 * FAIL 配置校验未通过：3 个错误，1 个警告
 *   [ERROR] CRED-001 以下模块需要调用 AWS API，但 IAM_CREDENTIALS=none：storage、queue
 *           修复：scripts/module enable iam
 *   [WARN ] ASG-009  LOG_DRIVER=file：日志分散在各实例，实例终止后日志随之消失
 *           建议：scripts/module enable logging
 * ```
 */
export function printConfigReport(
  parseErrors: readonly ConfigIssue[],
  verdict: Verdict,
  out: (line: string) => void = (l) => process.stderr.write(`${l}\n`),
): string {
  const errors = [...parseErrorsToFindings(parseErrors), ...verdict.errors];
  const lines: string[] = [];
  const total = `${errors.length} 个错误，${verdict.warnings.length} 个警告${verdict.overridden.length ? `，${verdict.overridden.length} 条规则被 CLOUDALBUM_ALLOW_UNSAFE 降级` : ''}`;
  lines.push(errors.length ? `FAIL 配置校验未通过：${total}` : `OK   配置校验通过：${total}`);
  const fmt = (tag: string, f: Finding, fixLabel: string) => {
    lines.push(`  [${tag}] ${f.rule.padEnd(8)} ${f.message}`);
    if (f.fix) lines.push(`          ${fixLabel}：${f.fix}`);
  };
  for (const f of errors) fmt('ERROR', f, '修复');
  for (const f of verdict.overridden) fmt('UNSAFE', f, '说明');
  for (const f of verdict.warnings) fmt('WARN ', f, '建议');
  const text = lines.join('\n');
  for (const l of lines) out(l);
  return text;
}

