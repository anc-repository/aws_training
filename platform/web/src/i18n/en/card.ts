/**
 * en（English）：命名空间 card。由 `npm run i18n:sync` 按 zh-CN 词典维护结构：
 * 只填写引号内的译文（空字符串 = 未翻译，运行时按 en → en → zh-CN 回退）；行尾注释是 zh-CN 原文。
 * 术语与风格见 ../glossary.md（不翻译 AWS 服务名、CLI 命令、代码、资源名、API 路径、环境变量）。
 */
import type { Dict } from '../dict';
import type zh from '../zh-CN/card';

export default {
  page: {
    notFoundTitle: 'Page not found', // 页面不存在
    notFound: 'There is no card {id}. It may not be published yet.', // 没有这张卡片（{id}）。它可能尚未发布。
    back: 'Back to the catalog', // 返回目录
    meta: '{est} · limit {limit} (extend up to {n, plural, one {# time} other {# times}}, {m} min each)', // {est} · 上限 {limit}（可延长 {n} 次，每次 {m} 分钟）
    provision: 'Setup: {t} ({c})', // 环境准备：{t}（{c}）
    status: 'Status: ', // 状态：
    badge: 'Badge: ', // 徽章：
    quoteOnly: 'Check current price', // 计算当前价格
    quiz: 'Quiz', // 小测
    personalFailed: 'Can’t tell whether you can start right now', // 暂时无法判断能否开始
    personalRetry: 'Retry', // 重试
    beta: 'Beta', // 测试版
    version: 'v{v}', // v{v}
    ctaRegion: 'Start lab actions', // 开始实验操作栏
    asideLabel: 'Before you start and summary', // 开始前准备与摘要
  },
  sections: {
    resourcesIntro: 'When you choose “Start lab”, the platform deploys into your account ({region}): L0 (one lab instance on EC2, a separate data volume, and an Elastic IP)', // 点“开始实验”后，平台会在你的账号（{region}）中自动部署：L0（一台实验机 EC2、独立数据卷、弹性 IP）
    resourcesModule: 'and turns on {name} in advance ({reason})', // 并预先启用 {name}（{reason}）
    resourcesLocal: '{name} uses the local implementation as the “without it” baseline ({reason})', // {name}使用本地档，作为“没有它”的基线（{reason}）
    resourcesRuntime: '{name} is turned on ({reason})', // 已打开 {name}（{reason}）
    resourcesSeed: '{name} is prepared ({reason})', // 已准备 {name}（{reason}）
    resourcesChannel: 'The lab instance has the platform’s management channel (instance role CloudAlbumAppRole, with only the permissions Session Manager needs; it is not an application permission).', // 实验机带有平台管理通道（实例角色 CloudAlbumAppRole，只含 Session Manager 所需权限，不属于应用权限）。
    resourcesExtra: 'It also deploys {title}, which is specific to this card (not a CloudAlbum module; deleted together at the end).', // 另外部署本卡专用的 {title}（不属于 CloudAlbum 模块，结束时一并删除）。
    target: 'You will do it yourself: ', // 你将亲手完成：
    targetItem: '{name} ({from} → {to})', // {name}（{from} → {to}）
    targetItemNew: '{name} (enable {to})', // {name}（启用 {to}）
    targetTail: 'Use the console or scripts/module in the workbench terminal; the platform’s checks are exactly the same for both.', // 可以用控制台，也可以在工作台终端用 scripts/module，平台的检查对两种做法完全相同。
    optional: ' (optional)', // （选做）
    warnings: 'At the start, {name} showing “degraded” is expected: {text}', // 开始时 {name} 显示“降级”是预期的：{text}
    workstation: 'Each session has one workbench EC2 instance with the AWS CLI, Node.js, k6, and the project repository installed. In the workbench terminal you act as ATLLearnerRole, limited by a permissions boundary.', // 每个会话有一台工作台 EC2，预装 AWS CLI、Node.js、k6 与项目仓库；你在工作台终端中的身份是 ATLLearnerRole，受权限边界约束。
    workstationDegraded: 'If you don’t start the workbench (CloudShell saving mode), results of load experiments are for reference only.', // 选择不启动工作台（CloudShell 省钱模式）时，负载类实验的结果只供参考。
    workstationRequired: 'This card requires the workbench.', // 本卡片必须使用工作台。
    cleanup: 'When the lab ends or expires, the platform deletes every resource this session created, including those you created by hand in the console; anything that can’t be deleted automatically goes on the manual-handling list.', // 结束或到期后，平台删除本会话创建的全部资源，包括你在控制台手动创建的；无法自动删除的会列入“待人工处理清单”。
    costLine: 'Cost tier: ', // 费用档位：
    costSources: '. Main cost drivers besides the lab instance and the workbench: {list}.', // 。除实验机与工作台外，主要计费来源：{list}。
    costNone: '. No hourly-billed resources besides the lab instance and the workbench.', // 。除实验机与工作台外没有按小时计费的资源。
    costOptional: ' Optional steps raise the tier to {tier}.', // 选做步骤会让档位变为 {tier}。
    costKeep: 'Keeping the environment is still billed: the data volume and Elastic IP after the lab instance stops, and so on.', // 保留环境期间仍计费：实验机停止后的数据卷与弹性 IP 等。
    costDisclaimer: 'Amounts are estimated from Price List prices as of the price date and exclude data transfer and some per-request charges; AWS’s official pricing and your bill take precedence.', // 金额按 Price List 的价格日期估算，不含数据传输与部分按请求计费项，以 AWS 官方定价与账单为准。
    stepNo: '#', // #
    stepTitle: 'Step', // 步骤
    stepType: 'Type', // 类型
    stepMarks: 'Notes', // 标记
    markOptional: 'Optional', // 选做
    markWait: 'About {n} min wait', // 需等待约 {n} 分钟
    markHourly: 'Starts hourly billing', // 开始按小时计费
    markUsage: 'Starts usage billing', // 开始按量计费
    markOutage: 'Expected outage', // 预期中断
    noSteps: 'The step list is generated from the manual, which hasn’t been published for this card yet.', // 步骤表由手册生成，这张卡片还没有发布手册。
    experimentsGenerated: '{title} ({module}/{id}, {req})', // {title}（{module}/{id}，{req}）
    required: 'Required', // 必做
    elective: 'Optional', // 选做
    prereqCards: 'Recommended first: ', // 建议先完成：
    prereqNone: 'None', // 无
    inputs: 'You need to provide: ', // 需要你提供：
    accountImpact: 'Account-wide impact: ', // 账号级影响：
    platformOps: 'Platform actions: ', // 平台动作：
    impactItem: 'Changes: {resource} ({revert})', // 会修改：{resource}（{revert}）
    revertDelete: 'deleted at the end', // 结束时删除
    revertRestore: 'restored at the end', // 结束时还原
    revertKeep: 'not reverted', // 不撤销
    opItem: 'The platform runs for you: {title}', // 平台会代你执行：{title}
    timing: 'The countdown starts when the environment is ready, with a limit of {limit}; you can extend up to {n, plural, one {# time} other {# times}}, {m} min each. Everything is released automatically when the lab ends or expires. ', // 倒计时从环境就绪开始，上限 {limit}，可延长 {n} 次、每次 {m} 分钟。结束或到期后自动释放；
    timingKeep: 'To continue another day, you can keep the environment (up to {h} hours; billing continues and you need to confirm).', // 如需改天继续，可以选择保留环境（最长 {h} 小时，期间持续计费，需要你确认）。
    timingNoKeep: 'This card does not allow keeping the environment.', // 本卡片不允许保留环境。
    costTier: 'Tier ', // 档位 
    costMain: ' · main cost drivers: {list}', //  · 主要计费来源：{list}
    badgeText: 'Complete this card (pass the final check) to earn the badge “{title}”; quiz scores are recorded on the badge and don’t affect completion.', // 完成本卡片（最终复核通过）即获得徽章“{title}”；小测成绩会记在徽章上，不影响完成。
    badgeEarned: 'Earned: {level}', // 已获得：{level}
    trackItem: '{track} ({stage}, {role})', // {track}（{stage}，{role}）
    reuseNone: 'No kept environment to continue in', // 没有可直接继续的保留环境
    reuseItem: 'environment of {labId}', // {labId} 的环境
    reuseWarn: ' (reusable, but it brings {mods}: billing may continue and the baseline may be affected)', // （可复用，但会带上 {mods}：可能持续计费，并可能影响基线）
    reuseNote: 'Hint only; whether it can be reused is decided by the difference plan at quote time.', // 只是提示；能否复用以报价时的差异计划为准。
    attemptsNone: '(none)', // （无）
    attemptDetail: 'Details', // 详情
    attemptReport: 'Report', // 报告
    variants: 'This card has {n} ways to start: {list}. They share one badge.', // 本卡片有 {n} 种起始方式：{list}。它们共用一个徽章。
    preflightVariant: 'Before starting, the platform checks your account; if conditions aren’t met it switches to “{title}” automatically and quotes the higher of the two.', // 开始前平台会检查账号条件；不满足时自动改用“{title}”，报价按两者中较高者。
    knowledge: 'Background you need: ', // 需要的基础：
  },
  start: {
    start: 'Start lab', // 开始实验
    startHint: 'You see a cost estimate first; resources are created only after you confirm.', // 先显示费用估算，确认后才会创建资源。
    startResidual: 'Acknowledge leftovers and start', // 确认残留后开始
    startReuse: 'Start in the kept environment', // 在保留的环境中开始
    releaseFresh: 'Release and start fresh', // 释放后全新开始
    toWorkspace: 'Back to workbench', // 回到工作台
    viewProgress: 'View progress', // 查看进度
    viewSettings: 'View settings', // 查看设置
    viewGuardrails: 'View guardrails', // 查看护栏
    handleResidual: 'Handle leftovers first', // 先处理残留
    until: 'expires at {t}', // {t} 到期
    preparing: 'Preparing', // 准备中
    activeExists: '{labId} is in progress ({when}); you can start a new lab after it ends.', // {labId} 正在进行（{when}），结束后才能开始新的实验。
    deleted: '{n}/{m} deleted', // 已删除 {n}/{m}
    cleaning: 'The previous environment is being released ({count}).', // 上一个环境正在释放（{count}）。
    uninstalling: 'The platform is being uninstalled and no longer accepts new labs.', // 平台正在卸载，已停止接受新实验。
    maintenance: 'The platform is in maintenance mode (usually during an upgrade); new labs can’t start right now.', // 平台处于维护模式（通常是升级中），暂时不能开始新实验。
    budget: 'This month’s spend is over budget, so new labs are paused as configured.', // 本月费用已超过预算，按设置暂停开始新实验。
    reuseBusy: 'The kept environment is being taken over by a new session; you can’t start right now.', // 保留的环境正在被新会话接管，暂时不能开始。
    targetSatisfied: 'This card’s target is already in effect in this environment, so starting here can’t produce completion evidence for this session; release it and start fresh.', // 这个环境里本卡片的目标已经生效，在这里开始拿不到本次会话的完成证据，只能释放后全新开始。
    incompatible: 'The kept environment isn’t compatible with this card; release it and start fresh.', // 保留的环境与本卡片不兼容，只能释放后全新开始。
    hardPrereq: 'A prerequisite card isn’t completed yet.', // 前置卡片还没有完成。
    residualBlock: 'The last lab left hourly-billed resources unreleased. By platform setting, you must handle the leftovers before starting a new lab.', // 上次实验还有按小时计费的资源未释放。按平台设置，必须先处理残留才能开始新的实验。
    residualInfo: 'The last lab left resources unreleased (by platform setting this is a notice only).', // 上次实验还有未释放的资源（按平台设置只提示）。
    plannedNote: 'This card is still being written: you can read the overview, but you can’t start the lab yet.', // 这张卡片还在编写中：可以先看简介，暂时不能开始实验。
    deprecatedNote: 'This card has been retired; new labs can’t start.', // 本卡片已停用，不能开始新的实验。
  },
  dialog: {
    title: 'Start lab: {id} · {title}', // 开始实验：{id} · {title}
    options: 'Options', // 选项
    env: 'Environment', // 环境
    envFresh: 'New environment', // 全新环境
    envReuse: 'Start in the kept environment (from {labId})', // 在保留的环境中开始（{labId} 的环境）
    workstation: 'Workbench', // 工作台
    wsEc2: 'Workbench EC2 (recommended)', // 工作台 EC2（推荐）
    wsCloudshell: 'Don’t start the workbench; use CloudShell (saving mode)', // 不启动工作台，用 CloudShell（省钱模式）
    wsRequired: 'Workbench EC2 (this card needs the workbench; no saving mode)', // 工作台 EC2（本卡片需要工作台，不提供省钱模式）
    wsLimits: 'Saving mode limits: no embedded split view; console sessions last at most 1 hour; comparison-experiment results can’t be uploaded; experiments on the lab instance can only be observed by hand; you clean up the CloudShell home directory yourself.', // 省钱模式的限制：不能嵌入分屏；控制台会话最长 1 小时；对比实验结果无法上传；实验机侧实验只能手动观察；CloudShell 主目录需自行清理。
    wsDegraded: 'Results of load experiments are for reference only.', // 负载类实验的结果只供参考。
    inputs: 'You need to provide', // 需要你提供
    inputsNone: '— (none for this card)', // —（本卡片没有）
    variant: 'Way to start', // 起始方式
    cost: 'Cost', // 费用
    costSub: 'Estimate · unit prices from the Price List, fetched {date} · AWS’s official pricing and your bill take precedence', // 估算 · 单价取自 Price List，取价时间 {date} · 以 AWS 官方定价与账单为准
    expiresIn: 'Quote expires in {t}', // 报价 {t} 后失效
    expired: 'Quote expired', // 报价已失效
    quoting: 'Calculating the cost…', // 正在计算费用…
    quoteFailed: 'The cost can’t be calculated right now.', // 暂时无法计算费用。
    dimensions: 'Show the billing dimensions of each item', // 查看每一项的计费维度
    freeTier: 'The Free Tier isn’t taken into account (it differs by account).', // 不计入免费额度（各账号情况不同）。
    unknownPrice: 'Unit prices are unavailable, so only the billing dimensions are listed; those rows show “Unknown”.', // 单价暂不可得，界面只列计费维度；相关行显示“未知”。
    ackUnknown: 'I understand some costs aren’t estimated', // 我了解有未估算的费用
    budgetWarn: 'This month’s spend has reached 80% of the budget (actual or forecast).', // 本月费用已达到预算的 80%（实际或预测）。
    ackBudget: 'I know this month’s spend is close to the budget', // 我知道本月费用已接近预算
    residualTitle: 'The last lab left resources unreleased, and they are still billed:', // 上次实验还有未释放的资源，这些资源仍在计费：
    residualInfo: 'The last lab left resources unreleased (by platform setting this is a notice only; no confirmation needed):', // 上次实验还有未释放的资源（按平台设置只提示，不要求确认）：
    residualItem: '{type} {name} ({billing}; hourly estimate: not estimated)', // {type} {name}（{billing}；每小时估算：未估算）
    ackResidual: 'I know the last lab left resources unreleased and still want to start', // 我知道上次实验还有未释放的资源，仍要开始
    viewList: 'View list', // 查看清单
    inspector: 'Once Inspector EC2 scanning is activated in the Region, it also scans and bills the workbench (and, if Lambda scanning is activated, the platform’s own functions).', // Inspector 的 EC2 扫描一旦在区域内激活，会同时扫描并计费工作台（以及若激活 Lambda 扫描，平台自身的函数）。
    accountImpact: 'This card changes account-wide settings: {list}.', // 本卡片会修改账号级设置：{list}。
    reusePlan: 'Difference plan: ', // 差异计划：
    reuseEnable: 'enable {list}', // 需启用 {list}
    reuseChange: 'parameter changes {list}', // 参数变更 {list}
    reuseChangeItem: '{module} ({replace}{downtime})', // {module}（{replace}{downtime}）
    reuseReplace: 'replaces the instance', // 替换实例
    reuseNoReplace: 'keeps the instance', // 不替换实例
    reuseDowntime: ', with downtime', // ，会停机
    reuseNoDowntime: ', no downtime', // ，无停机
    reuseExtra: 'extra modules {list} keep billing and may remove the “without it” baseline for some of this card’s comparison experiments', // 多余模块 {list} 会继续计费，并可能让本卡片的部分对比实验失去“没有它”的基线
    reuseManual: '{n, plural, one {# hand-made resource} other {# hand-made resources}} from the previous session', // 上一个会话的手工资源 {n} 项
    reuseFailure: 'After the handover, if provisioning fails, the platform releases the whole environment (including the modules and hand-made resources kept from the previous card) instead of returning it to the kept state.', // 交接完成后，如果准备阶段失败，平台会释放整个环境（包括上一张卡片保留的模块与手工资源），不会退回保留状态。
    reuseIncompatible: 'This kept environment can’t be used for this card: {reason}', // 这个保留的环境不能用于本卡片：{reason}
    time: 'Time', // 时间
    timeText: 'Countdown {limit}, starting when the environment is ready; extend up to {n, plural, one {# time} other {# times}}, {m} min each', // 倒计时 {limit}，从环境就绪开始；可延长 {n} 次，每次 {m} 分钟
    timeIdle: '; ends automatically if you don’t enter the workbench within {idle} min of being ready', // ；就绪后 {idle} 分钟未进入工作台自动结束
    timeProvision: 'Setup: {t} ({c}). While it prepares you can read the manual or leave the page.', // 环境准备：{t}（{c}）。准备期间可以先读手册，也可以离开页面。
    confirm: 'Confirm', // 确认
    ack: 'I understand: resources are created in my AWS account and billed at AWS prices; they are released automatically when the lab ends or expires; keeping the environment keeps billing.', // 我已了解：资源创建在我的 AWS 账号中并按 AWS 价格计费；结束或到期后自动释放；选择保留会持续计费。
    cancel: 'Cancel', // 取消
    submit: 'Start lab', // 开始实验
    submitEst: 'Start lab (est. {est})', // 开始实验（预计 {est}）
    submitting: 'Starting…', // 正在开始…
    requote: 'Recalculate cost', // 重新计算费用
    quoteUpdated: 'The cost information changed; please confirm again.', // 费用信息已更新，请重新确认。
    variantGone: 'This way to start no longer exists; please choose again.', // 这个起始方式已不存在，请重新选择。
    ackRequired: 'Check the confirmation above first.', // 请先勾选上面的确认项。
    notDelivered: 'The request wasn’t confirmed as delivered.', // 请求未确认送达。
    retry: 'Retry', // 重试
    blockedTitle: 'You can’t start right now', // 现在不能开始
  },
  release: {
    title: 'Release the kept environment now', // 立即释放保留的环境
    body: 'Release the kept environment now (this can’t be undone). Once reclaiming starts, you can’t start a new lab until it finishes.', // 立即释放保留的环境（不可撤销）。释放进入回收后，完成前不能开始新的实验。
    confirm: 'Release now', // 立即释放
    busy: 'Releasing…', // 正在释放…
    started: 'The previous environment is being released; you can start once it finishes.', // 上一个环境正在释放，释放完成后才能开始。
    viewProgress: 'View reclaim progress', // 查看回收进度
    inProgress: 'This environment is being taken over by a new session and can’t be released right now.', // 该环境正在被新会话接管，不能立即释放。
  },
  quoteOnly: {
    title: 'Current price (view only, nothing starts): {id}', // 当前价格（只显示，不开始）：{id}
    lead: 'Estimate · unit prices from the Price List · AWS’s official pricing and your bill take precedence. This only calculates; no resources are created.', // 估算 · 单价取自 Price List · 以 AWS 官方定价与账单为准。这里只计算，不会创建任何资源。
    close: 'Close', // 关闭
  },
  quote: {
    start: 'Start state per hour', // 起始状态每小时
    startDefault: 'L0 lab instance, EBS, public IPv4 · IAM role', // L0 实验机、EBS、公网 IPv4 · IAM 角色
    reuseSuffix: ' (reused: already in the environment)', // （复用：已在环境中）
    completed: 'When done per hour', // 完成后每小时
    targetDefault: 'This card’s target resources', // 本卡片的目标资源
    usage: 'Usage-based', // 按量计费
    usageTail: ': learning traffic is usually tiny and may fall within the Free Tier; see the official pricing', // ：学习流量通常很小，可能在免费额度内，以官方为准
    monthly: 'Monthly, prorated', // 按月折算
    workstation: 'Workbench', // 工作台
    workstationDesc: 'Workbench EC2, public IPv4, EBS (platform overhead)', // 工作台 EC2、公网 IPv4、EBS（平台开销）
    workstationSaving: 'Saving mode: the workbench isn’t started (CloudShell has no extra charge; see the official pricing)', // 省钱模式：不启动工作台（CloudShell 不另收费，以官方为准）
    build: 'Build (per session)', // 构建（每次会话）
    buildDesc: 'CodeBuild build minutes: one runner at start and one at end (historical median; without history, a range by provisioning class)', // CodeBuild 构建分钟：开始、结束各一次运行器（历史中位数；没有历史时按部署等级给范围）
    orchestration: 'Orchestration and logs', // 编排与日志
    orchestrationDesc: 'Step Functions, Lambda, CloudWatch Logs ingestion: usually tiny', // Step Functions、Lambda、CloudWatch Logs 摄入：通常很小
    deploy: 'While deploying', // 部署期间
    deployDesc: 'Billing starts when environment creation starts; the countdown starts at “ready”', // 环境创建开始即计费，倒计时从“就绪”开始
    max: 'Maximum for this session', // 本次会话最多
    maxDesc: 'Includes {n, plural, one {# extension} other {# extensions}} ({total} in total), deploy and reclaim time, and one build', // 含 {n} 次延长（共 {total}）、部署与回收期间，以及一次构建开销
    perHour: ' /hour', //  /小时
    perRun: ' /run', //  /次
    noEstimate: 'Not estimated', // 不估金额
    notProvided: 'Not provided', // 未提供
    unknown: 'Unknown', // 未知
    refStart: 'Start state (L0 lab instance, EBS, public IPv4, and modules turned on in advance)', // 起始状态（L0 实验机、EBS、公网 IPv4 与预先启用的模块）
    refWorkstation: 'Workbench', // 工作台
    refTarget: 'This card’s target modules', // 本卡片的目标模块
    refExtra: 'Card-specific stack', // 卡片自带栈
    refModule: 'Enabled modules', // 已启用的模块
    unknownMark: ' (unit price unavailable)', // （单价暂不可得）
    fixture: 'Development mode: amounts come from local sample prices, not AWS prices, and are only for checking the screen.', // 开发模式：金额来自本地示例单价，不是 AWS 价格，只用于检查界面。
  },
  inputs: {
    required: 'Required', // 必填
    domain: 'Enter a lowercase domain, for example lab.example.com (each label 1–63 letters, digits, or -; at least two labels; no IP addresses or wildcards)', // 请填写小写域名，例如 lab.example.com（每段 1～63 个字母、数字或 -，至少两段，不接受 IP 与通配符）
    hostedZone: 'A hosted zone ID looks like Z0123456789ABC', // 托管区域 ID 形如 Z0123456789ABC
    sesIdentity: 'Enter an email address or a domain', // 请填写邮箱或域名
    email: 'Enter a valid email address', // 请填写有效的邮箱地址
    recipients: 'Enter 1–2 email addresses, separated by commas', // 请填写 1～2 个邮箱，用逗号分隔
    budget: 'Enter two positive numbers with up to two decimals, separated by a comma', // 请填写两个正数，最多两位小数，用逗号分隔
    costTags: 'Run the platform action first, then check this', // 请先执行平台动作并勾选
  },
  visual: {
    archTitle: 'At start → When done', // 开始时 → 完成后
    archAria: 'Architecture of {id}', // {id} 的架构图
    compareTitle: 'With vs without', // 有 vs 没有
    without: 'Without {name}', // 没有 {name}
    with: 'With {name}', // 有 {name}
    none: '(none)', // （没有）
    local: 'Local implementation', // 本地实现
    driver: 'driver {driver}', // 驱动 {driver}
    notYet: 'Not there at start', // 开始时还没有
    costMore: 'About the cost', // 费用说明
    confusable: '{label}: {a} / {b}: {rule}', // {label}：{a} / {b}：{rule}
  },
  quiz: {
    title: '{id} quiz', // {id} 小测
    sub: '{n} questions · no time limit · the quiz doesn’t use the lab environment', // {n} 题 · 不限时 · 小测不依赖实验环境
    subTimed: '{n} questions · submit by {at} · the quiz doesn’t use the lab environment', // {n} 题 · {at} 前交卷 · 小测不依赖实验环境
    exit: 'Leave quiz', // 退出小测
    progress: 'Question {i} of {n} · {domain} · {type}', // 第 {i} / {n} 题 · {domain} · {type}
    single: 'Single choice', // 单选
    multiple: 'Multiple choice', // 多选
    prev: 'Previous', // 上一题
    next: 'Next', // 下一题
    saved: 'Answers saved automatically', // 作答已自动保存
    saving: 'Saving…', // 正在保存…
    unsaved: 'Answers not saved', // 作答未保存
    retrySave: 'Retry', // 重试
    footer: 'After you submit you see your score and explanations. Quiz scores are only recorded on the badge and don’t affect card completion.', // 提交后显示正确率与解析。小测成绩只记录在徽章上，不影响卡片完成。
    submit: 'Submit', // 交卷
    submitting: 'Submitting…', // 正在交卷…
    unanswered: '{n, plural, one {# question unanswered} other {# questions unanswered}}', // 还有 {n} 题没有作答
    starting: 'Drawing questions…', // 正在抽题…
    noQuiz: 'This card has no quiz yet.', // 这张卡片暂时没有小测。
    exhausted: 'You’ve used all of today’s attempts.', // 今天的作答次数已用完。
    expiredAttempt: 'This attempt has ended; please start again.', // 这次作答已经结束，请重新开始。
    back: 'Back to the overview', // 返回简介页
    resultTitle: 'Quiz result: {pct} correct ({c} / {n})', // 小测结果：正确率 {pct}（{c} / {n}）
    recorded: 'The result is recorded on the badge.', // 结果已记录在徽章上。
    notYet: 'Once you complete the card, the score is recorded on the badge.', // 完成卡片后，成绩会记在徽章上。
    onlyRecord: ' Quiz scores are only recorded and don’t affect card completion.', // 小测成绩只记录，不影响卡片完成。
    domain: 'Domain', // 领域
    rate: 'Correct', // 正确率
    qNo: 'Question {i}', // 第 {i} 题
    correct: 'Correct', // 正确
    wrong: 'Incorrect', // 错误
    answer: 'Correct answer: {list}.', // 正确答案：{list}。
    yours: 'Your answer: {list}.', // 你的答案：{list}。
    revisit: 'Revisit step: {step}', // 回看步骤：{step}
    again: 'Try again', // 再做一次
  },
} satisfies Dict<typeof zh>;
