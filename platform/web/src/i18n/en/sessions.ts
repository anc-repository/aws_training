/**
 * en（English）：命名空间 sessions。由 `npm run i18n:sync` 按 zh-CN 词典维护结构：
 * 只填写引号内的译文（空字符串 = 未翻译，运行时按 en → en → zh-CN 回退）；行尾注释是 zh-CN 原文。
 * 术语与风格见 ../glossary.md（不翻译 AWS 服务名、CLI 命令、代码、资源名、API 路径、环境变量）。
 */
import type { Dict } from '../dict';
import type zh from '../zh-CN/sessions';

export default {
  events: {
    category: {
      state: 'State, extensions and keep', // 状态、延长与保留
      phase: 'Stages and progress', // 阶段与进度
      ops: 'Platform actions', // 平台动作
      workspace: 'Terminal and console', // 终端与控制台
      checks: 'Checks, submissions and results', // 检测、提交与成果
      reclaim: 'Reclaim', // 回收
      env: 'Environment and budget', // 环境与预算
      other: 'Other', // 其他
    },
    phase: {
      'start.validate': 'Validate', // 校验
      'start.lock': 'Reserve environment', // 占用环境
      'start.preflight': 'Preflight', // 预检
      'provision.base': 'Base environment', // 基础环境
      'provision.resume': 'Resume kept environment', // 恢复保留的环境
      'provision.workstation': 'Workbench', // 工作台
      'provision.profile': 'Start state', // 起始状态
      'provision.extra-stack': 'Extra stack', // 附加栈
      'provision.ssm': 'Connect', // 连接
      'provision.wire': 'Wire up', // 接入
      'provision.health': 'Health check', // 健康检查
      'provision.ready': 'Ready', // 就绪
      'end.stop-start': 'Stop the start flow', // 停止开始流程
      'end.disarm': 'Stop the countdown', // 停止倒计时
      'end.revoke': 'Revoke access', // 收回访问
      'end.finalize': 'Final check', // 最终复核
      'end.seal': 'Report snapshot', // 报告快照
      'end.workstation-down': 'Delete the workbench', // 删除工作台
      'end.suspend': 'Enter saving mode', // 进入节省模式
      'clean.destroy': 'Tear down the environment stack', // 拆除环境栈
      'clean.reclaim': 'Reclaim', // 回收
      'clean.verify': 'Verify', // 校验
      'clean.conclude': 'Conclusion', // 结论
    },
    phaseStatus: {
      QUEUED: 'Queued', // 排队中
      RUNNING: 'In progress', // 进行中
      RETRYING: 'Retrying', // 重试中
      DONE: 'Done', // 完成
      FAILED: 'Failed', // 失败
      SKIPPED: 'Skipped', // 跳过
    },
    passMode: {
      PRIMARY: 'Primary reclaim', // 主回收
      RESCAN: 'Rescan', // 复扫
      RETRY: 'Retry', // 重试
      UNINSTALL: 'Uninstall', // 卸载
    },
    resource: 'Resource', // 资源
    paren: ' ({text})', // （{text}）
    sep: ', ', // ，
    detailTail: ' · {detail}', //  · {detail}
    requested: 'Accepted', // 已受理
    requestedQuote: 'quote {id}…', // 报价 {id}…
    requestedProfile: 'start profile {name}', // 起始档位 {name}
    phaseLine: 'Stage {phase}: {status}', // 阶段 {phase}：{status}
    phaseOther: 'Other', // 其他
    phaseUpdate: 'Update', // 更新
    progressMsg: 'Progress: {text}', // 进度：{text}
    progressModule: 'Progress: module {module}', // 进度：模块 {module}
    progressModuleStatus: 'Progress: module {module} {status}', // 进度：模块 {module} {status}
    progressUpdate: 'Progress update', // 进度更新
    expiryWarning: 'Expiry reminder', // 到期提醒
    expiryWarningMin: 'Expiry reminder: {n} min left', // 到期提醒：剩余 {n} 分钟
    extended: 'Extended by {n} min', // 延长 {n} 分钟
    extendedTo: 'Extended by {n} min (until {t})', // 延长 {n} 分钟（到 {t}）
    endRequested: 'End requested ({reason})', // 请求结束（{reason}）
    accessRevoked: 'Access revoked: terminal disconnected, console and workbench credentials revoked', // 收回访问：终端断开，控制台与工作台凭证吊销
    keepStarted: 'Keep started', // 开始保留环境
    keepStartedUntil: 'Keep started (until {t})', // 开始保留环境（至 {t}）
    keepExtended: 'Keep extended', // 延长保留
    keepExtendedUntil: 'Keep extended (until {t})', // 延长保留（至 {t}）
    keepExpiryWarning: 'The kept environment will be released soon', // 保留的环境即将自动释放
    handedOver: 'Environment handed over to a new session', // 环境已交接给新的会话
    outageOpen: 'Expected outage window opened (until {t})', // 预期中断窗口打开（至 {t}）
    outageClosed: 'Expected outage window closed', // 预期中断窗口结束
    envDegraded: 'Environment degraded', // 环境异常
    envDegradedDetail: 'Environment degraded: {detail}', // 环境异常：{detail}
    envRecovered: 'Environment recovered', // 环境已恢复
    budgetState: 'Budget state: {state}', // 预算状态：{state}
    update: 'Update', // 更新
    opStarted: 'started', // 开始
    opSucceeded: 'succeeded', // 成功
    opFailed: 'failed', // 失败
    op: 'Platform action: {verb}', // 平台动作：{verb}
    opWhat: 'Platform action {what}: {verb}', // 平台动作 {what}：{verb}
    passStarted: 'Reclaim pass {n} started ({mode})', // 回收第 {n} 轮开始（{mode}）
    passDefault: 'Reclaim', // 回收
    passCompleted: 'Reclaim pass {n} done: {deleted} deleted', // 回收第 {n} 轮完成：删除 {deleted} 项
    passCompletedManual: 'Reclaim pass {n} done: {deleted} deleted, {manual} need you', // 回收第 {n} 轮完成：删除 {deleted} 项，需人工 {manual} 项
    itemDeleted: 'Deleted {res}', // 已删除 {res}
    itemManual: 'Needs you: {res}', // 需人工处理：{res}
    discovered: 'Discovered {res}', // 发现资源 {res}
    cleanupCompleted: 'Reclaim complete', // 回收完成
    cleanupFailed: 'Cleanup incomplete: some resources could not be deleted automatically', // 释放未完成：有资源没能自动删除
    accessFinding: 'External access analysis: a publicly accessible resource was found', // 外部访问分析：发现对外开放的资源
    checkPass: '{n} passed', // {n} 项通过
    checkFail: '{n} failed', // {n} 项未通过
    checkDone: 'Checks done', // 检测完成
    checkDoneStep: 'Checks done (step {step})', // 检测完成（步骤 {step}）
    checkParts: ': {parts}', // ：{parts}
    stepState: 'Step {step}: {state}', // 步骤 {step}：{state}
    stateChanged: 'State changed', // 状态变化
    stepDrifted: 'Step {step} drifted', // 步骤 {step} 漂移
    attemptState: 'Attempt: {state}', // 尝试：{state}
    manualSubmitted: 'Manual confirmation submitted', // 提交手动确认
    manualReviewed: 'Assistant review: {decision}', // 助教复核：{decision}
    rejected: 'rejected', // 打回
    approved: 'approved', // 通过
    expRecorded: 'Experiment run uploaded: {name}', // 实验运行已上传：{name}
    expValidated: 'Experiment validated: {name}', // 实验校验：{name}
    label: ' ({label})', // （{label}）
    quizGraded: 'Quiz graded (recorded only)', // 小测已判分（只记录）
    badgeEarned: 'Badge earned', // 获得徽章
    badgeEarnedLevel: 'Badge earned ({level})', // 获得徽章（{level}）
    badgeWithdrawn: 'Badge withdrawn', // 徽章被撤回
    masteryRegression: 'Service mastery: review needed', // 服务掌握度：需要复习
    trackCompleted: 'Learning path certificate requirements met', // 学习路径的证书条件已满足
    reportGenerated: 'Report revision {n} generated', // 报告第 {n} 版已生成
    certIssued: 'Certificate issued', // 签发证书
    certRevoked: 'Certificate revoked', // 证书已吊销
    terminalOpened: 'Terminal opened', // 打开终端
    terminalOpenedLab: 'Terminal opened (lab instance)', // 打开终端（实验机）
    terminalOpenedWs: 'Terminal opened (workbench)', // 打开终端（工作台）
    terminalClosed: 'Terminal closed', // 终端关闭
    consoleIssued: 'Console sign-in issued', // 签发控制台登录
    workspaceOp: 'Workbench action', // 工作台操作
    platformRecord: 'Platform record', // 平台记录
  },
  values: {
    endReason: {
      USER_ENDED: 'Ended by you', // 你结束的
      EXPIRED: 'Expired', // 到期
      IDLE_NOT_STARTED: 'Never opened after ready', // 就绪后未进入
      CANCELLED: 'Cancelled by you', // 你取消的
      PROVISION_FAILED: 'Provisioning failed', // 部署失败
      PROVISION_TIMEOUT: 'Provisioning timed out', // 部署超时
      BUDGET_ENFORCED: 'Budget enforced', // 预算强制
      ADMIN_ENDED: 'Ended by an admin', // 管理员结束
      KEEP_EXPIRED: 'Keep expired', // 保留到期
      KEEP_RELEASED: 'Released by you', // 你释放的
      PLATFORM_UNINSTALL: 'Platform uninstall', // 平台卸载
      CLEANUP_RETRY: 'Reclaim retry', // 回收重试
      HANDED_OVER: 'Environment handed over', // 环境已交接
    },
    other: 'Other', // 其他
    discoveredBy: {
      STACK: 'Stack', // 栈
      RETAINED: 'Retained', // 保留
      OUT_OF_BAND: 'Out of band', // 带外
      CLOUDTRAIL: 'CloudTrail (you created it in the console or CLI)', // CloudTrail（你在控制台或 CLI 创建）
      DERIVED: 'Derived', // 派生
      REALTIME: 'Real time', // 实时
      OWNERSHIP_LOOKUP: 'Targeted scan', // 定向扫描
      TAG: 'Tag (found by tag only)', // 标签（仅凭标签发现）
      INVENTORY: 'Inventory', // 清点
    },
    stage: {
      S0: 'S0 Entry points and triggers', // S0 入口与触发
      S1: 'S1 Compute', // S1 计算
      S2: 'S2 Data and managed services', // S2 数据与托管服务
      S3: 'S3 Network', // S3 网络
      S4: 'S4 Images and volumes', // S4 镜像与卷
      S5: 'S5 Identity and keys', // S5 身份与密钥
      S6: 'S6 Reset and environment state', // S6 复位与环境状态
      other: 'Other', // 其他
    },
    reportCleanup: {
      pending: 'Reclaiming; a revision is added to the report when done', // 回收进行中，完成后报告会追加修订
      clean: 'Released', // 已释放
      'needs-review': 'Needs review', // 需复核
      'cleanup-failed': 'Cleanup incomplete', // 释放未完成
      kept: 'Environment kept', // 环境保留中
    },
    badgeLevel: {
      verified: 'Verified', // 已核验
      attested: 'Includes manual', // 含手动
      'self-reported': 'Mostly self-reported', // 自述为主
    },
    badgeStatus: {
      valid: 'Valid', // 有效
      pending: 'Verifying', // 核验中
      withdrawn: 'Withdrawn', // 已撤回
    },
    validityReason: {
      OUT_OF_WINDOW: 'Outside the registered time window', // 不在登记的时间窗内
      DRIVER_MISMATCH: 'The runtime driver does not match this variant', // 运行时驱动与该变体要求不符
      NOT_CORROBORATED: 'The server did not see enough requests', // 服务端没有看到足够的请求
      PATH_RATIO: 'Path share too low', // 路径占比不足
      TOO_FEW_SAMPLES: 'Too few samples', // 样本不足
      OUTPUT_TRUNCATED: 'Output truncated', // 输出被截断
      DELIVERY_MISMATCH: 'Delivery does not match the registration', // 交付方式与登记不符
    },
    withDetail: '{text} ({detail})', // {text}（{detail}）
    compareReason: {
      DIFFERENT_EXPERIMENT: 'Not the same experiment', // 不是同一个实验
      DIFFERENT_SCENARIO: 'Different scenario', // 场景不一致
      DIFFERENT_CARD_VARIANT: 'Different start variant', // 起始变体不一致
      DIFFERENT_INSTANCE_TYPE: 'Different instance type', // 实例类型不一致
      FORCED: 'A forced run was used', // 使用了强制运行
    },
    moneyRange: '≈ {low}–{high} {currency}{unit}', // ≈ {low}～{high} {currency}{unit}
    money: '≈ {amount} {currency}{unit}', // ≈ {amount} {currency}{unit}
  },
  list: {
    range: {
      '7': 'Last 7 days', // 最近 7 天
      '30': 'Last 30 days', // 最近 30 天
      '90': 'Last 90 days', // 最近 90 天
      all: 'All', // 全部
    },
    cleanupFailed: 'Cleanup incomplete', // 释放未完成
    pendingItems: '{n} pending', // {n} 项待处理
    inProgress: 'In progress', // 进行中
    kept: 'Kept', // 保留中
    released: 'Released', // 已释放
    colStarted: 'Started', // 开始时间
    colCard: 'Card', // 卡片
    colState: 'State', // 状态
    colEndReason: 'End reason', // 结束原因
    colAttempt: 'Attempt result', // 尝试结果
    seeDetail: '(see session details)', // （在会话详情中查看）
    colDuration: 'Duration', // 用时
    colCost: 'Estimated cost', // 估算费用
    colCleanup: 'Cleanup', // 清理
    title: 'My labs', // 我的实验
    readOnlySub: 'The learner’s lab history (read-only)', // 学员的实验记录（只读）
    refresh: 'Refresh', // 刷新
    overview: 'Overview (last 30 days)', // 概览（最近 30 天）
    overviewLine: '{n} sessions · {ended} ended · total lab time {total} · estimated cost: see each session’s details', // 会话 {n} · 已结束 {ended} · 实验时长合计 {total} · 估算费用：在各会话详情中查看
    manualPending: '{n} need you', // 待人工处理 {n} 项
    manualHourly: ' ({n} billed hourly)', // （{n} 项按小时计费）
    view: 'View', // 查看
    keptEnv: ' · kept environment: {v}', //  · 保留中的环境：{v}
    yes: 'yes', // 有
    no: 'no', // 无
    filters: 'Filters', // 筛选
    state: 'State', // 状态
    all: 'All', // 全部
    card: 'Card', // 卡片
    time: 'Period', // 时间
    loading: 'Loading lab history', // 正在读取实验记录
    emptyTitle: 'No labs yet.', // 还没有实验记录。
    toCatalog: 'Start your first card from the catalog →', // 去卡片目录开始第一张 →
    noMatch: 'No sessions match the filters.', // 没有符合条件的会话。
    clearFilters: 'Clear filters', // 清除筛选
    olderNotLoaded: 'Older records are not loaded yet; load more to see them.', // 较早的记录还没有加载，可以先加载更多。
    caption: 'My lab sessions', // 我的实验会话
    loadingMore: 'Loading…', // 正在加载…
    loadMore: 'Load more', // 加载更多
    loadFailed: 'Loading failed ·', // 加载失败 ·
    retry: 'Retry', // 重试
    footnote: 'A session that just ended can take a few seconds to appear; press Refresh. Rows are focusable; press Enter to open the session details.', // 刚结束的会话可能晚几秒出现在列表中，可以点“刷新”。行可聚焦，按 Enter 打开会话详情。
  },
  detail: {
    tab: {
      timeline: 'Timeline', // 时间线
      resources: 'Resources', // 资源
      cost: 'Cost', // 费用
      ops: 'Platform actions', // 平台动作
      audit: 'Audit', // 审计
    },
    noSession: 'Session not found', // 没有这个会话
    title: 'Session details', // 会话详情
    reading: 'Loading the session', // 正在读取会话
    crumbs: 'Breadcrumb', // 面包屑
    mySessions: 'My labs', // 我的实验
    heading: '{labId} · session {sid}', // {labId} · 会话 {sid}
    inProgress: 'in progress', // 进行中
    env: ' · environment {name}', //  · 环境 {name}
    backToWorkspace: 'Back to workbench', // 回到工作台
    manageKeep: 'Manage keep', // 管理保留
    viewReclaim: 'View reclaim progress', // 查看回收进度
    report: 'Report', // 报告
    reclaim: 'Reclaim', // 回收
    tabs: 'Tabs', // 页签
    deniedTail: 'This tab is only for the learner and assistants.', // 这个页签只对学员与助教开放。
    readingTimeline: 'Loading the timeline', // 正在读取时间线
    timeline: 'Timeline', // 时间线
    sumRequested: 'Accepted', // 已受理
    sumReady: 'Environment ready', // 环境已就绪
    sumRevoked: 'Access revoked', // 收回访问
    sumEnded: 'Ended ({reason})', // 结束（{reason}）
    filterByCategory: 'Filter by category', // 按类别筛选
    allCategories: 'All categories', // 全部类别
    truncated: 'Older events were cleared per the retention period; only the summary is shown.', // 较早的事件已按保留期清理，只显示摘要。
    summary: 'Summary', // 摘要
    noEventsInCategory: 'No events in this category.', // 这个类别没有事件。
    noEvents: 'No events yet.', // 还没有事件。
    cleanupState: 'Cleanup state', // 清理状态
    all: 'All', // 全部
    resources: 'Resources', // 资源
    resourcesHeading: 'Resources created by this session ({n})', // 本会话创建的资源（{n} 项）
    resourcesNote: 'Only resources created by this session are listed; in a reused environment, resources created by other sessions in the hand-over chain are shown in those sessions.', // 这里只列出本会话创建的资源；复用环境中由交接链里其他会话创建的资源在各自的会话中查看。
    perHour: '/hour', // /小时
    costNote: 'Current or final billing (estimate · unit prices from the Price List{asOf} · your AWS bill is authoritative)', // 当前或最终的计费（估算 · 单价取自 Price List{asOf} · 以 AWS 账单为准）
    priceAsOf: ', as of {t}', // ，取价时间 {t}
    colService: 'Service', // 服务
    colDimension: 'Billing dimension', // 计费维度
    colDetail: 'Details', // 详情
    noDimensions: 'The quote before start recorded no billing dimensions.', // 开始前的报价没有记录计费维度。
    startEstimate: 'Estimate before start', // 开始前估算
    unknownPrice: 'Unknown (unit price unavailable)', // 未知（单价暂不可得）
    quoteRef: ' · quote {id}', //  · 报价 {id}
    thisSession: 'This session', // 本次会话
    recomputed: '{est} (recalculated by actual duration, estimate)', // {est}（按实际时长重算，估算）
    unknownBill: '≈ unknown (unit price unavailable; check your bill)', // ≈ 未知（单价暂不可得，以账单为准）
    unestimated: ' · + {n} manually created resources not estimated', //  · + 未估算的手工资源 {n} 项
    extensions: 'Extensions', // 延长
    extensionLine: 'Extended by {n} min', // 延长 {n} 分钟
    extensionQuote: ' (quote {id}…)', // （报价 {id}…）
    cost: 'Cost', // 费用
    billable: 'Billed resources', // 计费资源
    since: ' · since {t}', //  · 自 {t}
    billNote: 'To see the actual bill: after you activate the cost allocation tags, AWS Cost Explorer can show costs by atl:session-id (data usually lags by about a day).', // 想看实际账单：激活成本分配标签后，可在 AWS Cost Explorer 中按 atl:session-id 查看（数据通常有一天左右的延迟）。
    source: {
      platform: 'Platform', // 平台
      agent: 'Workbench', // 工作台
      runner: 'Runner', // 运行器
    },
    ops: 'Platform actions', // 平台动作
    noOps: 'This session has no platform or module actions.', // 这次会话没有平台动作或模块操作。
    colTime: 'Time', // 时间
    colSource: 'Source', // 来源
    colOp: 'Action', // 操作
    colModule: 'Module', // 模块
    colResult: 'Result', // 结果
    colRunId: 'Run ID', // 运行 ID
    opRunning: 'Running', // 进行中
    opOk: 'Succeeded', // 成功
    opFailed: 'Failed (exit code {code})', // 失败（退出码 {code}）
    result: {
      ok: 'Succeeded', // 成功
      success: 'Succeeded', // 成功
      denied: 'Denied', // 被拒绝
      error: 'Error', // 出错
    },
    platform: 'Platform', // 平台
    actorRole: '{name} ({role})', // {name}（{role}）
    audit: 'Audit', // 审计
    noAudit: 'This session has no audit events.', // 这次会话没有审计事件。
    colActor: 'Actor', // 操作者
    colAction: 'Action', // 动作
    colTarget: 'Target', // 对象
  },
  visual: {
    sessions: 'Sessions', // 会话
    ended: 'Ended', // 已结束
    total: 'Lab time', // 实验时长
    manual: 'Need you', // 待人工处理
    kept: 'Kept environment', // 保留中的环境
  },
} satisfies Dict<typeof zh>;
