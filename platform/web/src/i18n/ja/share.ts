/**
 * ja（日本語）：命名空间 share。由 `npm run i18n:sync` 按 zh-CN 词典维护结构：
 * 只填写引号内的译文（空字符串 = 未翻译，运行时按 ja → en → zh-CN 回退）；行尾注释是 zh-CN 原文。
 * 术语与风格见 ../glossary.md（不翻译 AWS 服务名、CLI 命令、代码、资源名、API 路径、环境变量）。
 */
import type { Dict } from '../dict';
import type zh from '../zh-CN/share';

export default {
  nature: '', // 这是由自托管 ATL 实验平台生成的脱敏报告副本，不是 AWS 官方认证。
  unknown: '', // 未记录
  badge: '', //  · 徽章“{title}”
  paren: '', // （{text}）
  active: '', // ，有交互 {t}
  extensions: '', //  · 延长 {n} 次
  conclusion: '', // 结论
  duration: '', // 用时
  durationValue: '', // 共 {total}
  checks: '', // 检查
  checksValue: '', // 自动 {auto} · 手动 {manual} · 未通过 {failed}
  drift: '', //  · 漂移 {n} 次
  trust: '', //  · 可信度：高 {high} · 中 {medium} · 低 {low}
  cleanup: '', // 清理
  environment: '', // 环境
  reused: '', // 复用环境
  fresh: '', // 全新环境
  account: '', //  · 账号 {acct}
  startProfile: '', //  · 起始档位 {name}
  end: '', // 结束
  endValue: '', // {reason} · 就绪 {ready} → 结束 {ended}
  summary: '', // 摘要
  steps: '', // 逐步证据
  noSteps: '', // 没有步骤记录。
  assertion: '', // {mark} {label}：期望 {expected} · 实际 {actual}
  inherited: '', // 继承自交接链中的会话
  thisSession: '', // 本次完成
  ownershipLate: '', // 归属在会话结束后确认
  manualObserved: '', // 手动确认：看到的值 {v}
  colResult: '', // 结果
  colSource: '', // 来源
  colCheck: '', // 检查与关键断言
  colDigest: '', // 证据摘要
  experiments: '', // 对比实验
  noExperiments: '', // 本卡片没有对比实验。
  colMetric: '', // 指标
  colDelta: '', // 差异
  comparable: '', // 可比
  notComparable: '', // 不可比（{list}）
  reasonSep: '', // ；
  acrossTypes: '', //  · 跨实例类型比较
  variants: '', // 变体：{list}
  variantItem: '', // {label}（{role}）
  listSep: '', // 、
  metricsCaption: '', // {name} 的指标
  noMetrics: '', // 没有可比较的指标。
  directionNote: '', // 差异方向只说明变化，不代表好坏：启用托管服务后单次延迟变高也可能是正确结论。数值只来自实际记录。
  severity: {
    BLOCKING: '', // 阻塞
    REVIEW: '', // 需复核
    INFO: '', // 信息
  },
  reclaimed: '', //  · 已回收 {n} 项
  colType: '', // 类型
  colResource: '', // 资源
  colLevel: '', // 级别
  colReason: '', // 原因
  lab: '', // 实验
  title: '', // {id} · 实验报告（脱敏副本）
  expiresAt: '', //  · 有效期至 {t}
  noExpiry: '', //  · 不过期（平台卸载前有效）
  header: '', // 实验报告 · 第 {rev} 版 · 报告生成于 {generated} · 卡片版本 {version} · 起始变体 {variant}
  footer1: '', // 平台卸载后此链接失效 · 生成于 {t}{expires}
  footer2: '', // 本副本由自托管 AWS Training Lab 实例生成：账号 ID、IP、资源 ID 的中段、会话 id 与环境名已打码，不含手动确认备注。费用信息不在副本中，以 AWS 账单为准。
} satisfies Dict<typeof zh>;
