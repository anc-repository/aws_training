/**
 * ja（日本語）：命名空间 end。由 `npm run i18n:sync` 按 zh-CN 词典维护结构：
 * 只填写引号内的译文（空字符串 = 未翻译，运行时按 ja → en → zh-CN 回退）；行尾注释是 zh-CN 原文。
 * 术语与风格见 ../glossary.md（不翻译 AWS 服务名、CLI 命令、代码、资源名、API 路径、环境变量）。
 */
import type { Dict } from '../dict';
import type zh from '../zh-CN/end';

export default {
  stage: {
    stop: '', // 停止倒计时
    revoke: '', // 收回访问
    finalize: '', // 定稿报告
    workstation: '', // 删除工作台
    suspend: '', // 进入节省模式
    destroy: '', // 拆除环境栈
    reclaim: '', // 回收与校验
    conclude: '', // 结论
  },
  stageStatus: {
    todo: '', // 未开始
    queued: '', // 排队中
    running: '', // 进行中
    retrying: '', // 重试中
    done: '', // 完成
    failed: '', // 失败
    skipped: '', // 跳过
  },
  hint: {
    cloudfront: '', // 正在禁用，部署完成后删除（通常较慢）
    rds: '', // 删除较慢，通常需要数分钟以上
    nat: '', // 异步删除中
    elasticache: '', // 删除较慢
  },
  offsetMin: '', // +{n} 分钟
  offsetHour: '', // +{n} 小时
  phaseDone: '', // {title}已完成
  phasesTitle: '', // 结束阶段
  reclaimFlow: '', // （发现 → 分阶段删除 → 校验）
  export: {
    label: '', // 导出回收报告
    started: '', // 已开始下载
    exporting: '', // 正在导出…
    aria: '', // {label}（Markdown 或 JSON）
    md: '', // Markdown（含 CLI 删除命令）
  },
  rescan: {
    title: '', // 复扫时间线
    done: '', // 完成
    doneAt: '', // 完成 {t}
    found: '', // 发现残留
    foundAt: '', // 发现残留 {t}
    running: '', // 进行中
    due: '', // 已到计划时间 {t}
    planned: '', // 计划 {t}
    item: '', // 复扫 {n} · {status}
  },
  resources: {
    unmasked: '', // 已显示完整的账号 ID 与 IP，30 秒后恢复打码
    masked: '', // 已恢复打码
    title: '', // 资源（本次实验创建或接管的 {n} 项）
    titleChain: '', // 资源（本次实验创建或接管的 {n} 项，另含交接链中其他会话的资源 {m} 项）
    counts: '', // 已删除 {deleted} · 删除中 {deleting} · 等待 {waiting} · 保留 {retained} · 需人工 {attention}
    remask: '', // 恢复打码
    unmask: '', // 显示完整值
    none: '', // 没有记录到本次实验创建的资源。
    stageSr: '', // 已删除 {done} 项，共 {total} 项
    colState: '', // 状态
    colName: '', // 类型与名称
    colSource: '', // 来源
    colBilling: '', // 计费
    colNote: '', // 说明
    attempts: '', // 已尝试 {n} 次
  },
  page: {
    noSession: '', // 没有这个会话
    title: '', // 结束与回收
    reading: '', // 正在读取会话
    viewReport: '', // 查看报告
    revoked: '', // 终端已断开 · 控制台与工作台凭证已吊销（已打开的控制台窗口中的权限会被拒绝；权限收回需要一点时间，以官方文档为准）
    neverReady: '', // 环境未就绪：没有报告，尝试不计入次数
    attempt: '', // 尝试：{state}
    unverified: '', // （部分资源的归属将在复扫后确认）
    reportRev: '', //  · 报告第 {n} 版已生成
    reclaimed: '', // 已删除 {n} 项
    reclaimedManual: '', // 已删除 {n} 项 · 需人工 {m} 项
    cleanupFailed: '', // 释放未完成
    allReleased: '', // 已释放全部资源
    failedReleased: '', // 启动失败，已释放已创建的资源
    crumbs: '', // 面包屑
    mySessions: '', // 我的实验
    heading: '', // {labId} · 结束与回收
    session: '', // 会话 {sid}
    env: '', //  · 环境 {name}
    endReason: '', //  · 结束原因：{reason}
    elapsed: '', // 已用 {t} · 回收较慢的项目会单独提示
    retrying: '', // 正在重试回收。
    allReleasedDot: '', // 已释放全部资源。
    rescanPending: '', // 复扫会在 {t} 前完成。复扫若发现删不掉的残留，会话会转为“释放未完成”并通知你。
    allDone: '', // 回收已全部完成。
    handedOver: '', // 环境已交接给新的会话。
    failureReason: '', // 失败原因：{reason}（{code}）· 
    notCounted: '', // 这次尝试不计入次数
    restart: '', // 重新开始
    sessionDetail: '', // 会话详情
    manualTitle: '', // 释放未完成：{n} 项资源没能自动删除
    manualHourly: '', // ，其中 {n} 项按小时计费
    observerNote: '', // 有资源没能自动删除，学员需要逐项处理。你的角色（观察者）看不到待人工处理清单。
    manualGuide: '', // 它们仍可能计费，请按下面的指引处理。平台会在 1 小时、6 小时、24 小时后自动重试回收（以平台设置为准）。这些资源都带有 {tag} 标签，可以在控制台按标签查找。
    manualUnavailable: '', // 待人工处理清单暂不可用
    allHandled: '', // 清单中的资源都已处理，正在等待平台核对结论。
    requestingRetry: '', // 正在请求重试…
    retryNow: '', // 立即重试回收
    exportList: '', // 导出清单
    reclaimAfterEnd: '', // 结束阶段完成后开始回收资源。
    resources: '', // 资源
    reportUnavailable: '', // 回收报告暂不可用 ·
    retry: '', // 重试
    readingResources: '', // 正在读取资源
    observerConclusion: '', // 回收结论：{v}。你的角色（观察者）看不到资源清单与费用明细。
    reclaiming: '', // 回收进行中
    released: '', // 已释放
    afterTitle: '', // 之后还会做什么
    afterBody: '', // CloudTrail 事件有投递延迟。主回收完成后，平台会在收回访问后的 +20 分钟、+60 分钟、+6 小时各复扫一次，补删迟到的资源。复扫不影响你开始下一张卡片。
    canLeave: '', // 可以离开这个页面。
    nextCard: '', // 先看看下一张卡片 →
    noReport: '', // 这次会话在环境就绪前结束，没有报告（尝试不计入次数）。
    notCleanupFailed: '', // 会话已不在“释放未完成”状态，页面已刷新
  },
  keep: {
    perHour: '', // /小时
    amount: '', // {range} × {n} 小时
    extendedTo: '', // 已延长保留到 {t}
    extended: '', // 已延长保留
    title: '', // 延长保留
    cancel: '', // 取消
    recompute: '', // 重新计算费用
    extending: '', // 正在延长…
    computingReason: '', // 正在计算费用
    confirmFirst: '', // 请先确认费用
    extend: '', // 延长保留
    more: '', // 再保留
    moreHint: '', // 单次最多 {n} 小时；累计不超过环境的最长寿命。
    hours: '', // {n} 小时
    computing: '', // 正在计算费用…
    cost: '', // 保留期间持续计费（估算）：{amount}
    unknown: '', // 未知
    unknownPrice: '', // （单价暂不可得）
    period: '', // 。
    unknownLine: '', //  · 未知
    priceNote: '', // 估算 · 单价取自 Price List{asOf} · 以 AWS 官方定价与账单为准
    priceAsOf: '', // ，取价时间 {t}
    validUntil: '', //  · 报价有效至 {t}
    expired: '', // 报价已过期，请重新计算费用。
    ack: '', // 我了解保留期间资源会持续计费
    ackUnknown: '', // 我了解部分资源的费用未能估算（标为“未知”的行）
    ackBudget: '', // 本月费用已达到预算的 80%（实际或预测），我仍要延长保留
    releaseStarted: '', // 已开始释放保留的环境
    releaseTitle: '', // 立即释放保留的环境
    releasing: '', // 正在释放…
    release: '', // 立即释放
    releaseNote: '', // 立即释放保留的环境（不可撤销）。环境中的资源会被删除，回收完成前仍会计费。
  },
  kept: {
    uninstalling: '', // 平台正在卸载，不能延长保留。
    budget: '', // 本月费用已超过预算，按设置不能延长保留。
    cannot: '', // 当前不能延长保留。
    crumbs: '', // 面包屑
    mySessions: '', // 我的实验
    title: '', // 环境保留中
    heading: '', // 环境保留中 · {labId}
    autoRelease: '', // {until} 自动释放
    untilUnknown: '', // 保留截止时间未知
    from: '', // 来自
    fromValue: '', // {labId}（{when}）
    endedAt: '', // {t} 结束
    saveMode: '', // 节省模式
    saveOn: '', // 开（实验机已停止）
    saveOff: '', // 关：实验机仍在运行并计费
    envAge: '', // 环境年龄
    maxAge: '', // （最长保留到 {t}）
    modules: '', // 启用的模块
    listSep: '', // 、
    billing: '', // 仍在计费（估算，按当前实际资源）：{money}
    unknown: '', // 未知
    unknownNote: '', // （单价暂不可得，以 AWS 账单为准）
    saveOffNote: '', // 节省模式关闭：实验机仍在运行并计费。
    asg: '', // 该环境含 ASG，保留期间持续计费。
    estimate: '', // 估算 · 以 AWS 官方定价与账单为准。
    reserved: '', // 正在被新会话接管，暂时不能立即释放。
    reuseNext: '', // 在下一张卡片中复用 →
    continue: '', // 继续本卡片 →
    extend: '', // 延长保留…
    release: '', // 立即释放…
    noAccess: '', // 保留期间没有终端与控制台访问。要继续操作，请开始一个复用该环境的新会话。
    resources: '', // 保留的资源（{n} 项）
  },
} satisfies Dict<typeof zh>;
