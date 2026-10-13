// 徽章文案（总纲 12.3）：文案全部来自 registry.yaml 的 lab.badges；这里只有通用规则，不为单个模块写分支。
//
// 选词规则（lab.badges 的键）：
//   - 模块未启用（status=off）→ 先找与当前驱动同名的键（例如 cache 的 none），再找 selfHosted（EC2 自建档），最后 local；
//   - 模块已启用 → 先找与当前驱动同名的键（例如 iam 的 keys），最后 aws；
//   - variant（例如 storage 的 upload → uploadLocal / uploadAws；ec2 的 footer）优先；
//   - 请求级结果：bypass → bypass 键（紫）；error-bypass / error-basic / error-fallback → degraded 键（黄）；
//     hit → 绿；unknown → unknown 键（灰虚线，前端不猜）；
//   - 状态 degraded / error → degraded / error 键（黄 / 红），没有时在文案后附“降级”/“故障”。
// 占位符 {outcome}、{cacheState}、{multiAz}、{instanceId} 等缺值时连同前面的分隔符一起去掉。
import type { ModuleCapability, ModuleId, RegistryDocument } from '@cloudalbum/contracts';
import { badgesOf } from './registry';

export type BadgeTone = 'local' | 'aws' | 'hit' | 'degraded' | 'error' | 'bypass' | 'unknown';

/** 色调 → CSS 类（.badge-<color>） */
export const TONE_CLASS: Record<BadgeTone, string> = {
  local: 'gray', aws: 'orange', hit: 'green', degraded: 'yellow', error: 'red', bypass: 'purple', unknown: 'unknown',
};

export type BadgeVars = Record<string, string | number | boolean | null | undefined>;

export interface BadgeOptions {
  /** 请求级结果（X-CloudAlbum-Path 段的 outcome，或 Resource Timing 推断的 CDN 缓存状态） */
  outcome?: string | undefined;
  /** 文案变体，例如 'upload'（→ uploadLocal / uploadAws）、'footer'、'card' */
  variant?: string | undefined;
  vars?: BadgeVars | undefined;
}

export interface Badge {
  text: string;
  tone: BadgeTone;
  /** 悬停说明：状态 · detail */
  title: string;
}

const DEGRADED_OUTCOMES = new Set(['error-bypass', 'error-basic', 'error-fallback']);

export function outcomeLabel(outcome: string | undefined): string | undefined {
  if (!outcome) return undefined;
  const v = outcome.toLowerCase();
  if (v === 'hit') return 'HIT';
  if (v === 'miss') return 'MISS';
  if (v === 'refreshhit' || v === 'refresh' || v === 'refresh-hit') return 'RefreshHit';
  return outcome;
}

/** `{key}` 替换；缺值时把占位符与它前面的分隔符（“ · ”或空格）一起去掉 */
export function fillTemplate(tpl: string, vars: BadgeVars): string {
  return tpl
    .replace(/(\s*·\s*|\s+)?\{(\w+)\}/g, (_m, sep: string | undefined, key: string) => {
      const v = vars[key];
      if (v === undefined || v === null || v === '') return '';
      return `${sep ?? ''}${typeof v === 'boolean' ? (v ? '开' : '关') : String(v)}`;
    })
    .replace(/\s*·\s*$/, '')
    .trim();
}

function isSelfHosted(reg: RegistryDocument | null | undefined, id: ModuleId, cap: ModuleCapability): boolean {
  const sh = reg?.modules[id]?.selfHosted;
  return Boolean(sh && cap.status === 'off' && cap.driver === sh.driver);
}

function defaultVars(id: ModuleId, cap: ModuleCapability): BadgeVars {
  const vars: BadgeVars = {};
  const pub = cap.public ?? {};
  const data = cap.data ?? {};
  const multiAz = pub['multiAz'] ?? data['multiAz'];
  if (id === 'database' && cap.status !== 'off') vars.multiAz = typeof multiAz === 'boolean' ? multiAz : '未知';
  return vars;
}

export function baseText(
  id: ModuleId,
  cap: ModuleCapability,
  reg: RegistryDocument | null | undefined,
  variant?: string,
): string {
  const badges = badgesOf(reg, id);
  const enabled = cap.status !== 'off';
  if (variant) {
    const v = badges[`${variant}${enabled ? 'Aws' : 'Local'}`] ?? badges[variant];
    if (v) return v;
  }
  const byDriver = cap.driver && !['local', 'aws', 'degraded', 'error', 'unknown', 'bypass'].includes(cap.driver)
    ? badges[cap.driver]
    : undefined;
  if (!enabled) {
    if (byDriver) return byDriver;
    if (isSelfHosted(reg, id, cap)) return badges['selfHosted'] ?? `${reg?.modules[id]?.function ?? id} · EC2 自建（${cap.driver}）`;
    return badges['local'] ?? `${reg?.modules[id]?.function ?? id}（本地实现 · ${cap.driver}）`;
  }
  if (byDriver) return byDriver;
  return badges['aws'] ?? cap.awsService ?? reg?.modules[id]?.awsService ?? id;
}

export function badgeFor(
  id: ModuleId,
  cap: ModuleCapability,
  reg: RegistryDocument | null | undefined,
  opts: BadgeOptions = {},
): Badge {
  const badges = badgesOf(reg, id);
  const enabled = cap.status !== 'off';
  const health = enabled ? cap.status : (cap.localHealth ?? 'ok');
  const outcome = opts.outcome?.toLowerCase();
  const label = outcomeLabel(opts.outcome);
  const vars: BadgeVars = { ...defaultVars(id, cap), outcome: label, cacheState: label, ...(opts.vars ?? {}) };
  const title = `${enabled ? cap.status : `off（本地实现：${cap.localHealth ?? 'ok'}）`} · ${cap.detail}`;

  let tpl = baseText(id, cap, reg, opts.variant);
  // CDN 之类“有缓存状态时另有文案”的模块
  if (enabled && label && !opts.variant && badges['awsWithCache'] && outcome && ['hit', 'miss', 'refreshhit', 'refresh', 'refresh-hit'].includes(outcome)) {
    tpl = badges['awsWithCache'];
  }
  const base = fillTemplate(tpl, vars);

  // 1. 管理员旁路（紫）
  if (outcome === 'bypass' || outcome?.endsWith('-bypass') && !DEGRADED_OUTCOMES.has(outcome)) {
    return { text: badges['bypass'] ? fillTemplate(badges['bypass'], vars) : `${base} · 旁路`, tone: 'bypass', title };
  }
  // 2. 模块（或本地实现）的健康状态
  if (health === 'error') {
    const t = enabled && badges['error'] ? fillTemplate(badges['error'], { ...vars, detail: cap.detail }) : `${base} · 故障`;
    return { text: t, tone: 'error', title };
  }
  if (health === 'degraded') {
    const t = enabled && badges['degraded'] ? fillTemplate(badges['degraded'], { ...vars, detail: cap.detail, reason: cap.detail }) : `${base} · 降级`;
    return { text: t, tone: 'degraded', title };
  }
  // 3. 请求级结果
  if (outcome && DEGRADED_OUTCOMES.has(outcome)) {
    const t = badges['degraded'] ? fillTemplate(badges['degraded'], vars) : `${base} · 降级`;
    return { text: t, tone: 'degraded', title };
  }
  if (outcome === 'fault' || outcome === 'error' || outcome?.endsWith(':fault')) {
    return { text: `${base} · 故障注入`, tone: 'error', title };
  }
  if (outcome === 'unknown') {
    const t = badges['unknown'] ? fillTemplate(badges['unknown'], vars) : `${base} · 状态未知`;
    return { text: t, tone: 'unknown', title };
  }
  if (outcome === 'hit') return { text: base, tone: 'hit', title };
  return { text: base, tone: id === 'ec2' ? 'local' : enabled ? 'aws' : 'local', title };
}

/** 照片详情“缩略图由谁生成”的文案：来自 photo.processedBy（随照片保存，与当前驱动无关） */
export function processedByText(
  reg: RegistryDocument | null | undefined,
  p: { driver: string; durationMs: number; coldStart?: boolean | undefined },
): { text: string; tone: BadgeTone } {
  const badges = badgesOf(reg, 'image-processing');
  const aws = p.driver === 'lambda';
  const head = aws ? (badges['aws'] ?? '缩略图由 AWS Lambda 生成') : (badges['local'] ?? '缩略图由 EC2 生成');
  const ms = `${Math.round(p.durationMs)} ms`;
  const tail = aws ? (p.coldStart ? ' · 冷启动' : '') : `（${p.driver}）`;
  return { text: `${head} · ${ms}${tail}`, tone: aws ? 'aws' : 'local' };
}
