/**
 * en（English）：命名空间 workspace。由 `npm run i18n:sync` 按 zh-CN 词典维护结构：
 * 只填写引号内的译文（空字符串 = 未翻译，运行时按 en → en → zh-CN 回退）；行尾注释是 zh-CN 原文。
 * 术语与风格见 ../glossary.md（不翻译 AWS 服务名、CLI 命令、代码、资源名、API 路径、环境变量）。
 */
import type { Dict } from '../dict';
import type zh from '../zh-CN/workspace';

export default {
  terminal: {
    host: {
      lab: '', // 实验机
      workstation: '', // 工作台
    },
    limitPerInstance: '', // 同一实例最多 3 个终端
    awsIdentity: '', // {user} · AWS 身份 {identity}
    labIdentityNote: '', // 实验机终端里的 AWS CLI 默认使用实例角色；你的学员权限在工作台终端里。
    subtabs: '', // {host}终端子标签
    newTerminal: '', // 新开终端
    menu: '', // 终端菜单
    copiedSelection: '', // 已复制选中内容
    noSelection: '', // 没有选中的内容
    copySelection: '', // 复制选中
    clear: '', // 清屏
    openInNewSub: '', // 在新子标签中打开
    endSession: '', // 结束会话
    notOpened: '', // 还没有打开终端
    open: '', // 打开终端
    termLabel: '', // {host}终端 #{no}，{instance}，{user}
    unknownInstance: '', // 实例未知
    connecting: '', // 正在建立 Session Manager 会话…
    agentOffline: '', // {host}的 SSM Agent 不在线
    agentOfflineText: '', // 常见原因：实例正在重启；网络切换为私有放置但缺少 NAT 或 ssm / ssmmessages / ec2messages 终端节点；Agent 被停止。
    retry: '', // 重试
    troubleshoot: '', // 查看排障步骤
    ts1: '', // 在 AWS 控制台确认实验机处于“正在运行”。
    ts2: '', // 私有放置时确认 NAT 网关或 ssm、ssmmessages、ec2messages 接口终端节点存在。
    ts3: '', // 确认实例配置文件仍是 CloudAlbumAppRole，且没有被加上拒绝策略。
    repairRequested: '', // 已请求修复环境
    repairFailed: '', // 修复请求没有完成
    repair: '', // 修复环境
    notPrepared: '', // {host}还在执行平台准备（创建 labuser 等）
    autoRetry: '', // 平台会自动重试连接。
    accessDenied: '', // 权限不足
    accessDeniedText: '', // 学员角色缺少打开终端的权限，这是平台配置问题，不是你的操作问题。
    invalidDocument: '', // 平台文档不可用
    invalidDocumentText: '', // 平台文档 ATL-SessionShell 不存在或不可用，请重新部署平台。
    noResponse: '', // {host}没有响应
    reconnect: '', // 重新连接
    reconnecting: '', // 网络中断，正在重连（第 {n}/{max} 次）
    retryNow: '', // 立即重试
    idle: '', // 会话因空闲 {n} 分钟被关闭
    maxDuration: '', // 单个终端会话最长 {n} 小时，已自动关闭
    replaced: '', // {host}已替换：{from} → {to}
    replacedText: '', // 命令中的实例 ID 已更新。
    connectNew: '', // 连接新{host}
    expectedOutage: '', // 预期中断
    expectedOutageText: '', // 本步骤会暂时中断平台管理通道，终端与本地检查暂时不可用，这是预期现象{until}。平台会自动重试连接。
    expectedOutageUntil: '', // ；预计在 {t} 前恢复
    reauth: '', // 需要重新登录
    reauthText: '', // 打开终端要求最近 60 分钟内登录过。
    signInAgain: '', // 重新登录
    revoked: '', // 访问已收回
    revokedText: '', // 实验已结束，正在收回访问并释放资源。
    viewReclaim: '', // 查看回收进度
    limit: '', // 终端数量已达上限
    limitText: '', // 同一实例最多 3 个、整个会话最多 6 个终端。请先结束不用的终端。
    unavailable: '', // 终端暂时不可用
    clientUnavailable: '', // 终端组件没有加载。请刷新页面后重试。
    notProvided: '', // 平台还没有提供网页终端（开发环境中需要启动本地终端模拟服务）。
    gone: '', // 终端会话已结束，不能续连
    closed: '', // 终端会话已关闭
    failed: '', // 终端连接失败
    copiedDiag: '', // 已复制诊断信息
    clipboardDenied: '', // 无法访问剪贴板
    copyDiag: '', // 复制诊断信息
    connected: '', // 已连接
    reconnectingShort: '', // 重连中
    connectingShort: '', // 连接中
    disconnected: '', // 断开
    idleNote: '', // Session Manager · 空闲 {n} 分钟断开
    busy: '', // 正在运行命令
    tmuxNote: '', // tmux 中无法判断终端是否空闲
    recording: '', // 本终端的输入输出会记录到 CloudWatch Logs /atl-recordings/terminal-sessions
    backToManual: '', // 按 {ctrl}+{dot} 再按 {m} 回到手册
    keybar: '', // 终端按键条
    key: {
      pipe: '', // 竖线
      tilde: '', // 波浪号
      slash: '', // 斜杠
      minus: '', // 减号
    },
    readClipboardFailed: '', // 无法读取剪贴板，请用系统粘贴
    paste: '', // 粘贴
    endedNoConnect: '', // 会话已结束，终端不可连接
    openedList: '', // 本会话打开过的终端：
    statusOpen: '', // 打开
    statusClosed: '', // 已关闭
    noneOpened: '', // 本会话没有打开过{host}终端。
    viewReport: '', // 查看报告
    notInState: '', // 本状态下不提供终端
    keptNote: '', // 保留期间没有终端与控制台访问。要继续操作，请开始一个复用该环境的新会话。
    afterReady: '', // 环境就绪后可用。
    ended: '', // 会话已结束。
    manageKeep: '', // 管理保留
    loadFailed: '', // 终端组件加载失败，请刷新页面。
  },
  provision: {
    phase: {
      done: '', // 完成
      running: '', // 进行中
      todo: '', // 未开始
      retrying: '', // 重试中
      queued: '', // 排队中
      failed: '', // 失败
      skipped: '', // 跳过
    },
    phaseDone: '', // {title}已完成
    phaseDoneTook: '', // {title}已完成，用时 {t}
    region: '', // 准备进度
    title: '', // 正在准备实验环境
    class: '', // 环境准备：{name}（{cls}）
    elapsed: '', // 已用 {t} · {note}
    defaultNote: '', // 起始状态包含的资源决定准备时间。
    phases: '', // 准备阶段
    queued: '', // 运行器排队中（CodeBuild 并发已满）
    slow: '', // 比通常更久。平台会在超时前自动停止并释放已创建的资源。
    billing: '', // 计费：环境创建开始即计费（{estimate}），倒计时从“就绪”开始。
    billingHourly: '', // {range}/小时，估算
    billingQuote: '', // 估算见开始时的报价
    leave: '', // 可以离开这个页面：准备在后台进行。就绪后顶栏会提示，也会发送邮件（需已确认订阅）。浏览器通知只能尽力送达。
    notifOn: '', // 已开启浏览器通知
    notifDenied: '', // 浏览器拒绝了通知，可以在浏览器设置中重新允许
    enableNotif: '', // 开启浏览器通知
    reallow: '', // 可以在浏览器设置中重新允许。
    cancel: '', // 取消…
    ready: '', // 环境已就绪
    readyTook: '', // （用时 {t}）
    countdownStarted: '', // ，倒计时 {t} 已开始
    cancelProgress: '', // 取消进度
    startFailed: '', // 启动失败
    cancelled: '', // 已取消实验
    failedReleased: '', // 启动失败，已释放已创建的资源
    cancelling: '', // 正在取消：释放已创建的资源
    failedReleasing: '', // 启动失败：正在释放已创建的资源
    released: '', // 已释放已创建的资源
    releasing: '', // 正在释放已创建的资源
    deleted: '', // 已删除 {n}/{m}
    endedNote: '', // 这次尝试不计入次数。准备期间产生的费用不会退回。
    releasingNote: '', // 释放在后台进行，可以离开这个页面。释放完成前不能开始新的实验。
    restart: '', // 重新开始
    viewReclaim: '', // 查看回收进度
    backToCatalog: '', // 回到卡片目录
    diagnostics: '', // 诊断信息
    compensation: '', // 补偿回收
    notReleased: '', // 有资源未释放
    viewList: '', // 查看清单
    fresh: '', // 全新开始
    viewCurrent: '', // 查看当前实验
    copyDiag: '', // 复制诊断信息
    restartNote: '', // 这次尝试不计入次数。重新开始会回到简介页并打开开始对话框（必须重新报价）。
    cancelDialog: '', // 取消
    copiedDiag: '', // 已复制诊断信息
    clipboardDenied: '', // 无法访问剪贴板
    copyRaw: '', // 复制原文
    diagWarning: '', // 诊断信息包含 AWS 账号 ID、资源 ARN 等原文，便于排查；分享给他人前请自行打码。
  },
  exp: {
    reason: {
      OUT_OF_WINDOW: '', // 不在登记的时间窗内
      DRIVER_MISMATCH: '', // 运行时驱动与该变体要求不符
      NOT_CORROBORATED: '', // 服务端没有看到足够的请求
      PATH_RATIO: '', // 路径占比不足
      TOO_FEW_SAMPLES: '', // 样本不足
      OUTPUT_TRUNCATED: '', // 输出被截断
      DELIVERY_MISMATCH: '', // 投递位置与要求不符
      LABEL_NOT_IN_LAB: '', // 变体不在卡片声明中
    },
    variantStatus: {
      none: '', // 还没有记录
      registered: '', // 运行中或未上传
      'stale-registered': '', // 可能上传失败：请看工作台终端中运行器的输出
      uploaded: '', // 已上传，等待校验
      'pending-crosscheck': '', // 交叉校验中（服务端指标可能有数分钟延迟，稍后自动复核）
      valid: '', // 有效
      simulated: '', // 模拟基线（旁路补测）
      invalid: '', // 无效
    },
    deltaSame: '', // 差异不明显
    deltaDown: '', // ▼ 下降
    deltaUp: '', // ▲ 上升
    faster: '', //  · 更快
    slower: '', //  · 更慢
    toZero: '', // ▼ 变为 0
    cmpScenario: '', // 场景不一致
    cmpParams: '', // 参数不一致
    cmpInstanceType: '', // 实例类型不一致
    cmpVariant: '', // 起始变体不一致
    cmpForced: '', // 使用了强制运行
    role: {
      baseline: '', // baseline · 基线
      treatment: '', // treatment · 处理
      single: '', // single · 一次性
    },
    track: {
      registered: '', // 已登记
      uploaded: '', // 已上传
      crosscheck: '', // 交叉校验中
      result: '', // 结论
    },
    drawerTitle: '', // 对比实验 · {key}
    notFoundTitle: '', // 没有找到这个实验
    notFound: '', // 卡片 {labId} 没有声明对比实验 {key}。
    crumb: '', // {labId} › 对比实验 · {key}（{req}）
    required: '', // 必做
    optional: '', // 选做
    session: '', // 会话 {sid}
    cloudshell: '', // 省钱模式下对比实验结果无法上传，相关检查只能按规则降级。
    ending: '', // 实验已结束：进入结束前已登记的运行仍会接收上传。
    noRuns: '', // 还没有运行这个实验
    noRunsHint: '', // 先在工作台终端运行{a}，再完成接入应用后运行{b}。
    chart: '', // 图表
    bars: '', // 条形对照
    table: '', // 查看数据表
    directionNote: '', // 差异方向只说明变化，不代表好坏：启用托管服务后单次延迟变高也可能是正确结论。
    noMetrics: '', // 所选记录还没有可比较的指标（上传与交叉校验完成后显示）。
    pair: '', // 成对比较 {a} ↔ {b}
    missing: '', // 缺少 {list}
    and: '', //  和 
    comparable: '', // 可比（场景、参数、实例类型、起始变体一致；都不是强制运行）
    notComparable: '', // 不可比：{list}
    listSep: '', // 、
    howToRun: '', // 怎么运行（在工作台终端）
    readOnly: '', // 只读：你的角色不能使用工作台终端。
    crossSession: '', // 跨会话对比（与之前会话的 {label} 比较）
    roleTitle: '', // （{role}）
    fromSession: '', //  · 来自会话 {sid}
    invalid: '', // 无效：{list}
    runsCount: '', // 记录 {n} 次
    pickRun: '', // 选择 {label} 的记录
    registered: '', // 已登记
    uploadProgress: '', // 上传进度
    colMetric: '', // 指标
    colDelta: '', // 差异
    clientServer: '', // 客户端 {client} · 服务端 {server}
    mismatch: '', //  ▲ 客户端与服务端统计不一致
    chartDesc: '', // 条形对照：{desc}
    descSep: '', // ；
    descItemSep: '', // ，
    validity: '', // 有效性校验
    waitUpload: '', // ◷ 等待上传与校验
    validAll: '', // ✓ 结构、登记、时间窗、驱动与服务端佐证都通过
    simulated: '', // ◐ 模拟基线（旁路补测），证据权重较低
    crosscheckWait: '', // ◷ 服务端佐证等待中（指标可能有数分钟延迟）
    invalidShort: '', // 无效
    functional: '', // 功能型实验：以下检查在实验时间窗内通过即视为有效。
    pass: '', // ✓ 通过
    notRun: '', // 未检测
    noPrevious: '', // 之前的会话里没有这个变体的记录。
    pickPrevious: '', // 选择之前会话的记录
    none: '', // （不使用）
    prevOption: '', // {t} · 会话 {sid} · {status}
    descItem: '', // {label}：{values}
  },
  checkDrawer: {
    basis: {
      stack: '', // 栈成员
      ledger: '', // 台账
      parent: '', // 父资源
      lookup: '', // 定向扫描（CloudTrail）
    },
    title: '', // 检查详情：{name}
    verdict: '', // 结论
    how: '', // 判定方式
    manual: '', // 手动
    manualSub: '', // 手动（{sub}）
    sub: {
      native: '', // 原生
      degraded: '', // 降级
      evidence: '', // 带证据
    },
    auto: '', // 自动
    source: '', // 来源
    executor: '', // 执行者
    manualLearner: '', // 提交手动确认的学员
    executorRole: '', // {role}（atl-{sid}-verify）
    time: '', // 时间
    review: '', // 复核
    reviewed: '', // 助教已复核
    rejected: '', // 被打回
    comment: '', // ：{text}
    ownershipPending: '', // 正在确认这个资源是你在本次实验中创建的（CloudTrail 通常几分钟，不作保证）。平台会按 2、2、4、4、8 分钟的节奏复查。
    checkerError: '', // 检测器出错，不是你的问题。
    expectedActual: '', // 期望与实际
    colAssertion: '', // 断言
    colExpected: '', // 期望
    colActual: '', // 实际
    colResult: '', // 结果
    matches: '', // ✓ 符合
    mismatch: '', // ✕ 不符合
    corroboration: '', // 佐证
    via: '', // （{via}）
    optionalTail: '', //  · 可选
    ownership: '', // 归属
    basisLine: '', // 依据：{basis}
    notConfirmed: '', // 尚未确认
    confirming: '', //  · 确认中
    raw: '', // 原始证据
    redactedJson: '', // 脱敏后的 JSON（已打码）
    large: '', // 证据较大，摘要已显示；完整证据可在报告导出中查看。
    noEvidence: '', // 还没有证据。
    reproduce: '', // 复现命令
    pitfalls: '', // 常见错误
    cause: '', // ：{cause}
    fix: '', //  处理：{fix}
    history: '', // 历史（最近 10 次）
    errorCode: '', // （{code}）
    drift: '', //  [!] 漂移
    noHistory: '', // 还没有检测记录。
    manualConfirm: '', // 手动确认…
    approvedAnnounce: '', // 已通过
    rejectedAnnounce: '', // 已打回
    reviewFailed: '', // 没能提交复核
    assistantReview: '', // 助教复核
    commentLabel: '', // 评语（打回时学员会看到）
    approve: '', // 通过
    reject: '', // 打回…
  },
  end: {
    prereq: {
      'route53-hosted-zone': '', // Route 53 托管区域
      'ses-identity': '', // SES 发件身份
      'acm-certificate': '', // ACM 证书
    },
    quoteFailed: '', // 没能计算保留费用
    notAllowed: '', // 当前状态不能结束实验。
    ending: '', // 正在结束实验
    keepAfter: '', // 到期后保留 {n} 小时
    releaseAtExpiry: '', // 到期时释放资源
    quoteExpired: '', // 费用报价已失效，已重新计算，请重新确认。
    stateChanged: '', // 会话状态刚刚变化，已刷新。
    retryable: '', // 没有完成，可以重试（重试不会重复结束）。
    title: '', // 结束实验
    cancel: '', // 取消
    submitting: '', // 正在提交…
    flow: '', // 结束后：平台收回终端与控制台访问 → 生成报告 → 删除工作台 →（释放或保留环境）。
    attempt: '', // 尝试状态：{state}
    active: '', // 进行中
    notSubmitted: '', // （未提交）。结束时平台会自动做一次最终复核，忘记提交也不吃亏。
    period: '', // 。
    environment: '', // 环境
    releaseAll: '', // 释放全部资源（推荐）
    releaseCost: '', // 费用：释放后不再新增计费；回收完成前（通常几分钟，CloudFront、RDS 等更久）已创建的资源仍按实际时长计费。本次会话已产生 {accrued}（估算 · Price List · 以账单为准）。
    noEstimate: '', // （估算未提供）
    keep: '', // 保留环境
    keepHours: '', // 保留时长
    hours: '', // {n} 小时
    cardMax: '', // （本卡片上限 {n} 小时）
    canKeep: '', // 可以保留
    computing: '', // 正在计算保留费用…
    keepCost: '', // 保留期间持续计费（估算）：{hourly}/小时 × {n} ≈ {total}
    keepCostUnknown: '', // 保留期间持续计费：每小时单价暂不可得，无法估算保留的费用。
    priceAsOf: '', // 取价时间 {t} · 以 AWS 官方定价与账单为准
    notProvided: '', // 未提供
    quoteExpiredShort: '', //  · 报价已失效
    quoteExpiresIn: '', //  · 报价 {t} 后失效
    recompute: '', // 重新计算费用
    saveMode: '', // 节省模式（默认开启）：停止实验机；{tail}
    nonStoppable: '', // 以下资源停不了，会继续计费：
    nonStoppableGeneric: '', // 停不了的资源（例如弹性 IP、EBS 数据卷、按请求计费的服务）会继续计费。
    noAccess: '', // 保留期间没有终端与控制台；要继续操作，请开始一个复用该环境的新会话。
    ackKeep: '', // 我了解保留期间这些资源会持续计费
    typeId: '', // 请输入卡片 id 以确认：
    typeIdHint: '', // 每小时估算较高，输入 {labId} 确认
    prereqs: '', // 前置资源（可选保留，不随环境释放）
    when: '', // 何时
    now: '', // 现在结束
    atExpiry: '', // 到期时按上面的选择处理
    atExpiryTime: '', // 到期时按上面的选择处理（{t}）
    defaultNote: '', // 释放是默认选择；结束后会跳到回收进度页。
  },
  console: {
    link: {
      's3.bucket': '', // S3 · 照片桶
      'cloudfront.distribution': '', // CloudFront · 分配
      'ec2.instance': '', // EC2 · 实验机
      'iam.role': '', // IAM · 角色
      'sqs.queue': '', // SQS · 队列
      'rds.instance': '', // RDS · 数据库实例
    },
    opened: '', // 已在新标签页打开 AWS 控制台
    errState: '', // 实验已结束，控制台访问已收回。
    errDestination: '', // 该页面不在允许列表中。
    errFederation: '', // 联合登录失败，可以重试。
    errReauth: '', // 这个操作要求最近 60 分钟内登录过，请重新登录后再试。
    errNotImplemented: '', // 控制台登录暂时不可用（平台还没有提供控制台联合登录）。
    errRate: '', // 操作太频繁，请稍后重试。
    errOther: '', // 没能取得控制台登录（{title}）。
    errNetwork: '', // 没能取得控制台登录，请检查网络后重试。
    cleanupFailedOnly: '', // 只提供待人工处理清单中各项的控制台深链（不签发新的联合登录）
    revoked: '', // 实验已结束，控制台访问已收回
    permissionsRevoked: '', // 已打开的控制台窗口中的权限已被收回。
    viewManual: '', // 查看待人工处理清单
    title: '', // AWS 控制台（新标签页打开，AWS 不允许嵌入）
    identity: '', // 身份
    identityValue: '', // ATLLearnerRole · 会话名 atl-{sid}-console
    region: '', // 区域
    lastIssued: '', // 上次签发
    issued: '', // {t} · 控制台会话到 {until}（最长 1 小时，到期后需要续期）
    notIssued: '', // 尚未签发（控制台会话最长 1 小时，到期后需要续期）
    soon: '', // 剩余不足 10 分钟
    expired: '', // 控制台会话已到期
    expiringNote: '', // 控制台会话可能先于实验结束失效。
    gettingLogin: '', // 正在获取登录…
    open: '', // 在新标签页打开 AWS 控制台
    renew: '', // 续期
    popupBlocked: '', // 浏览器拦截了新窗口。
    refetchOpen: '', // 重新获取并打开
    openInNewTab: '', // 在新标签页打开
    linkValidity: '', // （登录链接取得后 10 分钟内使用，超过后自动重新获取）
    commonPages: '', // 本卡片常用页面
    usedBySteps: '', // 步骤 {list} 用到
    listSep: '', // 、
    reLogin: '', // 以学员身份重新登录
    cloudTrailNote: '', // 控制台中的操作会被 CloudTrail 记录；结束实验时，本次实验中手动创建的资源会被回收。刚在控制台创建的资源，平台需要几分钟才能确认归属（检测时显示“归属确认中”）。
    profileNote: '', // 浏览器里若已登录你自己的 AWS 身份，联合登录会替换当前控制台会话。建议用单独的浏览器配置文件。
  },
  cost: {
    title: '', // 费用计（估算）
    hourly: '', // 每小时
    perHour: '', // {range}/小时
    accrued: '', // 已产生
    notProvided: '', // 未提供
    priceAsOf: '', // 取价时间
    incomplete: '', // 估算不完整：{n} 项单价不可得。
    billable: '', // 当前计费的资源
    resource: '', // 资源
    learnerCreated: '', //  · 你手动创建
    noBillable: '', // 没有记录到按小时或按量计费的资源。
    unestimated: '', // + 未估算的手工资源 {n} 项
    consoleNote: '', // 控制台中新建、尚未经检测确认的资源可能不在此列。
    disclaimer: '', // 估算值，以 AWS 账单为准。
    billNote: '', // 以 AWS 账单为准。
  },
  shortcuts: {
    switchPane: '', // 切换到 实验机终端 / 工作台终端 / AWS 控制台 / 应用预览
    manual: '', // 回到手册当前步骤（离开终端）
    terminal: '', // 焦点到当前终端
    check: '', // 检测当前步骤
    nextPrev: '', // 下一步 / 上一步
    splitter: '', // 分隔条左移 / 右移 64px
    splitterReset: '', // 分隔条复位
    collapse: '', // 折叠 / 展开手册
    screenReader: '', // 切换终端读屏模式
    help: '', // 快捷键帮助
    passThrough: '', // 把 Ctrl+. 原样交给终端
    copyPaste: '', // 终端中复制 / 粘贴
    whenManualFocused: '', // {key}（手册聚焦时）
    title: '', // 工作台快捷键
    close: '', // 关闭
    intro: '', // 先按前导键 {leader}，1.5 秒内再按第二个键。前导键在终端中同样生效；可以在“终端设置”中更换。
  },
  termSettings: {
    title: '', // 终端设置
    cancel: '', // 取消
    save: '', // 保存
    fontSize: '', // 字号
    screenReader: '', // 读屏模式（为终端输出维护可访问的行缓冲，有渲染开销）
    leader: '', // 前导键
    execute: '', // 在“粘贴到终端”的菜单中提供“粘贴并执行”（每次都会确认；危险命令不允许）
  },
  preview: {
    reason: {
      MIXED_CONTENT: '', // 当前入口只有 HTTP，嵌入会被浏览器作为混合内容拦截。本卡片从自签名 / ALB 的 HTTP 入口讲起时，预览在新标签页打开。
      MIXED_CONTENT_HINT: '', // 如何在此处直接预览：使用受信任 HTTPS 的入口，例如启用 cdn 后改用 CloudFront 入口。
      UNTRUSTED_CERT: '', // 入口的证书不受浏览器信任（例如自签名），无法嵌入。不建议在新标签页中忽略证书警告。
      FRAME_ANCESTORS_MISSING: '', // 应用没有允许平台嵌入（CSP frame-ancestors）。
      X_FRAME_OPTIONS: '', // 应用没有允许平台嵌入（X-Frame-Options）。
      UNREACHABLE: '', // 入口暂时无法访问（实例停止、安全组收紧或换 IP 演练期间）。
    },
    entry: {
      direct: '', // 直连 EC2
      app: '', // 应用入口
      cdn: '', // CloudFront
      alb: '', // 负载均衡器
      'custom-domain': '', // 自定义域名
    },
    unavailable: '', // 预览不可用：环境已停止或已释放。
    loadFailed: '', // 读取预览入口失败。
    noEntry: '', // 还没有可用的应用入口。
    notEmbeddable: '', // 这个入口不能嵌入预览。
    entryLabel: '', // 入口
    embeddable: '', // ✓ 可嵌入
    newTabOnly: '', // ✕ 仅新标签页
    path: '', // 路径
    refresh: '', // 刷新预览
    newTab: '', // 新标签页
    viewport: '', // 视口宽度
    auto: '', // 自适应
    adminAccount: '', // 管理员账号
    frameTitle: '', // CloudAlbum 应用预览（{entry}）
    loginNote: '', // 预览框内与新标签页中的 CloudAlbum 登录状态互相独立；部分浏览器（含部分 Safari 版本）在预览框内无法保持登录，请改用新标签页。
    narrow: '', // 窄屏下预览在新标签页打开
    cannotPreview: '', // 无法在此处预览
    retry: '', // 重试
    openNewTab: '', // 在新标签页打开
    reauth: '', // 查看管理员密码要求最近 60 分钟内登录过。
    notImplemented: '', // 平台暂时不能提供管理员账号。
    readFailed: '', // 读取失败
    credTitle: '', // CloudAlbum 管理员账号
    close: '', // 关闭
    username: '', // 用户名
    password: '', // 初始密码
    show10s: '', // 显示 10 秒
    copiedPassword: '', // 已复制密码
    clipboardDenied: '', // 无法访问剪贴板
    copy: '', // 复制
    passwordNote: '', // 密码只在这个对话框中显示，关闭后从页面内存中清除。
  },
  bar: {
    catalog: '', // ‹ 目录
    heading: '', // 工作台 · {title}
    scenario: '', // 场景
    service: '', // 服务
    variant: '', //  · 变体 {v}
    elapsed: '', // 已用 {t} · 倒计时未开始
    readyRemaining: '', // 环境已就绪 · 剩余
    keepAfter: '', // 到期后保留 {n} 小时
    releaseAtExpiry: '', // 到期时释放
    keptUntil: '', // 至 {t}
    hourlyEstimate: '', // {range}/h（估算）
    hourly: '', // {range}/h
    noHourly: '', // 每小时估算未提供
    costTitle: '', // 费用计（估算）
    accrued: '', //  · 已产生 {v}
    notProvided: '', // 未提供
    extend: '', // 延长 {n} 分钟（剩 {left} 次）
    extendedMax: '', // 已延长 {n} 次（上限）
    canExtend: '', // 可以延长
    end: '', // 结束实验…
    cancel: '', // 取消…
    more: '', // 更多
    costDetail: '', // 费用计明细
    shortcuts: '', // 快捷键帮助
    termSettings: '', // 终端设置…
    theme: '', // 主题
    themeItem: '', // 主题：{v}
    language: '', // 界面语言
    sessionDetail: '', // 会话详情
    adminAccount: '', // 查看 CloudAlbum 管理员账号
    catalogNav: '', // 卡片目录（全站导航）
    targets: '', // 本卡将依次启用：
  },
  banners: {
    t15: '', // 剩余 {n} 分钟（{t} 到期）。到期后自动收回访问并释放资源。
    extend: '', // 延长 {n} 分钟
    canExtend: '', // 可以延长
    keepAtExpiry: '', // 到期后保留环境…
    endNow: '', // 现在结束…
    precheck: '', // 到期预检：还差 {list}。结束时平台会自动做最终复核。
    stepNo: '', // 第 {n} 步
    listSep: '', // 、
    kept: '', // 环境保留中。保留期间没有终端与控制台访问。
    keptUntil: '', // 环境保留中 · 至 {t}。保留期间没有终端与控制台访问。
    manageKeep: '', // 管理保留
    cleanupFailed: '', // 释放未完成：有资源没能自动删除，它们仍可能计费。
    viewList: '', // 查看清单
    archive: '', // 已结束 · 只读存档。本会话打开过的终端列在右侧终端区。
    viewReport: '', // 查看报告
    degraded: '', // 实验机的管理通道不可达：终端与本地检测暂时不可用。
    degradedOutage: '', //  本步骤会让管理通道暂时不可达：检测会显示“通道不可达”，属预期，窗口结束后（{t}）重新检测即可。
    causes: '', // 常见原因
    causesText: '', // 给 CloudAlbumAppRole 加了拒绝策略或“撤销活动会话”；私有放置缺 NAT 或 ssm / ssmmessages / ec2messages 终端节点；实例配置文件被替换；Agent 被停止。
    repair: '', // 修复环境
    end: '', // 结束实验…
    budget: '', // 本月费用已超过预算，平台将在 10 分钟后结束本实验。
    moduleOp: '', // 平台正在修改环境：{action}
    platformAction: '', // 平台动作
    runner: '', // （运行器 {id}）
    completed: '', // 已完成（全自动）。
    completedManual: '', // 已完成（含手动）。
    badge: '', // 获得徽章“{badge}”。
    completedTail: '', // 你可以结束并清理，也可以继续探索（倒计时照常）。
    endAndClean: '', // 结束并清理…
    keepExploring: '', // 继续探索
    submitFailed: '', // 提交未通过：还差 {n} 项。修好之后可以再次提交。
    dismiss: '', // 关闭提醒
    region: '', // 工作台提醒
  },
  extend: {
    limit: '', // 延长次数或累计时长已用完。
    quoteFailed: '', // 没能计算费用，请重试。
    extendedTo: '', // 已延长到 {t}
    extended: '', // 已延长
    quoteExpired: '', // 费用报价已失效，已重新计算，请重新确认。
    precondition: '', // 截止时间刚刚变化（可能在另一个标签页延长过），已刷新。
    expired: '', // 已经到期，无法延长。
    budget: '', // 本月费用已超过预算，按设置不能延长。
    uninstalling: '', // 平台正在卸载，不能延长。
    retryable: '', // 延长没有完成，可以重试（重试不会重复延长）。
    title: '', // 延长 {n} 分钟
    cancel: '', // 取消
    recompute: '', // 重新计算费用
    extending: '', // 正在延长…
    retry: '', // 重试
    computing: '', // 正在计算费用…
    cost: '', // 费用（估算 · 按当前环境实际启用的资源）：{hourly}/小时 × {h} 小时 ≈ {total}
    costUnknown: '', // 费用（估算）：每小时单价暂不可得，无法估算这次延长的费用；延长期间资源照常按实际用量计费。
    incomplete: '', // 部分单价不可得（{n} 项“未知”），估算不完整。
    priceAsOf: '', // 取价时间 {t} · 以 AWS 官方定价与账单为准
    notProvided: '', // 未提供
    quoteExpiredShort: '', //  · 报价已失效
    quoteExpiresIn: '', //  · 报价 {t} 后失效
    budgetWarn: '', // 本月费用已接近预算。
    ack: '', // 我了解延长期间资源继续计费
    ackBudget: '', // 我知道本月费用已接近预算
  },
  stepCheck: {
    done: '', // 本步检测完成：{pass} 项通过
    doneFail: '', // 本步检测完成：{pass} 项通过，{fail} 项未通过
    afterReady: '', // 环境就绪后可用
    ended: '', // 实验已结束，不能再检测
    title: '', // 本步检测
    verifying: '', // 核验中…
    run: '', // 检测
    checks: '', // 检查
    drift: '', // 这一步曾于 {t} 通过，现在{what}未通过。
    before: '', // 之前
    someChecks: '', // 有检查
    quoted: '', // “{list}”
    quoteSep: '', // ”“
    noPitfalls: '', // 本步没有登记常见错误
    troubleshoot: '', // 排错
    ackDone: '', // 已记录：这是有意的改动。提交时仍要求这一步通过。
    ackFailed: '', // 没能记录，请稍后重试
    intended: '', // 我是有意改动的
    ackNote: '', // 确认只关闭提醒，提交时仍要求通过。
    cmdOk: '', // 命令已完成（退出码 0）
    cmdFailed: '', // 命令失败（退出码 {code}）
    unknown: '', // 未知
    checkStep: '', // 检测本步
    noAuto: '', // 本步没有自动检查。
    failedNote: '', // 未通过不会扣分：修好之后重新检测即可。最终以提交时的复核为准。
    manualLabel: '', // 手动确认：{title}
    manual: '', // 手动确认…
    reviewComment: '', // 助教评语：{text}
    waited: '', // 已等待 {t}
    waiting: '', // 等待中
    typical: '', //  · 通常需要约 {n} 分钟
    nextCheck: '', // 等待型检查 · 下次检测 {t} 后
  },
  main: {
    afterReady: '', // 环境就绪后可用
    termNotReady: '', // 终端还没有准备好
    newSubNotConnected: '', // 新的终端子标签没有连上
    notConnected: '', // 终端还没有连上
    notConnectedCopied: '', // {lead}，命令已复制，可以连上后手动粘贴
    notConnectedCopy: '', // {lead}，请先复制命令，连上后手动粘贴
    pasted: '', // 已粘贴到 {target}终端 #{no}，检查后按 Enter 执行
    ended: '', // 实验已结束，不能再检测
    checkStarted: '', // 已开始检测
    checkNotStarted: '', // 检测没有开始，请稍后重试
    labCheckStarted: '', // 已开始检测整张卡片
    labCheckNotStarted: '', // 检测没有开始
    backToManual: '', // 已回到手册
    readyAnnounce: '', // 环境已就绪，倒计时已开始
    notifTitle: '', // ATL 实验平台
    notifReady: '', // {labId} 的实验环境已就绪
    notifRemaining: '', // {labId} 还剩 {n} 分钟，到期后自动收回访问并释放资源。
    srOn: '', // 终端读屏模式已开启
    srOff: '', // 终端读屏模式已关闭
    segProgress: '', // 进度
    segManual: '', // 手册
    repairRequested: '', // 已请求修复环境
    repairFailed: '', // 修复请求没有完成
    segNav: '', // 工作台分段
    segShow: '', // 显示
    expandManual: '', // 展开手册
    leaderWait: '', // 等待第二个键…
    t5Hint: '', // 将显示到期提醒
  },
  manual: {
    title: '', // 实验手册
    attempt: '', // 尝试：{state}
    progress: '', // 进度 {n}
    progressSr: '', //  个必需步骤已达成
    submit: '', // 提交实验
    preparing: '', // 环境准备中：可以先读手册；“粘贴到终端”与检测会在就绪后可用。
    readOnly: '', // 只读：你的角色可以查看手册与检测结果{extra}。
    readOnlyAssistant: '', // 、运行检测并复核手动确认
    missingTitle: '', // 手册内容缺失
    missingBody: '', // 请在 设置 › 内容版本 中检查。
    overview: '', // 卡片概览
    prev: '', // ← 上一步
    afterReady: '', // 环境就绪后可用
    ended: '', // 实验已结束
    check: '', // 检测
    next: '', // 下一步 →
    steps: '', // 步骤
    allSteps: '', // 全部步骤
    optional: '', // 选做
    wait: '', // 等待
    outage: '', // 预期中断
    billing: '', // 开始计费
  },
  md: {
    method: {
      console: '', // 控制台
      cli: '', // CLI
      script: '', // 脚本
      code: '', // 代码
    },
    domain: {
      secure: '', // 安全
      resilient: '', // 弹性
      performance: '', // 高性能
      cost: '', // 成本优化
    },
    fromVar: '', // 来自变量 {name}
    unfilled: '', // 未填写：{name}
    methodLabel: '', // 做法：{m}
    methods: '', // 做法
    done: '', // 已完成
    notDone: '', // 未完成
    why: '', // 为什么
    reveal: '', // 展开提示
    tip: '', // 提示
    warning: '', // 注意
    danger: '', // 危险
    expected: '', // 预期结果
    wait: '', // 等待：通常需要约 {n} 分钟{max}。等待型检查会自动复查（15、30、45、60 秒之后每 60 秒），页面不可见时暂停。
    waitMax: '', // （最长 {n} 分钟）
    whySaa: '', // 为什么（SAA）
    domainTail: '', //  · {d}
    confusable: '', //  · 易混淆
    runsOn: '', //  · 运行于：{where}
    lab: '', // 实验机
    workstation: '', // 工作台
    openConsole: '', // 在控制台打开
    consoleNewTab: '', // （AWS 控制台，新标签页）
    tab: {
      'terminal-lab': '', // 实验机终端
      'terminal-workstation': '', // 工作台终端
      console: '', // AWS 控制台
      preview: '', // 应用预览
    },
    switchTo: '', // 切换到“{tab}”
  },
  failure: {
    quote: {
      title: '', // 费用信息已更新
      description: '', // 报价在开始前失效。没有创建任何资源。
    },
    lockBusy: {
      title: '', // 环境被占用
      description: '', // 另一个实验正持有环境。没有创建资源。
    },
    envGone: {
      title: '', // 要复用的环境已不可用
      description: '', // 要复用的保留环境已释放或不可用。没有创建资源。
    },
    preflight: {
      title: '', // 账号预检未通过
      description: '', // 逐项检查默认 VPC、配额、缺少的学员输入与灾备区域设置。没有创建任何资源。
    },
    capacity: {
      title: '', // 可用区容量不足
      description: '', // 已换可用区重试一次仍失败。请稍后再试。
    },
    account: {
      title: '', // 账号受限
      description: '', // 下面是 AWS 返回的原始错误。可能是组织 SCP 的限制或账号配额不足，建议联系账号管理员或申请提高配额。
    },
    base: {
      title: '', // 实验机启动失败
      description: '', // 实验机没能完成引导。诊断信息中有引导日志摘要与实例控制台输出。
    },
    definition: {
      title: '', // 实验定义有误
      description: '', // 这是卡片内容或平台版本的问题，不是你的操作问题，已通知管理员（你）。可以在 设置 › 内容版本 中查看。
    },
    profile: {
      title: '', // 起始状态部署失败
      description: '', // 部署起始状态时失败。诊断信息中有失败的模块或栈与 CloudFormation 原因。
    },
    runner: {
      title: '', // 平台运行器出错
      description: '', // 平台运行器没能完成部署（已按规则重试）。排队超时时，可以申请提高 CodeBuild 并发配额。
    },
    workstation: {
      title: '', // 工作台创建失败
      description: '', // 工作台实例没能创建。卡片允许时，可以选择“不启动工作台（CloudShell 省钱模式）”重新开始。
    },
    ssm: {
      title: '', // 实验机无法连接管理通道
      description: '', // 常见原因：实例配置文件、出网路径、私有放置缺 NAT 或终端节点。
    },
    health: {
      title: '', // 健康检查未通过
      description: '', // 修复一次后仍未通过。诊断信息中列出了未通过的检查项。
    },
    timeout: {
      title: '', // 准备超时
      description: '', // 准备时间超过上限，平台已自动停止并释放已创建的资源。
    },
    workflow: {
      title: '', // 平台编排出错
      description: '', // 平台编排出错，已生成待人工处理清单；平台会自动重试回收。
    },
    fallback: {
      title: '', // 启动失败
      description: '', // 平台没能完成准备。下面是原始错误。
    },
    regionPlaceholder: '', // <区域>
  },
  phases: {
    title: {
      validate: '', // 校验与预检
      base: '', // 创建基础环境
      profile: '', // 部署实验起始状态
      connect: '', // 连接实验机（SSM）
      health: '', // 健康检查
      ready: '', // 就绪，开始计时
    },
    slow: {
      elasticache: '', // ElastiCache 复制组
      cloudfront: '', // CloudFront 分配
      asg: '', // Auto Scaling 组
    },
    fallbackVariant: '', // 已改用回退档 {name}
    reuse: '', // 正在接管保留的环境
    healthFix: '', // 健康检查未通过，正在修复一次
    reboot: '', // 正在重启实验机后重试
    queued: '', // 运行器排队中（CodeBuild 并发已满）
    retryAz: '', // 正在换可用区重试
    moduleIdx: '', // 模块 {i}/{n} · {module}
    module: '', // 模块 {module}
    resourceParen: '', // （{text}）
    processing: '', // 正在处理：{line}
    slowHint: '', // {name}通常是最慢的一步。可以先阅读手册第 1～2 节。
    profileName: '', // 起始档位 {name}
    instances: '', // 实验机 {lab} · 工作台 {ws}
  },
  expiry: {
    extend: {
      state: '', // 实验已到期或正在结束，无法延长。
      none: '', // 已延长到上限次数。
      last30s: '', // 即将到期，无法延长。
      cap: '', // 已达到单次实验总时长上限。
      uninstalling: '', // 平台正在卸载，不能延长。
      budget: '', // 本月费用已超过预算，不能延长。
      role: '', // 你的角色不能延长实验。
    },
    keep: {
      'not-allowed': '', // 本卡片不允许保留环境，只能释放。
      degraded: '', // 环境异常时不能保留，只能释放。
      uninstalling: '', // 平台正在卸载，进行中的实验会被结束，不允许保留。
      budget: '', // 本月费用已超过预算，只能释放。
      'env-age': '', // 环境已超过最长寿命，只能释放。
      state: '', // 当前状态不能保留环境。
    },
    endKeep: '', // 结束并保留环境 {n} 小时
    endRelease: '', // 结束并释放资源
    expiryKeep: '', // 到期时保留 {n} 小时
    expiryRelease: '', // 到期时释放
    nth: '', // 第 {n} 次
    last: '', // 这是最后一次延长
    more: '', // 还可以再延长 {n} 次
    latest: '', // ；本次实验最晚到 {t}
    summary: '', // 延长后 {after} 到期（{nth}，{more}{latest}）。
  },
  labText: {
    stepType: {
      console: '', // 控制台
      cli: '', // CLI
      script: '', // 脚本
      code: '', // 代码
      observe: '', // 观察
      experiment: '', // 对比实验
    },
    provisionName: {
      A: '', // 较快
      B: '', // 中等
      C: '', // 较慢
      D: '', // 很慢
    },
    provisionNote: {
      A: '', // 本卡片的起始状态只有 L0 与快速创建的资源（A）。
      B: '', // 本卡片的起始状态包含 CloudFront、ALB、实例替换等较慢的资源（B）。
      C: '', // 本卡片的起始状态包含 RDS 或 ElastiCache，通常需要较长时间（C）。
      D: '', // 本卡片的起始状态包含 RDS / ElastiCache 与其他慢资源，通常需要很长时间（D）。
    },
  },
  checkText: {
    expectedActual: '', // {label} · 期望 {expected}，实际 {actual}
    youEntered: '', // 你填写：{v}
    evidenceOk: '', //  · 证据已校验
    ownership: '', // 归属确认中（CloudTrail 通常几分钟，不作保证）
    ownershipNext: '', // 归属确认中（CloudTrail 通常几分钟，不作保证） · 下次 {t} 后
    outageRetry: '', // 窗口结束后自动重试
    notYourFault: '', // 不是你的问题
    runDone: '', // 本步检测完成：{pass} 项通过
    runFail: '', // ，{n} 项未通过
    runOther: '', // ，{n} 项待定
  },
  paste: {
    unresolved: '', // 有 {n} 个变量未填写，已定位到变量条
    secret: '', // 命令含密钥占位，不能粘贴。请在实验机上读取密钥后手动输入。
    tooLarge: '', // 命令超过 16KB，只能复制
    dangerExecute: '', // 危险命令不允许“粘贴并执行”，请粘贴后检查再自己按 Enter
    multiline: '', // 当前程序不支持安全粘贴，请复制后手动粘贴
    target: {
      lab: '', // 实验机
      workstation: '', // 工作台
    },
  },
  money: {
    notProvided: '', // 未提供
    approx: '', // ≈ {v}
    range: '', // ≈ {low}～{high}
  },
  right: {
    tab: {
      'terminal-lab': '', // 实验机
      'terminal-workstation': '', // 工作台
      console: '', // AWS 控制台
      preview: '', // 应用预览
    },
    tabShort: {
      'terminal-lab': '', // 实验机
      'terminal-workstation': '', // 工作台
      console: '', // 控制台
      preview: '', // 预览
    },
    connected: '', // 已连接
    reconnecting: '', // 重连中
    unavailable: '', // 不可用
    connecting: '', // 连接中
    disconnected: '', // 断开
    region: '', // 终端、控制台与预览
    tabs: '', // 右侧标签
    newTab: '', // （新标签页打开）
    splitNA: '', // 拆分右栏暂不提供
    split: '', // 拆分
    readOnly: '', // 只读：你的角色不能连接终端或控制台
    readOnlyText: '', // 助教与观察者永远拿不到 AWS 凭证。可以在手册中查看检测结果{extra}。
    readOnlyAssistant: '', // 、运行检测并复核手动确认
    cloudshell: '', // CloudShell（省钱模式）
    cloudshellText: '', // 本次实验没有启动工作台实例。工作台命令请在 AWS CloudShell 中执行：先打开控制台，再从控制台顶栏打开 CloudShell。手册中工作台命令的“粘贴”改为“复制”。
    cloudshellExp: '', // 省钱模式下对比实验结果无法上传，相关检查只能按规则降级。
    openConsole: '', // 在新标签页打开 AWS 控制台
  },
  manualConfirm: {
    evidenceTooLong: '', // 证据超过 {n} 个字符，请只粘贴命令输出中的相关部分
    evidenceJson: '', // 只能粘贴 JSON 格式的命令输出
    submittedReview: '', // 已提交手动确认，等待助教复核
    submitted: '', // 已提交手动确认
    invalid: '', // 输入不符合要求：{detail}
    failed: '', // 提交失败，可以重试
    title: '', // 手动确认：{name}
    done: '', // 完成
    cancel: '', // 取消
    submitting: '', // 正在提交…
    submit: '', // 提交确认
    doneReview: '', // 已提交。安装中有助教时，复核前会显示“等待助教复核”。
    doneEvidence: '', // 已手动确认（带证据）。
    doneManual: '', // 已手动确认。
    native: '', // 这项检查需要你确认看到的结果（手动·原生）。
    degraded: '', // 自动检测暂时无法判定，你可以按下面的位置查看后手动确认（手动·降级）。手动确认不能覆盖自动检测的“未通过”。
    where: '', // 位置：{path}
    whereRegion: '', // （区域：{region}）
    labRegion: '', // 实验区域
    question: '', // 你看到的是什么？
    notExpected: '', // 这不是期望的结果，不能提交。
    fixDefault: '', // 先修正配置，再重新检测。
    valueLabel: '', // 你看到的值
    example: '', // 例如 {v}
    badFormat: '', // 格式不符合要求
    note: '', // 备注（至少 6 个字）
    noteShort: '', // 备注至少 6 个字
    evidenceOptional: '', // 可选：粘贴命令输出作为证据（平台会用同一套断言校验，通过记为“带证据的手动”）
    evidenceLabel: '', // 命令输出（JSON）
  },
  dialogs: {
    cancelling: '', // 正在取消实验
    cancelFailed: '', // 取消没有完成，可以重试。
    cancelTitle: '', // 取消实验
    keepPreparing: '', // 继续准备
    cancellingBusy: '', // 正在取消…
    cancelRequested: '', // 尚未创建任何资源，取消不会产生费用。
    cancelProvisioning: '', // 取消后，已经创建的资源会被释放，可能需要一些时间。准备期间产生的费用不会退回。
    t5Title: '', // 还剩 5 分钟
    extend30: '', // 延长 30 分钟
    gotIt: '', // 知道了
    t5Body: '', // 还剩 5 分钟。正在运行的对比实验，请尽快让结果上传完成（结束时平台会接收在途上传）。
    overdueAnnounce: '', // 实验时间已到，相关对话框已关闭
    endedAnnounce: '', // 实验已结束，正在收回访问并释放资源
    overdueTitle: '', // 实验时间已到
    endedTitle: '', // 实验已结束
    overdueBody: '', // 实验时间已到，正在收回访问并释放资源。
    endedBody: '', // 实验已结束，正在收回访问并释放资源。
    expiredAt: '', // （{t} 到期）
    drift: '', // 平台正在补触发到期处理（通常几分钟内）。
    viewReclaim: '', // 查看回收进度
    viewReport: '', // 查看报告
    backToCatalog: '', // 回到卡片目录
    standaloneCancel: '', // 取消实验
    standaloneExtend: '', // 延长实验
    standaloneEnd: '', // 结束实验
  },
  expCard: {
    title: '', // 对比实验 {key}
    required: '', // （必做）
    optional: '', // （选做）
    view: '', // 查看对比
    notDeclared: '', // 卡片没有声明这个实验。
  },
  splitter: {
    label: '', // 调整手册宽度
    collapsed: '', // 手册已折叠
    width: '', // 手册宽度 {n}%
  },
  command: {
    afterReady: '', // 环境就绪后可用
    role: '', // 你的角色不能使用终端
    ended: '', // 实验已结束，终端不可用
  },
  pasteDlg: {
    severeTitle: '', // 粘贴危险命令
    busyTitle: '', // 终端正在运行命令
    executeTitle: '', // 粘贴并执行
    linesTitle: '', // 将粘贴 {n} 行
    confirmTitle: '', // 确认粘贴
    cancel: '', // 取消
    newTab: '', // 在新的终端子标签中粘贴
    severeOk: '', // 我了解，粘贴
    busyOk: '', // 仍然粘贴
    executeOk: '', // 粘贴并执行
    ok: '', // 粘贴
    severeNote: '', // 这条命令会删除或停用资源，影响无法撤销。粘贴后请检查，再自己按 Enter；危险命令不允许“粘贴并执行”。
    busyNote: '', // 终端正在运行命令（例如 tail -f），粘贴的内容会成为该程序的输入。
    mismatch: '', // 这条命令本应在 {target} 上执行。
    multiline: '', // 将向 {target}终端粘贴 {n} 行（安全粘贴，不会立即执行）。
    host: '', // 目标主机
    linuxUser: '', // Linux 用户
    awsIdentity: '', // AWS 身份
    dontAsk: '', // 本卡片内不再询问（仅普通命令）
    rejectTitle: '', // 不能粘贴
    gotIt: '', // 知道了
    readOnLab: '', // 在实验机终端中读取：
    copied: '', // 命令已复制到剪贴板，检查后可以在终端里手动粘贴。
    copyFirst: '', // 可以先复制命令，再在终端里手动粘贴。
  },
  step: {
    est: '', // 约 {n} 分钟 · 
    optional: '', //  · 选做
    billing: '', // 从这一步开始{what}{keys}。
    billingDefault: '', // 计费
    billingKeys: '', // （{list}）
    listSep: '', // 、
    outageOpen: '', // 预期中断：本步骤会暂时中断平台管理通道{reason}。在 {t} 之前，实验机终端与本地检测不可用是正常现象，不计为失败；窗口结束后平台自动重试。
    reasonParen: '', // （{reason}）
    outageNotice: '', // 本步骤会让管理通道暂时不可达（约 {n} 分钟）：检测会显示“通道不可达”，属预期，窗口结束后重新检测即可。
    several: '', // 数
    noBody: '', // 本步没有手册正文。
    pitfalls: '', // 常见错误（{n}）
    hit: '', // ● 命中：
    cause: '', // ：{cause}
    fix: '', //  处理：{fix}
    unskipped: '', // 已撤销跳过
    skipped: '', // 已跳过本步
    failed: '', // 操作没有完成，请稍后重试
    unskip: '', // 撤销跳过
    skip: '', // 跳过本步
    readDone: '', // 已记录：本步已读
    readFailed: '', // 没能记录，请稍后重试
    read: '', // 我已读完
  },
  vars: {
    label: '', // 变量
    collapse: '', // 收起变量
    all: '', // 全部变量（{n}）
    unresolved: '', // 未解析
    masked: '', // （显示已打码）
    updated: '', // 已更新
    editLabel: '', // 编辑变量 {label}
    edit: '', // 编辑
    badFormat: '', // 格式不符合要求
    badFormatExample: '', // 格式不符合要求，例如 {example}
    required: '', // 请填写
    saved: '', // 已保存变量 {label}
    saveFailed: '', // 没能保存，请稍后重试
    fill: '', // 填写变量 {label}
    saving: '', // 正在保存…
    roleDenied: '', // 你的角色不能填写变量
    afterReady: '', // 实验就绪后可以填写
    save: '', // 保存
    cancelEdit: '', // 取消编辑
    current: '', // 当前值：{v}
    empty: '', // 还没有填写
  },
  action: {
    deploy: '', // 部署 {id}
    roleDenied: '', // 你的角色不能执行平台动作
    afterReady: '', // 实验就绪后可用
    running: '', // 平台正在执行这个动作
    requested: '', // 已请求平台动作：{title}
    notAllowed: '', // 本卡片不允许这个平台动作
    reauth: '', // 这个操作要求最近 60 分钟内登录过
    failed: '', // 请求没有完成，请稍后重试
    title: '', // 平台动作：{title}
    interrupts: '', // 执行期间会暂时中断平台管理通道（预期中断）。
    modifying: '', // 平台正在修改环境
    execFailed: '', // 执行失败
    execFailedSummary: '', // 执行失败：{summary}
    done: '', // 已完成
    cancel: '', // 取消
    requesting: '', // 正在请求…
    confirm: '', // 确认执行
    confirmDefault: '', // 平台会以运行器修改你的实验环境。确认执行吗？
    interruptsNote: '', // 执行期间实验机终端与本地检测会暂时不可用，属预期。
  },
  submit: {
    previewFailed: '', // 预检查没有完成
    stepTitle: '', // 步骤 {n}“{title}”
    submitted: '', // 已提交，平台正在做最终复核
    failed: '', // 提交失败，请稍后重试
    title: '', // 提交实验
    cancel: '', // 取消
    submitting: '', // 正在提交…
    submitAnyway: '', // 仍然提交（可能不通过）
    submit: '', // 提交
    intro: '', // 平台会对全部必需检查强制重测一次（最终复核），通过即完成并获得徽章。
    generating: '', // 正在生成预检查…
    previewError: '', // 预检查没有完成（{error}），可以直接提交。
    precheck: '', // 当前预检查：必需步骤 {done}/{total} 已达成
    drifted: '', //  · {n} 项漂移
    missing: '', // 还差：{step}
    allDone: '', // 必需步骤都已达成
  },
} satisfies Dict<typeof zh>;
