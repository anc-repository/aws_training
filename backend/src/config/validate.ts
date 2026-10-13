// backend/src/config/validate.ts —— 启动配置校验的三步（总纲 4.5 第 1～3 步），buildContainer 与 `cli check-config` 共用
//
//   1) 分层加载 + 键归属检查（load-env.ts，CFG-002/003）
//   2) 结构校验（zod，schema.ts；含“未实现的驱动”，CFG-001）
//   3) 语义校验（规则引擎，rules/engine.ts + rules.ts）
import type { ProcessRole } from '../observability/lab-metrics.js';
import { runRules, emptyVerdict, type RuleScope, type Verdict } from '../rules/engine.js';
import { RULES } from '../rules/rules.js';
import { REGISTRY } from '../modules/registry.js';
import { loadEnvLayers, type EnvLayers } from './load-env.js';
import { parseConfig, type ParsedConfig } from './schema.js';

export const DEFAULT_ENV_DIR = '/etc/cloudalbum';

export interface ConfigValidation {
  layers: EnvLayers;
  parsed: ParsedConfig;
  verdict: Verdict;
  ok: boolean;
}

export interface ValidateOptions {
  role: ProcessRole;
  /** 默认 process.env.CLOUDALBUM_ENV_DIR ?? /etc/cloudalbum */
  envDir?: string;
  processEnv?: NodeJS.ProcessEnv;
  /** 已加载的分层（测试、scripts/module 的计划校验） */
  layers?: EnvLayers;
  /** 默认 ['startup']；`check-config --plan` 为 ['startup', 'deploy'] */
  phases?: readonly RuleScope[];
  lockScope?: 'host' | 'cluster';
  /** 拒绝本轮未实现的驱动（默认 true） */
  checkImplemented?: boolean;
}

/** 结构校验失败时规则引擎无法运行，但 CFG-002 / CFG-003（键归属）仍要一次性列出 */
function layerIssuesVerdict(layers: EnvLayers): Verdict {
  const v = emptyVerdict();
  for (const i of layers.issues) {
    v.errors.push({ rule: i.code, category: 'CFG', severity: 'error', modules: [], message: i.message });
  }
  return v;
}

export async function validateConfig(opts: ValidateOptions): Promise<ConfigValidation> {
  const processEnv = opts.processEnv ?? process.env;
  const envDir = opts.envDir ?? processEnv.CLOUDALBUM_ENV_DIR ?? DEFAULT_ENV_DIR;
  const layers = opts.layers ?? (await loadEnvLayers(envDir, { processEnv, registry: REGISTRY }));
  const input = { ...layers.merged, CLOUDALBUM_ROLE: opts.role };
  const parsed = parseConfig(input, opts.checkImplemented === undefined ? {} : { checkImplemented: opts.checkImplemented });
  // 只有“未实现的驱动”（CFG-001）时结构本身是合法的：照样运行规则引擎，把语义错误（例如 ASG-002）一并列出（一次性打印全部错误）。
  // parsed.config 仍为 undefined，container 照样拒绝启动。
  const onlyImplementation = !parsed.config && parsed.errors.length > 0 && parsed.errors.every((e) => e.section === 'implementation');
  const structural = onlyImplementation ? parseConfig(input, { checkImplemented: false }) : parsed;
  const verdict = structural.config
    ? runRules(RULES, {
      cfg: structural.config, env: structural.effective, layers, role: opts.role,
      ...(opts.lockScope ? { lockScope: opts.lockScope } : {}),
    }, { phases: opts.phases ?? ['startup'] })
    : layerIssuesVerdict(layers);
  return { layers, parsed, verdict, ok: parsed.errors.length === 0 && verdict.errors.length === 0 };
}
