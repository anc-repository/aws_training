/**
 * en（English）：命名空间 pages。由 `npm run i18n:sync` 按 zh-CN 词典维护结构：
 * 只填写引号内的译文（空字符串 = 未翻译，运行时按 en → en → zh-CN 回退）；行尾注释是 zh-CN 原文。
 * 术语与风格见 ../glossary.md（不翻译 AWS 服务名、CLI 命令、代码、资源名、API 路径、环境变量）。
 */
import type { Dict } from '../dict';
import type zh from '../zh-CN/pages';

export default {
  card: {
    overviewHeading: {
      background: 'Background', // 背景
      why: 'Why combine them', // 为什么组合在一起
      experiments: 'Comparison experiments', // 对比实验预告
      platform: 'Platform mode notes', // 平台模式说明
    },
    crumbs: 'Breadcrumb', // 面包屑
    tierHigh: '$$$ High', // $$$ 高
    tierMedium: '$$ Medium', // $$ 中
    optionalMark: ' (optional)', // （可选）
    listSep: '; ', // ；
    nameSep: ', ', // 、
    defaultVariant: 'Default', // 默认
    trackRole: ' ({stage}, {role})', // （{stage}，{role}）
    roleRequired: 'required', // 必修
    roleGroup: 'elective group', // 选修组
    roleOptional: 'optional', // 可选
    extraModules: 'extra modules', // 额外模块
    hours: '{n} h', // {n} 小时
    optionalLine: ' (optional)', // （选做）
    colon: ':', // ：
    period: '. ', // 。
    labelHint: '{label}: {hint}', // {label}：{hint}
    range: '≈ {low}–{high}{unit}', // ≈ {low}～{high}{unit}
    badgeEarnedLine: '“{title}” {level}', // “{title}” {level}
  },
  tracks: {
    revokeReason: {
      superseded: 'superseded by a new certificate', // 被新证书取代
      'learner-request': 'requested by the holder', // 持有人申请
      'content-defect': 'content defect', // 内容缺陷
      misissued: 'misissued', // 误签
      'key-compromise': 'key compromise', // 密钥泄露
      'dependency-revoked': 'the certificate it relied on was revoked', // 所依据的证书已被吊销
    },
    crumbs: 'Breadcrumb', // 面包屑
    pending: '{n}: {list}', // {n} 张：{list}
    listSep: ', ', // 、
  },
  labs: {
    cost: {
      low: '$ Low', // $ 低
      medium: '$$ Medium', // $$ 中
      high: '$$$ High', // $$$ 高
    },
    inProgress: 'In progress', // 进行中
    search: 'Search “{q}”', // 搜索“{q}”
    facet: '{label}: {values}', // {label}：{values}
    listSep: ', ', // 、
    recommend: '{label}: ', // {label}：
    recCard: ' ({difficulty} · about {n} min · {cost})', // （{difficulty} · 约 {n} 分钟 · {cost}）
    readingProgress: 'Loading your progress…', // 正在读取学习进度…
    currentTrack: 'Current path: ', // 当前路径：
    nextRec: 'Recommended next: ', // 下一张推荐：
    about: ' · about {n} min', //  · 约 {n} 分钟
    trackDone: 'All required cards in this path are done', // 这条路径的必修卡片都已完成
    canClaim: '; you can claim the certificate', // ，可以领取证书
    period: '.', // 。
    topic: 'Topic: {text}', // 考点：{text}
    minutes: '{n} min', // {n} 分钟
    badgeAria: 'Badge: {title}, {state}', // 徽章：{title}，{state}
    old: 'Old', // 旧
    base: 'Base', // 基础
    category: '{id} {label}', // {id} {label}
    scenarioCredits: '{label}: {n}', // {label} {n} 张
    hours: '{n} h', // {n} 小时
    serviceOption: '{name} ({abbr})', // {name}（{abbr}）
    trackOption: '{title} ({id})', // {title}（{id}）
    paren: '{text} ({note})', // {text}（{note}）
    numRange: '{a}–{b}', // {a}～{b}
  },
  manualExport: {
    title: '# ATL manual-handling list', // # ATL 待人工处理清单
    exportedAt: 'Exported: {t}', // 导出时间：{t}
    count: '{n} items. After handling them, press “Handled, recheck” in the platform’s manual-handling list.', // 共 {n} 项。处理后在平台的“待人工处理清单”中点“我已处理，重新核对”。
    arn: '- ARN: {v}', // - ARN：{v}
    region: '- Region: {v}', // - 区域：{v}
    severity: '- Severity: {v}', // - 严重级别：{v}
    billing: '- Billing: {v}', // - 计费方式：{v}
    session: '- Session: {v}', // - 会话：{v}
    sessionLab: '- Session: {v} ({lab})', // - 会话：{v}（{lab}）
    console: '- Console: {v}', // - 控制台：{v}
    note: '- Note: {v}', // - 说明：{v}
    nonNegative: 'Enter a whole number of 0 or more', // 请填写非负整数
  },
} satisfies Dict<typeof zh>;
