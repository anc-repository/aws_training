/**
 * en（English）：命名空间 certificates。由 `npm run i18n:sync` 按 zh-CN 词典维护结构：
 * 只填写引号内的译文（空字符串 = 未翻译，运行时按 en → en → zh-CN 回退）；行尾注释是 zh-CN 原文。
 * 术语与风格见 ../glossary.md（不翻译 AWS 服务名、CLI 命令、代码、资源名、API 路径、环境变量）。
 */
import type { Dict } from '../dict';
import type zh from '../zh-CN/certificates';

export default {
  values: {
    revokeReason: {
      superseded: 'Superseded by a new certificate', // 被新证书取代
      'learner-request': 'Holder’s request', // 持有人申请
      'evidence-invalidated': 'Underlying evidence invalidated', // 依据的证据被判无效
      'content-defect': 'Content defect', // 内容缺陷
      misissued: 'Misissued', // 误签
      'key-compromise': 'Key compromise', // 密钥泄露
      'dependency-revoked': 'The earlier certificate it relied on was revoked', // 所依据的旧版证书已被吊销
    },
    otherReason: 'Other reason', // 其他原因
    unspecified: 'Not specified', // 未说明
    labWithTitle: '{id} ({title})', // {id}（{title}）
    requiredMissing: 'Required card {lab} has no valid badge yet', // 必修卡片 {lab} 还没有有效徽章
    badgePending: 'The badge for {lab} is being verified and counts once that finishes', // {lab} 的徽章核验中，结束后才能计入
    groupUnmet: 'Elective group {group} needs {need}; {have} done', // 选修组 {group} 需要 {need} 张，已完成 {have} 张
    ratioLow: 'The “verified” share {ratio} is below the required {min}', // “已核验”占比 {ratio} 低于要求的 {min}
    defective: 'The content version used ({v}) has been marked defective', // 所用的内容版本 {v} 已被标记为有缺陷
    trackDisabled: 'This learning path does not issue certificates', // 这条路径不签发证书
    labDisabled: 'This card does not issue certificates', // 这张卡片不签发证书
    unmet: 'Requirements not met', // 条件未满足
    trackCert: {
      'not-eligible': 'Not yet', // 未达成
      eligible: 'Ready to claim (requirements met)', // 可领取（条件已满足）
      issued: 'Claimed', // 已领取
      revoked: 'Revoked', // 已吊销
      disabled: 'No certificate', // 不签发证书
    },
    badgeLevel: {
      verified: 'Verified', // 已核验
      attested: 'Includes manual', // 含手动
      'self-reported': 'Mostly self-reported', // 自述为主
    },
  },
  list: {
    none: 'Not earned', // 未获得
    pending: 'Verifying', // 核验中
    withdrawn: 'Withdrawn', // 已撤回
    scenario: 'Scenario', // 场景
    base: 'Basics', // 基础
    catLabel: '{id} {label}', // {id} {label}
    title: 'Certificates and badges', // 证书与徽章
    readOnlySub: 'The learner’s certificates and badges (read-only)', // 学员的证书与徽章（只读）
    readOnlySubNamed: 'Certificates and badges of learner {name} (read-only)', // 学员 {name} 的证书与徽章（只读）
    trackCerts: 'Learning path certificates', // 路径证书
    cardBadges: 'Card badges', // 卡片徽章
    notice: 'Certificates are issued by your own ATL instance as proof of completion on a self-hosted platform. They are not official AWS certifications and do not represent any AWS certification.', // 证书由你自己的 ATL 实例签发，是自托管平台的完成证明，不是 AWS 官方认证，也不代表任何 AWS 认证资格。
    readingTracks: 'Loading learning path certificates', // 正在读取路径证书
    colCert: 'Certificate', // 证书
    colState: 'Status', // 状态
    colCond: 'Requirements', // 条件
    colActions: 'Actions', // 操作
    public: 'Public', // 已公开
    notPublic: 'Not public', // 未公开
    history: 'Earlier certificates ({n})', // 历史证书（{n}）
    revokedReason: 'Revoked ({reason})', // 已吊销（{reason}）
    valid: 'Valid', // 有效
    required: 'Required {done}/{total}', // 必修 {done}/{total}
    groups: ' · elective groups {done}/{total}', //  · 选修组 {done}/{total}
    ratio: ' · verified {ratio} (needs ≥ {min})', //  · 已核验 {ratio}（需 ≥ {min}）
    pendingBadges: '{n, plural, one {# badge is} other {# badges are}} being verified and count once that finishes', // {n} 张徽章核验中，结束后才能计入
    view: 'View', // 查看
    claim: 'Claim…', // 领取…
    track: 'Path', // 路径
    myCerts: 'My certificates', // 我的证书
    badgesCount: 'Card badges · {earned} / {total}', // 卡片徽章 · {earned} / {total}
    onlyEarned: 'Earned only', // 只看已获得
    readingBadges: 'Loading badges', // 正在读取徽章
    firstBadge: 'Finish your first card to earn a badge.', // 完成第一张卡片即获得徽章。
    startEc2: 'Start with svc-ec2 →', // 从 svc-ec2 开始 →
    badgeLabel: 'Badge: {title}, {state}', // 徽章：{title}，{state}
    badgeTitle: 'Badge · {title}', // 徽章 · {title}
    level: 'Level', // 等级
    evidenceScore: 'Evidence score', // 证据分
    earnedAt: 'Earned', // 获得时间
    attempt: 'Based on attempt', // 依据的尝试
    viewReport: 'View report', // 查看报告
    variant: 'Start variant', // 起始变体
    contentVersion: 'Content version', // 内容版本
    catalogVersion: ' · catalog {v}', //  · 目录 {v}
    quizBest: 'Best quiz score', // 小测最好成绩
    quizScore: '{score} (recorded only)', // {score}（只记录）
    quizNone: 'Not taken', // 尚未作答
    notEarned: 'Not earned yet. Finish this card (pass the final check) to earn the badge; quiz scores are recorded only and do not affect it.', // 未获得。完成本卡片（最终复核通过）即获得徽章；小测成绩只记录，不影响徽章。
    openCard: 'Open card', // 打开卡片
    withdrawnNote: 'Badge withdrawn: its evidence was invalidated. Redo this card.', // 徽章已撤回：所依据的证据被判无效，请重做这张卡片。
  },
  detail: {
    copied: 'Copied', // 已复制
    copyFailed: 'Copy failed; select it manually', // 复制失败，请手动选中
    publishSubmitted: 'Submitted; updating the public status', // 已提交，正在更新公开状态
    missing: 'Certificate not found', // 没有这张证书
    backToList: 'Back to certificates and badges', // 回到证书与徽章
    title: 'Certificate details', // 证书详情
    reading: 'Loading the certificate', // 正在读取证书
    bundleStarted: 'Offline verification bundle download started', // 已开始下载离线验证包
    crumbs: 'Breadcrumb', // 面包屑
    certsAndBadges: 'Certificates and badges', // 证书与徽章
    heading: '{title} · {id}', // {title} · {id}
    holder: 'Holder {name}', // 持有人 {name}
    track: ' · path {id}', //  · 路径 {id}
    ratio: ' · “verified” share {ratio}', //  · “已核验”占比 {ratio}
    validIssued: 'Valid · issued {t}', // 有效 · 签发于 {t}
    revoked: 'Revoked ({reason})', // 已吊销（{reason}）
    revokedAt: 'Revoked ({reason} · {t})', // 已吊销（{reason} · {t}）
    notice: 'This proof was issued by your self-hosted ATL instance as proof of completion on a self-hosted platform. It is not an official AWS certification and does not represent any AWS certification.', // 本证明由你的自托管 ATL 实例签发，是自托管平台的完成证明，不是 AWS 官方认证，也不代表任何 AWS 认证资格。
    superseded: 'Superseded by a new certificate: {id}', // 已被新证书取代：{id}
    evidenceInvalidated: 'A badge this certificate relied on was withdrawn (for example an experiment cross-check became invalid), so the certificate was revoked. Redo the affected cards and claim it again.', // 证书所依据的徽章被撤回（例如对比实验的交叉核验转为无效），证书已吊销。请重做相关卡片后重新领取。
    labs: 'Included cards ({n})', // 包含的卡片（{n}）
    colCard: 'Card', // 卡片
    colLevel: 'Level', // 等级
    colVerdict: 'Checks', // 判定
    colCompleted: 'Completed', // 完成于
    colDigest: 'Report digest', // 报告摘要
    colReport: 'Report', // 报告
    checks: 'automatic {auto} · manual {manual}', // 自动 {auto} · 手动 {manual}
    viewReport: 'View the report for {labId}', // 查看 {labId} 的报告
    report: 'Report', // 报告
    digestNote: 'Checking a report needs the exact report JSON the certificate references (unmasked); it will be downloadable here once the platform supports it. A masked export or a later revision shows as “mismatch” on the verification page.', // 核对报告需要证书引用的那一版报告 JSON（未经导出打码），平台支持后在此下载；打码导出的报告或更新过的版本在验证页会显示“不一致”。
    verifyLink: 'Verification link', // 验证链接
    copy: 'Copy', // 复制
    open: 'Open', // 打开
    public: 'Public', // 公开
    publicFile: 'Certificate file is public ({path})', // 已公开证书文件（{path}）
    notPublic: 'Not public: others need the certificate file you give them, or a link with #jws=', // 未公开：对方需要使用你提供的证书文件，或带 #jws= 的链接
    updating: 'Updating…', // 正在更新…
    unpublish: 'Make private', // 取消公开
    publish: 'Make public', // 公开
    copyFragment: 'Copy link with #jws=', // 复制带 #jws= 的链接
    signature: 'Signature', // 签名
    fingerprint: ' · public key fingerprint', //  · 公钥指纹
    copyFingerprint: 'Copy the public key fingerprint', // 复制公钥指纹
    copyJws: 'Copy JWS', // 复制 JWS
    preparing: 'Preparing…', // 正在准备…
    downloadBundle: 'Download offline verification bundle', // 下载离线验证包
    fingerprintTip: 'Also publish this public key fingerprint on a public profile of yours (for example GitHub) so others can compare it.', // 建议在你的公开主页（例如 GitHub 个人页）同时公布这个公钥指纹，第三方即可对照。
    revoke: 'Revoke certificate…', // 吊销证书…
    uninstallNote: 'The online verification page stops working when the platform is uninstalled; download the offline verification bundle first.', // 平台卸载后在线验证页失效；请先下载离线验证包。
    reasonHelp: {
      'learner-request': 'Holder’s request', // 持有人申请
      'content-defect': 'Content defect: the content version it relies on was marked defective', // 内容缺陷：所依据的内容版本已标记为有缺陷
      misissued: 'Misissued', // 误签
    },
    revokedAnnounce: 'Certificate revoked', // 证书已吊销
    revokeTitle: 'Revoke certificate', // 吊销证书
    cancel: 'Cancel', // 取消
    revoking: 'Revoking…', // 正在吊销…
    revokeOk: 'Revoke', // 吊销
    revokeNote: 'Revocation cannot be undone; the verification page then shows “revoked” and the reason.', // 吊销不可撤销；吊销后验证页显示“已吊销”与原因。
    reason: 'Reason', // 原因
    reasonItem: '{text} ({code})', // {text}（{code}）
    keyCompromise: 'Key compromise ({text}) is not handled one certificate at a time here: the key rotation process disables the old key and revokes in bulk.', // 密钥泄露（{text}）不在这里逐张处理：由密钥轮换流程停用旧密钥并批量吊销。
  },
  claim: {
    nameRequired: 'Enter the name to show on the certificate', // 请填写证书上显示的名字
    nameTooLong: 'The name can be at most 64 characters', // 名字最多 64 个字符
    title: 'Claim: {title}', // 领取：{title}
    cancel: 'Cancel', // 取消
    issuing: 'Issuing…', // 正在签发…
    issue: 'Issue certificate', // 签发证书
    nameLabel: 'Name on the certificate', // 证书上显示的名字
    nameHint: 'Defaults to the certificate name in your profile.', // 默认取个人资料中的证书署名。
    public: 'Publish the certificate file: anyone can verify it directly at /verify/ATL-…; if not public, it can only be verified with a file or link you provide', // 公开证书文件：任何人可以通过 /verify/ATL-… 直接验证；不公开时只能用你提供的文件或链接验证
    records: 'The certificate records: the path and its version, the counted cards and badge levels, the “verified” share and each card’s report digest.', // 证书会记录：路径与版本、计入的卡片与徽章等级、“已核验”占比、每张卡片的报告摘要。
    notRecords: 'It does not record: your email, AWS account ID or quiz scores.', // 不会记录：你的邮箱、AWS 账号 ID、小测成绩。
    nature: 'Only one valid certificate is kept per path; if your results improve you can claim again and the old one is revoked automatically (superseded). This proof is issued by your self-hosted ATL instance and is not an official AWS certification.', // 同一路径只保留一张有效证书；以后成绩提高可以重新领取，旧证书会自动吊销（被新证书取代）。本证明由你的自托管 ATL 实例签发，不是 AWS 官方认证。
    notEligible: 'Requirements not met yet:', // 还不满足领取条件：
  },
  visual: {
    required: 'Required cards', // 必修卡片
    earned: 'Badges earned', // 已获得的徽章
    verified: '“Verified” share', // “已核验”占比
    category: '{label} badges earned', // {label}已获得的徽章
  },
} satisfies Dict<typeof zh>;
