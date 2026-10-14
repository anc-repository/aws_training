/**
 * en（English）：命名空间 report。由 `npm run i18n:sync` 按 zh-CN 词典维护结构：
 * 只填写引号内的译文（空字符串 = 未翻译，运行时按 en → en → zh-CN 回退）；行尾注释是 zh-CN 原文。
 * 术语与风格见 ../glossary.md（不翻译 AWS 服务名、CLI 命令、代码、资源名、API 路径、环境变量）。
 */
import type { Dict } from '../dict';
import type zh from '../zh-CN/report';

export default {
  revisionReason: {
    finalize: 'finalized', // 定稿
    cleanup: 'cleanup results added', // 追加清理结果
    'late-ownership': 'late ownership added', // 追加延迟归属
    ownership: 'late ownership added', // 追加延迟归属
    rescan: 'rescan results added', // 追加复扫结果
    quiz: 'quiz score added', // 追加小测成绩
    certificate: 'certificate added', // 追加证书
    regenerate: 'regenerated', // 重新生成
    manual: 'regenerated', // 重新生成
  },
  page: {
    noSession: 'Session not found', // 没有这个会话
    title: 'Lab report', // 实验报告
    readingSession: 'Loading the session', // 正在读取会话
    crumbs: 'Breadcrumb', // 面包屑
    mySessions: 'My labs', // 我的实验
    heading: '{labId} · Lab report', // {labId} · 实验报告
    sessionSub: 'Session {sid}', // 会话 {sid}
    noReportTitle: 'This session has no report', // 这次会话没有报告
    sessionDetail: 'Session details', // 会话详情
    noReportBody: 'The session ended before the environment was ready (the attempt does not count).', // 会话在环境就绪前结束（这次尝试不计入次数）。
    generating: 'The report is being generated (final checks and snapshot, usually a few minutes).', // 报告正在生成（最终复核与报告快照，通常几分钟）。
    generatingLabel: 'Generating the report', // 报告正在生成
    failed: 'The report snapshot could not be generated at the end (resource release is not affected).', // 报告快照未能在结束时生成（不影响资源释放）。
    requesting: 'Requesting…', // 正在请求…
    regenerate: 'Regenerate', // 重新生成
    regenStarted: 'Regeneration started; the page refreshes when it is done.', // 已开始重新生成报告，完成后自动刷新。
    readingReport: 'Loading the report', // 正在读取报告
    perHour: '/hour', // /小时
    cleanupFailed: 'Cleanup incomplete ({n} need you)', // 释放未完成（{n} 项待人工处理）
    cleanupReclaiming: 'Reclaiming; a revision is added to the report when done', // 回收进行中，完成后报告会追加修订
    cleanupKept: 'Environment kept', // 环境保留中
    cleanupLive: 'Lab in progress', // 实验进行中
    cleanupDone: 'Released', // 已释放
    cleanupRescan: 'Released (rescans in progress)', // 已释放（复扫进行中）
    previewSub: 'Preview (not saved) · session {sid} · {state}', // 预览（不保存）· 会话 {sid} · {state}
    versionSub: 'Revision {v}', // 第 {v} 版
    versionReason: ' ({reason})', // （{reason}）
    generatedAt: ' · generated {t}', //  · 生成于 {t}
    sessionTail: '· session {sid}', // · 会话 {sid}
    version: 'Revision', // 版本
    versionLatest: 'Revision {v} (latest)', // 第 {v} 版（最新）
    export: 'Export…', // 导出…
    share: 'Share…', // 分享…
    revisionsNote: '{n} revisions; the latest is shown here. Earlier revisions will be viewable here once the platform supports it.', // 共 {n} 版；这里显示最新版，较早的版本平台支持后可在此查看。
    newer: 'The report was updated to revision {v}.', // 报告已更新到第 {v} 版。
    view: 'View', // 查看
    previewNote: 'The lab has not ended; this is a preview (not saved). Export and sharing are not available.', // 实验尚未结束，以下是预览（不保存）。没有导出与分享。
    summary: 'Summary', // 摘要
    conclusion: 'Result', // 结论
    unverified: 'Could not verify', // 未能核验
    badgeTitle: ' · badge “{title}”', //  · 徽章“{title}”
    evidenceScore: ' (evidence score {n})', // （证据分 {n}）
    unverifiedNote: 'Ownership of some resources is not confirmed yet; the report updates automatically after the rescans.', // 部分资源的归属尚未确认，复扫完成后会自动更新报告。
    incompleteNote: 'Incomplete: {list}', // 未完成：{list}
    reasons: {
      ATTEMPT_INCOMPLETE: 'The attempt is incomplete or the badge conditions are not met', // 尝试未完成或徽章条件未满足
    },
    listSep: '; ', // ；
    idleNote: 'Not started: the workbench was never opened after the environment was ready.', // 未开始：环境就绪后一直没有进入工作台。
    duration: 'Duration', // 用时
    readyAt: 'Ready {t}', // 就绪 {t}
    endedAt: ' → ended {t}', //  → 结束 {t}
    ongoing: ' → in progress', //  → 进行中
    total: ' · total {t}', //  · 共 {t}
    extensions: ' · {n, plural, one {# extension} other {# extensions}}', //  · 延长 {n} 次
    checks: 'Checks', // 检查
    stepsDone: 'Steps {done}/{total}', // 步骤 {done}/{total}
    quality: ' · confidence: high {high} · medium {medium} · low {low}', //  · 可信度：高 {high} · 中 {medium} · 低 {low}
    cost: 'Cost', // 费用
    costLine: 'Estimate before start {start} · the recalculation by actual duration is in the HTML report (estimate · unit prices from the Price List · your bill is authoritative)', // 开始前估算 {start} · 按实际时长的重算见 HTML 报告（估算 · 单价取自 Price List · 以账单为准）
    unknown: 'unknown', // 未知
    cleanup: 'Cleanup', // 清理
    manualList: 'List', // 清单
    environment: 'Environment', // 环境
    reused: 'Reused environment', // 复用环境
    fresh: 'Fresh environment', // 全新环境
    account: ' · account {acct}', //  · 账号 {acct}
    startProfile: ' · start profile {name}', //  · 起始档位 {name}
    fullNote: 'This page shows the summary and this session’s check records. For the full report (larger evidence, quiz and cost recalculated by actual duration), {link}.', // 这里显示摘要与本次会话的检测记录；完整报告（含较大的证据、小测与按实际时长重算的费用）请{link}查看。
    downloadHtml: 'download the HTML report', // 下载 HTML 报告
    downloadInExport: 'download the HTML report from Export', // 在导出中下载 HTML 报告
    learnerExports: 'ask the learner to export the HTML report', // 由学员导出 HTML 报告
    toc: 'Report contents', // 报告目录
    tocLead: 'Contents:', // 目录：
    steps: 'Evidence by step', // 逐步证据
    experiments: 'Comparison experiments', // 对比实验
    appendix: 'Appendix', // 附录
    fullHistory: 'Full check history', // 完整检查记录
    noExperiments: 'This card has no comparison experiments.', // 本卡片没有对比实验。
    required: ' (required)', // （必做）
    optional: ' (optional)', // （选做）
    openCompare: 'Open comparison view', // 打开对比视图
    quiz: 'Quiz', // 小测
    quizBest: 'Best score {score} · {n, plural, one {# attempt} other {# attempts}}. ', // 最好成绩 {score} · 作答 {n} 次。
    quizInHtml: 'The quiz score is in the HTML report. ', // 小测成绩见 HTML 报告。
    quizNote: 'Recorded only; it does not affect completion or badges.', // 只记录，不影响完成与徽章。
    costNote: 'Both the estimate before start and the recalculation by actual duration are estimates (unit prices from the Price List{asOf}). Data transfer and some per-request charges are not included; your AWS bill is authoritative.', // 开始前的估算与按实际时长的重算都是估算（单价取自 Price List{asOf}），不含数据传输与部分按请求计费项，以 AWS 账单为准。
    priceAsOf: ', as of {t}', // ，取价时间 {t}
    startEstimate: 'Estimate before start', // 开始前估算
    unknownPrice: 'Unknown (unit price unavailable)', // 未知（单价暂不可得）
    quoteRef: ' · quote {id}', //  · 报价 {id}
    billActual: 'Actual bill', // 账单实际
    billNote: 'After you activate the cost allocation tags, AWS Cost Explorer can show costs by atl:session-id (data usually lags by about a day).', // 激活成本分配标签后，可在 AWS Cost Explorer 中按 atl:session-id 查看（数据通常有一天左右的延迟）。
    costInDetail: 'See billed resources and the recalculated estimate in the session details →', // 在会话详情中查看计费资源与按实际时长重算的估算 →
    reclaimed: ' · {n} reclaimed', //  · 已回收 {n} 项
    manualPending: ' · {n} need you', //  · 待人工处理 {n} 项
    reclaimProgress: 'Reclaim progress', // 回收进度
    card: 'Card', // 卡片
    cardVersion: 'Card version', // 卡片版本
    catalogVersion: 'Catalog version', // 目录版本
    variant: 'Start variant', // 起始变体
    digest: 'Report integrity digest', // 报告完整性摘要
    copyDigest: 'Copy the report integrity digest', // 复制报告完整性摘要
    copy: 'Copy', // 复制
    shareLinks: 'Share links', // 分享链接
    createShare: 'Create share link…', // 创建分享链接…
    printFooter: 'Exported {t} · account ID masked · self-hosted ATL Lab Platform (not affiliated with AWS)', // 导出时间 {t} · 账号 ID 已打码 · 自托管 ATL 实验平台（非 AWS 官方）
  },
  evidence: {
    title: 'Evidence by step', // 逐步证据
    readingSteps: 'Loading steps', // 正在读取步骤
    noSteps: 'No step records.', // 没有步骤记录。
    firstPassed: ' · first passed {t}', //  · 首次达成 {t}
    spent: ' · took {t}', //  · 用时 {t}
    drift: ' · drifted {n}×', //  · 漂移 {n} 次
    stepChecks: 'Checks for step {n}', // 第 {n} 步的检查
    inherited: 'Inherited from the hand-over chain', // 继承自交接链中的会话
    thisSession: 'Done in this session', // 本次完成
    ownershipPending: 'Ownership is confirmed after the session ends', // 归属在会话结束后确认
    manualObserved: 'Manual confirmation: observed {v}', // 手动确认：看到的值 {v}
    digest: 'Evidence digest {d}…', // 证据摘要 {d}…
    optional: ' (optional)', // （选做）
    trigger: {
      learner: 'Learner', // 学员
      user: 'Learner', // 学员
      manual: 'Learner', // 学员
      auto: 'Automatic', // 自动
      schedule: 'Automatic', // 自动
      wait: 'Polling', // 等待轮询
      poll: 'Polling', // 等待轮询
      submit: 'Submit', // 提交
      'expiring-precheck': 'Pre-expiry check', // 到期预检
      precheck: 'Pre-expiry check', // 到期预检
      finalize: 'Finalize', // 定稿
      final: 'Finalize', // 定稿
      ownership: 'Late ownership', // 延迟归属
      'late-ownership': 'Late ownership', // 延迟归属
      assistant: 'Assistant', // 助教
    },
    historyTitle: 'Check history', // 检查记录
    noHistory: 'No check records.', // 没有检查记录。
    filterByResult: 'Filter by result', // 按结果筛选
    all: 'All', // 全部
    recentOnly: 'Showing the latest 100 runs; the full history is in the HTML report.', // 显示最近 100 次检测；完整记录见 HTML 报告。
    caption: 'Full check history', // 完整检查记录
    colTime: 'Time', // 时间
    colCheck: 'Check', // 检查
    colResult: 'Result', // 结果
    colCode: 'Error code', // 错误码
    colTrigger: 'Trigger', // 触发方式
    other: 'Other', // 其他
  },
  share: {
    status: {
      publishing: 'Publishing', // 正在发布
      revoking: 'Revoking', // 正在撤销
      active: 'Active', // 有效
      revoked: 'Revoked', // 已撤销
      expired: 'Expired', // 已过期
    },
    expiry: {
      d7: '7 days', // 7 天
      d30: '30 days', // 30 天
      d90: '90 days', // 90 天
      never: 'Never expires', // 不过期
    },
    createTitle: 'Create share link', // 创建分享链接
    close: 'Close', // 关闭
    cancel: 'Cancel', // 取消
    creating: 'Creating…', // 正在创建…
    create: 'Create link', // 创建链接
    redactNote: 'What you share is a redacted copy: account IDs (including those inside ARNs, bucket names and URLs) keep only the last 4 digits; public IPs, the middle of resource IDs, session IDs and environment names are masked; manual-confirmation notes are left out.', // 分享的是一份脱敏副本：账号 ID（含 ARN、桶名、URL 中嵌入的）只留后 4 位，公网 IP、资源 ID 的中段、会话 id 与环境名一律打码，不含手动确认备注。
    publicNote: 'Anyone with the link can open it without signing in; search engines do not index it.', // 任何拿到链接的人都能打开，无需登录；搜索引擎不收录。
    expiresIn: 'Expires after', // 有效期
    uninstallNote: 'The link stops working when the platform is uninstalled.', // 平台卸载后链接随之失效。
    created: 'Created: {url} (publishing; usually opens within a few seconds)', // 已创建：{url}（正在发布，通常几秒后可以打开）
    notGenerated: 'The report has not been generated yet; you can share it once it is', // 报告还没有生成，生成后才能分享
    listTitle: 'Share links', // 分享链接
    none: 'No share links yet.', // 还没有分享链接。
    createdAt: 'Created {t}', // 创建 {t}
    expiresAt: ' · expires {t}', //  · {t} 过期
    noExpiry: ' · never expires', //  · 不过期
    copyLabel: 'Copy share link {url}', // 复制分享链接 {url}
    copied: 'Copied', // 已复制
    copyFailed: 'Copy failed; select the link manually', // 复制失败，请手动选中链接
    copy: 'Copy', // 复制
    open: 'Open', // 打开
    revokeLabel: 'Revoke share link {url}', // 撤销分享链接 {url}
    revoke: 'Revoke', // 撤销
    revokedAnnounce: 'Share link revoked', // 已撤销分享链接
    revokeTitle: 'Revoke share link', // 撤销分享链接
    revoking: 'Revoking…', // 正在撤销…
    revokeNote: 'After revoking, the link stops working shortly (the CDN cache takes time to refresh).', // 撤销后链接在短时间内失效（CDN 缓存刷新需要时间）。
  },
  export: {
    mixed: 'The platform can only mask both the account ID and public IPs, or neither', // 平台目前只能同时打码或同时不打码账号 ID 与公网 IP
    confirmFirst: 'First confirm that the export will contain the full AWS account ID', // 请先确认导出文件会包含完整的 AWS 账号 ID
    ready: 'The export file is ready', // 导出文件已就绪
    title: 'Export report', // 导出报告
    close: 'Close', // 关闭
    cancel: 'Cancel', // 取消
    rendering: 'Generating…', // 正在生成…
    export: 'Export', // 导出
    format: 'Format', // 格式
    html: 'HTML (single file; opens offline and prints to PDF)', // HTML（单文件，可离线打开、可打印为 PDF）
    json: 'JSON (authoritative format)', // JSON（权威格式）
    maskAccount: 'Mask the account ID', // 账号 ID 打码
    confirmUnmask: 'I confirm the export will contain the full AWS account ID', // 我确认导出文件会包含完整的 AWS 账号 ID
    maskIp: 'Mask public IPs', // 公网 IP 打码
    mixedNote: 'The platform can only mask both the account ID and public IPs, or neither.', // 平台目前只能同时打码或同时不打码账号 ID 与公网 IP。
    contents: 'The exported report includes manual-confirmation notes and the full check history. PDF: open the HTML report in a browser and choose Print › Save as PDF.', // 导出的报告包含手动确认备注与完整检查记录。PDF：在浏览器中打开 HTML 报告后，选择 打印 › 另存为 PDF。
    notForCert: 'A masked export is not byte-identical to the report the certificate references, so it cannot be used to check a certificate; download the report JSON for that from the certificate details.', // 打码导出的文件与证书引用的报告不是同一份字节，不能用于证书核对；核对用的报告 JSON 请在证书详情中下载。
    generating: 'Generating the export file (usually tens of seconds); you can wait here.', // 正在生成导出文件（通常几十秒），可以留在这里等待。
    timeout: 'The export file is not ready yet; try again shortly.', // 导出文件还没有生成完，请稍后再试。
    download: 'Download {format}', // 下载 {format}
    validFor: 'The link is valid for 15 minutes.', // 链接 15 分钟内有效。
  },
  visual: {
    steps: 'Steps', // 步骤
    stepsValue: '{done}/{total}', // {done}/{total}
    conclusion: 'Result', // 结论
    duration: 'Duration', // 用时
    evidence: 'Evidence confidence', // 证据可信度
    high: 'High', // 高
    medium: 'Medium', // 中
    low: 'Low', // 低
    built: 'What this lab built', // 这次实验搭建的构成
    target: 'Target architecture of this card', // 这张卡片的目标构成
    targetPending: 'Dashed: parts not wired in this session', // 虚线：这次会话还没有完成接入的部分
    details: 'Details', // 详细说明
  },
} satisfies Dict<typeof zh>;
