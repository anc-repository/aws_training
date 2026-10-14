/**
 * ja（日本語）：命名空间 share。由 `npm run i18n:sync` 按 zh-CN 词典维护结构：
 * 只填写引号内的译文（空字符串 = 未翻译，运行时按 ja → en → zh-CN 回退）；行尾注释是 zh-CN 原文。
 * 术语与风格见 ../glossary.md（不翻译 AWS 服务名、CLI 命令、代码、资源名、API 路径、环境变量）。
 */
import type { Dict } from '../dict';
import type zh from '../zh-CN/share';

export default {
  nature: 'これはセルフホストの ATL ラボプラットフォームが生成した、マスク済みのレポートのコピーです。AWS の公式認定ではありません。', // 这是由自托管 ATL 实验平台生成的脱敏报告副本，不是 AWS 官方认证。
  unknown: '記録なし', // 未记录
  badge: ' · バッジ「{title}」', //  · 徽章“{title}”
  paren: '（{text}）', // （{text}）
  active: '、操作あり {t}', // ，有交互 {t}
  extensions: ' · 延長 {n} 回', //  · 延长 {n} 次
  conclusion: '結果', // 结论
  duration: '所要時間', // 用时
  durationValue: '合計 {total}', // 共 {total}
  checks: 'チェック', // 检查
  checksValue: '自動 {auto} · 手動 {manual} · 不合格 {failed}', // 自动 {auto} · 手动 {manual} · 未通过 {failed}
  drift: ' · ドリフト {n} 回', //  · 漂移 {n} 次
  trust: ' · 信頼度：高 {high} · 中 {medium} · 低 {low}', //  · 可信度：高 {high} · 中 {medium} · 低 {low}
  cleanup: 'クリーンアップ', // 清理
  environment: '環境', // 环境
  reused: '再利用した環境', // 复用环境
  fresh: '新しい環境', // 全新环境
  account: ' · アカウント {acct}', //  · 账号 {acct}
  startProfile: ' · 開始プロファイル {name}', //  · 起始档位 {name}
  end: '終了', // 结束
  endValue: '{reason} · 準備完了 {ready} → 終了 {ended}', // {reason} · 就绪 {ready} → 结束 {ended}
  summary: '概要', // 摘要
  steps: 'ステップごとの証拠', // 逐步证据
  noSteps: 'ステップの記録はありません。', // 没有步骤记录。
  assertion: '{mark} {label}：期待 {expected} · 実際 {actual}', // {mark} {label}：期望 {expected} · 实际 {actual}
  inherited: '引き継ぎ元のセッションから継承', // 继承自交接链中的会话
  thisSession: 'このセッションで完了', // 本次完成
  ownershipLate: '帰属はセッション終了後に確定', // 归属在会话结束后确认
  manualObserved: '手動確認：確認した値 {v}', // 手动确认：看到的值 {v}
  colResult: '結果', // 结果
  colSource: '実行元', // 来源
  colCheck: 'チェックと主なアサーション', // 检查与关键断言
  colDigest: '証拠ダイジェスト', // 证据摘要
  experiments: '比較実験', // 对比实验
  noExperiments: 'このカードには比較実験がありません。', // 本卡片没有对比实验。
  colMetric: '指標', // 指标
  colDelta: '差', // 差异
  comparable: '比較可能', // 可比
  notComparable: '比較不可（{list}）', // 不可比（{list}）
  reasonSep: '、', // ；
  acrossTypes: ' · インスタンスタイプをまたぐ比較', //  · 跨实例类型比较
  variants: 'バリアント：{list}', // 变体：{list}
  variantItem: '{label}（{role}）', // {label}（{role}）
  listSep: '、', // 、
  metricsCaption: '{name} の指標', // {name} 的指标
  noMetrics: '比較できる指標はありません。', // 没有可比较的指标。
  directionNote: '差の向きは変化を示すだけで、良し悪しではありません。マネージドサービスを有効にすると 1 回あたりのレイテンシが増えるのも正しい結果になり得ます。数値は実際の記録だけから取っています。', // 差异方向只说明变化，不代表好坏：启用托管服务后单次延迟变高也可能是正确结论。数值只来自实际记录。
  severity: {
    BLOCKING: 'ブロック', // 阻塞
    REVIEW: '要確認', // 需复核
    INFO: '情報', // 信息
  },
  reclaimed: ' · 回収済み {n} 件', //  · 已回收 {n} 项
  colType: '種類', // 类型
  colResource: 'リソース', // 资源
  colLevel: 'レベル', // 级别
  colReason: '理由', // 原因
  lab: 'ラボ', // 实验
  title: '{id} · ラボレポート（マスク済みコピー）', // {id} · 实验报告（脱敏副本）
  expiresAt: ' · 有効期限 {t}', //  · 有效期至 {t}
  noExpiry: ' · 無期限（プラットフォームのアンインストールまで有効）', //  · 不过期（平台卸载前有效）
  header: 'ラボレポート · 第 {rev} 版 · 作成 {generated} · カードのバージョン {version} · 開始バリアント {variant}', // 实验报告 · 第 {rev} 版 · 报告生成于 {generated} · 卡片版本 {version} · 起始变体 {variant}
  footer1: 'プラットフォームをアンインストールするとこのリンクは無効になります · 作成 {t}{expires}', // 平台卸载后此链接失效 · 生成于 {t}{expires}
  footer2: 'このコピーはセルフホストの AWS Training Lab インスタンスが生成しました。アカウント ID、IP、リソース ID の中間部、セッション ID、環境名はマスク済みで、手動確認のメモは含みません。費用の情報はコピーに含まれません。正式な金額は AWS の請求書を確認してください。', // 本副本由自托管 AWS Training Lab 实例生成：账号 ID、IP、资源 ID 的中段、会话 id 与环境名已打码，不含手动确认备注。费用信息不在副本中，以 AWS 账单为准。
  visual: {
    steps: 'ステップ', // 步骤
    evidence: '証拠の信頼度', // 证据可信度
    high: '高', // 高
    medium: '中', // 中
    low: '低', // 低
    language: '言語', // 语言
  },
} satisfies Dict<typeof zh>;
