/**
 * en（English）：命名空间 settings。由 `npm run i18n:sync` 按 zh-CN 词典维护结构：
 * 只填写引号内的译文（空字符串 = 未翻译，运行时按 en → en → zh-CN 回退）；行尾注释是 zh-CN 原文。
 * 术语与风格见 ../glossary.md（不翻译 AWS 服务名、CLI 命令、代码、资源名、API 路径、环境变量）。
 */
import type { Dict } from '../dict';
import type zh from '../zh-CN/settings';

export default {
  title: 'Settings', // 设置
  navLabel: 'Settings', // 设置
  selectLabel: 'Settings tab', // 设置页签
  tabs: {
    profile: 'Profile and preferences', // 个人资料与偏好
    platform: 'About and health check', // 关于与体检
    guardrails: 'Guardrails and budget', // 护栏与预算
    workspace: 'Workbench and preview', // 工作台与预览
    members: 'Members', // 成员
    content: 'Content version', // 内容版本
    audit: 'Audit', // 审计
    upgrade: 'Upgrade', // 升级
    uninstall: 'Uninstall', // 卸载
  },
  readonly: 'The platform is being uninstalled: this tab is read-only.', // 平台卸载中：本页签只读。
  save: 'Save', // 保存
  saving: 'Saving…', // 正在保存…
  saved: 'Saved', // 已保存
  savedNext: 'Saved · takes effect the next time a lab starts', // 已保存 · 下一次开始实验时生效
  conflict: 'The settings just changed (maybe in another tab) and were refreshed. Please try again.', // 设置刚被修改（可能在另一个标签页），已刷新。请重新操作。
  activeNote: 'Some settings don’t apply to the lab in progress.', // 部分设置对进行中的实验不生效。
  profile: {
    displayName: 'Display name', // 显示名
    certName: 'Name on certificates', // 证书署名
    nameRequired: 'Display name can’t be empty', // 显示名不能为空
    theme: 'Theme', // 主题
    themeSystem: 'Match system', // 跟随系统
    themeLight: 'Light', // 亮
    themeDark: 'Dark', // 暗
    shortcuts: 'Enable single-key shortcuts (G W, /, ?, and so on; when off, only Ctrl+K and Esc remain)', // 启用单键快捷键（G W、/、? 等；关闭后只保留 Ctrl+K 与 Esc）
    leader: 'Workbench leader key', // 工作台前导键
    fontSize: 'Terminal font size', // 终端字号
    screenReader: 'Terminal screen reader mode', // 终端读屏模式
    notify: 'Browser notifications (sent only when the page isn’t visible, best effort; the text contains no resource IDs or account IDs)', // 浏览器通知（只在页面不可见时发送，尽力送达；文案不含资源 ID 与账号 ID）
    notifyDenied: 'The browser denied notification permission; you can allow it again in the browser’s site settings.', // 浏览器拒绝了通知权限，可以在浏览器的网站设置中重新允许。
    localNote: 'Theme, shortcuts, and terminal preferences are saved only in this browser and take effect immediately.', // 主题、快捷键与终端偏好只保存在这个浏览器中，修改后立即生效。
    revisit: 'Review first-run setup', // 重看首次设置
  },
  platform: {
    version: 'Platform version', // 平台版本
    dev: 'Development build', // 开发版本
    catalog: 'Catalog version', // 目录版本
    region: 'Region', // 区域
    dr: 'DR Region', // 灾备区域
    drNone: 'Not set', // 未设置
    installation: 'Installation ID', // 安装 ID
    url: 'Platform URL', // 平台 URL
    features: 'Optional components', // 可选组件
    featureText: 'Terminal recording {rec} · platform trail {trail} · external access analyzer {aa}', // 终端录制 {rec} · 平台 trail {trail} · 外部访问分析器 {aa}
    on: 'on', // 开
    off: 'off', // 关
    preflight: 'Health check results (at install)', // 体检结果（安装时）
    preflightCounts: 'Fix {fix} · notice {warn} · passed {pass} · can’t detect {unknown}', // 需处理 {fix} 项 · 提示 {warn} 项 · 通过 {pass} 项 · 无法检测 {unknown} 项
    preflightNone: 'The install-time health check results haven’t been written yet.', // 安装时的体检结果还没有写入。
    details: 'View details', // 查看详情
    regionNote: 'The Region can’t be switched here (a different Region requires reinstalling).', // 区域不可在界面中切换（换区域需要重新安装）。
  },
  guardrails: {
    limits: 'Limits (from install parameters, read-only)', // 限额（来自安装参数，只读）
    value: 'Value', // 取值
    maxSession: 'Total time per session', // 单次会话总时长
    extension: 'Extensions', // 延长
    extensionValue: '{n} × {m} min', // {n} 次 × {m} 分钟
    keep: 'Keep limit', // 保留上限
    envAge: 'Maximum environment lifetime', // 环境最长寿命
    readyIdle: 'Idle limit after ready', // 就绪空闲时限
    instanceTypes: 'Allowed instance types', // 允许的实例类型
    minutes: '{n} min', // {n} 分钟
    hours: '{n, plural, one {# hour} other {# hours}}', // {n} 小时
    days: '{n, plural, one {# day} other {# days}}', // {n} 天
    budget: 'Budget atl-platform-guard', // 预算 atl-platform-guard
    budgetUnset: 'No budget guardrail is set. You can update MonthlyBudgetAmount and BudgetEnforcement of the atl stack in CloudFormation (only while no lab is running).', // 未设置预算护栏。可以在 CloudFormation 中更新 atl 栈的 MonthlyBudgetAmount 与 BudgetEnforcement（只在没有进行中的实验时操作）。
    enforcement: 'Enforcement {e} · state ', // 处理方式 {e} · 状态 
    maintenance: 'Maintenance mode', // 维护模式
    maintenanceHint: 'While on, new labs can’t start; labs in progress aren’t affected.', // 开启后不能开始新实验；进行中的实验不受影响。
    enter: 'Enter maintenance mode', // 进入维护模式
    exit: 'Leave maintenance mode', // 退出维护模式
    busy: 'Switching…', // 正在切换…
    activeBlocks: 'An environment is still in progress or kept, so maintenance mode can’t be turned on.', // 仍有进行中或保留中的环境，不能进入维护模式。
  },
  workspace: {
    lead: 'Platform settings can’t exceed the limits from the install parameters; some settings apply only to new sessions.', // 平台设置不超过安装参数给出的上限；部分设置只对新会话生效。
    limitsTitle: 'Sessions and keeping', // 会话与保留
    terminalTitle: 'Terminal and workbench', // 终端与工作台
    previewTitle: 'Preview, upload, and reclaim', // 预览、上传与回收
    readyIdle: 'Idle limit after ready (minutes)', // 就绪空闲时限（分钟）
    maxKeep: 'Keep limit (hours)', // 保留上限（小时）
    maxSession: 'Maximum total time per session (minutes)', // 单次会话总时长上限（分钟）
    extMinutes: 'Each extension (minutes)', // 每次延长（分钟）
    extCount: 'Number of extensions', // 延长次数
    persistence: 'Keep terminal sessions (terminal.persistence)', // 终端会话保持（terminal.persistence）
    signing: 'Sign terminal stream URLs (terminal.streamUrlSigning)', // 终端流地址签名（terminal.streamUrlSigning）
    keepalive: 'Terminal keepalive interval (seconds, terminal.keepalive)', // 终端保活间隔（秒，terminal.keepalive）
    recording: 'Terminal recording (read-only, reflects the install parameter TerminalRecording)', // 终端录制（只读，反映安装参数 TerminalRecording）
    instanceType: 'Workbench instance type (read-only, install parameter)', // 工作台实例类型（只读，安装参数）
    longSession: 'Long console sessions (console.longSession, off by default)', // 控制台长会话（console.longSession，默认关）
    directHttps: 'Default for direct HTTPS preview (cards can override, preview.directHttps)', // 预览直连 HTTPS 的缺省值（卡片可覆盖，preview.directHttps）
    lateUpload: 'Fallback upload of finalized comparison-experiment results (agent.lateUploadFallback)', // 对比实验结果的定稿上传回退（agent.lateUploadFallback）
    residual: 'Starting a new lab while leftovers remain (reclaim.blockStartOnResidual)', // 有未释放的残留时开始新实验（reclaim.blockStartOnResidual）
    residualAck: 'ack: can start after confirming (default)', // ack：确认后可以开始（默认）
    residualBlock: 'block: leftovers must be handled first', // block：必须先处理残留
    residualIgnore: 'ignore: notice only', // ignore：只提示
    ownership: 'Maximum wait for ownership confirmation (minutes, ownership.maxWaitMinutes)', // 归属确认的最长等待（分钟，ownership.maxWaitMinutes）
    capError: 'Can’t exceed the install parameter limit: {detail}', // 不能超过安装参数的上限：{detail}
    on: 'On', // 开
    off: 'Off', // 关
  },
  members: {
    note: 'The learner is the only learner and can’t be removed or downgraded; to change the learner’s email, use the Cognito console.', // 学员是唯一的 learner，不能删除或降级；更换学员邮箱需要在 Cognito 控制台操作。
    member: 'Member', // 成员
    role: 'Role', // 角色
    invitedAt: 'Invited', // 邀请时间
    remove: 'Remove', // 删除
    removeLabel: 'Remove member {name}', // 删除成员 {name}
    removeTitle: 'Remove member', // 删除成员
    removeBody: 'After removing {name} ({role}), they can no longer sign in to the platform.', // 删除 {name}（{role}）后，对方不能再登录平台。
    inviteEmail: 'Email to invite', // 邀请邮箱
    inviteRole: 'Role', // 角色
    invite: 'Invite', // 邀请
    inviting: 'Inviting…', // 正在邀请…
    invited: 'Invitation sent: they will receive an email with a temporary password.', // 已发送邀请：对方会收到一封带临时密码的邮件。
    emailInvalid: 'Enter a valid email address', // 请填写有效的邮箱地址
    empty: 'No members yet.', // 还没有成员。
  },
  content: {
    version: 'Current catalog version', // 当前目录版本
    publishedAt: 'Published', // 发布时间
    digest: 'Content digest', // 内容摘要
    defective: 'Status', // 状态
    defectiveYes: 'Marked defective', // 已标记为有缺陷
    defectiveNo: 'OK', // 正常
    mark: 'Mark as defective…', // 标记为有缺陷…
    markTitle: 'Mark the catalog version as defective', // 标记目录版本为有缺陷
    markBody: 'Once marked, this version issues no new certificates. Certificates already issued are not revoked automatically: in Certificates and badges › Certificate details, revoke them one by one as “content defect” or “misissued”, or keep them.', // 标记后该版本不再签发新证书。已签发的证书不会自动吊销：在 证书与徽章 › 证书详情 中逐张以“内容缺陷”或“误签”吊销，或保留。
    reason: 'Reason (optional)', // 原因（可选）
    confirm: 'Mark', // 标记
    busy: 'Marking…', // 正在标记…
  },
  audit: {
    session: 'Session ID', // 会话 ID
    from: 'From', // 从
    to: 'To', // 到
    apply: 'Filter', // 筛选
    time: 'Time', // 时间
    actor: 'Actor and role', // 操作者与角色
    action: 'Action', // 动作
    target: 'Target', // 对象
    result: 'Result', // 结果
    source: 'Source', // 来源
    resultOk: 'Succeeded', // 成功
    resultDenied: 'Denied', // 被拒绝
    resultError: 'Error', // 出错
    via: {
      web: 'Web', // 网页
      agent: 'CLI', // CLI
      internal: 'Platform', // 平台
      system: 'Platform', // 平台
    },
    showIp: 'Show full source IP', // 显示完整来源 IP
    hideIp: 'Mask again', // 恢复打码
    ipOnlyLearner: 'Source IPs are shown only to the learner.', // 来源 IP 只对学员显示。
    empty: 'No audit events in this period.', // 这段时间没有审计事件。
  },
  upgrade: {
    current: 'Current version {v}', // 当前版本 {v}
    latest: 'New version {v} available', // 有新版本 {v}
    notes: 'Release notes', // 更新说明
    upToDate: 'Up to date', // 已是最新版本
    devVersion: 'Development builds don’t check for updates', // 开发版本不检查更新
    failed: 'Can’t check for updates', // 无法检查更新
    prereq: 'Before upgrading: no environment in progress or kept, and no session within its rescan window.', // 升级前提：没有进行中或保留中的环境，也没有处在复扫窗口内的会话。
    prereqOk: 'Met', // 满足
    prereqActive: '{labId} is currently {state}', // 当前有 {labId} {state}
    toSession: 'Back to the current lab', // 回到当前实验
    step1: 'Enter maintenance mode (new labs can’t start meanwhile)', // 进入维护模式（期间不能开始新实验）
    step1On: 'Maintenance mode is on', // 已进入维护模式
    step2: 'In CloudFormation, create a change set for the atl stack and review it (keep the previous parameter values)', // 在 CloudFormation 中为 atl 栈创建变更集并审阅（参数沿用旧值）
    openCfn: 'Open the CloudFormation console', // 打开 CloudFormation 控制台
    step3: 'Execute the change set and wait for the stack update to finish (on failure CloudFormation rolls back automatically and the old version’s artifacts are kept)', // 执行变更集，等待栈更新完成（失败时 CloudFormation 自动回滚，旧版本制品仍保留）
    step4: 'Reload this page to confirm the version, then leave maintenance mode', // 刷新本页确认版本，然后退出维护模式
    templatePlaceholder: '<new template URL>', // <新模板 URL>
  },
  uninstall: {
    warning: 'Uninstalling deletes all platform data: reports, badges, certificates, the online verification page, and share links all stop working. Export first.', // 卸载会删除平台的全部数据：报告、徽章、证书、在线验证页、分享链接都会失效。请先导出。
    s1: '1 Export', // 1 导出
    archive: 'Learning archive (report HTML, certificate JWS, public keys jwks.json, comparison-experiment results)', // 学习档案（报告 HTML、证书 JWS、公钥 jwks.json、对比实验结果）
    generate: 'Generate and download', // 生成并下载
    generating: 'Generating…', // 生成中…
    generatedAt: 'Generated {t}', // 已生成 {t}
    download: 'Download', // 下载
    exportTimeout: 'Generating has taken more than 10 minutes; please try again later.', // 生成时间超过 10 分钟，请稍后再试。
    manualList: 'Manual-handling list (Markdown / JSON, with CLI delete commands)', // 待人工处理清单（Markdown / JSON，含 CLI 删除命令）
    exportMd: 'Export Markdown', // 导出 Markdown
    exportJson: 'Export JSON', // 导出 JSON
    s2: '2 End everything and reclaim', // 2 结束全部并回收
    blockers: 'Blockers', // 阻塞项
    blockSession: 'Session {sid} ({labId}) is still {state}', // 会话 {sid}（{labId}）仍在 {state}
    blockManual: '{n, plural, one {# leftover needs} other {# leftovers need}} manual cleanup', // 待人工处理的残留 {n} 项
    blockRevocations: 'Revocation entries haven’t expired yet (cleared automatically in about {t})', // 吊销条目尚未过期（约 {t} 后自动清理）
    viewList: 'View list', // 查看清单
    noBlockers: 'No blockers.', // 没有阻塞项。
    confirmLabel: 'Type atl to confirm', // 输入 atl 以确认
    confirmHint: 'Ends every lab (keeping not allowed) and reclaims every environment.', // 会结束全部实验（不允许保留）并回收全部环境。
    prepare: 'End all labs and reclaim', // 结束全部实验并回收
    preparing: 'Reclaiming…', // 回收进行中…
    slow: 'Reclaiming continues in the background; delete the stack a little later.', // 回收仍在后台进行，请稍后再删除栈。
    s3: '3 Delete the platform stack', // 3 删除平台栈
    s3Hidden: 'Appears once all blockers are cleared.', // 全部阻塞项解除后出现。
    s3Text: 'The platform has turned off termination protection for the atl stack. Delete the atl stack in the CloudFormation console.', // 平台已关闭 atl 栈的终止保护。请在 CloudFormation 控制台删除 atl 栈。
    s3Warn: 'If the delete fails (DELETE_FAILED), don’t choose to retain resources such as UninstallGuard when retrying: that removes the platform’s ability to reclaim, and lab resources that are still billed would be left unreclaimed.', // 如果删除失败（DELETE_FAILED），重试删除时不要选择保留 UninstallGuard 等资源：那样平台的回收能力会被删除，仍在计费的实验资源将无人回收。
    s3After: 'When the delete finishes, no atl-*, ATL*, or cloudalbum-* resources should remain in the account; you can also check the /aws/lambda/atl-* log groups.', // 删除完成后，账号中不应残留 atl-*、ATL*、cloudalbum-* 资源；可检查 /aws/lambda/atl-* 日志组。
    statusFailed: 'The uninstall status can’t be read right now.', // 暂时无法读取卸载状态。
  },
} satisfies Dict<typeof zh>;
