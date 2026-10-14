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
      lab: 'lab instance', // 实验机
      workstation: 'workbench', // 工作台
    },
    limitPerInstance: 'Up to 3 terminals per instance', // 同一实例最多 3 个终端
    awsIdentity: '{user} · AWS identity {identity}', // {user} · AWS 身份 {identity}
    labIdentityNote: 'In lab instance terminals the AWS CLI uses the instance role by default. Your learner permissions are in the workbench terminal.', // 实验机终端里的 AWS CLI 默认使用实例角色；你的学员权限在工作台终端里。
    subtabs: '{host} terminal sub-tabs', // {host}终端子标签
    newTerminal: 'New terminal', // 新开终端
    menu: 'Terminal menu', // 终端菜单
    copiedSelection: 'Selection copied', // 已复制选中内容
    noSelection: 'Nothing is selected', // 没有选中的内容
    copySelection: 'Copy selection', // 复制选中
    clear: 'Clear screen', // 清屏
    openInNewSub: 'Open in a new sub-tab', // 在新子标签中打开
    endSession: 'End session', // 结束会话
    notOpened: 'No terminal open yet', // 还没有打开终端
    open: 'Open terminal', // 打开终端
    termLabel: '{host} terminal #{no}, {instance}, {user}', // {host}终端 #{no}，{instance}，{user}
    unknownInstance: 'unknown instance', // 实例未知
    connecting: 'Starting a Session Manager session…', // 正在建立 Session Manager 会话…
    agentOffline: 'The SSM Agent on the {host} is offline', // {host}的 SSM Agent 不在线
    agentOfflineText: 'Common causes: the instance is rebooting; the network was switched to private placement without a NAT or ssm / ssmmessages / ec2messages endpoints; the Agent was stopped.', // 常见原因：实例正在重启；网络切换为私有放置但缺少 NAT 或 ssm / ssmmessages / ec2messages 终端节点；Agent 被停止。
    retry: 'Retry', // 重试
    troubleshoot: 'Show troubleshooting steps', // 查看排障步骤
    ts1: 'In the AWS console, confirm that the lab instance is “Running”.', // 在 AWS 控制台确认实验机处于“正在运行”。
    ts2: 'With private placement, confirm that a NAT gateway or the ssm, ssmmessages and ec2messages interface endpoints exist.', // 私有放置时确认 NAT 网关或 ssm、ssmmessages、ec2messages 接口终端节点存在。
    ts3: 'Confirm that the instance profile is still CloudAlbumAppRole and that no deny policy was added.', // 确认实例配置文件仍是 CloudAlbumAppRole，且没有被加上拒绝策略。
    repairRequested: 'Environment repair requested', // 已请求修复环境
    repairFailed: 'The repair request did not complete', // 修复请求没有完成
    repair: 'Repair environment', // 修复环境
    notPrepared: 'The {host} is still being prepared by the platform (creating labuser and so on)', // {host}还在执行平台准备（创建 labuser 等）
    autoRetry: 'The platform will reconnect automatically.', // 平台会自动重试连接。
    accessDenied: 'Access denied', // 权限不足
    accessDeniedText: 'The learner role is missing the permission to open a terminal. This is a platform configuration issue, not something you did.', // 学员角色缺少打开终端的权限，这是平台配置问题，不是你的操作问题。
    invalidDocument: 'Platform document unavailable', // 平台文档不可用
    invalidDocumentText: 'The platform document ATL-SessionShell does not exist or is unavailable. Redeploy the platform.', // 平台文档 ATL-SessionShell 不存在或不可用，请重新部署平台。
    noResponse: 'The {host} is not responding', // {host}没有响应
    reconnect: 'Reconnect', // 重新连接
    reconnecting: 'Connection lost. Reconnecting (attempt {n} of {max})', // 网络中断，正在重连（第 {n}/{max} 次）
    retryNow: 'Retry now', // 立即重试
    idle: 'The session was closed after {n} minutes of inactivity', // 会话因空闲 {n} 分钟被关闭
    maxDuration: 'A terminal session lasts at most {n} hours and was closed automatically', // 单个终端会话最长 {n} 小时，已自动关闭
    replaced: 'The {host} was replaced: {from} → {to}', // {host}已替换：{from} → {to}
    replacedText: 'The instance IDs in commands have been updated.', // 命令中的实例 ID 已更新。
    connectNew: 'Connect to the new {host}', // 连接新{host}
    expectedOutage: 'Expected outage', // 预期中断
    expectedOutageText: 'This step briefly interrupts the platform management channel, so the terminal and local checks are unavailable for now. This is expected{until}. The platform will reconnect automatically.', // 本步骤会暂时中断平台管理通道，终端与本地检查暂时不可用，这是预期现象{until}。平台会自动重试连接。
    expectedOutageUntil: ' (back by {t})', // ；预计在 {t} 前恢复
    reauth: 'Sign-in required', // 需要重新登录
    reauthText: 'Opening a terminal requires a sign-in within the last 60 minutes.', // 打开终端要求最近 60 分钟内登录过。
    signInAgain: 'Sign in again', // 重新登录
    revoked: 'Access revoked', // 访问已收回
    revokedText: 'The lab has ended. Access is being revoked and resources released.', // 实验已结束，正在收回访问并释放资源。
    viewReclaim: 'View reclaim progress', // 查看回收进度
    limit: 'Terminal limit reached', // 终端数量已达上限
    limitText: 'Up to 3 terminals per instance and 6 per session. Close a terminal you no longer need first.', // 同一实例最多 3 个、整个会话最多 6 个终端。请先结束不用的终端。
    unavailable: 'Terminal temporarily unavailable', // 终端暂时不可用
    clientUnavailable: 'The terminal component did not load. Reload the page and try again.', // 终端组件没有加载。请刷新页面后重试。
    notProvided: 'The platform does not provide a web terminal yet (in development, start the local terminal mock).', // 平台还没有提供网页终端（开发环境中需要启动本地终端模拟服务）。
    gone: 'The terminal session has ended and cannot be resumed', // 终端会话已结束，不能续连
    closed: 'Terminal session closed', // 终端会话已关闭
    failed: 'Could not connect the terminal', // 终端连接失败
    copiedDiag: 'Diagnostics copied', // 已复制诊断信息
    clipboardDenied: 'Cannot access the clipboard', // 无法访问剪贴板
    copyDiag: 'Copy diagnostics', // 复制诊断信息
    connected: 'Connected', // 已连接
    reconnectingShort: 'Reconnecting', // 重连中
    connectingShort: 'Connecting', // 连接中
    disconnected: 'Disconnected', // 断开
    idleNote: 'Session Manager · disconnects after {n} min idle', // Session Manager · 空闲 {n} 分钟断开
    busy: 'Running a command', // 正在运行命令
    tmuxNote: 'Inside tmux the terminal cannot tell whether it is idle', // tmux 中无法判断终端是否空闲
    recording: 'Input and output of this terminal are recorded to CloudWatch Logs /atl-recordings/terminal-sessions', // 本终端的输入输出会记录到 CloudWatch Logs /atl-recordings/terminal-sessions
    backToManual: 'Press {ctrl}+{dot}, then {m} to return to the manual', // 按 {ctrl}+{dot} 再按 {m} 回到手册
    keybar: 'Terminal key bar', // 终端按键条
    key: {
      pipe: 'Pipe', // 竖线
      tilde: 'Tilde', // 波浪号
      slash: 'Slash', // 斜杠
      minus: 'Minus', // 减号
    },
    readClipboardFailed: 'Cannot read the clipboard. Use the system paste instead', // 无法读取剪贴板，请用系统粘贴
    paste: 'Paste', // 粘贴
    endedNoConnect: 'The session has ended; terminals cannot connect', // 会话已结束，终端不可连接
    openedList: 'Terminals opened in this session:', // 本会话打开过的终端：
    statusOpen: 'open', // 打开
    statusClosed: 'closed', // 已关闭
    noneOpened: 'No {host} terminal was opened in this session.', // 本会话没有打开过{host}终端。
    viewReport: 'View report', // 查看报告
    notInState: 'Terminals are not available in this state', // 本状态下不提供终端
    keptNote: 'While the environment is kept there is no terminal or console access. To keep working, start a new session that reuses this environment.', // 保留期间没有终端与控制台访问。要继续操作，请开始一个复用该环境的新会话。
    afterReady: 'Available once the environment is ready.', // 环境就绪后可用。
    ended: 'The session has ended.', // 会话已结束。
    manageKeep: 'Manage keep', // 管理保留
    loadFailed: 'The terminal component failed to load. Reload the page.', // 终端组件加载失败，请刷新页面。
  },
  provision: {
    phase: {
      done: 'Done', // 完成
      running: 'In progress', // 进行中
      todo: 'Not started', // 未开始
      retrying: 'Retrying', // 重试中
      queued: 'Queued', // 排队中
      failed: 'Failed', // 失败
      skipped: 'Skipped', // 跳过
    },
    phaseDone: '{title}: done', // {title}已完成
    phaseDoneTook: '{title}: done in {t}', // {title}已完成，用时 {t}
    region: 'Provisioning progress', // 准备进度
    title: 'Preparing your lab environment', // 正在准备实验环境
    class: 'Setup time: {name} ({cls})', // 环境准备：{name}（{cls}）
    elapsedLabel: 'Elapsed', // 已用时间
    defaultNote: 'Setup time depends on the resources in the start state.', // 起始状态包含的资源决定准备时间。
    archTitle: 'Lab environment', // 实验环境构成
    archCaption: 'The “at start” environment is being prepared. After this card it becomes the layout on the right (or below).', // 正在准备“开始时”的环境；完成本卡后变为右侧（或下方）的构成。
    factsLabel: 'Good to know while you wait', // 准备期间须知
    tileBilling: 'Billing starts on creation', // 创建即开始计费
    tileCountdown: 'Countdown starts when ready', // 倒计时从就绪开始
    tileLeave: 'You can leave this page', // 可以离开此页面
    more: 'Details', // 详细说明
    phases: 'Provisioning stages', // 准备阶段
    queued: 'Waiting for a runner (CodeBuild concurrency is full)', // 运行器排队中（CodeBuild 并发已满）
    slow: 'Taking longer than usual. The platform stops and releases created resources automatically before it times out.', // 比通常更久。平台会在超时前自动停止并释放已创建的资源。
    billing: 'Billing: charges start as soon as the environment is created ({estimate}). The countdown starts when it is “Ready”.', // 计费：环境创建开始即计费（{estimate}），倒计时从“就绪”开始。
    billingHourly: '{range}/hour, estimated', // {range}/小时，估算
    billingQuote: 'see the quote shown at start', // 估算见开始时的报价
    leave: 'You can leave this page: provisioning continues in the background. When it is ready the top bar shows it and an email is sent (if you confirmed the subscription). Browser notifications are best effort.', // 可以离开这个页面：准备在后台进行。就绪后顶栏会提示，也会发送邮件（需已确认订阅）。浏览器通知只能尽力送达。
    notifOn: 'Browser notifications on', // 已开启浏览器通知
    notifDenied: 'The browser blocked notifications. You can allow them again in the browser settings', // 浏览器拒绝了通知，可以在浏览器设置中重新允许
    enableNotif: 'Turn on browser notifications', // 开启浏览器通知
    reallow: 'You can allow them again in the browser settings.', // 可以在浏览器设置中重新允许。
    cancel: 'Cancel…', // 取消…
    ready: 'Environment ready', // 环境已就绪
    readyTook: ' (took {t})', // （用时 {t}）
    countdownStarted: '; the {t} countdown has started', // ，倒计时 {t} 已开始
    cancelProgress: 'Cancellation progress', // 取消进度
    startFailed: 'Start failed', // 启动失败
    cancelled: 'Lab cancelled', // 已取消实验
    failedReleased: 'Start failed; created resources were released', // 启动失败，已释放已创建的资源
    cancelling: 'Cancelling: releasing created resources', // 正在取消：释放已创建的资源
    failedReleasing: 'Start failed: releasing created resources', // 启动失败：正在释放已创建的资源
    released: 'Created resources released', // 已释放已创建的资源
    releasing: 'Releasing created resources', // 正在释放已创建的资源
    deleted: '{n}/{m} deleted', // 已删除 {n}/{m}
    endedNote: 'This attempt does not count. Charges incurred while provisioning are not refunded.', // 这次尝试不计入次数。准备期间产生的费用不会退回。
    releasingNote: 'Releasing continues in the background, so you can leave this page. You cannot start a new lab until it finishes.', // 释放在后台进行，可以离开这个页面。释放完成前不能开始新的实验。
    restart: 'Start over', // 重新开始
    viewReclaim: 'View reclaim progress', // 查看回收进度
    backToCatalog: 'Back to the card catalog', // 回到卡片目录
    diagnostics: 'Diagnostics', // 诊断信息
    compensation: 'Compensating cleanup', // 补偿回收
    notReleased: 'Some resources were not released', // 有资源未释放
    viewList: 'View list', // 查看清单
    fresh: 'Start fresh', // 全新开始
    viewCurrent: 'View current lab', // 查看当前实验
    copyDiag: 'Copy diagnostics', // 复制诊断信息
    restartNote: 'This attempt does not count. Starting over returns to the intro page and opens the start dialog (a new quote is required).', // 这次尝试不计入次数。重新开始会回到简介页并打开开始对话框（必须重新报价）。
    cancelDialog: 'Cancel', // 取消
    copiedDiag: 'Diagnostics copied', // 已复制诊断信息
    clipboardDenied: 'Cannot access the clipboard', // 无法访问剪贴板
    copyRaw: 'Copy raw text', // 复制原文
    diagWarning: 'Diagnostics contain raw values such as your AWS account ID and resource ARNs to help troubleshooting. Mask them before sharing with others.', // 诊断信息包含 AWS 账号 ID、资源 ARN 等原文，便于排查；分享给他人前请自行打码。
  },
  exp: {
    reason: {
      OUT_OF_WINDOW: 'Outside the registered time window', // 不在登记的时间窗内
      DRIVER_MISMATCH: 'The runtime driver does not match this variant', // 运行时驱动与该变体要求不符
      NOT_CORROBORATED: 'The server did not see enough requests', // 服务端没有看到足够的请求
      PATH_RATIO: 'Not enough requests took the expected path', // 路径占比不足
      TOO_FEW_SAMPLES: 'Too few samples', // 样本不足
      OUTPUT_TRUNCATED: 'Output was truncated', // 输出被截断
      DELIVERY_MISMATCH: 'Delivery target does not match the requirement', // 投递位置与要求不符
      LABEL_NOT_IN_LAB: 'Variant is not declared by the card', // 变体不在卡片声明中
    },
    variantStatus: {
      none: 'No records yet', // 还没有记录
      registered: 'Running or not uploaded', // 运行中或未上传
      'stale-registered': 'The upload may have failed: check the runner output in the workbench terminal', // 可能上传失败：请看工作台终端中运行器的输出
      uploaded: 'Uploaded, waiting for validation', // 已上传，等待校验
      'pending-crosscheck': 'Cross-checking (server metrics can lag by a few minutes; rechecked automatically)', // 交叉校验中（服务端指标可能有数分钟延迟，稍后自动复核）
      valid: 'Valid', // 有效
      simulated: 'Simulated baseline (measured out of band)', // 模拟基线（旁路补测）
      invalid: 'Invalid', // 无效
    },
    deltaSame: 'No clear difference', // 差异不明显
    deltaDown: '▼ Down', // ▼ 下降
    deltaUp: '▲ Up', // ▲ 上升
    faster: ' · faster', //  · 更快
    slower: ' · slower', //  · 更慢
    toZero: '▼ to 0', // ▼ 变为 0
    cmpScenario: 'different scenarios', // 场景不一致
    cmpParams: 'different parameters', // 参数不一致
    cmpInstanceType: 'different instance types', // 实例类型不一致
    cmpVariant: 'different start variants', // 起始变体不一致
    cmpForced: 'a forced run was used', // 使用了强制运行
    role: {
      baseline: 'baseline', // baseline · 基线
      treatment: 'treatment', // treatment · 处理
      single: 'single run', // single · 一次性
    },
    track: {
      registered: 'Registered', // 已登记
      uploaded: 'Uploaded', // 已上传
      crosscheck: 'Cross-checking', // 交叉校验中
      result: 'Result', // 结论
    },
    drawerTitle: 'Comparison experiment · {key}', // 对比实验 · {key}
    notFoundTitle: 'Experiment not found', // 没有找到这个实验
    notFound: 'Card {labId} does not declare the comparison experiment {key}.', // 卡片 {labId} 没有声明对比实验 {key}。
    crumb: '{labId} › Comparison experiment · {key} ({req})', // {labId} › 对比实验 · {key}（{req}）
    required: 'required', // 必做
    optional: 'optional', // 选做
    session: 'Session {sid}', // 会话 {sid}
    cloudshell: 'In saving mode comparison results cannot be uploaded, so the related checks are downgraded by rule.', // 省钱模式下对比实验结果无法上传，相关检查只能按规则降级。
    ending: 'The lab has ended: uploads from runs registered before the end are still accepted.', // 实验已结束：进入结束前已登记的运行仍会接收上传。
    noRuns: 'This experiment has not been run yet', // 还没有运行这个实验
    noRunsHint: 'First run {a} in the workbench terminal, then run {b} after wiring the app.', // 先在工作台终端运行{a}，再完成接入应用后运行{b}。
    chart: 'Chart', // 图表
    bars: 'Bar comparison', // 条形对照
    table: 'View data table', // 查看数据表
    directionNote: 'The direction of a difference only shows change, not better or worse: higher per-request latency after enabling a managed service can be the correct result.', // 差异方向只说明变化，不代表好坏：启用托管服务后单次延迟变高也可能是正确结论。
    noMetrics: 'The selected records have no comparable metrics yet (they appear after upload and cross-check).', // 所选记录还没有可比较的指标（上传与交叉校验完成后显示）。
    pair: 'Pair {a} ↔ {b}', // 成对比较 {a} ↔ {b}
    missing: 'Missing {list}', // 缺少 {list}
    and: ' and ', //  和 
    comparable: 'Comparable (same scenario, parameters, instance type and start variant; neither is a forced run)', // 可比（场景、参数、实例类型、起始变体一致；都不是强制运行）
    notComparable: 'Not comparable: {list}', // 不可比：{list}
    listSep: ', ', // 、
    howToRun: 'How to run (in the workbench terminal)', // 怎么运行（在工作台终端）
    readOnly: 'Read-only: your role cannot use the workbench terminal.', // 只读：你的角色不能使用工作台终端。
    crossSession: 'Cross-session comparison (against {label} from an earlier session)', // 跨会话对比（与之前会话的 {label} 比较）
    roleTitle: ' ({role})', // （{role}）
    fromSession: ' · from session {sid}', //  · 来自会话 {sid}
    invalid: 'Invalid: {list}', // 无效：{list}
    runsCount: '{n, plural, one {# record} other {# records}}', // 记录 {n} 次
    pickRun: 'Choose a {label} record', // 选择 {label} 的记录
    registered: 'Registered', // 已登记
    uploadProgress: 'Upload progress', // 上传进度
    colMetric: 'Metric', // 指标
    colDelta: 'Difference', // 差异
    clientServer: 'Client {client} · server {server}', // 客户端 {client} · 服务端 {server}
    mismatch: ' ▲ client and server counts disagree', //  ▲ 客户端与服务端统计不一致
    chartDesc: 'Bar comparison: {desc}', // 条形对照：{desc}
    descSep: '; ', // ；
    descItemSep: ', ', // ，
    validity: 'Validity', // 有效性校验
    waitUpload: '◷ Waiting for upload and validation', // ◷ 等待上传与校验
    validAll: '✓ Structure, registration, time window, driver and server corroboration all passed', // ✓ 结构、登记、时间窗、驱动与服务端佐证都通过
    simulated: '◐ Simulated baseline (measured out of band); weaker evidence', // ◐ 模拟基线（旁路补测），证据权重较低
    crosscheckWait: '◷ Waiting for server corroboration (metrics can lag by a few minutes)', // ◷ 服务端佐证等待中（指标可能有数分钟延迟）
    invalidShort: 'Invalid', // 无效
    functional: 'Functional experiment: valid if the checks below pass within the experiment time window.', // 功能型实验：以下检查在实验时间窗内通过即视为有效。
    pass: '✓ Pass', // ✓ 通过
    notRun: 'Not checked', // 未检测
    noPrevious: 'No earlier session has a record of this variant.', // 之前的会话里没有这个变体的记录。
    pickPrevious: 'Choose a record from an earlier session', // 选择之前会话的记录
    none: '(none)', // （不使用）
    prevOption: '{t} · session {sid} · {status}', // {t} · 会话 {sid} · {status}
    descItem: '{label}: {values}', // {label}：{values}
  },
  checkDrawer: {
    basis: {
      stack: 'stack member', // 栈成员
      ledger: 'ledger', // 台账
      parent: 'parent resource', // 父资源
      lookup: 'targeted scan (CloudTrail)', // 定向扫描（CloudTrail）
    },
    title: 'Check details: {name}', // 检查详情：{name}
    verdict: 'Verdict', // 结论
    how: 'How it was judged', // 判定方式
    manual: 'Manual', // 手动
    manualSub: 'Manual ({sub})', // 手动（{sub}）
    sub: {
      native: 'native', // 原生
      degraded: 'degraded', // 降级
      evidence: 'with evidence', // 带证据
    },
    auto: 'Automatic', // 自动
    source: 'Source', // 来源
    executor: 'Run by', // 执行者
    manualLearner: 'The learner who submitted the manual confirmation', // 提交手动确认的学员
    executorRole: '{role} (atl-{sid}-verify)', // {role}（atl-{sid}-verify）
    time: 'Time', // 时间
    review: 'Review', // 复核
    reviewed: 'Reviewed by an assistant', // 助教已复核
    rejected: 'Sent back', // 被打回
    comment: ': {text}', // ：{text}
    ownershipPending: 'Confirming that you created this resource in this lab (CloudTrail usually takes a few minutes, not guaranteed). The platform rechecks after 2, 2, 4, 4 and 8 minutes.', // 正在确认这个资源是你在本次实验中创建的（CloudTrail 通常几分钟，不作保证）。平台会按 2、2、4、4、8 分钟的节奏复查。
    checkerError: 'The checker failed. This is not your fault.', // 检测器出错，不是你的问题。
    expectedActual: 'Expected vs actual', // 期望与实际
    colAssertion: 'Assertion', // 断言
    colExpected: 'Expected', // 期望
    colActual: 'Actual', // 实际
    colResult: 'Result', // 结果
    matches: '✓ Matches', // ✓ 符合
    mismatch: '✕ Does not match', // ✕ 不符合
    corroboration: 'Corroboration', // 佐证
    via: ' ({via})', // （{via}）
    optionalTail: ' · optional', //  · 可选
    ownership: 'Ownership', // 归属
    basisLine: 'Basis: {basis}', // 依据：{basis}
    notConfirmed: 'Not confirmed yet', // 尚未确认
    confirming: ' · confirming', //  · 确认中
    raw: 'Raw evidence', // 原始证据
    redactedJson: 'Redacted JSON (masked)', // 脱敏后的 JSON（已打码）
    large: 'The evidence is large, so a summary is shown. The full evidence is in the report export.', // 证据较大，摘要已显示；完整证据可在报告导出中查看。
    noEvidence: 'No evidence yet.', // 还没有证据。
    reproduce: 'Command to reproduce', // 复现命令
    pitfalls: 'Common pitfalls', // 常见错误
    cause: ': {cause}', // ：{cause}
    fix: ' Fix: {fix}', //  处理：{fix}
    history: 'History (last 10)', // 历史（最近 10 次）
    errorCode: ' ({code})', // （{code}）
    drift: ' [!] drift', //  [!] 漂移
    noHistory: 'No check runs yet.', // 还没有检测记录。
    manualConfirm: 'Confirm manually…', // 手动确认…
    approvedAnnounce: 'Approved', // 已通过
    rejectedAnnounce: 'Sent back', // 已打回
    reviewFailed: 'Could not submit the review', // 没能提交复核
    assistantReview: 'Assistant review', // 助教复核
    commentLabel: 'Comment (shown to the learner when sent back)', // 评语（打回时学员会看到）
    approve: 'Approve', // 通过
    reject: 'Send back…', // 打回…
  },
  end: {
    prereq: {
      'route53-hosted-zone': 'Route 53 hosted zone', // Route 53 托管区域
      'ses-identity': 'SES sending identity', // SES 发件身份
      'acm-certificate': 'ACM certificate', // ACM 证书
    },
    quoteFailed: 'Could not calculate the cost of keeping', // 没能计算保留费用
    notAllowed: 'The lab cannot be ended in its current state.', // 当前状态不能结束实验。
    ending: 'Ending the lab', // 正在结束实验
    keepAfter: 'Keep for {n} h after expiry', // 到期后保留 {n} 小时
    releaseAtExpiry: 'Release resources at expiry', // 到期时释放资源
    quoteExpired: 'The cost quote expired and was recalculated. Please confirm again.', // 费用报价已失效，已重新计算，请重新确认。
    stateChanged: 'The session state just changed and has been refreshed.', // 会话状态刚刚变化，已刷新。
    retryable: 'This did not complete. You can retry (retrying will not end the lab twice).', // 没有完成，可以重试（重试不会重复结束）。
    title: 'End lab', // 结束实验
    cancel: 'Cancel', // 取消
    submitting: 'Submitting…', // 正在提交…
    flow: 'After ending: the platform revokes terminal and console access → generates the report → deletes the workbench → (releases or keeps the environment).', // 结束后：平台收回终端与控制台访问 → 生成报告 → 删除工作台 →（释放或保留环境）。
    attempt: 'Attempt status: {state}', // 尝试状态：{state}
    active: 'in progress', // 进行中
    notSubmitted: ' (not submitted). The platform runs a final review automatically when the lab ends, so forgetting to submit costs you nothing.', // （未提交）。结束时平台会自动做一次最终复核，忘记提交也不吃亏。
    period: '.', // 。
    environment: 'Environment', // 环境
    releaseAll: 'Release all resources (recommended)', // 释放全部资源（推荐）
    releaseCost: 'Cost: no new charges after release; until reclaiming finishes (usually a few minutes, longer for CloudFront, RDS and similar), created resources are billed for their actual time. This session has cost {accrued} so far (estimate · Price List · your bill is authoritative).', // 费用：释放后不再新增计费；回收完成前（通常几分钟，CloudFront、RDS 等更久）已创建的资源仍按实际时长计费。本次会话已产生 {accrued}（估算 · Price List · 以账单为准）。
    noEstimate: '(no estimate)', // （估算未提供）
    keep: 'Keep environment', // 保留环境
    keepHours: 'Keep for', // 保留时长
    hours: '{n, plural, one {# hour} other {# hours}}', // {n} 小时
    cardMax: ' (this card allows up to {n} h)', // （本卡片上限 {n} 小时）
    canKeep: 'Can be kept', // 可以保留
    computing: 'Calculating the cost of keeping…', // 正在计算保留费用…
    keepCost: 'Charges continue while kept (estimate): {hourly}/hour × {n} ≈ {total}', // 保留期间持续计费（估算）：{hourly}/小时 × {n} ≈ {total}
    keepCostUnknown: 'Charges continue while kept: the hourly price is not available, so the cost of keeping cannot be estimated.', // 保留期间持续计费：每小时单价暂不可得，无法估算保留的费用。
    priceAsOf: 'Prices as of {t} · AWS pricing and your bill are authoritative', // 取价时间 {t} · 以 AWS 官方定价与账单为准
    notProvided: 'not available', // 未提供
    quoteExpiredShort: ' · quote expired', //  · 报价已失效
    quoteExpiresIn: ' · quote expires in {t}', //  · 报价 {t} 后失效
    recompute: 'Recalculate cost', // 重新计算费用
    saveMode: 'Saving mode (on by default): stops the lab instance; {tail}', // 节省模式（默认开启）：停止实验机；{tail}
    nonStoppable: 'These resources cannot be stopped and keep being billed:', // 以下资源停不了，会继续计费：
    nonStoppableGeneric: 'Resources that cannot be stopped (such as Elastic IPs, EBS data volumes and request-billed services) keep being billed.', // 停不了的资源（例如弹性 IP、EBS 数据卷、按请求计费的服务）会继续计费。
    noAccess: 'No terminal or console while kept; to keep working, start a new session that reuses the environment.', // 保留期间没有终端与控制台；要继续操作，请开始一个复用该环境的新会话。
    ackKeep: 'I understand these resources keep being billed while kept', // 我了解保留期间这些资源会持续计费
    typeId: 'Type the card ID to confirm:', // 请输入卡片 id 以确认：
    typeIdHint: 'The hourly estimate is relatively high. Type {labId} to confirm', // 每小时估算较高，输入 {labId} 确认
    prereqs: 'Prerequisite resources (optional to keep; not released with the environment)', // 前置资源（可选保留，不随环境释放）
    when: 'When', // 何时
    now: 'End now', // 现在结束
    atExpiry: 'At expiry, as chosen above', // 到期时按上面的选择处理
    atExpiryTime: 'At expiry ({t}), as chosen above', // 到期时按上面的选择处理（{t}）
    defaultNote: 'Release is the default. After ending you go to the reclaim progress page.', // 释放是默认选择；结束后会跳到回收进度页。
  },
  console: {
    link: {
      's3.bucket': 'S3 · photo bucket', // S3 · 照片桶
      'cloudfront.distribution': 'CloudFront · distribution', // CloudFront · 分配
      'ec2.instance': 'EC2 · lab instance', // EC2 · 实验机
      'iam.role': 'IAM · role', // IAM · 角色
      'sqs.queue': 'SQS · queue', // SQS · 队列
      'rds.instance': 'RDS · DB instance', // RDS · 数据库实例
    },
    opened: 'AWS console opened in a new tab', // 已在新标签页打开 AWS 控制台
    errState: 'The lab has ended and console access was revoked.', // 实验已结束，控制台访问已收回。
    errDestination: 'This page is not on the allow list.', // 该页面不在允许列表中。
    errFederation: 'Federated sign-in failed. You can retry.', // 联合登录失败，可以重试。
    errReauth: 'This action requires a sign-in within the last 60 minutes. Sign in again and retry.', // 这个操作要求最近 60 分钟内登录过，请重新登录后再试。
    errNotImplemented: 'Console sign-in is temporarily unavailable (the platform does not provide console federation yet).', // 控制台登录暂时不可用（平台还没有提供控制台联合登录）。
    errRate: 'Too many requests. Try again shortly.', // 操作太频繁，请稍后重试。
    errOther: 'Could not get a console sign-in ({title}).', // 没能取得控制台登录（{title}）。
    errNetwork: 'Could not get a console sign-in. Check your network and retry.', // 没能取得控制台登录，请检查网络后重试。
    cleanupFailedOnly: 'Only console links for the items on the manual cleanup list are offered (no new federated sign-in is issued)', // 只提供待人工处理清单中各项的控制台深链（不签发新的联合登录）
    revoked: 'The lab has ended and console access was revoked', // 实验已结束，控制台访问已收回
    permissionsRevoked: 'Permissions in console windows that are already open have been revoked.', // 已打开的控制台窗口中的权限已被收回。
    viewManual: 'View manual cleanup list', // 查看待人工处理清单
    title: 'AWS console (opens in a new tab; AWS does not allow embedding)', // AWS 控制台（新标签页打开，AWS 不允许嵌入）
    identity: 'Identity', // 身份
    identityValue: 'ATLLearnerRole · session name atl-{sid}-console', // ATLLearnerRole · 会话名 atl-{sid}-console
    region: 'Region', // 区域
    lastIssued: 'Last issued', // 上次签发
    issued: '{t} · console session valid until {until} (1 hour at most; renew after it expires)', // {t} · 控制台会话到 {until}（最长 1 小时，到期后需要续期）
    notIssued: 'Not issued yet (a console session lasts 1 hour at most; renew after it expires)', // 尚未签发（控制台会话最长 1 小时，到期后需要续期）
    soon: 'Less than 10 minutes left', // 剩余不足 10 分钟
    expired: 'Console session expired', // 控制台会话已到期
    expiringNote: 'The console session may expire before the lab ends.', // 控制台会话可能先于实验结束失效。
    gettingLogin: 'Getting sign-in…', // 正在获取登录…
    open: 'Open AWS console in a new tab', // 在新标签页打开 AWS 控制台
    renew: 'Renew', // 续期
    popupBlocked: 'The browser blocked the new window.', // 浏览器拦截了新窗口。
    refetchOpen: 'Get a new sign-in and open', // 重新获取并打开
    openInNewTab: 'Open in a new tab', // 在新标签页打开
    linkValidity: '(use the sign-in link within 10 minutes; after that a new one is fetched automatically)', // （登录链接取得后 10 分钟内使用，超过后自动重新获取）
    commonPages: 'Pages this card uses often', // 本卡片常用页面
    usedBySteps: 'Used in steps {list}', // 步骤 {list} 用到
    listSep: ', ', // 、
    reLogin: 'Sign in again as the learner', // 以学员身份重新登录
    cloudTrailNote: 'Actions in the console are recorded by CloudTrail. When the lab ends, resources you created by hand in this lab are reclaimed. For resources you just created in the console, the platform needs a few minutes to confirm ownership (checks show “Confirming ownership”).', // 控制台中的操作会被 CloudTrail 记录；结束实验时，本次实验中手动创建的资源会被回收。刚在控制台创建的资源，平台需要几分钟才能确认归属（检测时显示“归属确认中”）。
    profileNote: 'If the browser is already signed in to your own AWS identity, federated sign-in replaces that console session. A separate browser profile is recommended.', // 浏览器里若已登录你自己的 AWS 身份，联合登录会替换当前控制台会话。建议用单独的浏览器配置文件。
  },
  cost: {
    title: 'Cost meter (estimate)', // 费用计（估算）
    hourly: 'Per hour', // 每小时
    perHour: '{range}/hour', // {range}/小时
    accrued: 'So far', // 已产生
    notProvided: 'not available', // 未提供
    priceAsOf: 'Prices as of', // 取价时间
    incomplete: '{n, plural, one {Incomplete estimate: # price is unavailable.} other {Incomplete estimate: # prices are unavailable.}}', // 估算不完整：{n} 项单价不可得。
    billable: 'Resources billed now', // 当前计费的资源
    resource: 'Resource', // 资源
    learnerCreated: ' · created by you', //  · 你手动创建
    noBillable: 'No hourly or usage-billed resources recorded.', // 没有记录到按小时或按量计费的资源。
    unestimated: '+ {n} manually created resource(s) not estimated', // + 未估算的手工资源 {n} 项
    consoleNote: 'Resources newly created in the console and not yet confirmed by a check may be missing here.', // 控制台中新建、尚未经检测确认的资源可能不在此列。
    disclaimer: 'Estimate only; your AWS bill is authoritative.', // 估算值，以 AWS 账单为准。
    billNote: 'Your AWS bill is authoritative.', // 以 AWS 账单为准。
  },
  shortcuts: {
    switchPane: 'Switch to the lab terminal / workbench terminal / AWS console / app preview', // 切换到 实验机终端 / 工作台终端 / AWS 控制台 / 应用预览
    manual: 'Back to the current step in the manual (leave the terminal)', // 回到手册当前步骤（离开终端）
    terminal: 'Focus the current terminal', // 焦点到当前终端
    check: 'Check the current step', // 检测当前步骤
    nextPrev: 'Next / previous step', // 下一步 / 上一步
    splitter: 'Move the divider 64px left / right', // 分隔条左移 / 右移 64px
    splitterReset: 'Reset the divider', // 分隔条复位
    collapse: 'Collapse / expand the manual', // 折叠 / 展开手册
    screenReader: 'Toggle terminal screen reader mode', // 切换终端读屏模式
    help: 'Shortcut help', // 快捷键帮助
    passThrough: 'Send Ctrl+. to the terminal as is', // 把 Ctrl+. 原样交给终端
    copyPaste: 'Copy / paste in the terminal', // 终端中复制 / 粘贴
    whenManualFocused: '{key} (when the manual has focus)', // {key}（手册聚焦时）
    title: 'Workbench shortcuts', // 工作台快捷键
    close: 'Close', // 关闭
    intro: 'Press the leader key {leader} first, then the second key within 1.5 seconds. The leader key also works inside the terminal; you can change it in “Terminal settings”.', // 先按前导键 {leader}，1.5 秒内再按第二个键。前导键在终端中同样生效；可以在“终端设置”中更换。
  },
  termSettings: {
    title: 'Terminal settings', // 终端设置
    cancel: 'Cancel', // 取消
    save: 'Save', // 保存
    fontSize: 'Font size', // 字号
    screenReader: 'Screen reader mode (keeps an accessible line buffer of the terminal output; costs some rendering performance)', // 读屏模式（为终端输出维护可访问的行缓冲，有渲染开销）
    leader: 'Leader key', // 前导键
    execute: 'Offer “Paste and run” in the “Paste to terminal” menu (always asks for confirmation; not allowed for dangerous commands)', // 在“粘贴到终端”的菜单中提供“粘贴并执行”（每次都会确认；危险命令不允许）
  },
  preview: {
    reason: {
      MIXED_CONTENT: 'The current entry is HTTP only, so the browser would block it as mixed content when embedded. When this card starts from a self-signed or ALB HTTP entry, the preview opens in a new tab.', // 当前入口只有 HTTP，嵌入会被浏览器作为混合内容拦截。本卡片从自签名 / ALB 的 HTTP 入口讲起时，预览在新标签页打开。
      MIXED_CONTENT_HINT: 'To preview here: use an entry with trusted HTTPS, for example switch to the CloudFront entry after enabling cdn.', // 如何在此处直接预览：使用受信任 HTTPS 的入口，例如启用 cdn 后改用 CloudFront 入口。
      UNTRUSTED_CERT: 'The browser does not trust the entry\'s certificate (for example a self-signed one), so it cannot be embedded. Ignoring the certificate warning in a new tab is not recommended.', // 入口的证书不受浏览器信任（例如自签名），无法嵌入。不建议在新标签页中忽略证书警告。
      FRAME_ANCESTORS_MISSING: 'The app does not allow the platform to embed it (CSP frame-ancestors).', // 应用没有允许平台嵌入（CSP frame-ancestors）。
      X_FRAME_OPTIONS: 'The app does not allow the platform to embed it (X-Frame-Options).', // 应用没有允许平台嵌入（X-Frame-Options）。
      UNREACHABLE: 'The entry is temporarily unreachable (the instance is stopped, the security group was tightened, or an IP change exercise is in progress).', // 入口暂时无法访问（实例停止、安全组收紧或换 IP 演练期间）。
    },
    entry: {
      direct: 'Direct to EC2', // 直连 EC2
      app: 'App entry', // 应用入口
      cdn: 'CloudFront', // CloudFront
      alb: 'Load balancer', // 负载均衡器
      'custom-domain': 'Custom domain', // 自定义域名
    },
    unavailable: 'Preview unavailable: the environment is stopped or released.', // 预览不可用：环境已停止或已释放。
    loadFailed: 'Could not load the preview entries.', // 读取预览入口失败。
    noEntry: 'No app entry is available yet.', // 还没有可用的应用入口。
    notEmbeddable: 'This entry cannot be embedded in the preview.', // 这个入口不能嵌入预览。
    entryLabel: 'Entry', // 入口
    embeddable: '✓ Embeddable', // ✓ 可嵌入
    newTabOnly: '✕ New tab only', // ✕ 仅新标签页
    path: 'Path', // 路径
    refresh: 'Refresh preview', // 刷新预览
    newTab: 'New tab', // 新标签页
    viewport: 'Viewport width', // 视口宽度
    auto: 'Auto', // 自适应
    adminAccount: 'Admin account', // 管理员账号
    frameTitle: 'CloudAlbum app preview ({entry})', // CloudAlbum 应用预览（{entry}）
    loginNote: 'The CloudAlbum sign-in in the preview frame is separate from the one in a new tab. Some browsers (including some Safari versions) cannot keep you signed in inside the frame; use a new tab instead.', // 预览框内与新标签页中的 CloudAlbum 登录状态互相独立；部分浏览器（含部分 Safari 版本）在预览框内无法保持登录，请改用新标签页。
    narrow: 'On narrow screens the preview opens in a new tab', // 窄屏下预览在新标签页打开
    cannotPreview: 'Cannot preview here', // 无法在此处预览
    retry: 'Retry', // 重试
    openNewTab: 'Open in a new tab', // 在新标签页打开
    reauth: 'Viewing the admin password requires a sign-in within the last 60 minutes.', // 查看管理员密码要求最近 60 分钟内登录过。
    notImplemented: 'The platform cannot provide the admin account at the moment.', // 平台暂时不能提供管理员账号。
    readFailed: 'Could not load', // 读取失败
    credTitle: 'CloudAlbum admin account', // CloudAlbum 管理员账号
    close: 'Close', // 关闭
    username: 'User name', // 用户名
    password: 'Initial password', // 初始密码
    show10s: 'Show for 10 seconds', // 显示 10 秒
    copiedPassword: 'Password copied', // 已复制密码
    clipboardDenied: 'Cannot access the clipboard', // 无法访问剪贴板
    copy: 'Copy', // 复制
    passwordNote: 'The password is shown only in this dialog and is cleared from page memory when you close it.', // 密码只在这个对话框中显示，关闭后从页面内存中清除。
  },
  bar: {
    catalog: '‹ Catalog', // ‹ 目录
    heading: 'Workbench · {title}', // 工作台 · {title}
    scenario: 'Scenario', // 场景
    service: 'Service', // 服务
    variant: ' · variant {v}', //  · 变体 {v}
    elapsedLabel: 'Elapsed', // 已用时间
    notStarted: 'Countdown not started yet', // 倒计时未开始
    readyRemaining: 'Environment ready · remaining', // 环境已就绪 · 剩余
    keepAfter: 'Keep for {n} h after expiry', // 到期后保留 {n} 小时
    releaseAtExpiry: 'Release at expiry', // 到期时释放
    keptUntil: 'until {t}', // 至 {t}
    hourlyEstimate: '{range}/h (estimate)', // {range}/h（估算）
    hourly: '{range}/h', // {range}/h
    noHourly: 'No hourly estimate', // 每小时估算未提供
    costTitle: 'Cost meter (estimate)', // 费用计（估算）
    costAria: 'Cost meter (estimate): {hourly} per hour, {accrued} so far', // 费用计（估算）：每小时 {hourly}，已产生 {accrued}
    costAriaHourly: 'Cost meter (estimate): {hourly} per hour', // 费用计（估算）：每小时 {hourly}
    notProvided: 'n/a', // 未提供
    extend: 'Extend by {n} minutes ({left} left)', // 延长 {n} 分钟（剩 {left} 次）
    extendShort: '+{n} min', // +{n} 分钟
    extendLeft: '{left} left', // 剩 {left} 次
    extendedMax: '{n, plural, one {Extended # time (limit)} other {Extended # times (limit)}}', // 已延长 {n} 次（上限）
    canExtend: 'Can be extended', // 可以延长
    end: 'End lab…', // 结束实验…
    cancel: 'Cancel…', // 取消…
    more: 'More', // 更多
    costDetail: 'Cost meter details', // 费用计明细
    shortcuts: 'Shortcut help', // 快捷键帮助
    termSettings: 'Terminal settings…', // 终端设置…
    theme: 'Theme', // 主题
    themeItem: 'Theme: {v}', // 主题：{v}
    language: 'Display language', // 界面语言
    sessionDetail: 'Session details', // 会话详情
    adminAccount: 'Show the CloudAlbum admin account', // 查看 CloudAlbum 管理员账号
    catalogNav: 'Card catalog (site navigation)', // 卡片目录（全站导航）
    targets: 'Services this card enables, in order', // 本卡将依次启用的服务
    targetDone: 'wired', // 已接入
  },
  banners: {
    t15: '{n} minutes left (expires at {t}). At expiry access is revoked and resources are released.', // 剩余 {n} 分钟（{t} 到期）。到期后自动收回访问并释放资源。
    extend: 'Extend by {n} minutes', // 延长 {n} 分钟
    canExtend: 'Can be extended', // 可以延长
    keepAtExpiry: 'Keep environment after expiry…', // 到期后保留环境…
    endNow: 'End now…', // 现在结束…
    precheck: 'Pre-expiry check: still missing {list}. The platform runs a final review automatically when the lab ends.', // 到期预检：还差 {list}。结束时平台会自动做最终复核。
    stepNo: 'step {n}', // 第 {n} 步
    listSep: ', ', // 、
    kept: 'Environment kept. There is no terminal or console access while it is kept.', // 环境保留中。保留期间没有终端与控制台访问。
    keptUntil: 'Environment kept until {t}. There is no terminal or console access while it is kept.', // 环境保留中 · 至 {t}。保留期间没有终端与控制台访问。
    manageKeep: 'Manage keep', // 管理保留
    cleanupFailed: 'Release incomplete: some resources could not be deleted automatically and may still be billed.', // 释放未完成：有资源没能自动删除，它们仍可能计费。
    viewList: 'View list', // 查看清单
    archive: 'Ended · read-only archive. Terminals opened in this session are listed in the terminal area on the right.', // 已结束 · 只读存档。本会话打开过的终端列在右侧终端区。
    viewReport: 'View report', // 查看报告
    degraded: 'The lab instance\'s management channel is unreachable: the terminal and local checks are temporarily unavailable.', // 实验机的管理通道不可达：终端与本地检测暂时不可用。
    degradedOutage: ' This step makes the management channel temporarily unreachable: checks show “Channel unreachable”, which is expected. Check again after the window ends ({t}).', //  本步骤会让管理通道暂时不可达：检测会显示“通道不可达”，属预期，窗口结束后（{t}）重新检测即可。
    causes: 'Common causes', // 常见原因
    causesText: 'A deny policy or “Revoke active sessions” was applied to CloudAlbumAppRole; private placement without a NAT or ssm / ssmmessages / ec2messages endpoints; the instance profile was replaced; the Agent was stopped.', // 给 CloudAlbumAppRole 加了拒绝策略或“撤销活动会话”；私有放置缺 NAT 或 ssm / ssmmessages / ec2messages 终端节点；实例配置文件被替换；Agent 被停止。
    repair: 'Repair environment', // 修复环境
    end: 'End lab…', // 结束实验…
    budget: 'This month\'s spending is over budget. The platform will end this lab in 10 minutes.', // 本月费用已超过预算，平台将在 10 分钟后结束本实验。
    moduleOp: 'The platform is changing the environment: {action}', // 平台正在修改环境：{action}
    platformAction: 'Platform action', // 平台动作
    runner: ' (runner {id})', // （运行器 {id}）
    completed: 'Completed (fully automatic).', // 已完成（全自动）。
    completedManual: 'Completed (including manual confirmations).', // 已完成（含手动）。
    badge: 'You earned the “{badge}” badge.', // 获得徽章“{badge}”。
    completedTail: 'You can end and clean up, or keep exploring (the countdown continues).', // 你可以结束并清理，也可以继续探索（倒计时照常）。
    endAndClean: 'End and clean up…', // 结束并清理…
    keepExploring: 'Keep exploring', // 继续探索
    submitFailed: '{n, plural, one {Submission did not pass: # item is still missing. Fix it and submit again.} other {Submission did not pass: # items are still missing. Fix them and submit again.}}', // 提交未通过：还差 {n} 项。修好之后可以再次提交。
    dismiss: 'Dismiss', // 关闭提醒
    region: 'Workbench notices', // 工作台提醒
  },
  extend: {
    limit: 'No extensions or extension time left.', // 延长次数或累计时长已用完。
    quoteFailed: 'Could not calculate the cost. Please retry.', // 没能计算费用，请重试。
    extendedTo: 'Extended to {t}', // 已延长到 {t}
    extended: 'Extended', // 已延长
    quoteExpired: 'The cost quote expired and was recalculated. Please confirm again.', // 费用报价已失效，已重新计算，请重新确认。
    precondition: 'The deadline just changed (perhaps extended in another tab) and has been refreshed.', // 截止时间刚刚变化（可能在另一个标签页延长过），已刷新。
    expired: 'The lab has already expired and cannot be extended.', // 已经到期，无法延长。
    budget: 'This month\'s spending is over budget, so extending is not allowed by the settings.', // 本月费用已超过预算，按设置不能延长。
    uninstalling: 'The platform is being uninstalled; extending is not possible.', // 平台正在卸载，不能延长。
    retryable: 'The extension did not complete. You can retry (retrying will not extend twice).', // 延长没有完成，可以重试（重试不会重复延长）。
    title: 'Extend by {n} minutes', // 延长 {n} 分钟
    cancel: 'Cancel', // 取消
    recompute: 'Recalculate cost', // 重新计算费用
    extending: 'Extending…', // 正在延长…
    retry: 'Retry', // 重试
    computing: 'Calculating the cost…', // 正在计算费用…
    cost: 'Cost (estimate · based on the resources actually enabled now): {hourly}/hour × {h} h ≈ {total}', // 费用（估算 · 按当前环境实际启用的资源）：{hourly}/小时 × {h} 小时 ≈ {total}
    costUnknown: 'Cost (estimate): the hourly price is not available, so this extension cannot be estimated. Resources are billed for actual usage during the extension as usual.', // 费用（估算）：每小时单价暂不可得，无法估算这次延长的费用；延长期间资源照常按实际用量计费。
    incomplete: 'Some prices are unavailable ({n} “unknown”), so the estimate is incomplete.', // 部分单价不可得（{n} 项“未知”），估算不完整。
    priceAsOf: 'Prices as of {t} · AWS pricing and your bill are authoritative', // 取价时间 {t} · 以 AWS 官方定价与账单为准
    notProvided: 'not available', // 未提供
    quoteExpiredShort: ' · quote expired', //  · 报价已失效
    quoteExpiresIn: ' · quote expires in {t}', //  · 报价 {t} 后失效
    budgetWarn: 'This month\'s spending is close to the budget.', // 本月费用已接近预算。
    ack: 'I understand resources keep being billed during the extension', // 我了解延长期间资源继续计费
    ackBudget: 'I know this month\'s spending is close to the budget', // 我知道本月费用已接近预算
  },
  stepCheck: {
    done: 'Step checks finished: {pass} passed', // 本步检测完成：{pass} 项通过
    doneFail: 'Step checks finished: {pass} passed, {fail} failed', // 本步检测完成：{pass} 项通过，{fail} 项未通过
    afterReady: 'Available once the environment is ready', // 环境就绪后可用
    ended: 'The lab has ended; checks can no longer run', // 实验已结束，不能再检测
    title: 'Step checks', // 本步检测
    verifying: 'Verifying…', // 核验中…
    run: 'Check', // 检测
    checks: 'Checks', // 检查
    drift: 'This step passed at {t}; now failing: {what}.', // 这一步曾于 {t} 通过，现在{what}未通过。
    before: 'an earlier time', // 之前
    someChecks: 'some checks', // 有检查
    quoted: '“{list}”', // “{list}”
    quoteSep: '”, “', // ”“
    noPitfalls: 'No common pitfalls are listed for this step', // 本步没有登记常见错误
    troubleshoot: 'Troubleshoot', // 排错
    ackDone: 'Recorded as an intentional change. Submitting still requires this step to pass.', // 已记录：这是有意的改动。提交时仍要求这一步通过。
    ackFailed: 'Could not record it. Try again shortly', // 没能记录，请稍后重试
    intended: 'I changed this on purpose', // 我是有意改动的
    ackNote: 'Confirming only dismisses the notice; submitting still requires a pass.', // 确认只关闭提醒，提交时仍要求通过。
    cmdOk: 'Command finished (exit code 0)', // 命令已完成（退出码 0）
    cmdFailed: 'Command failed (exit code {code})', // 命令失败（退出码 {code}）
    unknown: 'unknown', // 未知
    checkStep: 'Check this step', // 检测本步
    noAuto: 'This step has no automatic checks.', // 本步没有自动检查。
    failedNote: 'A failed check costs no points: fix the issue and check again. The final review at submission decides.', // 未通过不会扣分：修好之后重新检测即可。最终以提交时的复核为准。
    manualLabel: 'Manual confirmation: {title}', // 手动确认：{title}
    manual: 'Confirm manually…', // 手动确认…
    reviewComment: 'Assistant comment: {text}', // 助教评语：{text}
    waited: 'Waited {t}', // 已等待 {t}
    waiting: 'Waiting', // 等待中
    typical: ' · usually about {n} min', //  · 通常需要约 {n} 分钟
    nextCheck: 'Waiting check · next run in {t}', // 等待型检查 · 下次检测 {t} 后
  },
  main: {
    afterReady: 'Available once the environment is ready', // 环境就绪后可用
    termNotReady: 'The terminal is not ready yet', // 终端还没有准备好
    newSubNotConnected: 'The new terminal sub-tab did not connect', // 新的终端子标签没有连上
    notConnected: 'The terminal is not connected yet', // 终端还没有连上
    notConnectedCopied: '{lead}; the command was copied, so you can paste it by hand once connected', // {lead}，命令已复制，可以连上后手动粘贴
    notConnectedCopy: '{lead}; copy the command first and paste it by hand once connected', // {lead}，请先复制命令，连上后手动粘贴
    pasted: 'Pasted into {target} terminal #{no}. Review it, then press Enter to run', // 已粘贴到 {target}终端 #{no}，检查后按 Enter 执行
    ended: 'The lab has ended; checks can no longer run', // 实验已结束，不能再检测
    checkStarted: 'Check started', // 已开始检测
    checkNotStarted: 'The check did not start. Try again shortly', // 检测没有开始，请稍后重试
    labCheckStarted: 'Started checking the whole card', // 已开始检测整张卡片
    labCheckNotStarted: 'The check did not start', // 检测没有开始
    backToManual: 'Back in the manual', // 已回到手册
    readyAnnounce: 'Environment ready; the countdown has started', // 环境已就绪，倒计时已开始
    notifTitle: 'ATL Lab Platform', // ATL 实验平台
    notifReady: 'The lab environment for {labId} is ready', // {labId} 的实验环境已就绪
    notifRemaining: '{labId} has {n} minutes left. At expiry access is revoked and resources are released.', // {labId} 还剩 {n} 分钟，到期后自动收回访问并释放资源。
    srOn: 'Terminal screen reader mode on', // 终端读屏模式已开启
    srOff: 'Terminal screen reader mode off', // 终端读屏模式已关闭
    segProgress: 'Progress', // 进度
    segManual: 'Manual', // 手册
    repairRequested: 'Environment repair requested', // 已请求修复环境
    repairFailed: 'The repair request did not complete', // 修复请求没有完成
    segNav: 'Workbench sections', // 工作台分段
    segShow: 'Show', // 显示
    expandManual: 'Expand manual', // 展开手册
    leaderWait: 'Waiting for the second key…', // 等待第二个键…
    t5Hint: 'An expiry reminder will appear', // 将显示到期提醒
  },
  manual: {
    title: 'Lab manual', // 实验手册
    attempt: 'Attempt: {state}', // 尝试：{state}
    progressLabel: 'Progress', // 进度
    progressAria: 'Progress: {done} of {total} required steps done', // 进度：{done}/{total} 个必需步骤已达成
    submit: 'Submit lab', // 提交实验
    preparing: 'The environment is being prepared: you can read the manual now; “Paste to terminal” and checks become available once it is ready.', // 环境准备中：可以先读手册；“粘贴到终端”与检测会在就绪后可用。
    readOnly: 'Read-only: your role can view the manual and check results{extra}.', // 只读：你的角色可以查看手册与检测结果{extra}。
    readOnlyAssistant: ', run checks and review manual confirmations', // 、运行检测并复核手动确认
    missingTitle: 'Manual content missing', // 手册内容缺失
    missingBody: 'Check it under Settings › Content version.', // 请在 设置 › 内容版本 中检查。
    overview: 'Card overview', // 卡片概览
    prev: '← Previous', // ← 上一步
    afterReady: 'Available once the environment is ready', // 环境就绪后可用
    ended: 'The lab has ended', // 实验已结束
    check: 'Check', // 检测
    next: 'Next →', // 下一步 →
    steps: 'Steps', // 步骤
    allSteps: 'All steps', // 全部步骤
    optional: 'Optional', // 选做
    wait: 'Wait', // 等待
    outage: 'Expected outage', // 预期中断
    billing: 'Billing starts', // 开始计费
  },
  md: {
    method: {
      console: 'Console', // 控制台
      cli: 'CLI', // CLI
      script: 'Script', // 脚本
      code: 'Code', // 代码
    },
    domain: {
      secure: 'Secure', // 安全
      resilient: 'Resilient', // 弹性
      performance: 'High-performing', // 高性能
      cost: 'Cost-optimized', // 成本优化
    },
    fromVar: 'From variable {name}', // 来自变量 {name}
    unfilled: 'Not filled in: {name}', // 未填写：{name}
    methodLabel: 'Method: {m}', // 做法：{m}
    methods: 'Method', // 做法
    done: 'Done', // 已完成
    notDone: 'Not done', // 未完成
    why: 'Why', // 为什么
    reveal: 'Show hint', // 展开提示
    tip: 'Tip', // 提示
    warning: 'Caution', // 注意
    danger: 'Danger', // 危险
    expected: 'Expected result', // 预期结果
    waitTypical: 'Wait: usually about {n} min{max}', // 等待：通常约 {n} 分钟{max}
    waitAuto: 'Waiting checks recheck automatically (after 15, 30, 45 and 60 seconds, then every 60 seconds) and pause while the page is hidden.', // 等待型检查会自动复查（15、30、45、60 秒之后每 60 秒），页面不可见时暂停。
    waitMax: ' (up to {n} min)', // （最长 {n} 分钟）
    more: 'Details', // 展开全文
    less: 'Show less', // 收起
    whySaa: 'Why (SAA)', // 为什么（SAA）
    domainTail: ' · {d}', //  · {d}
    confusable: ' · easily confused', //  · 易混淆
    runsOn: ' · runs on: {where}', //  · 运行于：{where}
    lab: 'lab instance', // 实验机
    workstation: 'workbench', // 工作台
    openConsole: 'Open in the console', // 在控制台打开
    consoleNewTab: ' (AWS console, new tab)', // （AWS 控制台，新标签页）
    tab: {
      'terminal-lab': 'Lab terminal', // 实验机终端
      'terminal-workstation': 'Workbench terminal', // 工作台终端
      console: 'AWS console', // AWS 控制台
      preview: 'App preview', // 应用预览
    },
    switchTo: 'Switch to “{tab}”', // 切换到“{tab}”
  },
  failure: {
    quote: {
      title: 'Cost information updated', // 费用信息已更新
      description: 'The quote expired before the start. No resources were created.', // 报价在开始前失效。没有创建任何资源。
    },
    lockBusy: {
      title: 'Environment in use', // 环境被占用
      description: 'Another lab holds the environment. No resources were created.', // 另一个实验正持有环境。没有创建资源。
    },
    envGone: {
      title: 'The environment to reuse is gone', // 要复用的环境已不可用
      description: 'The kept environment you wanted to reuse was released or is unavailable. No resources were created.', // 要复用的保留环境已释放或不可用。没有创建资源。
    },
    preflight: {
      title: 'Account preflight failed', // 账号预检未通过
      description: 'Check the default VPC, quotas, missing learner inputs and the DR Region settings one by one. No resources were created.', // 逐项检查默认 VPC、配额、缺少的学员输入与灾备区域设置。没有创建任何资源。
    },
    capacity: {
      title: 'Not enough capacity in the Availability Zone', // 可用区容量不足
      description: 'A retry in another Availability Zone also failed. Try again later.', // 已换可用区重试一次仍失败。请稍后再试。
    },
    account: {
      title: 'Account restricted', // 账号受限
      description: 'Below is the raw error from AWS. It may be an organization SCP restriction or an insufficient account quota. Contact your account administrator or request a quota increase.', // 下面是 AWS 返回的原始错误。可能是组织 SCP 的限制或账号配额不足，建议联系账号管理员或申请提高配额。
    },
    base: {
      title: 'Lab instance failed to start', // 实验机启动失败
      description: 'The lab instance did not finish bootstrapping. The diagnostics include a bootstrap log summary and the instance console output.', // 实验机没能完成引导。诊断信息中有引导日志摘要与实例控制台输出。
    },
    definition: {
      title: 'Lab definition error', // 实验定义有误
      description: 'This is a problem with the card content or the platform version, not with anything you did; the administrator (you) has been notified. You can check it under Settings › Content version.', // 这是卡片内容或平台版本的问题，不是你的操作问题，已通知管理员（你）。可以在 设置 › 内容版本 中查看。
    },
    profile: {
      title: 'Start state deployment failed', // 起始状态部署失败
      description: 'Deploying the start state failed. The diagnostics show the failed module or stack and the CloudFormation reason.', // 部署起始状态时失败。诊断信息中有失败的模块或栈与 CloudFormation 原因。
    },
    runner: {
      title: 'Platform runner error', // 平台运行器出错
      description: 'The platform runner could not finish the deployment (retried by rule). If it timed out in the queue, you can request a higher CodeBuild concurrency quota.', // 平台运行器没能完成部署（已按规则重试）。排队超时时，可以申请提高 CodeBuild 并发配额。
    },
    workstation: {
      title: 'Workbench creation failed', // 工作台创建失败
      description: 'The workbench instance could not be created. If the card allows it, start over and choose “Do not start a workbench (CloudShell saving mode)”.', // 工作台实例没能创建。卡片允许时，可以选择“不启动工作台（CloudShell 省钱模式）”重新开始。
    },
    ssm: {
      title: 'Cannot reach the lab instance\'s management channel', // 实验机无法连接管理通道
      description: 'Common causes: the instance profile, the outbound network path, or private placement without a NAT or endpoints.', // 常见原因：实例配置文件、出网路径、私有放置缺 NAT 或终端节点。
    },
    health: {
      title: 'Health check failed', // 健康检查未通过
      description: 'It still failed after one repair. The diagnostics list the failed checks.', // 修复一次后仍未通过。诊断信息中列出了未通过的检查项。
    },
    timeout: {
      title: 'Provisioning timed out', // 准备超时
      description: 'Provisioning took longer than the limit, so the platform stopped and released the created resources automatically.', // 准备时间超过上限，平台已自动停止并释放已创建的资源。
    },
    workflow: {
      title: 'Platform orchestration error', // 平台编排出错
      description: 'The platform orchestration failed and a manual cleanup list was created; the platform retries reclaiming automatically.', // 平台编排出错，已生成待人工处理清单；平台会自动重试回收。
    },
    fallback: {
      title: 'Start failed', // 启动失败
      description: 'The platform could not finish provisioning. The raw error is below.', // 平台没能完成准备。下面是原始错误。
    },
    regionPlaceholder: '<region>', // <区域>
  },
  phases: {
    title: {
      validate: 'Validate and preflight', // 校验与预检
      base: 'Create base environment', // 创建基础环境
      profile: 'Deploy lab start state', // 部署实验起始状态
      connect: 'Connect to lab instance (SSM)', // 连接实验机（SSM）
      health: 'Health check', // 健康检查
      ready: 'Ready, timer starts', // 就绪，开始计时
    },
    slow: {
      elasticache: 'ElastiCache replication group', // ElastiCache 复制组
      cloudfront: 'CloudFront distribution', // CloudFront 分配
      asg: 'Auto Scaling group', // Auto Scaling 组
    },
    fallbackVariant: 'Switched to the fallback profile {name}', // 已改用回退档 {name}
    reuse: 'Taking over the kept environment', // 正在接管保留的环境
    healthFix: 'Health check failed; repairing once', // 健康检查未通过，正在修复一次
    reboot: 'Rebooting the lab instance, then retrying', // 正在重启实验机后重试
    queued: 'Waiting for a runner (CodeBuild concurrency is full)', // 运行器排队中（CodeBuild 并发已满）
    retryAz: 'Retrying in another Availability Zone', // 正在换可用区重试
    moduleIdx: 'Module {i}/{n} · {module}', // 模块 {i}/{n} · {module}
    module: 'Module {module}', // 模块 {module}
    resourceParen: ' ({text})', // （{text}）
    processing: 'Processing: {line}', // 正在处理：{line}
    slowHint: '{name} is usually the slowest part. Meanwhile you can read sections 1–2 of the manual.', // {name}通常是最慢的一步。可以先阅读手册第 1～2 节。
    profileName: 'Start profile {name}', // 起始档位 {name}
    instances: 'Lab instance {lab} · workbench {ws}', // 实验机 {lab} · 工作台 {ws}
  },
  expiry: {
    extend: {
      state: 'The lab has expired or is ending and cannot be extended.', // 实验已到期或正在结束，无法延长。
      none: 'The maximum number of extensions has been used.', // 已延长到上限次数。
      last30s: 'The lab is about to expire and cannot be extended.', // 即将到期，无法延长。
      cap: 'The total time limit for one lab has been reached.', // 已达到单次实验总时长上限。
      uninstalling: 'The platform is being uninstalled; extending is not possible.', // 平台正在卸载，不能延长。
      budget: 'This month\'s spending is over budget; extending is not possible.', // 本月费用已超过预算，不能延长。
      role: 'Your role cannot extend the lab.', // 你的角色不能延长实验。
    },
    keep: {
      'not-allowed': 'This card does not allow keeping the environment; it can only be released.', // 本卡片不允许保留环境，只能释放。
      degraded: 'An unhealthy environment cannot be kept; it can only be released.', // 环境异常时不能保留，只能释放。
      uninstalling: 'The platform is being uninstalled: running labs will be ended and cannot be kept.', // 平台正在卸载，进行中的实验会被结束，不允许保留。
      budget: 'This month\'s spending is over budget; the environment can only be released.', // 本月费用已超过预算，只能释放。
      'env-age': 'The environment has reached its maximum lifetime; it can only be released.', // 环境已超过最长寿命，只能释放。
      state: 'The environment cannot be kept in the current state.', // 当前状态不能保留环境。
    },
    endKeep: 'End and keep the environment for {n} h', // 结束并保留环境 {n} 小时
    endRelease: 'End and release resources', // 结束并释放资源
    expiryKeep: 'Keep for {n} h at expiry', // 到期时保留 {n} 小时
    expiryRelease: 'Release at expiry', // 到期时释放
    nth: 'extension {n}', // 第 {n} 次
    last: 'this is the last extension', // 这是最后一次延长
    more: '{n} more allowed', // 还可以再延长 {n} 次
    latest: '; this lab can run until {t} at the latest', // ；本次实验最晚到 {t}
    summary: 'After extending, the lab expires at {after} ({nth}, {more}{latest}).', // 延长后 {after} 到期（{nth}，{more}{latest}）。
  },
  labText: {
    stepType: {
      console: 'Console', // 控制台
      cli: 'CLI', // CLI
      script: 'Script', // 脚本
      code: 'Code', // 代码
      observe: 'Observe', // 观察
      experiment: 'Experiment', // 对比实验
    },
    provisionName: {
      A: 'Fast', // 较快
      B: 'Moderate', // 中等
      C: 'Slow', // 较慢
      D: 'Very slow', // 很慢
    },
    provisionNote: {
      A: 'This card\'s start state has only L0 and quick-to-create resources (A).', // 本卡片的起始状态只有 L0 与快速创建的资源（A）。
      B: 'This card\'s start state includes slower resources such as CloudFront, an ALB or instance replacement (B).', // 本卡片的起始状态包含 CloudFront、ALB、实例替换等较慢的资源（B）。
      C: 'This card\'s start state includes RDS or ElastiCache and usually takes a while (C).', // 本卡片的起始状态包含 RDS 或 ElastiCache，通常需要较长时间（C）。
      D: 'This card\'s start state includes RDS / ElastiCache and other slow resources and usually takes a long time (D).', // 本卡片的起始状态包含 RDS / ElastiCache 与其他慢资源，通常需要很长时间（D）。
    },
  },
  checkText: {
    expectedActual: '{label} · expected {expected}, actual {actual}', // {label} · 期望 {expected}，实际 {actual}
    youEntered: 'You entered: {v}', // 你填写：{v}
    evidenceOk: ' · evidence verified', //  · 证据已校验
    ownership: 'Confirming ownership (CloudTrail usually takes a few minutes, not guaranteed)', // 归属确认中（CloudTrail 通常几分钟，不作保证）
    ownershipNext: 'Confirming ownership (CloudTrail usually takes a few minutes, not guaranteed) · next in {t}', // 归属确认中（CloudTrail 通常几分钟，不作保证） · 下次 {t} 后
    outageRetry: 'Retries automatically after the window ends', // 窗口结束后自动重试
    notYourFault: 'Not your fault', // 不是你的问题
    runDone: 'Step checks finished: {pass} passed', // 本步检测完成：{pass} 项通过
    runFail: ', {n} failed', // ，{n} 项未通过
    runOther: ', {n} pending', // ，{n} 项待定
  },
  paste: {
    unresolved: '{n, plural, one {# variable is not filled in; jumped to the variable bar} other {# variables are not filled in; jumped to the variable bar}}', // 有 {n} 个变量未填写，已定位到变量条
    secret: 'The command contains a secret placeholder and cannot be pasted. Read the secret on the lab instance and type it by hand.', // 命令含密钥占位，不能粘贴。请在实验机上读取密钥后手动输入。
    tooLarge: 'The command is larger than 16KB and can only be copied', // 命令超过 16KB，只能复制
    dangerExecute: 'Dangerous commands cannot use “Paste and run”. Paste, review, then press Enter yourself', // 危险命令不允许“粘贴并执行”，请粘贴后检查再自己按 Enter
    multiline: 'The current program does not support safe paste. Copy the command and paste it by hand', // 当前程序不支持安全粘贴，请复制后手动粘贴
    target: {
      lab: 'lab instance', // 实验机
      workstation: 'workbench', // 工作台
    },
  },
  money: {
    notProvided: 'not available', // 未提供
    approx: '≈ {v}', // ≈ {v}
    range: '≈ {low}–{high}', // ≈ {low}～{high}
  },
  right: {
    tab: {
      'terminal-lab': 'Lab instance', // 实验机
      'terminal-workstation': 'Workbench', // 工作台
      console: 'AWS console', // AWS 控制台
      preview: 'App preview', // 应用预览
    },
    tabShort: {
      'terminal-lab': 'Lab', // 实验机
      'terminal-workstation': 'Workbench', // 工作台
      console: 'Console', // 控制台
      preview: 'Preview', // 预览
    },
    connected: 'Connected', // 已连接
    reconnecting: 'Reconnecting', // 重连中
    unavailable: 'Unavailable', // 不可用
    connecting: 'Connecting', // 连接中
    disconnected: 'Disconnected', // 断开
    region: 'Terminals, console and preview', // 终端、控制台与预览
    tabs: 'Right-side tabs', // 右侧标签
    newTab: ' (opens in a new tab)', // （新标签页打开）
    splitNA: 'Splitting the right pane is not available yet', // 拆分右栏暂不提供
    split: 'Split', // 拆分
    readOnly: 'Read-only: your role cannot connect to terminals or the console', // 只读：你的角色不能连接终端或控制台
    readOnlyText: 'Assistants and observers never receive AWS credentials. You can view check results in the manual{extra}.', // 助教与观察者永远拿不到 AWS 凭证。可以在手册中查看检测结果{extra}。
    readOnlyAssistant: ', run checks and review manual confirmations', // 、运行检测并复核手动确认
    cloudshell: 'CloudShell (saving mode)', // CloudShell（省钱模式）
    cloudshellText: 'No workbench instance was started for this lab. Run workbench commands in AWS CloudShell: open the console first, then open CloudShell from the console\'s top bar. In the manual, “Paste” for workbench commands becomes “Copy”.', // 本次实验没有启动工作台实例。工作台命令请在 AWS CloudShell 中执行：先打开控制台，再从控制台顶栏打开 CloudShell。手册中工作台命令的“粘贴”改为“复制”。
    cloudshellExp: 'In saving mode comparison results cannot be uploaded, so the related checks are downgraded by rule.', // 省钱模式下对比实验结果无法上传，相关检查只能按规则降级。
    openConsole: 'Open AWS console in a new tab', // 在新标签页打开 AWS 控制台
  },
  manualConfirm: {
    evidenceTooLong: 'Evidence is longer than {n} characters. Paste only the relevant part of the command output', // 证据超过 {n} 个字符，请只粘贴命令输出中的相关部分
    evidenceJson: 'Only command output in JSON can be pasted', // 只能粘贴 JSON 格式的命令输出
    submittedReview: 'Manual confirmation submitted; waiting for an assistant review', // 已提交手动确认，等待助教复核
    submitted: 'Manual confirmation submitted', // 已提交手动确认
    invalid: 'The input does not meet the requirements: {detail}', // 输入不符合要求：{detail}
    failed: 'Submission failed. You can retry', // 提交失败，可以重试
    title: 'Manual confirmation: {name}', // 手动确认：{name}
    done: 'Done', // 完成
    cancel: 'Cancel', // 取消
    submitting: 'Submitting…', // 正在提交…
    submit: 'Submit confirmation', // 提交确认
    doneReview: 'Submitted. When the installation has assistants, it shows “Waiting for assistant review” until reviewed.', // 已提交。安装中有助教时，复核前会显示“等待助教复核”。
    doneEvidence: 'Confirmed manually (with evidence).', // 已手动确认（带证据）。
    doneManual: 'Confirmed manually.', // 已手动确认。
    native: 'This check needs you to confirm what you see (manual · native).', // 这项检查需要你确认看到的结果（手动·原生）。
    degraded: 'The automatic check cannot decide for now. Look at the location below, then confirm manually (manual · degraded). A manual confirmation cannot override an automatic “fail”.', // 自动检测暂时无法判定，你可以按下面的位置查看后手动确认（手动·降级）。手动确认不能覆盖自动检测的“未通过”。
    where: 'Location: {path}', // 位置：{path}
    whereRegion: ' (Region: {region})', // （区域：{region}）
    labRegion: 'lab Region', // 实验区域
    question: 'What do you see?', // 你看到的是什么？
    notExpected: 'This is not the expected result, so it cannot be submitted.', // 这不是期望的结果，不能提交。
    fixDefault: 'Fix the configuration first, then check again.', // 先修正配置，再重新检测。
    valueLabel: 'Value you see', // 你看到的值
    example: 'e.g. {v}', // 例如 {v}
    badFormat: 'Invalid format', // 格式不符合要求
    note: 'Note (at least 6 characters)', // 备注（至少 6 个字）
    noteShort: 'The note needs at least 6 characters', // 备注至少 6 个字
    evidenceOptional: 'Optional: paste command output as evidence (the platform verifies it with the same assertions; if it passes, it counts as “manual with evidence”)', // 可选：粘贴命令输出作为证据（平台会用同一套断言校验，通过记为“带证据的手动”）
    evidenceLabel: 'Command output (JSON)', // 命令输出（JSON）
  },
  dialogs: {
    cancelling: 'Cancelling the lab', // 正在取消实验
    cancelFailed: 'Cancellation did not complete. You can retry.', // 取消没有完成，可以重试。
    cancelTitle: 'Cancel lab', // 取消实验
    keepPreparing: 'Keep preparing', // 继续准备
    cancellingBusy: 'Cancelling…', // 正在取消…
    cancelRequested: 'No resources have been created yet, so cancelling costs nothing.', // 尚未创建任何资源，取消不会产生费用。
    cancelProvisioning: 'Cancelling releases the resources already created, which can take a while. Charges incurred while provisioning are not refunded.', // 取消后，已经创建的资源会被释放，可能需要一些时间。准备期间产生的费用不会退回。
    t5Title: '5 minutes left', // 还剩 5 分钟
    extend30: 'Extend by 30 minutes', // 延长 30 分钟
    gotIt: 'Got it', // 知道了
    t5Body: '5 minutes left. If a comparison experiment is running, let its results finish uploading soon (the platform accepts in-flight uploads when the lab ends).', // 还剩 5 分钟。正在运行的对比实验，请尽快让结果上传完成（结束时平台会接收在途上传）。
    overdueAnnounce: 'Lab time is up; related dialogs were closed', // 实验时间已到，相关对话框已关闭
    endedAnnounce: 'The lab has ended; access is being revoked and resources released', // 实验已结束，正在收回访问并释放资源
    overdueTitle: 'Lab time is up', // 实验时间已到
    endedTitle: 'Lab ended', // 实验已结束
    overdueBody: 'Lab time is up. Access is being revoked and resources released.', // 实验时间已到，正在收回访问并释放资源。
    endedBody: 'The lab has ended. Access is being revoked and resources released.', // 实验已结束，正在收回访问并释放资源。
    expiredAt: ' (expired at {t})', // （{t} 到期）
    drift: 'The platform is catching up on expiry processing (usually within a few minutes).', // 平台正在补触发到期处理（通常几分钟内）。
    viewReclaim: 'View reclaim progress', // 查看回收进度
    viewReport: 'View report', // 查看报告
    backToCatalog: 'Back to the card catalog', // 回到卡片目录
    standaloneCancel: 'Cancel lab', // 取消实验
    standaloneExtend: 'Extend lab', // 延长实验
    standaloneEnd: 'End lab', // 结束实验
  },
  expCard: {
    title: 'Comparison experiment {key}', // 对比实验 {key}
    required: ' (required)', // （必做）
    optional: ' (optional)', // （选做）
    view: 'View comparison', // 查看对比
    notDeclared: 'The card does not declare this experiment.', // 卡片没有声明这个实验。
  },
  splitter: {
    label: 'Resize the manual', // 调整手册宽度
    collapsed: 'Manual collapsed', // 手册已折叠
    width: 'Manual width {n}%', // 手册宽度 {n}%
  },
  command: {
    afterReady: 'Available once the environment is ready', // 环境就绪后可用
    role: 'Your role cannot use terminals', // 你的角色不能使用终端
    ended: 'The lab has ended; terminals are unavailable', // 实验已结束，终端不可用
  },
  pasteDlg: {
    severeTitle: 'Paste a dangerous command', // 粘贴危险命令
    busyTitle: 'The terminal is running a command', // 终端正在运行命令
    executeTitle: 'Paste and run', // 粘贴并执行
    linesTitle: '{n, plural, one {Paste # line} other {Paste # lines}}', // 将粘贴 {n} 行
    confirmTitle: 'Confirm paste', // 确认粘贴
    cancel: 'Cancel', // 取消
    newTab: 'Paste into a new terminal sub-tab', // 在新的终端子标签中粘贴
    severeOk: 'I understand, paste', // 我了解，粘贴
    busyOk: 'Paste anyway', // 仍然粘贴
    executeOk: 'Paste and run', // 粘贴并执行
    ok: 'Paste', // 粘贴
    severeNote: 'This command deletes or disables resources and cannot be undone. Review it after pasting, then press Enter yourself; dangerous commands cannot use “Paste and run”.', // 这条命令会删除或停用资源，影响无法撤销。粘贴后请检查，再自己按 Enter；危险命令不允许“粘贴并执行”。
    busyNote: 'The terminal is running a command (such as tail -f); pasted text becomes input to that program.', // 终端正在运行命令（例如 tail -f），粘贴的内容会成为该程序的输入。
    mismatch: 'This command is meant to run on the {target}.', // 这条命令本应在 {target} 上执行。
    multiline: '{n, plural, one {Pastes # line into the {target} terminal (safe paste, not run immediately).} other {Pastes # lines into the {target} terminal (safe paste, not run immediately).}}', // 将向 {target}终端粘贴 {n} 行（安全粘贴，不会立即执行）。
    host: 'Target host', // 目标主机
    linuxUser: 'Linux user', // Linux 用户
    awsIdentity: 'AWS identity', // AWS 身份
    dontAsk: 'Don\'t ask again for this card (regular commands only)', // 本卡片内不再询问（仅普通命令）
    rejectTitle: 'Cannot paste', // 不能粘贴
    gotIt: 'Got it', // 知道了
    readOnLab: 'Read it in the lab instance terminal:', // 在实验机终端中读取：
    copied: 'The command was copied to the clipboard. Review it and paste it into the terminal by hand.', // 命令已复制到剪贴板，检查后可以在终端里手动粘贴。
    copyFirst: 'You can copy the command first and paste it into the terminal by hand.', // 可以先复制命令，再在终端里手动粘贴。
  },
  step: {
    services: 'Services in this step', // 本步相关服务
    billing: '{what} starts with this step{keys}.', // 从这一步开始{what}{keys}。
    billingDefault: 'Billing', // 计费
    billingKeys: ' ({list})', // （{list}）
    listSep: ', ', // 、
    outageOpen: 'Expected outage: this step briefly interrupts the platform management channel{reason}. Until {t}, an unavailable lab terminal and local checks are normal and do not count as failures; the platform retries automatically after the window.', // 预期中断：本步骤会暂时中断平台管理通道{reason}。在 {t} 之前，实验机终端与本地检测不可用是正常现象，不计为失败；窗口结束后平台自动重试。
    reasonParen: ' ({reason})', // （{reason}）
    outageHeadOpen: 'Expected outage · back by {t}', // 预期中断 · {t} 前恢复
    outageHead: 'Expected outage · up to {n} min', // 预期中断 · 约 {n} 分钟
    outageNotice: 'This step makes the management channel temporarily unreachable (up to {n} min): checks show “Channel unreachable”, which is expected. Check again after the window ends.', // 本步骤会让管理通道暂时不可达（约 {n} 分钟）：检测会显示“通道不可达”，属预期，窗口结束后重新检测即可。
    several: 'a few', // 数
    noBody: 'This step has no manual text.', // 本步没有手册正文。
    pitfalls: 'Common pitfalls ({n})', // 常见错误（{n}）
    hit: '● Matches: ', // ● 命中：
    cause: ': {cause}', // ：{cause}
    fix: ' Fix: {fix}', //  处理：{fix}
    unskipped: 'Skip undone', // 已撤销跳过
    skipped: 'Step skipped', // 已跳过本步
    failed: 'The action did not complete. Try again shortly', // 操作没有完成，请稍后重试
    unskip: 'Undo skip', // 撤销跳过
    skip: 'Skip this step', // 跳过本步
    readDone: 'Recorded: step read', // 已记录：本步已读
    readFailed: 'Could not record it. Try again shortly', // 没能记录，请稍后重试
    read: 'Mark as read', // 我已读完
  },
  vars: {
    label: 'Variables', // 变量
    collapse: 'Hide variables', // 收起变量
    all: 'All variables ({n})', // 全部变量（{n}）
    unresolved: 'unresolved', // 未解析
    masked: ' (shown masked)', // （显示已打码）
    updated: 'Updated', // 已更新
    editLabel: 'Edit variable {label}', // 编辑变量 {label}
    edit: 'Edit', // 编辑
    badFormat: 'Invalid format', // 格式不符合要求
    badFormatExample: 'Invalid format, for example {example}', // 格式不符合要求，例如 {example}
    required: 'Required', // 请填写
    saved: 'Variable {label} saved', // 已保存变量 {label}
    saveFailed: 'Could not save. Try again shortly', // 没能保存，请稍后重试
    fill: 'Fill in variable {label}', // 填写变量 {label}
    saving: 'Saving…', // 正在保存…
    roleDenied: 'Your role cannot fill in variables', // 你的角色不能填写变量
    afterReady: 'Can be filled in once the lab is ready', // 实验就绪后可以填写
    save: 'Save', // 保存
    cancelEdit: 'Cancel editing', // 取消编辑
    current: 'Current value: {v}', // 当前值：{v}
    empty: 'Not filled in yet', // 还没有填写
  },
  action: {
    deploy: 'Deploy {id}', // 部署 {id}
    roleDenied: 'Your role cannot run platform actions', // 你的角色不能执行平台动作
    afterReady: 'Available once the lab is ready', // 实验就绪后可用
    running: 'The platform is running this action', // 平台正在执行这个动作
    requested: 'Platform action requested: {title}', // 已请求平台动作：{title}
    notAllowed: 'This card does not allow this platform action', // 本卡片不允许这个平台动作
    reauth: 'This action requires a sign-in within the last 60 minutes', // 这个操作要求最近 60 分钟内登录过
    failed: 'The request did not complete. Try again shortly', // 请求没有完成，请稍后重试
    title: 'Platform action: {title}', // 平台动作：{title}
    interrupts: 'While it runs, the platform management channel is briefly interrupted (expected outage).', // 执行期间会暂时中断平台管理通道（预期中断）。
    modifying: 'The platform is changing the environment', // 平台正在修改环境
    execFailed: 'Failed', // 执行失败
    execFailedSummary: 'Failed: {summary}', // 执行失败：{summary}
    done: 'Done', // 已完成
    cancel: 'Cancel', // 取消
    requesting: 'Requesting…', // 正在请求…
    confirm: 'Run', // 确认执行
    confirmDefault: 'The platform will change your lab environment with a runner. Run it?', // 平台会以运行器修改你的实验环境。确认执行吗？
    interruptsNote: 'While it runs, the lab terminal and local checks are temporarily unavailable; this is expected.', // 执行期间实验机终端与本地检测会暂时不可用，属预期。
  },
  submit: {
    previewFailed: 'The pre-check did not complete', // 预检查没有完成
    stepTitle: 'Step {n} “{title}”', // 步骤 {n}“{title}”
    submitted: 'Submitted; the platform is running the final review', // 已提交，平台正在做最终复核
    failed: 'Submission failed. Try again shortly', // 提交失败，请稍后重试
    title: 'Submit lab', // 提交实验
    cancel: 'Cancel', // 取消
    submitting: 'Submitting…', // 正在提交…
    submitAnyway: 'Submit anyway (may not pass)', // 仍然提交（可能不通过）
    submit: 'Submit', // 提交
    intro: 'The platform reruns all required checks once (final review). If they pass, the lab is complete and you earn the badge.', // 平台会对全部必需检查强制重测一次（最终复核），通过即完成并获得徽章。
    generating: 'Preparing the pre-check…', // 正在生成预检查…
    previewError: 'The pre-check did not complete ({error}); you can submit directly.', // 预检查没有完成（{error}），可以直接提交。
    precheck: 'Current pre-check: {done}/{total} required steps done', // 当前预检查：必需步骤 {done}/{total} 已达成
    drifted: ' · {n} drifted', //  · {n} 项漂移
    missing: 'Still missing: {step}', // 还差：{step}
    allDone: 'All required steps are done', // 必需步骤都已达成
  },
} satisfies Dict<typeof zh>;
