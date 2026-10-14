// backend/src/adapters/monitoring/alert-rules.ts —— 本地告警规则（/etc/cloudalbum/alerts.yaml，05#monitoring 第 1 节）
//
// L0 文件（root:cloudalbum 0640，实际在数据卷 etc/ 上，随数据卷迁移）；不存在时使用下面的默认规则（与文档示例相同，阈值只是示例）。
// 阈值不是 ConfigPort 的运行时热键（D7）：worker 每次评估前检查文件的修改时间，变化后重新加载。
import { readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { parse as parseYaml } from 'yaml';

export type AlarmState = 'OK' | 'ALARM' | 'INSUFFICIENT_DATA';
export type RuleKind = 'ratio' | 'quantile' | 'gauge' | 'absent' | 'sum';
export type CompareOp = '>' | '>=' | '<' | '<=';

export interface AlertRule {
  name: string;
  kind: RuleKind;
  /** ratio：分子 / 分母；其余：指标 */
  num?: string;
  den?: string;
  metric?: string;
  /** quantile：0..1 */
  q?: number;
  /** 窗口（秒） */
  windowSec: number;
  op: CompareOp;
  threshold: number;
}

export interface AlertRulesFile {
  evaluateEverySec: number;
  alertEmail?: string;
  rules: AlertRule[];
  /** 规则来源：文件路径，或 'default'（文件不存在） */
  source: string;
  /** 解析失败或被忽略的规则 */
  issues: string[];
}

export const DEFAULT_ALERTS_YAML = `# /etc/cloudalbum/alerts.yaml（L0 默认规则，阈值是示例；05#monitoring 第 1 节）
evaluateEverySec: 30
alertEmail: admin@example.com
rules:
  - { name: app-5xx-rate,    kind: ratio,    num: "route.count{status=5xx}", den: "route.count", window: 5m, op: ">", threshold: 0.05 }
  - { name: app-p95-latency, kind: quantile, metric: "route.latency", q: 0.95, window: 5m, op: ">", threshold: 1000 }
  - { name: data-disk-high,  kind: gauge,    metric: "host.dataVolumeUsedRatio", window: 5m, op: ">", threshold: 0.85 }
  - { name: host-mem-high,   kind: gauge,    metric: "host.memUsedRatio", window: 5m, op: ">", threshold: 0.90 }
  - { name: api-heartbeat,   kind: absent,   metric: "process.heartbeat{role=api}", window: 2m }
  - { name: log-errors,      kind: sum,      metric: "log.events{level=error}", window: 5m, op: ">", threshold: 20 }
`;

/** 本地评估器认识的指标（其余规则的状态为 INSUFFICIENT_DATA，detail 说明数据源不可用） */
export const KNOWN_LOCAL_METRICS = [
  'route.count', 'route.count{status=5xx}', 'route.latency', 'host.memUsedRatio', 'host.dataVolumeUsedRatio', 'host.cpuPct',
  'process.heartbeat{role=api}', 'process.heartbeat{role=worker}',
] as const;

export function parseWindow(v: unknown, fallbackSec = 300): number {
  if (typeof v === 'number' && Number.isFinite(v) && v > 0) return Math.round(v);
  const m = /^(\d+)\s*(s|m|h)?$/.exec(String(v ?? '').trim());
  if (!m) return fallbackSec;
  const n = Number(m[1]);
  return m[2] === 'h' ? n * 3600 : m[2] === 'm' ? n * 60 : n;
}

export function parseAlertRules(text: string, source = 'inline'): AlertRulesFile {
  const issues: string[] = [];
  let doc: Record<string, unknown> = {};
  try {
    doc = (parseYaml(text) ?? {}) as Record<string, unknown>;
  } catch (e) {
    issues.push(`YAML 解析失败：${(e as Error).message}`);
  }
  const every = Number(doc.evaluateEverySec ?? 30);
  const rules: AlertRule[] = [];
  const names = new Set<string>();
  for (const [i, raw] of (Array.isArray(doc.rules) ? doc.rules : []).entries()) {
    const r = raw as Record<string, unknown>;
    const name = String(r.name ?? '').trim();
    const kind = String(r.kind ?? '') as RuleKind;
    if (!/^[a-z][a-z0-9-]{0,63}$/.test(name)) { issues.push(`rules[${i}]：name 必须是小写字母、数字与连字符`); continue; }
    if (names.has(name)) { issues.push(`rules[${i}]：重复的 name ${name}`); continue; }
    if (!['ratio', 'quantile', 'gauge', 'absent', 'sum'].includes(kind)) { issues.push(`${name}：未知的 kind ${String(r.kind)}`); continue; }
    const op = String(r.op ?? '>') as CompareOp;
    if (!['>', '>=', '<', '<='].includes(op)) { issues.push(`${name}：op 只能是 > >= < <=`); continue; }
    const threshold = Number(r.threshold ?? 0);
    if (kind !== 'absent' && !Number.isFinite(threshold)) { issues.push(`${name}：threshold 必须是数字`); continue; }
    if (kind === 'ratio' && (!r.num || !r.den)) { issues.push(`${name}：ratio 需要 num 与 den`); continue; }
    if (kind !== 'ratio' && !r.metric) { issues.push(`${name}：需要 metric`); continue; }
    names.add(name);
    rules.push({
      name, kind, op, threshold: Number.isFinite(threshold) ? threshold : 0, windowSec: parseWindow(r.window),
      ...(r.num ? { num: String(r.num) } : {}), ...(r.den ? { den: String(r.den) } : {}),
      ...(r.metric ? { metric: String(r.metric) } : {}),
      ...(kind === 'quantile' ? { q: Math.min(1, Math.max(0, Number(r.q ?? 0.95))) } : {}),
    });
  }
  return {
    evaluateEverySec: Number.isFinite(every) && every >= 10 ? Math.round(every) : 30,
    ...(typeof doc.alertEmail === 'string' && doc.alertEmail.includes('@') ? { alertEmail: doc.alertEmail.trim() } : {}),
    rules, source, issues,
  };
}

/** 默认路径：<CLOUDALBUM_ENV_DIR>/alerts.yaml */
export function alertsFile(envDir: string): string {
  return path.join(envDir, 'alerts.yaml');
}

/** 读取规则文件；不存在时返回默认规则。带修改时间缓存（同一文件未变化时不重复解析）。 */
export class AlertRulesLoader {
  private cache?: { mtimeMs: number; value: AlertRulesFile };

  constructor(private readonly file: string) {}

  load(): AlertRulesFile {
    let mtimeMs: number;
    try {
      mtimeMs = statSync(this.file).mtimeMs;
    } catch {
      return parseAlertRules(DEFAULT_ALERTS_YAML, 'default');
    }
    if (this.cache && this.cache.mtimeMs === mtimeMs) return this.cache.value;
    let text: string;
    try {
      text = readFileSync(this.file, 'utf8');
    } catch (e) {
      const value = parseAlertRules(DEFAULT_ALERTS_YAML, 'default');
      value.issues.push(`${this.file} 不可读（${(e as Error).message}），使用默认规则`);
      return value;
    }
    const value = parseAlertRules(text, this.file);
    this.cache = { mtimeMs, value };
    return value;
  }
}

export function compare(value: number, op: CompareOp, threshold: number): boolean {
  switch (op) {
    case '>': return value > threshold;
    case '>=': return value >= threshold;
    case '<': return value < threshold;
    case '<=': return value <= threshold;
    default: return false;
  }
}
