/**
 * ja（日本語）：命名空间 pages。由 `npm run i18n:sync` 按 zh-CN 词典维护结构：
 * 只填写引号内的译文（空字符串 = 未翻译，运行时按 ja → en → zh-CN 回退）；行尾注释是 zh-CN 原文。
 * 术语与风格见 ../glossary.md（不翻译 AWS 服务名、CLI 命令、代码、资源名、API 路径、环境变量）。
 */
import type { Dict } from '../dict';
import type zh from '../zh-CN/pages';

export default {
  card: {
    overviewHeading: {
      background: '背景', // 背景
      why: 'なぜ組み合わせるのか', // 为什么组合在一起
      experiments: '比較実験の予告', // 对比实验预告
      platform: 'プラットフォームモードについて', // 平台模式说明
    },
    crumbs: 'パンくずリスト', // 面包屑
    tierHigh: '$$$ 高', // $$$ 高
    tierMedium: '$$ 中', // $$ 中
    optionalMark: '（任意）', // （可选）
    listSep: '、', // ；
    nameSep: '、', // 、
    defaultVariant: '既定', // 默认
    trackRole: '（{stage}、{role}）', // （{stage}，{role}）
    roleRequired: '必修', // 必修
    roleGroup: '選択グループ', // 选修组
    roleOptional: '任意', // 可选
    extraModules: '追加のモジュール', // 额外模块
    hours: '{n} 時間', // {n} 小时
    optionalLine: '（任意）', // （选做）
    colon: '：', // ：
    period: '。', // 。
    labelHint: '{label}：{hint}', // {label}：{hint}
    range: '≈ {low}～{high}{unit}', // ≈ {low}～{high}{unit}
    badgeEarnedLine: '「{title}」{level}', // “{title}” {level}
  },
  tracks: {
    revokeReason: {
      superseded: '新しい修了証に置き換え', // 被新证书取代
      'learner-request': '所持者の申請', // 持有人申请
      'content-defect': 'コンテンツの不具合', // 内容缺陷
      misissued: '誤発行', // 误签
      'key-compromise': '鍵の漏えい', // 密钥泄露
      'dependency-revoked': '根拠とした修了証が失効済み', // 所依据的证书已被吊销
    },
    crumbs: 'パンくずリスト', // 面包屑
    pending: '{n} 枚：{list}', // {n} 张：{list}
    listSep: '、', // 、
  },
  labs: {
    cost: {
      low: '$ 低', // $ 低
      medium: '$$ 中', // $$ 中
      high: '$$$ 高', // $$$ 高
    },
    inProgress: '進行中', // 进行中
    search: '「{q}」を検索', // 搜索“{q}”
    facet: '{label}：{values}', // {label}：{values}
    listSep: '、', // 、
    recommend: '{label}：', // {label}：
    recCard: '（{difficulty} · 約 {n} 分 · {cost}）', // （{difficulty} · 约 {n} 分钟 · {cost}）
    readingProgress: '学習の進捗を読み込んでいます…', // 正在读取学习进度…
    currentTrack: '現在の学習パス：', // 当前路径：
    nextRec: '次のおすすめ：', // 下一张推荐：
    about: ' · 約 {n} 分', //  · 约 {n} 分钟
    trackDone: 'この学習パスの必修カードはすべて完了しました', // 这条路径的必修卡片都已完成
    canClaim: '。修了証を受け取れます', // ，可以领取证书
    period: '。', // 。
    topic: '出題範囲：{text}', // 考点：{text}
    minutes: '{n} 分', // {n} 分钟
    badgeAria: 'バッジ：{title}、{state}', // 徽章：{title}，{state}
    old: '旧', // 旧
    base: '基礎', // 基础
    category: '{id} {label}', // {id} {label}
    scenarioCredits: '{label} {n} 枚', // {label} {n} 张
    hours: '{n} 時間', // {n} 小时
    serviceOption: '{name}（{abbr}）', // {name}（{abbr}）
    trackOption: '{title}（{id}）', // {title}（{id}）
    paren: '{text}（{note}）', // {text}（{note}）
    numRange: '{a}～{b}', // {a}～{b}
  },
  manualExport: {
    title: '# ATL 要対応リスト', // # ATL 待人工处理清单
    exportedAt: 'エクスポート日時：{t}', // 导出时间：{t}
    count: '全 {n} 件。対応後、プラットフォームの「要対応リスト」で「対応済み、再確認」を押してください。', // 共 {n} 项。处理后在平台的“待人工处理清单”中点“我已处理，重新核对”。
    arn: '- ARN：{v}', // - ARN：{v}
    region: '- リージョン：{v}', // - 区域：{v}
    severity: '- 重要度：{v}', // - 严重级别：{v}
    billing: '- 課金方式：{v}', // - 计费方式：{v}
    session: '- セッション：{v}', // - 会话：{v}
    sessionLab: '- セッション：{v}（{lab}）', // - 会话：{v}（{lab}）
    console: '- コンソール：{v}', // - 控制台：{v}
    note: '- 補足：{v}', // - 说明：{v}
    nonNegative: '0 以上の整数を入力してください', // 请填写非负整数
  },
} satisfies Dict<typeof zh>;
