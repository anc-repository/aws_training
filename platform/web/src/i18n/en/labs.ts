/**
 * en（English）：命名空间 labs。由 `npm run i18n:sync` 按 zh-CN 词典维护结构：
 * 只填写引号内的译文（空字符串 = 未翻译，运行时按 en → en → zh-CN 回退）；行尾注释是 zh-CN 原文。
 * 术语与风格见 ../glossary.md（不翻译 AWS 服务名、CLI 命令、代码、资源名、API 路径、环境变量）。
 */
import type { Dict } from '../dict';
import type zh from '../zh-CN/labs';

export default {
  difficulty: {
    intro: '', // 入门
    beginner: '', // 初级
    intermediate: '', // 中级
    advanced: '', // 高级
  },
  domain: {
    secure: '', // 安全
    resilient: '', // 弹性
    performance: '', // 高性能
    cost: '', // 成本
  },
  duration: {
    short: '', // ≤ 1 小时
    medium: '', // 1～2 小时
    long: '', // > 2 小时
  },
  provision: {
    A: '', // 较快
    B: '', // 中等
    C: '', // 较慢
    D: '', // 很慢
  },
  provisionHint: {
    A: '', // 较快（A）：起始状态只有 L0 与快速创建的资源。不写分钟数；本平台积累足够记录后会显示实际耗时。
    B: '', // 中等（B）：起始状态含 CloudFront 分配、ALB、Cognito 用户池或实例替换中的一两项。
    C: '', // 较慢（C）：起始状态含 RDS 或 ElastiCache 之一。
    D: '', // 很慢（D）：RDS / ElastiCache 再叠加 ALB、另一个数据库或实例替换。
  },
  costTierHint: {
    low: '', // $ 低：除实验机与工作台外没有按小时计费的资源。具体金额在开始前按当前价格计算。
    medium: '', // $$ 中：额外有 1 个按小时计费的资源，或会开启账号级按量服务。具体金额在开始前按当前价格计算。
    high: '', // $$$ 高：额外有 2 个及以上按小时计费的资源。具体金额在开始前按当前价格计算。
  },
  flag: {
    'needs-advance': '', // 需提前准备
    limited: '', // 部分不可用
    'needs-domain': '', // 需要域名
    'domain-optional': '', // 域名可选
    'needs-email': '', // 需要邮箱确认
    'account-impact': '', // 账号级影响
    'long-wait': '', // 等待较长
    beta: '', // 测试版
    'new-version': '', // 有新版本
  },
  mastery: {
    not_started: '', // 未开始
    touched: '', // 已接触
    mastered: '', // 已掌握
    proficient: '', // 熟练
  },
  badgeLevel: {
    verified: '', // 已核验
    attested: '', // 含手动
    'self-reported': '', // 自述为主
  },
  roleInTrack: {
    required: '', // 必修
    optional: '', // 可选
    group: '', // 选修组成员
  },
  input: {
    domain: {
      label: '', // 域名
      need: '', // 一个可以修改 NS 记录的域名
      hint: '', // 小写，例如 lab.example.com；不接受 IP 与通配符
    },
    'hosted-zone': {
      label: '', // Route 53 托管区域 ID
      need: '', // Route 53 托管区域 ID
      hint: '', // 形如 Z0123456789ABC
    },
    'ses-identity': {
      label: '', // SES 发信身份
      need: '', // 一个可以验证的邮箱或域名
      hint: '', // 邮箱或域名；只用于本次实验的身份验证
    },
    'notify-email': {
      label: '', // 通知邮箱
      need: '', // 能收信的邮箱
      hint: '', // 只用于本次实验的订阅与身份验证，不写入证书与公开页面
    },
    'alert-email': {
      label: '', // 告警邮箱
      need: '', // 能收信的告警邮箱
      hint: '', // 只用于本次实验的订阅与身份验证，不写入证书与公开页面
    },
    'recipient-emails': {
      label: '', // 收件人邮箱（最多 2 个，用逗号分隔）
      need: '', // 1～2 个能收信的邮箱
      hint: '', // 只用于本次实验，不写入证书与公开页面
    },
    'budget-amounts': {
      label: '', // 两个预算金额（用逗号分隔）
      need: '', // 两个预算金额
      hint: '', // 正数，最多两位小数；由你按自己的承受能力填写，平台不给参考值
    },
    'cost-tags-active': {
      label: '', // 成本分配标签
      need: '', // 提前 24～48 小时激活成本分配标签
      hint: '', // 勾选表示已执行平台动作“激活成本分配标签”并等待生效（以官方文档为准）
    },
  },
  stepType: {
    observe: '', // 观察
    experiment: '', // 对比实验
    script: '', // 脚本
    cli: '', // 命令行
    console: '', // 控制台
    read: '', // 阅读
    manual: '', // 手动确认
    'platform-action': '', // 平台动作
    wire: '', // 接入
  },
  ui: {
    catalog: {
      title: '', // 卡片目录
      sub: '', // {n} 张卡片 · {svc} 张单服务 · {sc} 张场景 · 目录 {v}
      searchPlaceholder: '', // 搜索卡片、服务、考点、Lab 编号…
      searchLabel: '', // 搜索卡片（快捷键 /）
      viewLabel: '', // 视图
      viewGrid: '', // 卡片网格
      viewMap: '', // 服务地图
      viewTracks: '', // 路径
      group: '', // 分组
      groupKind: '', // 按类型
      groupCategory: '', // 按服务类别
      groupDomain: '', // 按考试领域
      groupNone: '', // 不分组
      sort: '', // 排序
      sortPath: '', // 推荐顺序
      sortDuration: '', // 预计时长
      sortCost: '', // 费用档位
      sortRecent: '', // 最近尝试
      filters: '', // 筛选（{n}）
      facetKind: '', // 类型
      facetDomain: '', // 领域
      facetDifficulty: '', // 难度
      facetDuration: '', // 时长
      facetCost: '', // 费用
      facetStatus: '', // 状态
      facetService: '', // 服务
      kindService: '', // 单服务
      kindScenario: '', // 场景
      onlyPrimary: '', // 只看主领域
      noManual: '', // 只看无需人工前置
      pickService: '', // 选择服务…
      removeService: '', // 移除服务 {name}
      shown: '', // 显示 {n} / {total} 张
      shownAnnounce: '', // 显示 {n} / {total} 张卡片
      clear: '', // 清除筛选
      cleared: '', // 已清除筛选，显示 {total} / {total} 张卡片
      emptyTitle: '', // 没有符合条件的卡片
      emptyNoManual: '', // 其中“只看无需人工前置”隐藏了需要域名、邮箱确认或提前准备的卡片。
      sectionCount: '', // {n} 张 · 已完成 {done} / {n}
      sectionService: '', // 单服务卡片 · {cat}
      sectionScenario: '', // 场景卡片
      sectionAll: '', // 全部卡片
      alsoDomain: '', // 也涉及（次领域）
      costPrimaryOnlyHint: '', // 成本优化考点分布在多张卡片中，取消“只看主领域”查看。
      otherTracks: '', // 其他学习路径
      shelfItem: '', // {counted}/{min} · {cert}
      certEligible: '', // 证书可领取
      certNotYet: '', // 证书未达成
      certClaimed: '', // 证书已领取
      statusUnavailable: '', // 状态暂不可用
      masteryUnavailable: '', // 掌握度暂不可用
      retry: '', // 重试
      statusFacetOff: '', // 个人状态暂不可用，“状态”筛选暂时不能使用
      skippedSetup: '', // 首次设置已跳过：可在 设置 › 平台 中重看。
      catalogError: '', // 卡片目录暂时无法加载。
      notPublished: '', // 还没有发布卡片目录。
    },
    card: {
      kindService: '', // 单服务 · {cat}
      kindScenario: '', // 场景 · 包含 {n} 个服务
      legacy: '', // 原 Lab {n}
      minutes: '', // 约 {n} 分钟
      hours: '', // 约 {n} 小时
      limit: '', // 上限 {t}
      provision: '', // 环境准备：{t}
      attempts: '', // 尝试 {n} 次
      noAttempts: '', // 尚未尝试
      badgeNone: '', // 未获得
      badgePending: '', // 核验中
      badgeWithdrawn: '', // 已撤回
      backToWorkspace: '', // 回到工作台
      viewProgress: '', // 查看进度
      planned: '', // 即将推出
      plannedNote: '', // 这张卡片还在编写中：可以先看简介，暂时不能开始实验。
      deprecated: '', // 本卡片已停用
      newVersion: '', // 有新版本
      services: '', // 服务：{list}
      scenarioOptional: '', // （选做 / 条件目标）
    },
    state: {
      preparing: '', // 准备中
      running: '', // 进行中 · 剩余 {t}
      ending: '', // 正在结束
      cleaning: '', // 正在释放
      kept: '', // 环境保留中 · 至 {t}
      cleanupFailed: '', // 释放未完成
      completed: '', // 已完成
      completedManual: '', // 已完成（含手动）
      incomplete: '', // 未完成
      notStarted: '', // 未开始
    },
    env: {
      region: '', // 当前环境
      elapsed: '', // 已用 {t}
      remaining: '', // 剩余 {t}
      provision: '', // 环境准备：{t}
      hourly: '', // 按小时计费 {n} 项
      deleted: '', // 已删除 {n}/{m}
      until: '', // 至 {t}
      saveMode: '', // 节省模式
      toWorkspace: '', // 回到工作台
      cancel: '', // 取消…
      extend: '', // 延长…
      end: '', // 结束实验…
      reclaim: '', // 查看回收进度
      manageKeep: '', // 管理保留
      reuseNext: '', // 在下一张卡片中复用
      residual: '', // {what}有 {n} 项资源未释放{hourly}
      residualHourly: '', // ，其中 {n} 项按小时计费
      residualOf: '', // {labId}（{at} 的实验）
      residualPrevious: '', // 之前的实验
      viewList: '', // 查看清单
      maintenance: '', // 平台维护中，暂时不能开始新实验。
      uninstalling: '', // 平台正在卸载，暂时不能开始新实验。
      extendBlocked: '', // 延长暂不可用
    },
    cont: {
      title: '', // 继续学习
      path: '', // {track} · {stage} · 必修 {done}/{total}
      recommend: '', // 推荐
      recommendAfter: '', // 当前环境之后推荐
      view: '', // 查看 →
      newLearner: '', // 从 {labId} 开始（{track}第 1 张）
      quickPath: '', // 只想看七组点名对比？→ 快速路径
      done: '', // {track}的卡片都已完成：可以领取证书。
      reuseHint: '', // ↳ 可在 {labId} 的保留环境中继续
    },
    map: {
      legend: '', // 图例：
      legendTail: '', // · 虚线框 = 含手动 · ! = 需复习 · * 需要域名才能由场景卡计入 · † 没有场景卡
      help: '', // 分数只用于进度环；等级文字按规则判定。点击服务格打开侧栏；Tab 进入地图后用方向键在格子之间移动。
      cellLabel: '', // {name}，{fn}，{level}，{score} 分
      needsReview: '', // 需复习
      domainNote: '', // 需要域名才能由场景卡计入
      noScenario: '', // 没有场景卡
      single: '', // 单服务 {mark} · 场景 {done}/{total}
      panelMastery: '', // 掌握度
      panelScore: '', // {score} / 100
      panelSvcCard: '', // 单服务卡
      panelCredited: '', // 计入本服务的场景卡
      panelNoScenario: '', // 没有场景卡（“熟练”按单服务卡 + 小测判定）
      panelAppears: '', // 也出现在（不计入）
      panelTracks: '', // 所在路径
      panelTopics: '', // 考点
      panelFeatures: '', // 附属服务
      panelReview: '', // ! 需复习：在之后的实验中发现了本服务的配置漂移
      panelQuiz: '', // 小测 {r}
      summary: '', // 服务掌握度（{n}）· 熟练 {pro} · 已掌握 {m} · 已接触 {t} · 未开始 {none} · 需复习 {review}
      rowLabel: '', // {cat}
    },
    track: {
      pick: '', // 路径
      detail: '', // 路径详情与证书 →
      head: '', // 必修 {done}/{total}
      groups: '', //  · 选修组 {done}/{total}
      verified: '', //  · 已核验 {pct}（需 ≥ {min}）
      counted: '', //  · 计入 {n}/{min}
      cert: '', // 证书：
      current: '', // 当前路径
      setCurrent: '', // 设为当前路径
      setCurrentDone: '', // 已设为当前路径：{name}
      hours: '', // {who} · 必修约 {req} 小时 · 全部约 {all} 小时（不含环境准备）
      stageCount: '', // {done}/{total}
      stageLegacy: '', // 原 Lab {n}
      groupLabel: '', // 选修组：选 {pick} 张，已完成 {done} 张
      groupText: '', // ◇ {title}：选 {pick} 张
      groupDone: '', //  · 已满足
      recommended: '', // 推荐
      reuseFrom: '', // ↳ 可在 {labId} 的保留环境中继续
      segLabel: '', // 已核验 {a} 张、含手动 {m} 张、进行中 {p} 张，最少完成 {min} 张
      certTitle: '', // 证书：{title}
      certAside: '', // 由自托管平台签发，不是 AWS 官方认证
      condition: '', // 条件
      status: '', // 状态
      condRequired: '', // 必修卡片全部有有效徽章
      condGroups: '', // 每个选修组至少 {pick} 张
      condGroupsNone: '', // —（本路径没有选修组）
      condGroupsMissing: '', // （{list} 的组未完成）
      condRatio: '', // “已核验”徽章占比 ≥ {min}（“自述为主”不计入）
      condDefect: '', // 计入的尝试都不在“有缺陷”的内容版本中
      condPending: '', // 核验中的徽章（等待对比实验交叉核验）
      none: '', // 无
      yes: '', // 是
      no: '', // 否
      claim: '', // 领取证书
      claimBlocked: '', // 条件未满足：{list}。以服务端返回的原因为准。
      reasonRequired: '', // 还差必修 {n} 张
      reasonGroups: '', // 选修组 {n} 个
      reasonRatio: '', // 已核验占比不足
      reasonPending: '', // 有徽章仍在核验中
      reasonDefect: '', // 有尝试在“有缺陷”的内容版本中
      reasonDisabled: '', // 本路径不签发证书
      stages: '', // 阶段与卡片
      history: '', // 历史证书
      historyNone: '', // 还没有签发过本路径的证书。
      historyRow: '', // {id} · {status}
      certDetail: '', // 证书详情 →
      currentCert: '', // 当前证书：{id}
      notFoundTitle: '', // 没有这条学习路径
      notFound: '', // 没有这条学习路径（{id}）。
      eligibleTag: '', // 可领取
      notYetTag: '', // 未达成
      claimedTag: '', // 已领取
      revokedTag: '', // 已吊销
    },
    claim: {
      title: '', // 领取：{cert}
      name: '', // 证书上显示的名字（默认取个人资料中的证书署名）
      public: '', // 公开证书文件：任何人可以通过验证链接直接验证；不公开时只能用你提供的文件或链接验证
      records: '', // 证书会记录：路径与版本、计入的卡片与徽章等级、“已核验”占比、每张卡片的报告摘要。
      notRecords: '', // 不会记录：你的邮箱、AWS 账号 ID、小测成绩。
      nature: '', // 同一路径只保留一张有效证书；以后成绩提高可以重新领取，旧证书会自动吊销。本证明由你的自托管 ATL 实例签发，不是 AWS 官方认证。
      submit: '', // 签发证书
      busy: '', // 正在签发…
      notEligible: '', // 还不满足领取条件：{list}
      done: '', // 证书已签发：{id}
    },
  },
  section: {
    scenario: '', // 场景
    constraints: '', // 约束
    antiPatterns: '', // 常见的错误方案
    background: '', // 背景
    why: '', // 原理
    objectives: '', // 你将学到
    resources: '', // 实验资源
    cost: '', // 预计费用
    steps: '', // 步骤概览
    experiments: '', // 对比实验预告
    topics: '', // 考点
    confusables: '', // 易混
    prereq: '', // 开始前准备
    timing: '', // 时间与结束
    costShort: '', // 费用
    badge: '', // 徽章
    tracks: '', // 所属路径
    reuse: '', // 可复用的保留环境
    attempts: '', // 历次尝试
  },
} satisfies Dict<typeof zh>;
