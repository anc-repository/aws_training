/**
 * en（English）：框架与全局文案。由 `npm run i18n:sync` 按 zh-CN 词典维护结构：
 * 只填写引号内的译文（空字符串 = 未翻译，运行时按 en → en → zh-CN 回退）；行尾注释是 zh-CN 原文。
 * 术语与风格见 ../glossary.md（不翻译 AWS 服务名、CLI 命令、代码、资源名、API 路径、环境变量）。
 */
import type { Dict } from '../dict';
import type zh from '../zh-CN/core';

export default {
  app: {
    name: 'ATL Lab Platform', // ATL 实验平台
    unofficial: 'Not affiliated with AWS', // 非 AWS 官方
    fullName: 'ATL Lab Platform (not affiliated with AWS)', // ATL 实验平台（非 AWS 官方）
    skipToMain: 'Skip to main content', // 跳到主要内容
    loading: 'Loading…', // 正在加载…
    stillLoading: 'Still loading…', // 仍在加载…
    retry: 'Retry', // 重试
    reload: 'Reload', // 重新加载
    close: 'Close', // 关闭
    cancel: 'Cancel', // 取消
    copy: 'Copy', // 复制
    copied: 'Copied', // 已复制
    copyDiagnostics: 'Copy diagnostics', // 复制诊断信息
    backToCatalog: 'Back to the card catalog', // 回到卡片目录
    newTab: ' (new tab)', // （新标签页）
    todo: 'This screen will be implemented later.', // 这个画面将在后续实现。
  },
  nav: {
    label: 'Main navigation', // 主导航
    catalog: 'Card catalog', // 卡片目录
    track: 'Learning paths', // 学习路径
    learning: 'My learning', // 我的学习
    sessions: 'My labs', // 我的实验
    openMenu: 'Open navigation', // 打开导航
    progress: 'Progress {counted}/{min}', // 进度 {counted}/{min}
  },
  roles: {
    L: 'Learner', // 学员
    A: 'Assistant', // 助教
    O: 'Observer', // 观察者
  },
  account: {
    menu: 'Account and Region', // 账号与区域
    menuLabel: 'Account and Region: {region}, account ending {last4}, {name}, {role}', // 账号与区域：{region}，账号尾号 {last4}，{name}，{role}
    region: 'Region', // 区域
    drRegion: 'DR Region', // 灾备区域
    account: 'Account', // 账号
    reveal: 'Show', // 显示
    revealLabel: 'Show the full account ID for 10 seconds', // 显示完整账号 ID 10 秒
    accountLater: 'The account ID appears after your first lab', // 账号 ID 将在第一次实验时显示
    regionFixed: 'The Region cannot be changed here (changing it requires a reinstall)', // 区域不可在界面中切换（换区域需要重新安装）
    theme: 'Theme', // 主题
    themeSystem: 'System', // 跟随系统
    themeLight: 'Light', // 亮
    themeDark: 'Dark', // 暗
    shortcuts: 'Keyboard shortcuts and legend', // 键盘快捷键与图例
    profile: 'Profile and preferences →', // 个人资料与偏好 →
    settings: 'Platform settings →', // 平台设置 →
    signOut: 'Sign out', // 退出
  },
  session: {
    pillLabel: 'Current lab {labId}, {state}, {rest}, back to the workbench', // 当前实验 {labId}，{state}，{rest}，回到工作台
    pillPrepLabel: 'Current lab {labId}, {state}, back to the workbench', // 当前实验 {labId}，{state}，回到工作台
    pillWindLabel: '{labId}, {state}, view reclaim progress', // {labId}，{state}，查看回收进度
    pillKeptLabel: '{labId}, environment kept, manage keep', // {labId}，环境保留中，管理保留
    pillFailedLabel: '{labId}, cleanup incomplete, view list', // {labId}，释放未完成，查看清单
    elapsed: '{t} elapsed', // 已用 {t}
    remaining: '{t} left', // 剩余 {t}
    until: 'until {t}', // 至 {t}
    saveMode: 'Saving mode', // 节省模式
    deleted: 'Deleted {n}/{m}', // 已删除 {n}/{m}
    hourlyBilled: '{n} billed hourly', // {n} 项按小时计费
    menu: 'Session menu', // 会话菜单
    menuBackToWorkspace: 'Back to workbench', // 回到工作台
    menuReclaim: 'View reclaim progress', // 查看回收进度
    menuKeep: 'Manage the kept environment', // 管理保留的环境
    menuCancel: 'Cancel…', // 取消…
    menuExtend: 'Extend {minutes} min ({n} left)', // 延长 {minutes} 分钟（剩余 {n} 次）
    menuEnd: 'End lab…', // 结束实验…
    menuDetail: 'Session details', // 会话详情
    countdownNotStarted: 'Countdown not started', // 倒计时未开始
    serverTime: 'Based on server time', // 按服务器时间计算
    expiresAt: 'Expires {t} (local time)', // {t} 到期（本地时间）
    extendBlocked: {
      none: 'No extensions left.', // 延长次数已用完。
      last30s: 'About to expire and cannot be extended (extensions are not accepted in the last 30 seconds).', // 即将到期，无法延长（截止前最后 30 秒不接受延长）。
      cap: 'The maximum total time for one lab has been reached.', // 已达到单次实验总时长上限。
      uninstalling: 'The platform is being uninstalled, so extensions are not possible.', // 平台正在卸载，不能延长。
      budget: 'This month’s cost is over budget; per the settings, extensions are blocked.', // 本月费用已超过预算，按设置不能延长。
      state: 'The lab has expired or is ending and cannot be extended.', // 实验已到期或正在结束，无法延长。
    },
  },
  footer: {
    live: 'Live · polling ({s} s)', // 实时 · 轮询中（{s} 秒）
    paused: 'Paused (page in background)', // 已暂停（页面在后台）
    offline: 'Connection lost', // 连接中断
    shortcutsHint: 'Press ? for shortcuts', // 按 ? 查看快捷键
    clockSkew: 'This device’s clock differs from the server by about {n} min; countdowns use server time.', // 本机时钟与服务器相差约 {n} 分钟，倒计时已按服务器时间显示。
  },
  banners: {
    region: 'Notices', // 提醒
    more: '{n, plural, one {# more notice} other {# more notices}}', // 还有 {n} 条提醒
    collapse: 'Collapse notices', // 收起提醒
    dismiss: 'Dismiss notice', // 关闭提醒
    uninstalling: 'The platform is being uninstalled: new labs are no longer accepted and all environments are being ended and reclaimed.', // 平台正在卸载：已停止接受新实验，正在结束并回收全部环境。
    uninstallingAction: 'View uninstall progress', // 查看卸载进度
    residual: '{what} has {n} unreleased resources{hourly}.', // {what}有 {n} 项资源未释放{hourly}。
    residualHourly: ', {n} billed hourly', // ，其中 {n} 项按小时计费
    residualAction: 'View list', // 查看清单
    residualPrevious: 'An earlier lab', // 之前的实验
    budgetExceeded: 'This month’s cost is over budget (atl-platform-guard). Per the settings, starting new labs is paused.', // 本月费用已超过预算（atl-platform-guard）。按设置，平台已暂停开始新实验。
    budgetAction: 'View guardrails', // 查看护栏
    expiring: '{labId} expires at {at} ({min} min left); its resources are released automatically afterwards.', // {labId} 将于 {at} 到期（剩余 {min} 分钟），到期后自动释放资源。
    expiringAction: 'Back to workbench', // 回到工作台
    envDegraded: 'The lab instance’s management channel is unreachable; the terminal and local checks are temporarily unavailable.', // 实验机的管理通道不可达，终端与本地检测暂时不可用。
    envDegradedAction: 'View troubleshooting', // 查看排障
    maintenance: 'The platform is in maintenance mode; new labs cannot be started right now.', // 平台处于维护模式，暂时不能开始新实验。
    maintenanceAction: 'Settings', // 设置
    budgetWarn: 'This month’s cost has reached 80% of the budget (actual or forecast). You will be asked to confirm again when you start, extend or keep.', // 本月费用已达到预算的 80%（实际或预测）。开始、延长、保留时会再次请你确认。
    catalogUpdated: 'The card catalog was updated to {v}.', // 卡片目录已更新到 {v}。
    platformUpdated: 'The platform was updated to {v}.', // 平台已更新到 {v}。
    refresh: 'Refresh', // 刷新
    keep: 'The kept environment is released automatically at {at}.', // 保留的环境将于 {at} 自动释放。
    keepAction: 'Manage keep', // 管理保留
    onboardingSkipped: 'First-time setup was skipped; you can revisit it in Settings › Platform.', // 首次设置已跳过：可在 设置 › 平台 中重看。
  },
  p13: {
    offline: 'You are offline. The lab keeps running on the server and resources are still billed; it syncs automatically when you reconnect.', // 网络已断开。实验仍在服务端计时，资源照常计费；恢复后自动同步。
    apiUnavailable: 'The platform service is temporarily unavailable ({status}).', // 平台服务暂时不可用（{status}）。
    throttled: 'AWS APIs are busy and the platform has retried. Try again shortly.', // AWS 接口繁忙，平台已重试。请稍后再试。
    rateLimited: 'Too many requests; try again in {n} s.', // 操作太频繁，请在 {n} 秒后重试。
    authExpiredTitle: 'Your sign-in has expired', // 登录已过期
    authExpired: 'Your sign-in has expired. What you entered on this page stays in this tab.', // 登录已过期。你在本页填写的内容会保留在本标签页。
    signInAgain: 'Sign in again', // 重新登录
    reauthTitle: 'Sign in again to continue', // 需要重新登录
    reauth: 'This action needs a sign-in within the last 60 minutes (opening a terminal, console sign-in, viewing the admin password, claiming a certificate, platform actions, preparing an uninstall).', // 这个操作要求最近 60 分钟内登录过（打开终端、控制台登录、查看管理员密码、领取证书、平台动作、卸载准备）。
    roleDeniedTitle: 'Your role cannot do this', // 角色不足
    roleDenied: 'Your role ({role}) is view-only and cannot open this page or perform this action. The address has been kept.', // 你的角色（{role}）只能查看，不能进入这个页面或执行这个操作。地址已保留。
    roleDeniedInline: 'Your role ({role}) is view-only and cannot perform this action.', // 你的角色（{role}）只能查看，不能执行这个操作。
    noRoleTitle: 'No role assigned', // 账号未分配角色
    noRole: 'This account is not assigned as a learner, assistant or observer. Ask the platform’s learner (the account owner) to invite you in Settings › Members.', // 这个账号还没有被分配为学员、助教或观察者。请联系平台的学员（账号所有者）在 设置 › 成员 中邀请你。
    platformUnavailableTitle: 'The platform is temporarily unavailable', // 平台暂时不可用
    platformUnavailable: 'The platform configuration could not be read. The lab keeps running on the server and resources are still billed.', // 读取平台配置失败。实验仍在服务端计时，资源照常计费。
    notFoundTitle: 'Page not found', // 页面不存在
    notFound: 'Page not found.', // 页面不存在。
    pageErrorTitle: 'Something went wrong on this page', // 页面出错了
    pageError: 'An error occurred while rendering (error ID {id}). The lab keeps running on the server and resources are still billed.', // 渲染时出现异常（错误 ID {id}）。实验仍在服务端计时，资源照常计费。
    precondition: 'The deadline just changed (perhaps extended in another tab), so the page was refreshed.', // 截止时间刚刚变化（可能在另一个标签页延长过），已刷新。
    unknown: '{title}', // {title}
    requestId: 'Error ID', // 错误 ID
  },
  errors: {
    SESSION_ACTIVE_EXISTS: 'A lab is already in progress: {detail}', // 已有进行中的实验：{detail}
    ENV_KEPT_EXISTS: 'An environment is being kept: release it first, or start in that environment', // 有保留中的环境：请先释放，或在该环境中开始
    CLEANUP_IN_PROGRESS: 'The previous environment is still being released; you can start a new lab when it finishes', // 上一个环境正在释放，完成后才能开始新的实验
    RESIDUAL_ACK_REQUIRED: 'Hourly-billed resources from your last lab are still unreleased; confirm before starting', // 上次实验还有按小时计费的资源未释放，开始前需要你确认
    RESIDUAL_BLOCKING: 'Hourly-billed resources from your last lab are still unreleased. Per the platform settings, handle the leftovers before starting a new lab', // 上次实验还有按小时计费的资源未释放。按平台设置，必须先处理残留才能开始新的实验
    REUSE_IN_PROGRESS: 'This environment is being taken over by a new session and cannot be released right now', // 该环境正在被新会话接管，不能立即释放
    INVALID_STATE: 'This action is not allowed in the current state; the page was refreshed', // 当前状态不允许这个操作，页面已刷新
    SESSION_EXPIRING_OR_ENDED: 'The lab has expired or is ending and cannot be extended', // 实验已到期或正在结束，无法延长
    EXTENSION_LIMIT: 'No extensions or extension time left', // 延长次数或累计时长已用完
    KEEP_NOT_ALLOWED: 'This card does not allow keeping the environment', // 本卡片不允许保留环境
    MAINTENANCE_MODE: 'The platform is in maintenance mode', // 平台处于维护模式
    PLATFORM_UNINSTALLING: 'The platform is being uninstalled', // 平台正在卸载
    BUDGET_BLOCKED: 'This month’s cost is over budget; per the settings this action is paused', // 本月费用已超过预算，按设置暂停了这个操作
    PRECONDITION_FAILED: 'The data just changed; the page was refreshed, try again', // 数据刚刚被修改，已刷新，请重新操作
    COST_ACK_REQUIRED: 'Confirm the cost first', // 请先确认费用
    QUOTE_EXPIRED: 'The cost quote expired and was recalculated', // 费用报价已过期，已重新计算
    QUOTE_MISMATCH: 'Prices or the card version changed; confirm the cost again', // 价格或卡片版本已更新，请重新确认费用
    LIMIT_EXCEEDED: 'Time or keep limit exceeded', // 超过时长或保留上限
    OP_NOT_ALLOWED: 'This card does not allow this platform action', // 本卡片不允许这个平台动作
    VARIANT_UNKNOWN: 'This start option no longer exists', // 这个起始方式已不存在
    PROFILE_DIGEST_MISMATCH: 'The lab definition does not match the platform version (the content must be republished)', // 实验定义与平台版本不匹配（内容需重新发布）
    CERT_NOT_ELIGIBLE: 'Requirements not met yet: {detail}', // 还不满足领取条件：{detail}
    VALIDATION_FAILED: 'Invalid input: {detail}', // 输入不符合要求：{detail}
    RATE_LIMITED: 'Too many requests; try again shortly', // 操作太频繁，请稍后重试
    UPSTREAM_THROTTLED: 'AWS APIs are busy and the platform has retried; try again shortly', // AWS 接口繁忙，平台已重试，请稍后再试
    UPSTREAM_UNAVAILABLE: 'A required AWS service is temporarily unavailable', // 依赖的 AWS 服务暂时不可用
    NOT_FOUND: 'Not found', // 没有找到
    INTERNAL: 'Internal platform error (error ID: {requestId})', // 平台内部错误（错误 ID：{requestId}）
    UNAUTHENTICATED: 'Your sign-in has expired; sign in again', // 登录已过期，请重新登录
    FORBIDDEN_ROLE: 'Your role cannot perform this action', // 你的角色不能执行这个操作
    REAUTH_REQUIRED: 'This action needs a sign-in within the last 60 minutes', // 这个操作要求最近 60 分钟内登录过
    TARGET_ALREADY_SATISFIED: 'In this environment {module} is already {value}, so starting here cannot produce completion evidence for this session', // 这个环境里 {module} 已经是 {value}，在这里开始拿不到本次会话的完成证据
    HARD_PREREQ_UNMET: 'A prerequisite card is not finished yet', // 前置卡片还没有完成
    LAB_DEPRECATED: 'This card has been retired', // 本卡片已停用
    TERMINAL_SESSION_STATE: 'The terminal cannot be opened in the current state (or access was revoked)', // 当前状态不能打开终端（或访问已收回）
    TERMINAL_TARGET_NOT_IN_SESSION: 'The target instance is not part of this environment', // 目标实例不属于本环境
    TERMINAL_TARGET_NOT_CONNECTED: 'The lab instance’s management channel is unreachable, so the terminal cannot open right now', // 实验机的管理通道不可达，暂时不能打开终端
    TERMINAL_TARGET_NOT_PREPARED: 'The lab instance’s terminal is not ready yet', // 实验机还没有准备好终端
    TERMINAL_LIMIT: 'Terminal limit reached', // 终端数量已达上限
    TERMINAL_GONE: 'The terminal session has ended and cannot be resumed', // 终端会话已结束，不能续连
    CONSOLE_SESSION_STATE: 'Console sign-in is not available in the current state', // 当前状态不能获取控制台登录
    CONSOLE_DESTINATION_NOT_ALLOWED: 'This console page is not on the allowed list', // 这个控制台页面不在允许的列表中
    CONSOLE_FEDERATION_FAILED: 'The console sign-in service is temporarily unavailable', // 控制台登录服务暂时不可用
    NETWORK: 'Cannot reach the platform; check your network and retry', // 无法连接平台，请检查网络后重试
    BAD_RESPONSE: 'The platform returned a response that could not be understood', // 平台返回了无法识别的响应
  },
  auth: {
    loginTitle: 'Sign in', // 登录
    tagline: 'An SAA-C03 lab platform deployed in your own AWS account.', // 部署在你自己 AWS 账号中的 SAA-C03 实验平台。
    signIn: 'Sign in with your platform account', // 使用平台账号登录
    firstLogin: 'On first sign-in you change the temporary password and set up TOTP two-step verification with an authenticator app. The temporary password was emailed to the learner when the platform was installed.', // 首次登录需要修改临时密码，并用验证器 App 绑定 TOTP 两步验证。临时密码在安装平台时发送到学员邮箱。
    forgot: 'Forgot your password: choose “Forgot your password?” on the sign-in page. Lost your authenticator: ask the account administrator to reset it in the Cognito console (the platform has no way around two-step verification).', // 忘记密码：在登录页点“忘记密码”。丢失验证器：请账号管理员在 Cognito 控制台重置（平台不提供绕过两步验证的入口）。
    tabOnly: 'Your sign-in is kept only in this browser tab; after closing the tab you need to sign in again.', // 登录状态只保存在当前浏览器标签页，关闭标签页后需要重新登录。
    reasonExpired: 'Your sign-in expired. Please sign in again; the page you were on opens automatically afterwards.', // 登录已过期，请重新登录。你刚才所在的页面会在登录后自动打开。
    reasonReauth: 'This action (opening the terminal, console sign-in, viewing the admin password, claiming a certificate, platform actions, preparing to uninstall) requires a sign-in within the last 60 minutes.', // 这个操作（打开终端、控制台登录、查看管理员密码、领取证书、平台动作、卸载准备）要求最近 60 分钟内登录过。
    reasonSignedOutElsewhere: 'You signed out in another tab.', // 你已在另一个标签页退出。
    callbackWorking: 'Finishing sign-in…', // 正在完成登录…
    callbackStale: 'The sign-in request is no longer valid (an old sign-in page may have been opened). Please sign in again.', // 登录请求已失效（可能是打开了旧的登录页）。请重新登录。
    callbackError: 'Sign-in not completed: {error}', // 登录未完成：{error}
    tokenFailed: 'Can’t reach the sign-in service. Check your network and try again.', // 无法连接登录服务，请检查网络后重试。
    signedOut: 'You have signed out of the ATL Lab Platform.', // 你已退出 ATL 实验平台。
    configFailed: 'The platform configuration (/config.json) can’t be read. Please try again later.', // 无法读取平台配置（/config.json）。请稍后重试。
    devTitle: 'Development sign-in', // 开发模式登录
    devHint: 'Local development (dev-server) uses development tokens and doesn’t connect to Cognito. Available on this machine’s address only.', // 本地开发（dev-server）使用开发令牌，不连接 Cognito。只在本机地址可用。
    devGroup: 'Role', // 角色
    devSub: 'User ID', // 用户标识
    devStaleAuth: 'Pretend I signed in 60 minutes ago (to test “sign in again”)', // 模拟 60 分钟前登录（测试“需要重新登录”）
    devSignIn: 'Sign in as developer', // 以开发身份登录
  },
  i18n: {
    switcher: 'Language', // 界面语言
    untranslated: 'Not translated', // 未翻译
    untranslatedHint: 'This content is not available in the selected language yet, so it is shown in another language.', // 这部分内容还没有当前语言的版本，暂时显示其他语言。
  },
  fmt: {
    spanHM: '{h} h {m} min', // {h} 小时 {m} 分
    spanH: '{h} h', // {h} 小时
    spanM: '{m} min', // {m} 分
    spokenS: '{s, plural, one {# second} other {# seconds}}', // {s} 秒
    spokenM: '{m, plural, one {# minute} other {# minutes}}', // {m} 分钟
    spokenHM: '{h, plural, one {# hour} other {# hours}} {m, plural, one {# minute} other {# minutes}}', // {h} 小时 {m} 分
    spokenH: '{h, plural, one {# hour} other {# hours}}', // {h} 小时
    remainingCoarse: 'About {t} left', // 剩余约 {t}
  },
} satisfies Dict<typeof zh>;
