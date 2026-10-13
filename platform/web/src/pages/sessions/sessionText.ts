/**
 * 会话、回收、报告与证书画面共用的取值 → 文案（08 §1.6、§4 P07/P08/P11；02 §6.1、§7.5）。纯数据，不含组件。
 * 状态的形状与颜色一律取 src/ui/semantics.ts（全站唯一映射），这里只有那张表之外的取值。
 */

/** 02 §6.1 的 endReason（08 P11 列表“结束原因”）。 */
export const END_REASON_TEXT: Readonly<Record<string, string>> = {
  USER_ENDED: '你结束的',
  EXPIRED: '到期',
  IDLE_NOT_STARTED: '就绪后未进入',
  CANCELLED: '你取消的',
  PROVISION_FAILED: '部署失败',
  PROVISION_TIMEOUT: '部署超时',
  BUDGET_ENFORCED: '预算强制',
  ADMIN_ENDED: '管理员结束',
  KEEP_EXPIRED: '保留到期',
  KEEP_RELEASED: '你释放的',
  PLATFORM_UNINSTALL: '平台卸载',
  CLEANUP_RETRY: '回收重试',
  HANDED_OVER: '环境已交接',
};

export function endReasonText(r: string | null | undefined): string {
  if (!r) return '—';
  return END_REASON_TEXT[r] ?? '其他';
}

/** 01 §7.3 SessionResource.discoveredBy（08 ResourceRow“来源”列）。 */
export const DISCOVERED_BY_TEXT: Readonly<Record<string, string>> = {
  STACK: '栈',
  RETAINED: '保留',
  OUT_OF_BAND: '带外',
  CLOUDTRAIL: 'CloudTrail（你在控制台或 CLI 创建）',
  DERIVED: '派生',
  REALTIME: '实时',
  OWNERSHIP_LOOKUP: '定向扫描',
  TAG: '标签（仅凭标签发现）',
  INVENTORY: '清点',
};

export function discoveredByText(v: string | null | undefined): string | null {
  if (!v) return null;
  return DISCOVERED_BY_TEXT[v] ?? v;
}

/** 02 §7.5 的删除阶段。 */
export const STAGES = ['S0', 'S1', 'S2', 'S3', 'S4', 'S5', 'S6'] as const;
export type Stage = (typeof STAGES)[number];
export const STAGE_TEXT: Readonly<Record<string, string>> = {
  S0: 'S0 入口与触发',
  S1: 'S1 计算',
  S2: 'S2 数据与托管服务',
  S3: 'S3 网络',
  S4: 'S4 镜像与卷',
  S5: 'S5 身份与密钥',
  S6: 'S6 复位与环境状态',
  other: '其他',
};

/** 报告 `cleanup.status`（04 §9.2）。 */
export const REPORT_CLEANUP_TEXT: Readonly<Record<string, string>> = {
  pending: '回收进行中，完成后报告会追加修订',
  clean: '已释放',
  'needs-review': '需复核',
  'cleanup-failed': '释放未完成',
  kept: '环境保留中',
};

/** 徽章等级（05 §2.10、tracks §5.3）。 */
export const BADGE_LEVEL_TEXT: Readonly<Record<string, string>> = {
  verified: '已核验',
  attested: '含手动',
  'self-reported': '自述为主',
};

export const BADGE_STATUS_TEXT: Readonly<Record<string, string>> = {
  valid: '有效',
  pending: '核验中',
  withdrawn: '已撤回',
};

/** 实验无效原因码（08 P06 变体状态表）。 */
export const VALIDITY_REASON_TEXT: Readonly<Record<string, string>> = {
  OUT_OF_WINDOW: '不在登记的时间窗内',
  DRIVER_MISMATCH: '运行时驱动与该变体要求不符',
  NOT_CORROBORATED: '服务端没有看到足够的请求',
  PATH_RATIO: '路径占比不足',
  TOO_FEW_SAMPLES: '样本不足',
  OUTPUT_TRUNCATED: '输出被截断',
  DELIVERY_MISMATCH: '交付方式与登记不符',
};

export function validityReasonText(code: string): string {
  const base = code.split(/[:\s]/)[0]!;
  const t = VALIDITY_REASON_TEXT[base];
  return t ? (code.length > base.length ? `${t}（${code.slice(base.length).replace(/^[:\s]+/, '')}）` : t) : code;
}

/** 成对比较不可比的原因（GET /experiment-runs/compare 的 reasons）。 */
export const COMPARE_REASON_TEXT: Readonly<Record<string, string>> = {
  DIFFERENT_EXPERIMENT: '不是同一个实验',
  DIFFERENT_SCENARIO: '场景不一致',
  DIFFERENT_CARD_VARIANT: '起始变体不一致',
  DIFFERENT_INSTANCE_TYPE: '实例类型不一致',
  FORCED: '使用了强制运行',
};

/** 计费金额区间：`≈ 0.12～0.15 USD/小时`；没有金额时 null（调用方写“未知”）。不编造价格（08 写作约束）。 */
export function formatMoneyRange(low: number | null | undefined, high: number | null | undefined, currency = 'USD', unit = ''): string | null {
  const ok = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
  if (!ok(low) && !ok(high)) return null;
  const f = (v: number) => (v >= 100 ? v.toFixed(0) : v >= 1 ? v.toFixed(2) : v.toPrecision(2));
  const a = ok(low) ? f(low) : '?';
  const b = ok(high) ? f(high) : '?';
  return `≈ ${a === b ? a : `${a}～${b}`} ${currency}${unit}`;
}

/** 会话视图 `env.hourlyEstimate` 的两种写法（08 §9.2 #30）：对象 `{start, completed}` / `{low, high}`，字符串视为未提供。 */
export function hourlyRange(v: unknown): { low: number | null; high: number | null } | null {
  if (!v || typeof v !== 'object') return null;
  const o = v as { low?: unknown; high?: unknown; completed?: unknown; start?: unknown };
  const pick = (x: unknown) => (x && typeof x === 'object' ? (x as { low?: unknown; high?: unknown }) : null);
  const r = typeof o.low === 'number' || typeof o.high === 'number' ? o : (pick(o.completed) ?? pick(o.start));
  if (!r) return null;
  const low = typeof r.low === 'number' ? r.low : null;
  const high = typeof r.high === 'number' ? r.high : null;
  return low === null && high === null ? null : { low, high };
}
