/**
 * en（English）：命名空间 end。由 `npm run i18n:sync` 按 zh-CN 词典维护结构：
 * 只填写引号内的译文（空字符串 = 未翻译，运行时按 en → en → zh-CN 回退）；行尾注释是 zh-CN 原文。
 * 术语与风格见 ../glossary.md（不翻译 AWS 服务名、CLI 命令、代码、资源名、API 路径、环境变量）。
 */
import type { Dict } from '../dict';
import type zh from '../zh-CN/end';

export default {
  stage: {
    stop: 'Stop the countdown', // 停止倒计时
    revoke: 'Revoke access', // 收回访问
    finalize: 'Finalize the report', // 定稿报告
    workstation: 'Delete the workbench', // 删除工作台
    suspend: 'Enter saving mode', // 进入节省模式
    destroy: 'Tear down the environment stack', // 拆除环境栈
    reclaim: 'Reclaim and verify', // 回收与校验
    conclude: 'Conclusion', // 结论
  },
  stageStatus: {
    todo: 'Not started', // 未开始
    queued: 'Queued', // 排队中
    running: 'In progress', // 进行中
    retrying: 'Retrying', // 重试中
    done: 'Done', // 完成
    failed: 'Failed', // 失败
    skipped: 'Skipped', // 跳过
  },
  hint: {
    cloudfront: 'Disabling; deleted after the deployment finishes (usually slow)', // 正在禁用，部署完成后删除（通常较慢）
    rds: 'Slow to delete (usually several minutes or more)', // 删除较慢，通常需要数分钟以上
    nat: 'Deleting asynchronously', // 异步删除中
    elasticache: 'Slow to delete', // 删除较慢
  },
  offsetMin: '+{n} min', // +{n} 分钟
  offsetHour: '+{n} h', // +{n} 小时
  phaseDone: '{title}: done', // {title}已完成
  phasesTitle: 'End stages', // 结束阶段
  reclaimFlow: ' (discover → delete in stages → verify)', // （发现 → 分阶段删除 → 校验）
  export: {
    label: 'Export the reclaim report', // 导出回收报告
    started: 'Download started', // 已开始下载
    exporting: 'Exporting…', // 正在导出…
    aria: '{label} (Markdown or JSON)', // {label}（Markdown 或 JSON）
    md: 'Markdown (with CLI delete commands)', // Markdown（含 CLI 删除命令）
  },
  rescan: {
    title: 'Rescan timeline', // 复扫时间线
    done: 'Done', // 完成
    doneAt: 'Done {t}', // 完成 {t}
    found: 'Leftovers found', // 发现残留
    foundAt: 'Leftovers found {t}', // 发现残留 {t}
    running: 'Running', // 进行中
    due: 'Due since {t}', // 已到计划时间 {t}
    planned: 'Planned {t}', // 计划 {t}
    item: 'Rescan {n} · {status}', // 复扫 {n} · {status}
  },
  resources: {
    unmasked: 'Full account ID and IPs shown; masked again in 30 seconds', // 已显示完整的账号 ID 与 IP，30 秒后恢复打码
    masked: 'Masked again', // 已恢复打码
    title: 'Resources ({n} created or adopted by this lab)', // 资源（本次实验创建或接管的 {n} 项）
    titleChain: 'Resources ({n} created or adopted by this lab, plus {m} from other sessions in the hand-over chain)', // 资源（本次实验创建或接管的 {n} 项，另含交接链中其他会话的资源 {m} 项）
    counts: 'Deleted {deleted} · deleting {deleting} · waiting {waiting} · kept {retained} · needs you {attention}', // 已删除 {deleted} · 删除中 {deleting} · 等待 {waiting} · 保留 {retained} · 需人工 {attention}
    remask: 'Mask again', // 恢复打码
    unmask: 'Show full values', // 显示完整值
    none: 'No resources created by this lab were recorded.', // 没有记录到本次实验创建的资源。
    stageSr: '{done} of {total} deleted', // 已删除 {done} 项，共 {total} 项
    colState: 'State', // 状态
    colName: 'Type and name', // 类型与名称
    colSource: 'Source', // 来源
    colBilling: 'Billing', // 计费
    colNote: 'Notes', // 说明
    attempts: '{n, plural, one {# attempt} other {# attempts}}', // 已尝试 {n} 次
  },
  page: {
    noSession: 'Session not found', // 没有这个会话
    title: 'End and reclaim', // 结束与回收
    reading: 'Loading the session', // 正在读取会话
    viewReport: 'View report', // 查看报告
    revoked: 'Terminal disconnected · console and workbench credentials revoked (open console windows will be denied; revocation takes a moment, see the official documentation)', // 终端已断开 · 控制台与工作台凭证已吊销（已打开的控制台窗口中的权限会被拒绝；权限收回需要一点时间，以官方文档为准）
    neverReady: 'Ended before the environment was ready: no report, and the attempt does not count', // 环境未就绪：没有报告，尝试不计入次数
    attempt: 'Attempt: {state}', // 尝试：{state}
    unverified: ' (ownership of some resources is confirmed after the rescans)', // （部分资源的归属将在复扫后确认）
    reportRev: ' · report revision {n} generated', //  · 报告第 {n} 版已生成
    reclaimed: '{n} deleted', // 已删除 {n} 项
    reclaimedManual: '{n} deleted · {m} need you', // 已删除 {n} 项 · 需人工 {m} 项
    cleanupFailed: 'Cleanup incomplete', // 释放未完成
    allReleased: 'All resources released', // 已释放全部资源
    failedReleased: 'Start failed; the resources it created were released', // 启动失败，已释放已创建的资源
    crumbs: 'Breadcrumb', // 面包屑
    mySessions: 'My labs', // 我的实验
    heading: '{labId} · End and reclaim', // {labId} · 结束与回收
    session: 'Session {sid}', // 会话 {sid}
    env: ' · environment {name}', //  · 环境 {name}
    endReason: ' · ended: {reason}', //  · 结束原因：{reason}
    elapsed: 'Elapsed {t} · slow items are flagged separately', // 已用 {t} · 回收较慢的项目会单独提示
    retrying: 'Retrying the reclaim.', // 正在重试回收。
    allReleasedDot: 'All resources released.', // 已释放全部资源。
    rescanPending: 'Rescans finish by {t}. If a rescan finds leftovers it cannot delete, the session becomes “Cleanup incomplete” and you are notified.', // 复扫会在 {t} 前完成。复扫若发现删不掉的残留，会话会转为“释放未完成”并通知你。
    allDone: 'Reclaim is complete.', // 回收已全部完成。
    handedOver: 'The environment was handed over to a new session.', // 环境已交接给新的会话。
    failureReason: 'Reason: {reason} ({code}) · ', // 失败原因：{reason}（{code}）· 
    notCounted: 'This attempt does not count', // 这次尝试不计入次数
    restart: 'Start again', // 重新开始
    sessionDetail: 'Session details', // 会话详情
    manualTitle: 'Cleanup incomplete: {n, plural, one {# resource} other {# resources}} could not be deleted automatically', // 释放未完成：{n} 项资源没能自动删除
    manualHourly: ', {n} billed hourly', // ，其中 {n} 项按小时计费
    observerNote: 'Some resources could not be deleted automatically and the learner must handle them one by one. Your role (observer) cannot see the manual-handling list.', // 有资源没能自动删除，学员需要逐项处理。你的角色（观察者）看不到待人工处理清单。
    manualGuide: 'They may still be billed; follow the guidance below. The platform retries the reclaim automatically after 1, 6 and 24 hours (per the platform settings). Every resource carries the {tag} tag, so you can find them by tag in the console.', // 它们仍可能计费，请按下面的指引处理。平台会在 1 小时、6 小时、24 小时后自动重试回收（以平台设置为准）。这些资源都带有 {tag} 标签，可以在控制台按标签查找。
    manualUnavailable: 'The manual-handling list is unavailable', // 待人工处理清单暂不可用
    allHandled: 'Every listed resource has been handled; waiting for the platform to confirm.', // 清单中的资源都已处理，正在等待平台核对结论。
    requestingRetry: 'Requesting a retry…', // 正在请求重试…
    retryNow: 'Retry reclaim now', // 立即重试回收
    exportList: 'Export list', // 导出清单
    reclaimAfterEnd: 'Resources are reclaimed after the end stages finish.', // 结束阶段完成后开始回收资源。
    resources: 'Resources', // 资源
    reportUnavailable: 'Reclaim report unavailable ·', // 回收报告暂不可用 ·
    retry: 'Retry', // 重试
    readingResources: 'Loading resources', // 正在读取资源
    observerConclusion: 'Reclaim result: {v}. Your role (observer) cannot see the resource list or cost details.', // 回收结论：{v}。你的角色（观察者）看不到资源清单与费用明细。
    reclaiming: 'Reclaiming', // 回收进行中
    released: 'Released', // 已释放
    afterTitle: 'What happens next', // 之后还会做什么
    afterBody: 'CloudTrail events arrive late. After the main reclaim, the platform rescans at +20 minutes, +60 minutes and +6 hours after access was revoked and deletes late arrivals. Rescans do not stop you from starting the next card.', // CloudTrail 事件有投递延迟。主回收完成后，平台会在收回访问后的 +20 分钟、+60 分钟、+6 小时各复扫一次，补删迟到的资源。复扫不影响你开始下一张卡片。
    canLeave: 'You can leave this page.', // 可以离开这个页面。
    nextCard: 'See the next card →', // 先看看下一张卡片 →
    noReport: 'This session ended before the environment was ready, so there is no report (and the attempt does not count).', // 这次会话在环境就绪前结束，没有报告（尝试不计入次数）。
    notCleanupFailed: 'The session is no longer “Cleanup incomplete”; the page was refreshed', // 会话已不在“释放未完成”状态，页面已刷新
  },
  keep: {
    perHour: '/hour', // /小时
    amount: '{range} × {n} h', // {range} × {n} 小时
    extendedTo: 'Kept until {t}', // 已延长保留到 {t}
    extended: 'Keep extended', // 已延长保留
    title: 'Extend keep', // 延长保留
    cancel: 'Cancel', // 取消
    recompute: 'Recalculate cost', // 重新计算费用
    extending: 'Extending…', // 正在延长…
    computingReason: 'Calculating the cost', // 正在计算费用
    confirmFirst: 'Confirm the cost first', // 请先确认费用
    extend: 'Extend keep', // 延长保留
    more: 'Keep for', // 再保留
    moreHint: 'Up to {n} hours at a time; the total cannot exceed the environment’s maximum lifetime.', // 单次最多 {n} 小时；累计不超过环境的最长寿命。
    hours: '{n, plural, one {# hour} other {# hours}}', // {n} 小时
    computing: 'Calculating the cost…', // 正在计算费用…
    cost: 'Billing continues while kept (estimate): {amount}', // 保留期间持续计费（估算）：{amount}
    unknown: 'unknown', // 未知
    unknownPrice: ' (unit price unavailable)', // （单价暂不可得）
    period: '.', // 。
    unknownLine: ' · unknown', //  · 未知
    priceNote: 'Estimate · unit prices from the Price List{asOf} · AWS pricing and your bill are authoritative', // 估算 · 单价取自 Price List{asOf} · 以 AWS 官方定价与账单为准
    priceAsOf: ' (as of {t})', // ，取价时间 {t}
    validUntil: ' · quote valid until {t}', //  · 报价有效至 {t}
    expired: 'The quote has expired. Recalculate the cost.', // 报价已过期，请重新计算费用。
    ack: 'I understand the resources are billed while kept', // 我了解保留期间资源会持续计费
    ackUnknown: 'I understand some costs could not be estimated (rows marked “unknown”)', // 我了解部分资源的费用未能估算（标为“未知”的行）
    ackBudget: 'This month’s cost has reached 80% of the budget (actual or forecast); extend the keep anyway', // 本月费用已达到预算的 80%（实际或预测），我仍要延长保留
    releaseStarted: 'Releasing the kept environment', // 已开始释放保留的环境
    releaseTitle: 'Release the kept environment now', // 立即释放保留的环境
    releasing: 'Releasing…', // 正在释放…
    release: 'Release now', // 立即释放
    releaseNote: 'Releases the kept environment now (cannot be undone). Its resources are deleted and billed until the reclaim finishes.', // 立即释放保留的环境（不可撤销）。环境中的资源会被删除，回收完成前仍会计费。
  },
  kept: {
    uninstalling: 'The platform is being uninstalled; the keep cannot be extended.', // 平台正在卸载，不能延长保留。
    budget: 'This month’s cost is over budget; per the settings the keep cannot be extended.', // 本月费用已超过预算，按设置不能延长保留。
    cannot: 'The keep cannot be extended right now.', // 当前不能延长保留。
    crumbs: 'Breadcrumb', // 面包屑
    mySessions: 'My labs', // 我的实验
    title: 'Environment kept', // 环境保留中
    heading: 'Environment kept · {labId}', // 环境保留中 · {labId}
    autoRelease: 'Released automatically {until}', // {until} 自动释放
    untilUnknown: 'Keep deadline unknown', // 保留截止时间未知
    from: 'From', // 来自
    fromValue: '{labId} ({when})', // {labId}（{when}）
    endedAt: 'ended {t}', // {t} 结束
    saveMode: 'Saving mode', // 节省模式
    saveOn: 'On (lab instance stopped)', // 开（实验机已停止）
    saveOff: 'Off: the lab instance is running and billed', // 关：实验机仍在运行并计费
    envAge: 'Environment age', // 环境年龄
    maxAge: ' (kept at most until {t})', // （最长保留到 {t}）
    modules: 'Enabled modules', // 启用的模块
    listSep: ', ', // 、
    billing: 'Still billed (estimate, from the current resources): {money}', // 仍在计费（估算，按当前实际资源）：{money}
    unknown: 'unknown', // 未知
    unknownNote: ' (unit price unavailable; your AWS bill is authoritative)', // （单价暂不可得，以 AWS 账单为准）
    saveOffNote: 'Saving mode is off: the lab instance is running and billed.', // 节省模式关闭：实验机仍在运行并计费。
    asg: 'This environment includes an ASG and is billed while kept.', // 该环境含 ASG，保留期间持续计费。
    estimate: 'Estimate · AWS pricing and your bill are authoritative.', // 估算 · 以 AWS 官方定价与账单为准。
    reserved: 'A new session is taking it over, so it cannot be released right now.', // 正在被新会话接管，暂时不能立即释放。
    reuseNext: 'Reuse in the next card →', // 在下一张卡片中复用 →
    continue: 'Continue this card →', // 继续本卡片 →
    extend: 'Extend keep…', // 延长保留…
    release: 'Release now…', // 立即释放…
    noAccess: 'There is no terminal or console access while the environment is kept. To continue, start a new session that reuses it.', // 保留期间没有终端与控制台访问。要继续操作，请开始一个复用该环境的新会话。
    resources: 'Kept resources ({n})', // 保留的资源（{n} 项）
  },
  visual: {
    deleted: 'Deleted', // 已删除
    details: 'Details', // 详细说明
    keepTimeline: 'Keep timeline', // 保留期限
    created: 'Created', // 创建
    now: 'Now', // 现在
    keepUntil: 'Auto release', // 自动释放
    maxAge: 'Maximum age', // 最长期限
  },
} satisfies Dict<typeof zh>;
