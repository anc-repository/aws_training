/**
 * modules/registry.yaml 的 CI 校验（总纲 §3.5、§4.4 末尾、§5.1）：
 *   1. 符合 registry.schema.json；
 *   2. packages/contracts/src/generated/registry.ts 与 YAML 一致（npm run gen:registry）；
 *   3. 规则 ID 在 rules.ts 中唯一；registry 的每个 `rule:` 都在 rules.ts 中；rules.ts 的每条 DEP / MUTEX 都被至少一个
 *      registry 条目引用（显式豁免见 RULE_REFERENCE_EXEMPTIONS）；requires 只引用 DEP、conflicts 只引用 MUTEX；
 *      registry 中 `severity: warn` 与 rules.ts 的级别一致；
 *   4. `doc` 指向的文件与锚点 `<a id="<id>"></a>` 存在；
 *   5. `ownsEnv` 前缀两两不重叠，或按“最长前缀”唯一归属（同一个完整项不能出现在两个模块里）；
 *   6. requires / conflicts 的 when、need 与 selfHosted.match 中出现的每个变量、以及每个开关变量都在 config/schema.ts 中声明；
 *      need 中的模块 id 合法；枚举开关的每个取值都能通过 zod 的开关校验；
 *   7. 本轮 MVP 模块与 ec2 的条目写完整（version、lab.summary、lab.keyMetrics、lab.badges）。
 */
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { MODULE_IDS, isModuleId, isParamSwitch, type ModuleId, type RegistryDocument } from '@cloudalbum/contracts';
import { CONFIG_KEYS, parseConfig } from '../../backend/src/config/schema.js';
import { MVP_MODULES } from '../../backend/src/config/implemented.js';
import { RULES } from '../../backend/src/rules/rules.js';
import { GENERATED_TS, REPO_ROOT, loadRegistry, renderGenerated, validateRegistrySchema } from './lib.js';

/** “rules.ts 的每条 DEP / MUTEX 都被 registry 引用”的显式豁免（附理由） */
export const RULE_REFERENCE_EXEMPTIONS: Readonly<Record<string, string>> = {
  'DEP-012': '总纲第 3 轮修订记录：Post Confirmation 触发器还没有开关变量与 registry 引用，待 02 组定名',
};

export interface CheckReport {
  errors: string[];
  warnings: string[];
  stats: { modules: number; rules: number; registryRuleRefs: number };
}

function needAtoms(item: string): string[] {
  return item.split('|').map((s) => s.trim()).filter(Boolean);
}

function atomVariable(atom: string): string | null {
  const ne = atom.indexOf('!=');
  const eq = atom.indexOf('=');
  if (ne === -1 && eq === -1) return null;
  return (ne !== -1 && ne === eq - 1 ? atom.slice(0, ne) : atom.slice(0, eq)).trim();
}

export function checkRegistry(): CheckReport {
  const errors: string[] = [];
  const warnings: string[] = [];
  const loaded = loadRegistry();
  const doc: RegistryDocument = loaded.doc;

  // 1. schema
  for (const e of validateRegistrySchema(doc)) errors.push(`schema ${e}`);
  if (errors.length) return { errors, warnings, stats: { modules: 0, rules: RULES.length, registryRuleRefs: 0 } };

  // 2. 生成文件
  const generated = existsSync(GENERATED_TS) ? readFileSync(GENERATED_TS, 'utf8') : '';
  if (generated !== renderGenerated(loaded)) {
    errors.push('packages/contracts/src/generated/registry.ts 已过期：运行 npm run gen:registry 并提交');
  }

  // 3. 规则交叉引用
  const ruleIds = new Map<string, number>();
  for (const r of RULES) ruleIds.set(r.id, (ruleIds.get(r.id) ?? 0) + 1);
  for (const [id, n] of ruleIds) if (n > 1) errors.push(`rules.ts 中规则 ID 重复：${id}（${n} 次）`);
  const referenced = new Set<string>();
  let refs = 0;
  for (const id of MODULE_IDS) {
    const m = doc.modules[id];
    for (const [kind, list] of [['requires', m.requires ?? []], ['conflicts', m.conflicts ?? []]] as const) {
      for (const e of list) {
        refs += 1;
        referenced.add(e.rule);
        const rule = RULES.find((r) => r.id === e.rule);
        if (!rule) {
          errors.push(`${id}.${kind}: 规则 ${e.rule} 不在 rules.ts 中`);
          continue;
        }
        if (kind === 'requires' && rule.category !== 'DEP') errors.push(`${id}.requires 引用了非 DEP 规则 ${e.rule}`);
        if (kind === 'conflicts' && rule.category !== 'MUTEX') errors.push(`${id}.conflicts 引用了非 MUTEX 规则 ${e.rule}`);
        if (!rule.fromRegistry) errors.push(`${id}.${kind}: 规则 ${e.rule} 在 rules.ts 中没有标记 fromRegistry`);
        const sev = 'severity' in e && e.severity ? e.severity : 'error';
        if (kind === 'requires' && sev !== rule.severity) {
          errors.push(`${id}.requires ${e.rule}: registry 级别 ${sev} 与 rules.ts 的 ${rule.severity} 不一致`);
        }
      }
    }
  }
  for (const r of RULES) {
    if ((r.category === 'DEP' || r.category === 'MUTEX') && !referenced.has(r.id) && !RULE_REFERENCE_EXEMPTIONS[r.id]) {
      errors.push(`rules.ts 的 ${r.id} 没有被任何 registry 条目引用`);
    }
    if (r.fromRegistry && !referenced.has(r.id)) errors.push(`rules.ts 的 ${r.id} 标记了 fromRegistry，但 registry 中没有对应表达式`);
  }
  for (const [id, reason] of Object.entries(RULE_REFERENCE_EXEMPTIONS)) warnings.push(`豁免 ${id}：${reason}`);

  // 4. doc 锚点
  for (const id of MODULE_IDS) {
    const [file, anchor] = doc.modules[id].doc.split('#');
    const abs = path.join(REPO_ROOT, file ?? '');
    if (!file || !existsSync(abs)) {
      errors.push(`${id}.doc: 文件不存在 ${file}`);
      continue;
    }
    if (anchor !== id) warnings.push(`${id}.doc: 锚点 #${anchor} 与模块 id 不同`);
    if (!readFileSync(abs, 'utf8').includes(`<a id="${anchor}"></a>`)) errors.push(`${id}.doc: ${file} 中没有锚点 <a id="${anchor}"></a>`);
  }

  // 5. ownsEnv 归属
  const entryOwner = new Map<string, ModuleId>();
  for (const id of MODULE_IDS) {
    for (const entry of doc.modules[id].ownsEnv ?? []) {
      const prev = entryOwner.get(entry);
      if (prev) errors.push(`ownsEnv 项 ${entry} 同时出现在 ${prev} 与 ${id}`);
      else entryOwner.set(entry, id);
    }
  }
  const prefixes = [...entryOwner.entries()].filter(([e]) => e.endsWith('_'));
  for (const [a, ma] of prefixes) {
    for (const [b, mb] of prefixes) {
      if (a !== b && ma !== mb && b.startsWith(a)) warnings.push(`ownsEnv 前缀重叠：${a}（${ma}）⊃ ${b}（${mb}），按最长前缀归 ${mb}`);
    }
  }

  // 6. 变量声明与表达式
  const declared = (v: string, where: string) => {
    if (!CONFIG_KEYS.has(v)) errors.push(`${where}: 变量 ${v} 没有在 backend/src/config/schema.ts 的任何分段中声明`);
  };
  for (const id of MODULE_IDS) {
    const m = doc.modules[id];
    if (m.switch) declared(m.switch.var, `${id}.switch`);
    for (const k of Object.keys(m.selfHosted?.match ?? {})) declared(k, `${id}.selfHosted.match`);
    const exprs = [...(m.requires ?? []), ...(m.conflicts ?? [])];
    for (const e of exprs) {
      for (const k of Object.keys(e.when ?? {})) declared(k, `${id} ${e.rule}.when`);
      for (const item of ('need' in e ? e.need ?? [] : [])) {
        for (const atom of needAtoms(item)) {
          const v = atomVariable(atom);
          if (v) declared(v, `${id} ${e.rule}.need`);
          else if (!isModuleId(atom)) errors.push(`${id} ${e.rule}.need: “${atom}” 既不是模块 id 也不是变量条件`);
        }
      }
    }
    // 枚举开关的每个取值都能通过 zod 的开关校验（其他必填变量的缺失不算）
    if (m.switch && !isParamSwitch(m.switch)) {
      for (const value of m.switch.values) {
        const r = parseConfig({ CLOUDALBUM_ROLE: 'cli', [m.switch.var]: value });
        const bad = r.errors.filter((e) => e.path === m.switch!.var && e.section !== 'implementation');
        if (bad.length) errors.push(`${id}.switch: ${m.switch.var}=${value} 被 zod 拒绝：${bad.map((b) => b.message).join('; ')}`);
      }
    }
  }

  // 7. MVP 模块与 ec2 写完整
  for (const id of ['ec2', ...MVP_MODULES] as ModuleId[]) {
    const m = doc.modules[id];
    if (!m.version) errors.push(`${id}: 缺少 version（MVP 模块与 ec2 必须写完整）`);
    if (!m.lab.summary?.local || !m.lab.summary?.aws) errors.push(`${id}: 缺少 lab.summary.local / aws`);
    if (!m.lab.keyMetrics?.length) errors.push(`${id}: 缺少 lab.keyMetrics`);
    if (!m.lab.badges) errors.push(`${id}: 缺少 lab.badges`);
    if (!m.lab.experiments?.length) errors.push(`${id}: 缺少 lab.experiments`);
  }

  return { errors, warnings, stats: { modules: MODULE_IDS.length, rules: RULES.length, registryRuleRefs: refs } };
}
