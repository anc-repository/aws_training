/**
 * ja（日本語）：命名空间 report。由 `npm run i18n:sync` 按 zh-CN 词典维护结构：
 * 只填写引号内的译文（空字符串 = 未翻译，运行时按 ja → en → zh-CN 回退）；行尾注释是 zh-CN 原文。
 * 术语与风格见 ../glossary.md（不翻译 AWS 服务名、CLI 命令、代码、资源名、API 路径、环境变量）。
 */
import type { Dict } from '../dict';
import type zh from '../zh-CN/report';

export default {
  revisionReason: {
    finalize: '', // 定稿
    cleanup: '', // 追加清理结果
    'late-ownership': '', // 追加延迟归属
    ownership: '', // 追加延迟归属
    rescan: '', // 追加复扫结果
    quiz: '', // 追加小测成绩
    certificate: '', // 追加证书
    regenerate: '', // 重新生成
    manual: '', // 重新生成
  },
  page: {
    noSession: '', // 没有这个会话
    title: '', // 实验报告
    readingSession: '', // 正在读取会话
    crumbs: '', // 面包屑
    mySessions: '', // 我的实验
    heading: '', // {labId} · 实验报告
    sessionSub: '', // 会话 {sid}
    noReportTitle: '', // 这次会话没有报告
    sessionDetail: '', // 会话详情
    noReportBody: '', // 会话在环境就绪前结束（这次尝试不计入次数）。
    generating: '', // 报告正在生成（最终复核与报告快照，通常几分钟）。
    generatingLabel: '', // 报告正在生成
    failed: '', // 报告快照未能在结束时生成（不影响资源释放）。
    requesting: '', // 正在请求…
    regenerate: '', // 重新生成
    regenStarted: '', // 已开始重新生成报告，完成后自动刷新。
    readingReport: '', // 正在读取报告
    perHour: '', // /小时
    cleanupFailed: '', // 释放未完成（{n} 项待人工处理）
    cleanupReclaiming: '', // 回收进行中，完成后报告会追加修订
    cleanupKept: '', // 环境保留中
    cleanupLive: '', // 实验进行中
    cleanupDone: '', // 已释放
    cleanupRescan: '', // 已释放（复扫进行中）
    previewSub: '', // 预览（不保存）· 会话 {sid} · {state}
    versionSub: '', // 第 {v} 版
    versionReason: '', // （{reason}）
    generatedAt: '', //  · 生成于 {t}
    sessionTail: '', // · 会话 {sid}
    version: '', // 版本
    versionLatest: '', // 第 {v} 版（最新）
    export: '', // 导出…
    share: '', // 分享…
    revisionsNote: '', // 共 {n} 版；这里显示最新版，较早的版本平台支持后可在此查看。
    newer: '', // 报告已更新到第 {v} 版。
    view: '', // 查看
    previewNote: '', // 实验尚未结束，以下是预览（不保存）。没有导出与分享。
    summary: '', // 摘要
    conclusion: '', // 结论
    unverified: '', // 未能核验
    badgeTitle: '', //  · 徽章“{title}”
    evidenceScore: '', // （证据分 {n}）
    unverifiedNote: '', // 部分资源的归属尚未确认，复扫完成后会自动更新报告。
    incompleteNote: '', // 未完成：{list}
    listSep: '', // ；
    idleNote: '', // 未开始：环境就绪后一直没有进入工作台。
    duration: '', // 用时
    readyAt: '', // 就绪 {t}
    endedAt: '', //  → 结束 {t}
    ongoing: '', //  → 进行中
    total: '', //  · 共 {t}
    extensions: '', //  · 延长 {n} 次
    checks: '', // 检查
    stepsDone: '', // 步骤 {done}/{total}
    quality: '', //  · 可信度：高 {high} · 中 {medium} · 低 {low}
    cost: '', // 费用
    costLine: '', // 开始前估算 {start} · 按实际时长的重算见 HTML 报告（估算 · 单价取自 Price List · 以账单为准）
    unknown: '', // 未知
    cleanup: '', // 清理
    manualList: '', // 清单
    environment: '', // 环境
    reused: '', // 复用环境
    fresh: '', // 全新环境
    account: '', //  · 账号 {acct}
    startProfile: '', //  · 起始档位 {name}
    fullNote: '', // 这里显示摘要与本次会话的检测记录；完整报告（含较大的证据、小测与按实际时长重算的费用）请{link}查看。
    downloadHtml: '', // 下载 HTML 报告
    downloadInExport: '', // 在导出中下载 HTML 报告
    learnerExports: '', // 由学员导出 HTML 报告
    toc: '', // 报告目录
    tocLead: '', // 目录：
    steps: '', // 逐步证据
    experiments: '', // 对比实验
    appendix: '', // 附录
    fullHistory: '', // 完整检查记录
    noExperiments: '', // 本卡片没有对比实验。
    required: '', // （必做）
    optional: '', // （选做）
    openCompare: '', // 打开对比视图
    quiz: '', // 小测
    quizBest: '', // 最好成绩 {score} · 作答 {n} 次。
    quizInHtml: '', // 小测成绩见 HTML 报告。
    quizNote: '', // 只记录，不影响完成与徽章。
    costNote: '', // 开始前的估算与按实际时长的重算都是估算（单价取自 Price List{asOf}），不含数据传输与部分按请求计费项，以 AWS 账单为准。
    priceAsOf: '', // ，取价时间 {t}
    startEstimate: '', // 开始前估算
    unknownPrice: '', // 未知（单价暂不可得）
    quoteRef: '', //  · 报价 {id}
    billActual: '', // 账单实际
    billNote: '', // 激活成本分配标签后，可在 AWS Cost Explorer 中按 atl:session-id 查看（数据通常有一天左右的延迟）。
    costInDetail: '', // 在会话详情中查看计费资源与按实际时长重算的估算 →
    reclaimed: '', //  · 已回收 {n} 项
    manualPending: '', //  · 待人工处理 {n} 项
    reclaimProgress: '', // 回收进度
    card: '', // 卡片
    cardVersion: '', // 卡片版本
    catalogVersion: '', // 目录版本
    variant: '', // 起始变体
    digest: '', // 报告完整性摘要
    copyDigest: '', // 复制报告完整性摘要
    copy: '', // 复制
    shareLinks: '', // 分享链接
    createShare: '', // 创建分享链接…
    printFooter: '', // 导出时间 {t} · 账号 ID 已打码 · 自托管 ATL 实验平台（非 AWS 官方）
  },
  evidence: {
    title: '', // 逐步证据
    readingSteps: '', // 正在读取步骤
    noSteps: '', // 没有步骤记录。
    firstPassed: '', //  · 首次达成 {t}
    spent: '', //  · 用时 {t}
    drift: '', //  · 漂移 {n} 次
    stepChecks: '', // 第 {n} 步的检查
    inherited: '', // 继承自交接链中的会话
    thisSession: '', // 本次完成
    ownershipPending: '', // 归属在会话结束后确认
    manualObserved: '', // 手动确认：看到的值 {v}
    digest: '', // 证据摘要 {d}…
    optional: '', // （选做）
    trigger: {
      learner: '', // 学员
      user: '', // 学员
      manual: '', // 学员
      auto: '', // 自动
      schedule: '', // 自动
      wait: '', // 等待轮询
      poll: '', // 等待轮询
      submit: '', // 提交
      'expiring-precheck': '', // 到期预检
      precheck: '', // 到期预检
      finalize: '', // 定稿
      final: '', // 定稿
      ownership: '', // 延迟归属
      'late-ownership': '', // 延迟归属
      assistant: '', // 助教
    },
    historyTitle: '', // 检查记录
    noHistory: '', // 没有检查记录。
    filterByResult: '', // 按结果筛选
    all: '', // 全部
    recentOnly: '', // 显示最近 100 次检测；完整记录见 HTML 报告。
    caption: '', // 完整检查记录
    colTime: '', // 时间
    colCheck: '', // 检查
    colResult: '', // 结果
    colCode: '', // 错误码
    colTrigger: '', // 触发方式
    other: '', // 其他
  },
  share: {
    status: {
      publishing: '', // 正在发布
      revoking: '', // 正在撤销
      active: '', // 有效
      revoked: '', // 已撤销
      expired: '', // 已过期
    },
    expiry: {
      d7: '', // 7 天
      d30: '', // 30 天
      d90: '', // 90 天
      never: '', // 不过期
    },
    createTitle: '', // 创建分享链接
    close: '', // 关闭
    cancel: '', // 取消
    creating: '', // 正在创建…
    create: '', // 创建链接
    redactNote: '', // 分享的是一份脱敏副本：账号 ID（含 ARN、桶名、URL 中嵌入的）只留后 4 位，公网 IP、资源 ID 的中段、会话 id 与环境名一律打码，不含手动确认备注。
    publicNote: '', // 任何拿到链接的人都能打开，无需登录；搜索引擎不收录。
    expiresIn: '', // 有效期
    uninstallNote: '', // 平台卸载后链接随之失效。
    created: '', // 已创建：{url}（正在发布，通常几秒后可以打开）
    notGenerated: '', // 报告还没有生成，生成后才能分享
    listTitle: '', // 分享链接
    none: '', // 还没有分享链接。
    createdAt: '', // 创建 {t}
    expiresAt: '', //  · {t} 过期
    noExpiry: '', //  · 不过期
    copyLabel: '', // 复制分享链接 {url}
    copied: '', // 已复制
    copyFailed: '', // 复制失败，请手动选中链接
    copy: '', // 复制
    open: '', // 打开
    revokeLabel: '', // 撤销分享链接 {url}
    revoke: '', // 撤销
    revokedAnnounce: '', // 已撤销分享链接
    revokeTitle: '', // 撤销分享链接
    revoking: '', // 正在撤销…
    revokeNote: '', // 撤销后链接在短时间内失效（CDN 缓存刷新需要时间）。
  },
  export: {
    mixed: '', // 平台目前只能同时打码或同时不打码账号 ID 与公网 IP
    confirmFirst: '', // 请先确认导出文件会包含完整的 AWS 账号 ID
    ready: '', // 导出文件已就绪
    title: '', // 导出报告
    close: '', // 关闭
    cancel: '', // 取消
    rendering: '', // 正在生成…
    export: '', // 导出
    format: '', // 格式
    html: '', // HTML（单文件，可离线打开、可打印为 PDF）
    json: '', // JSON（权威格式）
    maskAccount: '', // 账号 ID 打码
    confirmUnmask: '', // 我确认导出文件会包含完整的 AWS 账号 ID
    maskIp: '', // 公网 IP 打码
    mixedNote: '', // 平台目前只能同时打码或同时不打码账号 ID 与公网 IP。
    contents: '', // 导出的报告包含手动确认备注与完整检查记录。PDF：在浏览器中打开 HTML 报告后，选择 打印 › 另存为 PDF。
    notForCert: '', // 打码导出的文件与证书引用的报告不是同一份字节，不能用于证书核对；核对用的报告 JSON 请在证书详情中下载。
    generating: '', // 正在生成导出文件（通常几十秒），可以留在这里等待。
    timeout: '', // 导出文件还没有生成完，请稍后再试。
    download: '', // 下载 {format}
    validFor: '', // 链接 15 分钟内有效。
  },
} satisfies Dict<typeof zh>;
