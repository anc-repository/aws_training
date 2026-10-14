/**
 * en（English）：命名空间 labs。由 `npm run i18n:sync` 按 zh-CN 词典维护结构：
 * 只填写引号内的译文（空字符串 = 未翻译，运行时按 en → en → zh-CN 回退）；行尾注释是 zh-CN 原文。
 * 术语与风格见 ../glossary.md（不翻译 AWS 服务名、CLI 命令、代码、资源名、API 路径、环境变量）。
 */
import type { Dict } from '../dict';
import type zh from '../zh-CN/labs';

export default {
  difficulty: {
    intro: 'Intro', // 入门
    beginner: 'Beginner', // 初级
    intermediate: 'Intermediate', // 中级
    advanced: 'Advanced', // 高级
  },
  domain: {
    secure: 'Secure', // 安全
    resilient: 'Resilient', // 弹性
    performance: 'High-performing', // 高性能
    cost: 'Cost-optimized', // 成本
  },
  duration: {
    short: '≤ 1 hour', // ≤ 1 小时
    medium: '1–2 hours', // 1～2 小时
    long: '> 2 hours', // > 2 小时
  },
  provision: {
    A: 'Fast', // 较快
    B: 'Moderate', // 中等
    C: 'Slow', // 较慢
    D: 'Very slow', // 很慢
  },
  provisionHint: {
    A: 'Fast (A): the start state has only L0 and resources that are quick to create. No minutes are shown; once this platform has enough runs, the actual time is shown.', // 较快（A）：起始状态只有 L0 与快速创建的资源。不写分钟数；本平台积累足够记录后会显示实际耗时。
    B: 'Moderate (B): the start state includes one or two of a CloudFront distribution, an ALB, a Cognito user pool, or an instance replacement.', // 中等（B）：起始状态含 CloudFront 分配、ALB、Cognito 用户池或实例替换中的一两项。
    C: 'Slow (C): the start state includes RDS or ElastiCache.', // 较慢（C）：起始状态含 RDS 或 ElastiCache 之一。
    D: 'Very slow (D): RDS / ElastiCache plus an ALB, another database, or an instance replacement.', // 很慢（D）：RDS / ElastiCache 再叠加 ALB、另一个数据库或实例替换。
  },
  costTierHint: {
    low: '$ Low: no hourly-billed resources besides the lab instance and the workbench. The exact amount is calculated at current prices before you start.', // $ 低：除实验机与工作台外没有按小时计费的资源。具体金额在开始前按当前价格计算。
    medium: '$$ Medium: one more hourly-billed resource, or an account-level pay-per-use service is turned on. The exact amount is calculated at current prices before you start.', // $$ 中：额外有 1 个按小时计费的资源，或会开启账号级按量服务。具体金额在开始前按当前价格计算。
    high: '$$$ High: two or more extra hourly-billed resources. The exact amount is calculated at current prices before you start.', // $$$ 高：额外有 2 个及以上按小时计费的资源。具体金额在开始前按当前价格计算。
  },
  flag: {
    'needs-advance': 'Needs preparation', // 需提前准备
    limited: 'Partly unavailable', // 部分不可用
    'needs-domain': 'Needs a domain', // 需要域名
    'domain-optional': 'Domain optional', // 域名可选
    'needs-email': 'Needs email confirmation', // 需要邮箱确认
    'account-impact': 'Account-wide impact', // 账号级影响
    'long-wait': 'Long wait', // 等待较长
    beta: 'Beta', // 测试版
    'new-version': 'New version', // 有新版本
  },
  mastery: {
    not_started: 'Not started', // 未开始
    touched: 'Touched', // 已接触
    mastered: 'Mastered', // 已掌握
    proficient: 'Proficient', // 熟练
  },
  badgeLevel: {
    verified: 'Verified', // 已核验
    attested: 'Includes manual', // 含手动
    'self-reported': 'Mostly self-reported', // 自述为主
  },
  roleInTrack: {
    required: 'Required', // 必修
    optional: 'Optional', // 可选
    group: 'Elective group', // 选修组成员
  },
  input: {
    domain: {
      label: 'Domain name', // 域名
      need: 'A domain whose NS records you can change', // 一个可以修改 NS 记录的域名
      hint: 'Lowercase, for example lab.example.com; IP addresses and wildcards are not accepted', // 小写，例如 lab.example.com；不接受 IP 与通配符
    },
    'hosted-zone': {
      label: 'Route 53 hosted zone ID', // Route 53 托管区域 ID
      need: 'A Route 53 hosted zone ID', // Route 53 托管区域 ID
      hint: 'Looks like Z0123456789ABC', // 形如 Z0123456789ABC
    },
    'ses-identity': {
      label: 'SES sending identity', // SES 发信身份
      need: 'An email address or domain you can verify', // 一个可以验证的邮箱或域名
      hint: 'An email address or a domain; used only to verify the identity in this lab', // 邮箱或域名；只用于本次实验的身份验证
    },
    'notify-email': {
      label: 'Notification email', // 通知邮箱
      need: 'An email address that can receive mail', // 能收信的邮箱
      hint: 'Used only for this lab’s subscription and identity verification; never written to certificates or public pages', // 只用于本次实验的订阅与身份验证，不写入证书与公开页面
    },
    'alert-email': {
      label: 'Alert email', // 告警邮箱
      need: 'An email address that can receive alerts', // 能收信的告警邮箱
      hint: 'Used only for this lab’s subscription and identity verification; never written to certificates or public pages', // 只用于本次实验的订阅与身份验证，不写入证书与公开页面
    },
    'recipient-emails': {
      label: 'Recipient emails (up to 2, comma-separated)', // 收件人邮箱（最多 2 个，用逗号分隔）
      need: '1–2 email addresses that can receive mail', // 1～2 个能收信的邮箱
      hint: 'Used only for this lab; never written to certificates or public pages', // 只用于本次实验，不写入证书与公开页面
    },
    'budget-amounts': {
      label: 'Two budget amounts (comma-separated)', // 两个预算金额（用逗号分隔）
      need: 'Two budget amounts', // 两个预算金额
      hint: 'Positive numbers with up to two decimals. Choose them by what you can afford; the platform gives no reference values', // 正数，最多两位小数；由你按自己的承受能力填写，平台不给参考值
    },
    'cost-tags-active': {
      label: 'Cost allocation tags', // 成本分配标签
      need: 'Activate cost allocation tags 24–48 hours ahead', // 提前 24～48 小时激活成本分配标签
      hint: 'Check this when you have run the platform action “Activate cost allocation tags” and waited for it to take effect (see the official documentation)', // 勾选表示已执行平台动作“激活成本分配标签”并等待生效（以官方文档为准）
    },
  },
  stepType: {
    observe: 'Observe', // 观察
    experiment: 'Experiment', // 对比实验
    script: 'Script', // 脚本
    cli: 'CLI', // 命令行
    console: 'Console', // 控制台
    read: 'Read', // 阅读
    manual: 'Manual confirmation', // 手动确认
    'platform-action': 'Platform action', // 平台动作
    wire: 'Wire up', // 接入
  },
  ui: {
    catalog: {
      title: 'Card catalog', // 卡片目录
      sub: '{n} cards · {svc} service · {sc} scenario · catalog {v}', // {n} 张卡片 · {svc} 张单服务 · {sc} 张场景 · 目录 {v}
      searchPlaceholder: 'Search cards, services, topics, Lab numbers…', // 搜索卡片、服务、考点、Lab 编号…
      searchLabel: 'Search cards (shortcut /)', // 搜索卡片（快捷键 /）
      viewLabel: 'View', // 视图
      viewGrid: 'Cards', // 卡片网格
      viewMap: 'Service map', // 服务地图
      viewTracks: 'Learning paths', // 路径
      group: 'Group', // 分组
      groupKind: 'By type', // 按类型
      groupCategory: 'By service category', // 按服务类别
      groupDomain: 'By exam domain', // 按考试领域
      groupNone: 'No grouping', // 不分组
      sort: 'Sort', // 排序
      sortPath: 'Recommended order', // 推荐顺序
      sortDuration: 'Estimated time', // 预计时长
      sortCost: 'Cost tier', // 费用档位
      sortRecent: 'Recently tried', // 最近尝试
      filters: 'Filters ({n})', // 筛选（{n}）
      facetKind: 'Type', // 类型
      facetDomain: 'Domain', // 领域
      facetDifficulty: 'Difficulty', // 难度
      facetDuration: 'Time', // 时长
      facetCost: 'Cost', // 费用
      facetStatus: 'Status', // 状态
      facetService: 'Service', // 服务
      kindService: 'Service', // 单服务
      kindScenario: 'Scenario', // 场景
      onlyPrimary: 'Primary domain only', // 只看主领域
      noManual: 'No manual prerequisites only', // 只看无需人工前置
      pickService: 'Choose a service…', // 选择服务…
      removeService: 'Remove service {name}', // 移除服务 {name}
      shown: 'Showing {n} of {total}', // 显示 {n} / {total} 张
      shownAnnounce: 'Showing {n} of {total} cards', // 显示 {n} / {total} 张卡片
      clear: 'Clear filters', // 清除筛选
      cleared: 'Filters cleared; showing {total} of {total} cards', // 已清除筛选，显示 {total} / {total} 张卡片
      emptyTitle: 'No cards match', // 没有符合条件的卡片
      emptyNoManual: '“No manual prerequisites only” hides cards that need a domain, email confirmation, or preparation in advance.', // 其中“只看无需人工前置”隐藏了需要域名、邮箱确认或提前准备的卡片。
      sectionCount: '{n, plural, one {# card} other {# cards}} · {done} / {n} done', // {n} 张 · 已完成 {done} / {n}
      sectionService: 'Service cards · {cat}', // 单服务卡片 · {cat}
      sectionScenario: 'Scenario cards', // 场景卡片
      sectionAll: 'All cards', // 全部卡片
      alsoDomain: 'Also covers (secondary domain)', // 也涉及（次领域）
      costPrimaryOnlyHint: 'Cost-optimization topics are spread across several cards; clear “Primary domain only” to see them.', // 成本优化考点分布在多张卡片中，取消“只看主领域”查看。
      otherTracks: 'Other learning paths', // 其他学习路径
      shelfItem: '{counted}/{min} · {cert}', // {counted}/{min} · {cert}
      certEligible: 'Certificate available', // 证书可领取
      certNotYet: 'Certificate not yet earned', // 证书未达成
      certClaimed: 'Certificate claimed', // 证书已领取
      statusUnavailable: 'Status unavailable', // 状态暂不可用
      masteryUnavailable: 'Mastery unavailable', // 掌握度暂不可用
      retry: 'Retry', // 重试
      statusFacetOff: 'Your personal status is unavailable, so the “Status” filter can’t be used right now', // 个人状态暂不可用，“状态”筛选暂时不能使用
      skippedSetup: 'First-run setup was skipped. You can review it under Settings › Platform.', // 首次设置已跳过：可在 设置 › 平台 中重看。
      catalogError: 'The card catalog can’t be loaded right now.', // 卡片目录暂时无法加载。
      notPublished: 'No card catalog has been published yet.', // 还没有发布卡片目录。
    },
    card: {
      kindService: 'Service · {cat}', // 单服务 · {cat}
      kindScenario: 'Scenario · {n, plural, one {# service} other {# services}}', // 场景 · 包含 {n} 个服务
      legacy: 'Former Lab {n}', // 原 Lab {n}
      minutes: 'About {n} min', // 约 {n} 分钟
      hours: 'About {n} h', // 约 {n} 小时
      limit: 'Limit {t}', // 上限 {t}
      provision: 'Setup: {t}', // 环境准备：{t}
      attempts: '{n, plural, one {# attempt} other {# attempts}}', // 尝试 {n} 次
      noAttempts: 'Not tried yet', // 尚未尝试
      badgeNone: 'Not earned', // 未获得
      badgePending: 'Verifying', // 核验中
      badgeWithdrawn: 'Withdrawn', // 已撤回
      backToWorkspace: 'Back to workbench', // 回到工作台
      viewProgress: 'View progress', // 查看进度
      planned: 'Coming soon', // 即将推出
      plannedNote: 'This card is still being written: you can read the overview, but you can’t start the lab yet.', // 这张卡片还在编写中：可以先看简介，暂时不能开始实验。
      deprecated: 'This card has been retired', // 本卡片已停用
      newVersion: 'New version', // 有新版本
      services: 'Services: {list}', // 服务：{list}
      scenarioOptional: ' (optional / conditional target)', // （选做 / 条件目标）
    },
    state: {
      preparing: 'Preparing', // 准备中
      running: 'In progress · {t} left', // 进行中 · 剩余 {t}
      ending: 'Ending', // 正在结束
      cleaning: 'Releasing', // 正在释放
      kept: 'Environment kept · until {t}', // 环境保留中 · 至 {t}
      cleanupFailed: 'Release incomplete', // 释放未完成
      completed: 'Completed', // 已完成
      completedManual: 'Completed (includes manual)', // 已完成（含手动）
      incomplete: 'Incomplete', // 未完成
      notStarted: 'Not started', // 未开始
    },
    env: {
      region: 'Current environment', // 当前环境
      elapsed: '{t} elapsed', // 已用 {t}
      remaining: '{t} left', // 剩余 {t}
      provision: 'Setup: {t}', // 环境准备：{t}
      hourly: '{n} billed hourly', // 按小时计费 {n} 项
      deleted: '{n}/{m} deleted', // 已删除 {n}/{m}
      until: 'until {t}', // 至 {t}
      saveMode: 'Saving mode', // 节省模式
      toWorkspace: 'Back to workbench', // 回到工作台
      cancel: 'Cancel…', // 取消…
      extend: 'Extend…', // 延长…
      end: 'End lab…', // 结束实验…
      reclaim: 'View reclaim progress', // 查看回收进度
      manageKeep: 'Manage kept environment', // 管理保留
      reuseNext: 'Reuse in the next card', // 在下一张卡片中复用
      residual: '{what} left {n, plural, one {# resource} other {# resources}} unreleased{hourly}', // {what}有 {n} 项资源未释放{hourly}
      residualHourly: ', {n} of them billed hourly', // ，其中 {n} 项按小时计费
      residualOf: '{labId} (lab of {at})', // {labId}（{at} 的实验）
      residualPrevious: 'An earlier lab', // 之前的实验
      viewList: 'View list', // 查看清单
      maintenance: 'The platform is under maintenance; new labs can’t start right now.', // 平台维护中，暂时不能开始新实验。
      uninstalling: 'The platform is being uninstalled; new labs can’t start.', // 平台正在卸载，暂时不能开始新实验。
      extendBlocked: 'Extension unavailable', // 延长暂不可用
    },
    cont: {
      title: 'Keep learning', // 继续学习
      path: '{track} · {stage} · required {done}/{total}', // {track} · {stage} · 必修 {done}/{total}
      pathNoStage: '{track} · required {done}/{total}', // {track} · 必修 {done}/{total}
      recommend: 'Recommended', // 推荐
      recommendAfter: 'Recommended after the current environment', // 当前环境之后推荐
      view: 'View →', // 查看 →
      newLearner: 'Start with {labId} (card 1 of {track})', // 从 {labId} 开始（{track}第 1 张）
      quickPath: 'Only want the seven named comparisons? → Quick path', // 只想看七组点名对比？→ 快速路径
      done: 'All cards in {track} are done: you can claim the certificate.', // {track}的卡片都已完成：可以领取证书。
      reuseHint: '↳ Can continue in the kept environment of {labId}', // ↳ 可在 {labId} 的保留环境中继续
    },
    map: {
      legend: 'Legend:', // 图例：
      legendLevel: '{level}: {n, plural, one {# service} other {# services}}', // {level} {n} 项服务
      legendTail: '· dashed frame = includes manual · ! = needs review · * needs a domain to count via scenario cards · † no scenario card', // · 虚线框 = 含手动 · ! = 需复习 · * 需要域名才能由场景卡计入 · † 没有场景卡
      help: 'The score only drives the progress ring; the level follows the rules. Click a service to open the side panel; Tab into the map and use the arrow keys to move between cells.', // 分数只用于进度环；等级文字按规则判定。点击服务格打开侧栏；Tab 进入地图后用方向键在格子之间移动。
      cellLabel: '{name}, {fn}, {level}, {score} points', // {name}，{fn}，{level}，{score} 分
      needsReview: 'Needs review', // 需复习
      domainNote: 'Needs a domain to count via scenario cards', // 需要域名才能由场景卡计入
      noScenario: 'No scenario card', // 没有场景卡
      single: 'Service card {mark} · scenarios {done}/{total}', // 单服务 {mark} · 场景 {done}/{total}
      panelMastery: 'Mastery', // 掌握度
      panelScore: '{score} / 100', // {score} / 100
      panelSvcCard: 'Service card', // 单服务卡
      panelCredited: 'Scenario cards that count for this service', // 计入本服务的场景卡
      panelNoScenario: 'No scenario card (“Proficient” is judged by the service card and the quiz)', // 没有场景卡（“熟练”按单服务卡 + 小测判定）
      panelAppears: 'Also appears in (does not count)', // 也出现在（不计入）
      panelTracks: 'Learning paths', // 所在路径
      panelTopics: 'Topics', // 考点
      panelFeatures: 'Related services', // 附属服务
      panelReview: '! Needs review: a later lab found configuration drift in this service', // ! 需复习：在之后的实验中发现了本服务的配置漂移
      panelQuiz: 'Quiz {r}', // 小测 {r}
      summary: 'Service mastery ({n}) · proficient {pro} · mastered {m} · touched {t} · not started {none} · needs review {review}', // 服务掌握度（{n}）· 熟练 {pro} · 已掌握 {m} · 已接触 {t} · 未开始 {none} · 需复习 {review}
      rowLabel: '{cat}', // {cat}
      labelSep: ', ', // ，
      legendSvc: 'Service card', // 单服务卡
      legendSc: 'Scenario cards', // 场景卡
      panelSvcCardLine: '{label}: ', // {label}：
    },
    track: {
      pick: 'Learning path', // 路径
      detail: 'Path details and certificate →', // 路径详情与证书 →
      head: 'Required {done}/{total}', // 必修 {done}/{total}
      groups: ' · elective groups {done}/{total}', //  · 选修组 {done}/{total}
      verified: ' · verified {pct} (needs ≥ {min})', //  · 已核验 {pct}（需 ≥ {min}）
      counted: ' · counted {n}/{min}', //  · 计入 {n}/{min}
      cert: 'Certificate: ', // 证书：
      current: 'Current path', // 当前路径
      setCurrent: 'Set as current path', // 设为当前路径
      setCurrentDone: 'Set as current path: {name}', // 已设为当前路径：{name}
      hours: '{who} · required about {req} h · all about {all} h (setup time not included)', // {who} · 必修约 {req} 小时 · 全部约 {all} 小时（不含环境准备）
      stageCount: '{done}/{total}', // {done}/{total}
      stageLegacy: 'Former Lab {n}', // 原 Lab {n}
      groupLabel: 'Elective group: pick {pick}, {done} done', // 选修组：选 {pick} 张，已完成 {done} 张
      groupText: '◇ {title}: pick {pick}', // ◇ {title}：选 {pick} 张
      groupDone: ' · met', //  · 已满足
      recommended: 'Recommended', // 推荐
      reuseFrom: '↳ Can continue in the kept environment of {labId}', // ↳ 可在 {labId} 的保留环境中继续
      segLabel: '{a} verified, {m} including manual, {p} in progress; at least {min} cards to complete', // 已核验 {a} 张、含手动 {m} 张、进行中 {p} 张，最少完成 {min} 张
      certTitle: 'Certificate: {title}', // 证书：{title}
      certAside: 'Issued by your self-hosted platform, not an AWS certification', // 由自托管平台签发，不是 AWS 官方认证
      condition: 'Condition', // 条件
      status: 'Status', // 状态
      condRequired: 'Every required card has a valid badge', // 必修卡片全部有有效徽章
      condGroups: '{pick, plural, one {At least # card} other {At least # cards}} in each elective group', // 每个选修组至少 {pick} 张
      condGroupsNone: '— (this path has no elective groups)', // —（本路径没有选修组）
      condGroupsMissing: ' (groups in {list} not met)', // （{list} 的组未完成）
      condRatio: 'Share of “Verified” badges ≥ {min} (“Mostly self-reported” does not count)', // “已核验”徽章占比 ≥ {min}（“自述为主”不计入）
      condDefect: 'No counted attempt is on a content version marked “defective”', // 计入的尝试都不在“有缺陷”的内容版本中
      condPending: 'Badges being verified (waiting for comparison-experiment cross-checks)', // 核验中的徽章（等待对比实验交叉核验）
      none: 'None', // 无
      yes: 'Yes', // 是
      no: 'No', // 否
      claim: 'Claim certificate', // 领取证书
      claimBlocked: 'Conditions not met: {list}. The reasons returned by the server take precedence.', // 条件未满足：{list}。以服务端返回的原因为准。
      reasonRequired: '{n, plural, one {# required card to go} other {# required cards to go}}', // 还差必修 {n} 张
      reasonGroups: '{n, plural, one {# elective group not met} other {# elective groups not met}}', // 选修组 {n} 个
      reasonRatio: 'Verified share too low', // 已核验占比不足
      reasonPending: 'Some badges are still being verified', // 有徽章仍在核验中
      reasonDefect: 'Some attempts are on a content version marked “defective”', // 有尝试在“有缺陷”的内容版本中
      reasonDisabled: 'This path does not issue certificates', // 本路径不签发证书
      stages: 'Stages and cards', // 阶段与卡片
      history: 'Past certificates', // 历史证书
      historyNone: 'No certificate has been issued for this path yet.', // 还没有签发过本路径的证书。
      historyRow: '{id} · {status}', // {id} · {status}
      certDetail: 'Certificate details →', // 证书详情 →
      currentCert: 'Current certificate: {id}', // 当前证书：{id}
      notFoundTitle: 'No such learning path', // 没有这条学习路径
      notFound: 'There is no learning path {id}.', // 没有这条学习路径（{id}）。
      eligibleTag: 'Available', // 可领取
      notYetTag: 'Not yet', // 未达成
      claimedTag: 'Claimed', // 已领取
      revokedTag: 'Revoked', // 已吊销
    },
    visual: {
      more: 'Details', // 详细
      ringCounted: 'Counted cards', // 计入的卡片
    },
    claim: {
      title: 'Claim: {cert}', // 领取：{cert}
      name: 'Name shown on the certificate (defaults to the certificate name in your profile)', // 证书上显示的名字（默认取个人资料中的证书署名）
      public: 'Publish the certificate file: anyone can verify it from the verification link. If you don’t publish it, it can only be verified with the file or link you share', // 公开证书文件：任何人可以通过验证链接直接验证；不公开时只能用你提供的文件或链接验证
      records: 'The certificate records: the path and version, the counted cards and their badge levels, the “Verified” share, and a report summary for each card.', // 证书会记录：路径与版本、计入的卡片与徽章等级、“已核验”占比、每张卡片的报告摘要。
      notRecords: 'It does not record: your email address, your AWS account ID, or quiz scores.', // 不会记录：你的邮箱、AWS 账号 ID、小测成绩。
      nature: 'Only one valid certificate is kept per path; if your results improve you can claim again and the old certificate is revoked automatically. This credential is issued by your self-hosted ATL instance and is not an AWS certification.', // 同一路径只保留一张有效证书；以后成绩提高可以重新领取，旧证书会自动吊销。本证明由你的自托管 ATL 实例签发，不是 AWS 官方认证。
      submit: 'Issue certificate', // 签发证书
      busy: 'Issuing…', // 正在签发…
      notEligible: 'Not eligible yet: {list}', // 还不满足领取条件：{list}
      done: 'Certificate issued: {id}', // 证书已签发：{id}
    },
  },
  section: {
    scenario: 'Scenario', // 场景
    constraints: 'Constraints', // 约束
    antiPatterns: 'Common wrong approaches', // 常见的错误方案
    background: 'Background', // 背景
    why: 'How it works', // 原理
    objectives: 'What you will learn', // 你将学到
    resources: 'Lab resources', // 实验资源
    cost: 'Estimated cost', // 预计费用
    steps: 'Steps at a glance', // 步骤概览
    experiments: 'Comparison experiments', // 对比实验预告
    topics: 'Exam topics', // 考点
    confusables: 'Easily confused', // 易混
    prereq: 'Before you start', // 开始前准备
    timing: 'Time and ending', // 时间与结束
    costShort: 'Cost', // 费用
    badge: 'Badge', // 徽章
    tracks: 'Learning paths', // 所属路径
    reuse: 'Kept environments you can reuse', // 可复用的保留环境
    attempts: 'Past attempts', // 历次尝试
  },
} satisfies Dict<typeof zh>;
