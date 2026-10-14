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
      state: '', // 状态、延长与保留
      phase: '', // 阶段与进度
      ops: '', // 平台动作
      workspace: '', // 终端与控制台
      checks: '', // 检测、提交与成果
      reclaim: '', // 回收
      env: '', // 环境与预算
      other: '', // 其他
    },
    phase: {
      'start.validate': '', // 校验
      'start.lock': '', // 占用环境
      'start.preflight': '', // 预检
      'provision.base': '', // 基础环境
      'provision.resume': '', // 恢复保留的环境
      'provision.workstation': '', // 工作台
      'provision.profile': '', // 起始状态
      'provision.extra-stack': '', // 附加栈
      'provision.ssm': '', // 连接
      'provision.wire': '', // 接入
      'provision.health': '', // 健康检查
      'provision.ready': '', // 就绪
      'end.stop-start': '', // 停止开始流程
      'end.disarm': '', // 停止倒计时
      'end.revoke': '', // 收回访问
      'end.finalize': '', // 最终复核
      'end.seal': '', // 报告快照
      'end.workstation-down': '', // 删除工作台
      'end.suspend': '', // 进入节省模式
      'clean.destroy': '', // 拆除环境栈
      'clean.reclaim': '', // 回收
      'clean.verify': '', // 校验
      'clean.conclude': '', // 结论
    },
    phaseStatus: {
      QUEUED: '', // 排队中
      RUNNING: '', // 进行中
      RETRYING: '', // 重试中
      DONE: '', // 完成
      FAILED: '', // 失败
      SKIPPED: '', // 跳过
    },
    passMode: {
      PRIMARY: '', // 主回收
      RESCAN: '', // 复扫
      RETRY: '', // 重试
      UNINSTALL: '', // 卸载
    },
    resource: '', // 资源
    paren: '', // （{text}）
    sep: '', // ，
    detailTail: '', //  · {detail}
    requested: '', // 已受理
    requestedQuote: '', // 报价 {id}…
    requestedProfile: '', // 起始档位 {name}
    phaseLine: '', // 阶段 {phase}：{status}
    phaseOther: '', // 其他
    phaseUpdate: '', // 更新
    progressMsg: '', // 进度：{text}
    progressModule: '', // 进度：模块 {module}
    progressModuleStatus: '', // 进度：模块 {module} {status}
    progressUpdate: '', // 进度更新
    expiryWarning: '', // 到期提醒
    expiryWarningMin: '', // 到期提醒：剩余 {n} 分钟
    extended: '', // 延长 {n} 分钟
    extendedTo: '', // 延长 {n} 分钟（到 {t}）
    endRequested: '', // 请求结束（{reason}）
    accessRevoked: '', // 收回访问：终端断开，控制台与工作台凭证吊销
    keepStarted: '', // 开始保留环境
    keepStartedUntil: '', // 开始保留环境（至 {t}）
    keepExtended: '', // 延长保留
    keepExtendedUntil: '', // 延长保留（至 {t}）
    keepExpiryWarning: '', // 保留的环境即将自动释放
    handedOver: '', // 环境已交接给新的会话
    outageOpen: '', // 预期中断窗口打开（至 {t}）
    outageClosed: '', // 预期中断窗口结束
    envDegraded: '', // 环境异常
    envDegradedDetail: '', // 环境异常：{detail}
    envRecovered: '', // 环境已恢复
    budgetState: '', // 预算状态：{state}
    update: '', // 更新
    opStarted: '', // 开始
    opSucceeded: '', // 成功
    opFailed: '', // 失败
    op: '', // 平台动作：{verb}
    opWhat: '', // 平台动作 {what}：{verb}
    passStarted: '', // 回收第 {n} 轮开始（{mode}）
    passDefault: '', // 回收
    passCompleted: '', // 回收第 {n} 轮完成：删除 {deleted} 项
    passCompletedManual: '', // 回收第 {n} 轮完成：删除 {deleted} 项，需人工 {manual} 项
    itemDeleted: '', // 已删除 {res}
    itemManual: '', // 需人工处理：{res}
    discovered: '', // 发现资源 {res}
    cleanupCompleted: '', // 回收完成
    cleanupFailed: '', // 释放未完成：有资源没能自动删除
    accessFinding: '', // 外部访问分析：发现对外开放的资源
    checkPass: '', // {n} 项通过
    checkFail: '', // {n} 项未通过
    checkDone: '', // 检测完成
    checkDoneStep: '', // 检测完成（步骤 {step}）
    checkParts: '', // ：{parts}
    stepState: '', // 步骤 {step}：{state}
    stateChanged: '', // 状态变化
    stepDrifted: '', // 步骤 {step} 漂移
    attemptState: '', // 尝试：{state}
    manualSubmitted: '', // 提交手动确认
    manualReviewed: '', // 助教复核：{decision}
    rejected: '', // 打回
    approved: '', // 通过
    expRecorded: '', // 实验运行已上传：{name}
    expValidated: '', // 实验校验：{name}
    label: '', // （{label}）
    quizGraded: '', // 小测已判分（只记录）
    badgeEarned: '', // 获得徽章
    badgeEarnedLevel: '', // 获得徽章（{level}）
    badgeWithdrawn: '', // 徽章被撤回
    masteryRegression: '', // 服务掌握度：需要复习
    trackCompleted: '', // 学习路径的证书条件已满足
    reportGenerated: '', // 报告第 {n} 版已生成
    certIssued: '', // 签发证书
    certRevoked: '', // 证书已吊销
    terminalOpened: '', // 打开终端
    terminalOpenedLab: '', // 打开终端（实验机）
    terminalOpenedWs: '', // 打开终端（工作台）
    terminalClosed: '', // 终端关闭
    consoleIssued: '', // 签发控制台登录
    workspaceOp: '', // 工作台操作
    platformRecord: '', // 平台记录
  },
  values: {
    endReason: {
      USER_ENDED: '', // 你结束的
      EXPIRED: '', // 到期
      IDLE_NOT_STARTED: '', // 就绪后未进入
      CANCELLED: '', // 你取消的
      PROVISION_FAILED: '', // 部署失败
      PROVISION_TIMEOUT: '', // 部署超时
      BUDGET_ENFORCED: '', // 预算强制
      ADMIN_ENDED: '', // 管理员结束
      KEEP_EXPIRED: '', // 保留到期
      KEEP_RELEASED: '', // 你释放的
      PLATFORM_UNINSTALL: '', // 平台卸载
      CLEANUP_RETRY: '', // 回收重试
      HANDED_OVER: '', // 环境已交接
    },
    other: '', // 其他
    discoveredBy: {
      STACK: '', // 栈
      RETAINED: '', // 保留
      OUT_OF_BAND: '', // 带外
      CLOUDTRAIL: '', // CloudTrail（你在控制台或 CLI 创建）
      DERIVED: '', // 派生
      REALTIME: '', // 实时
      OWNERSHIP_LOOKUP: '', // 定向扫描
      TAG: '', // 标签（仅凭标签发现）
      INVENTORY: '', // 清点
    },
    stage: {
      S0: '', // S0 入口与触发
      S1: '', // S1 计算
      S2: '', // S2 数据与托管服务
      S3: '', // S3 网络
      S4: '', // S4 镜像与卷
      S5: '', // S5 身份与密钥
      S6: '', // S6 复位与环境状态
      other: '', // 其他
    },
    reportCleanup: {
      pending: '', // 回收进行中，完成后报告会追加修订
      clean: '', // 已释放
      'needs-review': '', // 需复核
      'cleanup-failed': '', // 释放未完成
      kept: '', // 环境保留中
    },
    badgeLevel: {
      verified: '', // 已核验
      attested: '', // 含手动
      'self-reported': '', // 自述为主
    },
    badgeStatus: {
      valid: '', // 有效
      pending: '', // 核验中
      withdrawn: '', // 已撤回
    },
    validityReason: {
      OUT_OF_WINDOW: '', // 不在登记的时间窗内
      DRIVER_MISMATCH: '', // 运行时驱动与该变体要求不符
      NOT_CORROBORATED: '', // 服务端没有看到足够的请求
      PATH_RATIO: '', // 路径占比不足
      TOO_FEW_SAMPLES: '', // 样本不足
      OUTPUT_TRUNCATED: '', // 输出被截断
      DELIVERY_MISMATCH: '', // 交付方式与登记不符
    },
    withDetail: '', // {text}（{detail}）
    compareReason: {
      DIFFERENT_EXPERIMENT: '', // 不是同一个实验
      DIFFERENT_SCENARIO: '', // 场景不一致
      DIFFERENT_CARD_VARIANT: '', // 起始变体不一致
      DIFFERENT_INSTANCE_TYPE: '', // 实例类型不一致
      FORCED: '', // 使用了强制运行
    },
    moneyRange: '', // ≈ {low}～{high} {currency}{unit}
    money: '', // ≈ {amount} {currency}{unit}
  },
  list: {
    range: {
      '7': '', // 最近 7 天
      '30': '', // 最近 30 天
      '90': '', // 最近 90 天
      all: '', // 全部
    },
    cleanupFailed: '', // 释放未完成
    pendingItems: '', // {n} 项待处理
    inProgress: '', // 进行中
    kept: '', // 保留中
    released: '', // 已释放
    colStarted: '', // 开始时间
    colCard: '', // 卡片
    colState: '', // 状态
    colEndReason: '', // 结束原因
    colAttempt: '', // 尝试结果
    seeDetail: '', // （在会话详情中查看）
    colDuration: '', // 用时
    colCost: '', // 估算费用
    colCleanup: '', // 清理
    title: '', // 我的实验
    readOnlySub: '', // 学员的实验记录（只读）
    refresh: '', // 刷新
    overview: '', // 概览（最近 30 天）
    overviewLine: '', // 会话 {n} · 已结束 {ended} · 实验时长合计 {total} · 估算费用：在各会话详情中查看
    manualPending: '', // 待人工处理 {n} 项
    manualHourly: '', // （{n} 项按小时计费）
    view: '', // 查看
    keptEnv: '', //  · 保留中的环境：{v}
    yes: '', // 有
    no: '', // 无
    filters: '', // 筛选
    state: '', // 状态
    all: '', // 全部
    card: '', // 卡片
    time: '', // 时间
    loading: '', // 正在读取实验记录
    emptyTitle: '', // 还没有实验记录。
    toCatalog: '', // 去卡片目录开始第一张 →
    noMatch: '', // 没有符合条件的会话。
    clearFilters: '', // 清除筛选
    olderNotLoaded: '', // 较早的记录还没有加载，可以先加载更多。
    caption: '', // 我的实验会话
    loadingMore: '', // 正在加载…
    loadMore: '', // 加载更多
    loadFailed: '', // 加载失败 ·
    retry: '', // 重试
    footnote: '', // 刚结束的会话可能晚几秒出现在列表中，可以点“刷新”。行可聚焦，按 Enter 打开会话详情。
  },
  detail: {
    tab: {
      timeline: '', // 时间线
      resources: '', // 资源
      cost: '', // 费用
      ops: '', // 平台动作
      audit: '', // 审计
    },
    noSession: '', // 没有这个会话
    title: '', // 会话详情
    reading: '', // 正在读取会话
    crumbs: '', // 面包屑
    mySessions: '', // 我的实验
    heading: '', // {labId} · 会话 {sid}
    inProgress: '', // 进行中
    env: '', //  · 环境 {name}
    backToWorkspace: '', // 回到工作台
    manageKeep: '', // 管理保留
    viewReclaim: '', // 查看回收进度
    report: '', // 报告
    reclaim: '', // 回收
    tabs: '', // 页签
    deniedTail: '', // 这个页签只对学员与助教开放。
    readingTimeline: '', // 正在读取时间线
    timeline: '', // 时间线
    sumRequested: '', // 已受理
    sumReady: '', // 环境已就绪
    sumRevoked: '', // 收回访问
    sumEnded: '', // 结束（{reason}）
    filterByCategory: '', // 按类别筛选
    allCategories: '', // 全部类别
    truncated: '', // 较早的事件已按保留期清理，只显示摘要。
    summary: '', // 摘要
    noEventsInCategory: '', // 这个类别没有事件。
    noEvents: '', // 还没有事件。
    cleanupState: '', // 清理状态
    all: '', // 全部
    resources: '', // 资源
    resourcesHeading: '', // 本会话创建的资源（{n} 项）
    resourcesNote: '', // 这里只列出本会话创建的资源；复用环境中由交接链里其他会话创建的资源在各自的会话中查看。
    perHour: '', // /小时
    costNote: '', // 当前或最终的计费（估算 · 单价取自 Price List{asOf} · 以 AWS 账单为准）
    priceAsOf: '', // ，取价时间 {t}
    colService: '', // 服务
    colDimension: '', // 计费维度
    colDetail: '', // 详情
    noDimensions: '', // 开始前的报价没有记录计费维度。
    startEstimate: '', // 开始前估算
    unknownPrice: '', // 未知（单价暂不可得）
    quoteRef: '', //  · 报价 {id}
    thisSession: '', // 本次会话
    recomputed: '', // {est}（按实际时长重算，估算）
    unknownBill: '', // ≈ 未知（单价暂不可得，以账单为准）
    unestimated: '', //  · + 未估算的手工资源 {n} 项
    extensions: '', // 延长
    extensionLine: '', // 延长 {n} 分钟
    extensionQuote: '', // （报价 {id}…）
    cost: '', // 费用
    billable: '', // 计费资源
    since: '', //  · 自 {t}
    billNote: '', // 想看实际账单：激活成本分配标签后，可在 AWS Cost Explorer 中按 atl:session-id 查看（数据通常有一天左右的延迟）。
    source: {
      platform: '', // 平台
      agent: '', // 工作台
      runner: '', // 运行器
    },
    ops: '', // 平台动作
    noOps: '', // 这次会话没有平台动作或模块操作。
    colTime: '', // 时间
    colSource: '', // 来源
    colOp: '', // 操作
    colModule: '', // 模块
    colResult: '', // 结果
    colRunId: '', // 运行 ID
    opRunning: '', // 进行中
    opOk: '', // 成功
    opFailed: '', // 失败（退出码 {code}）
    result: {
      ok: '', // 成功
      success: '', // 成功
      denied: '', // 被拒绝
      error: '', // 出错
    },
    platform: '', // 平台
    actorRole: '', // {name}（{role}）
    audit: '', // 审计
    noAudit: '', // 这次会话没有审计事件。
    colActor: '', // 操作者
    colAction: '', // 动作
    colTarget: '', // 对象
  },
} satisfies Dict<typeof zh>;
