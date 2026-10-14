/**
 * ja（日本語）：框架与全局文案。由 `npm run i18n:sync` 按 zh-CN 词典维护结构：
 * 只填写引号内的译文（空字符串 = 未翻译，运行时按 ja → en → zh-CN 回退）；行尾注释是 zh-CN 原文。
 * 术语与风格见 ../glossary.md（不翻译 AWS 服务名、CLI 命令、代码、资源名、API 路径、环境变量）。
 */
import type { Dict } from '../dict';
import type zh from '../zh-CN/core';

export default {
  app: {
    name: '', // ATL 实验平台
    unofficial: '', // 非 AWS 官方
    fullName: '', // ATL 实验平台（非 AWS 官方）
    skipToMain: '', // 跳到主要内容
    loading: '', // 正在加载…
    stillLoading: '', // 仍在加载…
    retry: '', // 重试
    reload: '', // 重新加载
    close: '', // 关闭
    cancel: '', // 取消
    copy: '', // 复制
    copied: '', // 已复制
    copyDiagnostics: '', // 复制诊断信息
    backToCatalog: '', // 回到卡片目录
    newTab: '', // （新标签页）
    todo: '', // 这个画面将在后续实现。
  },
  nav: {
    label: '', // 主导航
    catalog: '', // 卡片目录
    track: '', // 学习路径
    learning: '', // 我的学习
    sessions: '', // 我的实验
    openMenu: '', // 打开导航
    progress: '', // 进度 {counted}/{min}
  },
  roles: {
    L: '', // 学员
    A: '', // 助教
    O: '', // 观察者
  },
  account: {
    menu: '', // 账号与区域
    menuLabel: '', // 账号与区域：{region}，账号尾号 {last4}，{name}，{role}
    region: '', // 区域
    drRegion: '', // 灾备区域
    account: '', // 账号
    reveal: '', // 显示
    revealLabel: '', // 显示完整账号 ID 10 秒
    accountLater: '', // 账号 ID 将在第一次实验时显示
    regionFixed: '', // 区域不可在界面中切换（换区域需要重新安装）
    theme: '', // 主题
    themeSystem: '', // 跟随系统
    themeLight: '', // 亮
    themeDark: '', // 暗
    shortcuts: '', // 键盘快捷键与图例
    profile: '', // 个人资料与偏好 →
    settings: '', // 平台设置 →
    signOut: '', // 退出
  },
  session: {
    pillLabel: '', // 当前实验 {labId}，{state}，{rest}，回到工作台
    pillPrepLabel: '', // 当前实验 {labId}，{state}，回到工作台
    pillWindLabel: '', // {labId}，{state}，查看回收进度
    pillKeptLabel: '', // {labId}，环境保留中，管理保留
    pillFailedLabel: '', // {labId}，释放未完成，查看清单
    elapsed: '', // 已用 {t}
    remaining: '', // 剩余 {t}
    until: '', // 至 {t}
    saveMode: '', // 节省模式
    deleted: '', // 已删除 {n}/{m}
    hourlyBilled: '', // {n} 项按小时计费
    menu: '', // 会话菜单
    menuBackToWorkspace: '', // 回到工作台
    menuReclaim: '', // 查看回收进度
    menuKeep: '', // 管理保留的环境
    menuCancel: '', // 取消…
    menuExtend: '', // 延长 {minutes} 分钟（剩余 {n} 次）
    menuEnd: '', // 结束实验…
    menuDetail: '', // 会话详情
    countdownNotStarted: '', // 倒计时未开始
    serverTime: '', // 按服务器时间计算
    expiresAt: '', // {t} 到期（本地时间）
    extendBlocked: {
      none: '', // 延长次数已用完。
      last30s: '', // 即将到期，无法延长（截止前最后 30 秒不接受延长）。
      cap: '', // 已达到单次实验总时长上限。
      uninstalling: '', // 平台正在卸载，不能延长。
      budget: '', // 本月费用已超过预算，按设置不能延长。
      state: '', // 实验已到期或正在结束，无法延长。
    },
  },
  footer: {
    live: '', // 实时 · 轮询中（{s} 秒）
    paused: '', // 已暂停（页面在后台）
    offline: '', // 连接中断
    shortcutsHint: '', // 按 ? 查看快捷键
    clockSkew: '', // 本机时钟与服务器相差约 {n} 分钟，倒计时已按服务器时间显示。
  },
  banners: {
    region: '', // 提醒
    more: '', // 还有 {n} 条提醒
    collapse: '', // 收起提醒
    dismiss: '', // 关闭提醒
    uninstalling: '', // 平台正在卸载：已停止接受新实验，正在结束并回收全部环境。
    uninstallingAction: '', // 查看卸载进度
    residual: '', // {what}有 {n} 项资源未释放{hourly}。
    residualHourly: '', // ，其中 {n} 项按小时计费
    residualAction: '', // 查看清单
    residualPrevious: '', // 之前的实验
    budgetExceeded: '', // 本月费用已超过预算（atl-platform-guard）。按设置，平台已暂停开始新实验。
    budgetAction: '', // 查看护栏
    expiring: '', // {labId} 将于 {at} 到期（剩余 {min} 分钟），到期后自动释放资源。
    expiringAction: '', // 回到工作台
    envDegraded: '', // 实验机的管理通道不可达，终端与本地检测暂时不可用。
    envDegradedAction: '', // 查看排障
    maintenance: '', // 平台处于维护模式，暂时不能开始新实验。
    maintenanceAction: '', // 设置
    budgetWarn: '', // 本月费用已达到预算的 80%（实际或预测）。开始、延长、保留时会再次请你确认。
    catalogUpdated: '', // 卡片目录已更新到 {v}。
    platformUpdated: '', // 平台已更新到 {v}。
    refresh: '', // 刷新
    keep: '', // 保留的环境将于 {at} 自动释放。
    keepAction: '', // 管理保留
    onboardingSkipped: '', // 首次设置已跳过：可在 设置 › 平台 中重看。
  },
  p13: {
    offline: '', // 网络已断开。实验仍在服务端计时，资源照常计费；恢复后自动同步。
    apiUnavailable: '', // 平台服务暂时不可用（{status}）。
    throttled: '', // AWS 接口繁忙，平台已重试。请稍后再试。
    rateLimited: '', // 操作太频繁，请在 {n} 秒后重试。
    authExpiredTitle: '', // 登录已过期
    authExpired: '', // 登录已过期。你在本页填写的内容会保留在本标签页。
    signInAgain: '', // 重新登录
    reauthTitle: '', // 需要重新登录
    reauth: '', // 这个操作要求最近 60 分钟内登录过（打开终端、控制台登录、查看管理员密码、领取证书、平台动作、卸载准备）。
    roleDeniedTitle: '', // 角色不足
    roleDenied: '', // 你的角色（{role}）只能查看，不能进入这个页面或执行这个操作。地址已保留。
    roleDeniedInline: '', // 你的角色（{role}）只能查看，不能执行这个操作。
    noRoleTitle: '', // 账号未分配角色
    noRole: '', // 这个账号还没有被分配为学员、助教或观察者。请联系平台的学员（账号所有者）在 设置 › 成员 中邀请你。
    platformUnavailableTitle: '', // 平台暂时不可用
    platformUnavailable: '', // 读取平台配置失败。实验仍在服务端计时，资源照常计费。
    notFoundTitle: '', // 页面不存在
    notFound: '', // 页面不存在。
    pageErrorTitle: '', // 页面出错了
    pageError: '', // 渲染时出现异常（错误 ID {id}）。实验仍在服务端计时，资源照常计费。
    precondition: '', // 截止时间刚刚变化（可能在另一个标签页延长过），已刷新。
    unknown: '', // {title}
    requestId: '', // 错误 ID
  },
  errors: {
    SESSION_ACTIVE_EXISTS: '', // 已有进行中的实验：{detail}
    ENV_KEPT_EXISTS: '', // 有保留中的环境：请先释放，或在该环境中开始
    CLEANUP_IN_PROGRESS: '', // 上一个环境正在释放，完成后才能开始新的实验
    RESIDUAL_ACK_REQUIRED: '', // 上次实验还有按小时计费的资源未释放，开始前需要你确认
    RESIDUAL_BLOCKING: '', // 上次实验还有按小时计费的资源未释放。按平台设置，必须先处理残留才能开始新的实验
    REUSE_IN_PROGRESS: '', // 该环境正在被新会话接管，不能立即释放
    INVALID_STATE: '', // 当前状态不允许这个操作，页面已刷新
    SESSION_EXPIRING_OR_ENDED: '', // 实验已到期或正在结束，无法延长
    EXTENSION_LIMIT: '', // 延长次数或累计时长已用完
    KEEP_NOT_ALLOWED: '', // 本卡片不允许保留环境
    MAINTENANCE_MODE: '', // 平台处于维护模式
    PLATFORM_UNINSTALLING: '', // 平台正在卸载
    BUDGET_BLOCKED: '', // 本月费用已超过预算，按设置暂停了这个操作
    PRECONDITION_FAILED: '', // 数据刚刚被修改，已刷新，请重新操作
    COST_ACK_REQUIRED: '', // 请先确认费用
    QUOTE_EXPIRED: '', // 费用报价已过期，已重新计算
    QUOTE_MISMATCH: '', // 价格或卡片版本已更新，请重新确认费用
    LIMIT_EXCEEDED: '', // 超过时长或保留上限
    OP_NOT_ALLOWED: '', // 本卡片不允许这个平台动作
    VARIANT_UNKNOWN: '', // 这个起始方式已不存在
    PROFILE_DIGEST_MISMATCH: '', // 实验定义与平台版本不匹配（内容需重新发布）
    CERT_NOT_ELIGIBLE: '', // 还不满足领取条件：{detail}
    VALIDATION_FAILED: '', // 输入不符合要求：{detail}
    RATE_LIMITED: '', // 操作太频繁，请稍后重试
    UPSTREAM_THROTTLED: '', // AWS 接口繁忙，平台已重试，请稍后再试
    UPSTREAM_UNAVAILABLE: '', // 依赖的 AWS 服务暂时不可用
    NOT_FOUND: '', // 没有找到
    INTERNAL: '', // 平台内部错误（错误 ID：{requestId}）
    UNAUTHENTICATED: '', // 登录已过期，请重新登录
    FORBIDDEN_ROLE: '', // 你的角色不能执行这个操作
    REAUTH_REQUIRED: '', // 这个操作要求最近 60 分钟内登录过
    TARGET_ALREADY_SATISFIED: '', // 这个环境里 {module} 已经是 {value}，在这里开始拿不到本次会话的完成证据
    HARD_PREREQ_UNMET: '', // 前置卡片还没有完成
    LAB_DEPRECATED: '', // 本卡片已停用
    TERMINAL_SESSION_STATE: '', // 当前状态不能打开终端（或访问已收回）
    TERMINAL_TARGET_NOT_IN_SESSION: '', // 目标实例不属于本环境
    TERMINAL_TARGET_NOT_CONNECTED: '', // 实验机的管理通道不可达，暂时不能打开终端
    TERMINAL_TARGET_NOT_PREPARED: '', // 实验机还没有准备好终端
    TERMINAL_LIMIT: '', // 终端数量已达上限
    TERMINAL_GONE: '', // 终端会话已结束，不能续连
    CONSOLE_SESSION_STATE: '', // 当前状态不能获取控制台登录
    CONSOLE_DESTINATION_NOT_ALLOWED: '', // 这个控制台页面不在允许的列表中
    CONSOLE_FEDERATION_FAILED: '', // 控制台登录服务暂时不可用
    NETWORK: '', // 无法连接平台，请检查网络后重试
    BAD_RESPONSE: '', // 平台返回了无法识别的响应
  },
  auth: {
    loginTitle: '', // 登录
    tagline: '', // 部署在你自己 AWS 账号中的 SAA-C03 实验平台。
    signIn: '', // 使用平台账号登录
    firstLogin: '', // 首次登录需要修改临时密码，并用验证器 App 绑定 TOTP 两步验证。临时密码在安装平台时发送到学员邮箱。
    forgot: '', // 忘记密码：在登录页点“忘记密码”。丢失验证器：请账号管理员在 Cognito 控制台重置（平台不提供绕过两步验证的入口）。
    tabOnly: '', // 登录状态只保存在当前浏览器标签页，关闭标签页后需要重新登录。
    reasonExpired: '', // 登录已过期，请重新登录。你刚才所在的页面会在登录后自动打开。
    reasonReauth: '', // 这个操作（打开终端、控制台登录、查看管理员密码、领取证书、平台动作、卸载准备）要求最近 60 分钟内登录过。
    reasonSignedOutElsewhere: '', // 你已在另一个标签页退出。
    callbackWorking: '', // 正在完成登录…
    callbackStale: '', // 登录请求已失效（可能是打开了旧的登录页）。请重新登录。
    callbackError: '', // 登录未完成：{error}
    tokenFailed: '', // 无法连接登录服务，请检查网络后重试。
    signedOut: '', // 你已退出 ATL 实验平台。
    configFailed: '', // 无法读取平台配置（/config.json）。请稍后重试。
    devTitle: '', // 开发模式登录
    devHint: '', // 本地开发（dev-server）使用开发令牌，不连接 Cognito。只在本机地址可用。
    devGroup: '', // 角色
    devSub: '', // 用户标识
    devStaleAuth: '', // 模拟 60 分钟前登录（测试“需要重新登录”）
    devSignIn: '', // 以开发身份登录
  },
  i18n: {
    switcher: '表示言語', // 界面语言
    untranslated: '未翻訳', // 未翻译
    untranslatedHint: 'この内容はまだ選択した言語に翻訳されていないため、別の言語で表示しています。', // 这部分内容还没有当前语言的版本，暂时显示其他语言。
  },
  fmt: {
    spanHM: '{h} 時間 {m} 分', // {h} 小时 {m} 分
    spanH: '{h} 時間', // {h} 小时
    spanM: '{m} 分', // {m} 分
    spokenS: '{s} 秒', // {s} 秒
    spokenM: '{m} 分', // {m} 分钟
    spokenHM: '{h} 時間 {m} 分', // {h} 小时 {m} 分
    spokenH: '{h} 時間', // {h} 小时
    remainingCoarse: '残り約 {t}', // 剩余约 {t}
  },
} satisfies Dict<typeof zh>;
