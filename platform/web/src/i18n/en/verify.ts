/**
 * en（English）：命名空间 verify。由 `npm run i18n:sync` 按 zh-CN 词典维护结构：
 * 只填写引号内的译文（空字符串 = 未翻译，运行时按 en → en → zh-CN 回退）；行尾注释是 zh-CN 原文。
 * 术语与风格见 ../glossary.md（不翻译 AWS 服务名、CLI 命令、代码、资源名、API 路径、环境变量）。
 */
import type { Dict } from '../dict';
import type zh from '../zh-CN/verify';

export default {
  static: {
    docTitle: 'ATL certificate verification (not affiliated with AWS)', // ATL 证书验证（非 AWS 官方）
    skip: 'Skip to main content', // 跳到主要内容
    title: 'ATL certificate verification', // ATL 证书验证
    natureShort: 'Not an official AWS certification: a proof of completion issued by a self-hosted ATL instance.', // 这不是 AWS 官方认证，而是自托管 ATL 实例签发的完成证明。
    nature: 'This proof was issued automatically by a self-hosted AWS Training Lab instance deployed in the learner’s own AWS account. It shows that the instance recorded the holder completing the listed labs; the signature confirms the content has not been altered and comes from that instance’s signing key. It is not an official AWS certification and does not represent AWS Certified Solutions Architect – Associate or any other AWS certification. The issuer and the holder may be the same person, and the account owner controls the platform’s data and keys. A result only means “this instance issued this content”; it says nothing about the independence of the issuing process.', // 本证明由部署在学员自己 AWS 账号中的自托管 AWS Training Lab 实例自动签发，表示该实例记录到持有人完成了所列实验，签名可用于确认内容未被篡改、且出自该实例的签名密钥。它不是 AWS 官方认证，也不代表 AWS Certified Solutions Architect – Associate 或任何 AWS 认证资格；签发者与持有人可能是同一人，平台的数据与密钥由账号所有者控制。验证结果只说明“该实例签发了此内容”，不说明签发过程的独立性。
    retry: 'Retry', // 重试
    paste: 'Paste a certificate', // 粘贴证书
    labsTitle: 'Included cards', // 包含的卡片
    labsNote: 'Check a report: choose the report JSON the holder gave you. Your browser canonicalizes it per RFC 8785, computes SHA-256 and compares it with the report digest in the certificate; the file is not uploaded. Use the “report JSON for verification” the holder downloaded from the certificate details; masked exports or later revisions show as a mismatch.', // 核对报告：选择持有人提供的报告 JSON，浏览器按 RFC 8785 规范化后计算 SHA-256 并与证书中的报告摘要比较，文件不会上传。请使用持有人在证书详情中下载的“核验用报告 JSON”；打码导出的报告或更新过的版本会显示不一致。
    howTitle: 'How to check independently', // 如何独立核对
    howBody: 'Compare the public key fingerprint above with the one the holder publishes on a public profile (for example GitHub). Verification happens entirely in your browser and needs no sign-in: the page reads this instance’s public keys and the signed revocation list and checks the ES256 signature with the browser’s built-in WebCrypto.', // 把上面的公钥指纹与持有人在其公开主页（例如 GitHub 个人页）上公布的指纹对照。验证完全在你的浏览器中完成，不需要登录：页面读取本实例的公钥与签名的吊销列表，用浏览器内置的 WebCrypto 验证 ES256 签名。
    pasteTitle: 'Paste a certificate or choose a file', // 粘贴证书或选择文件
    jwsLabel: 'Certificate (JWS)', // 证书（JWS）
    pasteHint: 'You can also choose a certificate file (.jws) or an offline verification bundle (.json).', // 也可以选择证书文件（.jws）或离线验证包（.json）。
    submit: 'Verify', // 验证
    chooseFile: 'Choose file…', // 选择文件…
    footNote: 'Self-hosted ATL Lab Platform (not affiliated with AWS). When the platform is uninstalled, this page and the public certificate files stop working; use the offline verification bundle from the certificate page.', // 自托管 ATL 实验平台（非 AWS 官方）。平台卸载后，本页与公开证书文件随之失效；请使用证书页提供的离线验证包。
    language: 'Language', // 语言
  },
  revokeReason: {
    superseded: 'Superseded by a new certificate', // 被新证书取代
    'learner-request': 'Holder’s request', // 持有人申请
    'evidence-invalidated': 'Underlying evidence invalidated', // 依据的证据被判无效
    'content-defect': 'Content defect', // 内容缺陷
    misissued: 'Misissued', // 误签
    'key-compromise': 'Key compromise', // 密钥泄露
    'dependency-revoked': 'The earlier certificate it relied on was revoked', // 所依据的旧版证书已被吊销
  },
  badgeLevel: {
    verified: 'Verified', // 已核验
    attested: 'Includes manual', // 含手动
    'self-reported': 'Mostly self-reported', // 自述为主
  },
  unspecified: 'Not specified', // 未说明
  otherReason: 'Other reason', // 其他原因
  result: {
    verifying: 'Verifying the signature…', // 正在验证签名…
    noInput: 'Paste a certificate to verify it', // 粘贴证书以验证
    noInputDetail: 'Paste the certificate (JWS) the holder gave you below, or choose the certificate file. Verification happens entirely in your browser.', // 把持有人提供的证书（JWS）粘贴到下面，或选择证书文件。验证完全在你的浏览器中完成。
    notPublic: 'This certificate is not public', // 该证书未公开
    notPublicDetail: 'Use the certificate file from the holder, or a link with #jws=.', // 请使用持有人提供的证书文件，或带 #jws= 的链接。
    unsupported: 'Your browser cannot verify signatures locally', // 你的浏览器不支持本地验签
    unsupportedDetail: 'Use a recent browser, or the script in the offline verification bundle.', // 请换用新版浏览器，或使用离线验证包中的脚本。
    network: 'Cannot read the public keys (network error)', // 无法读取公钥（网络错误）
    revUnavailable: 'Signature valid · revocation status unknown', // 签名有效 · 无法确认吊销状态
    revUnavailableDetail: 'The revocation list is unavailable.', // 吊销列表暂不可用。
    revRollback: 'Signature valid · the revocation list may be stale', // 签名有效 · 吊销列表可能是旧版本
    revRollbackDetail: 'Sequence {got} < {seen} (this browser has seen a newer list).', // 序号 {got} < {seen}（本浏览器见过更新的列表）。
    valid: 'Signature valid', // 签名有效
    revoked: 'Revoked', // 已吊销
    revokedAt: ' · revoked {t}', //  · 吊销于 {t}
    revokedReason: 'Reason: {reason}', // 原因：{reason}
    revokedCode: ' ({code})', // （{code}）
    invalidSignature: 'Invalid signature', // 签名无效
    invalidSignatureDetail: 'The content was changed, or it was not issued by this instance.', // 内容被修改，或不是本实例签发。
    unknownKey: 'Unknown signing key', // 未知签名密钥
    unknownKeyDetail: 'The certificate may come from another ATL instance, or the key was removed.', // 证书可能来自另一个 ATL 实例，或密钥已被移除。
    keyNotValid: 'Issued outside the key’s validity period', // 签发时间不在该密钥的有效期内
    originMismatch: 'Issuer mismatch', // 签发源不符
    originMismatchDetail: 'The issuing instance named in the certificate does not match this site.', // 证书声明的签发实例与本站不一致。
    malformed: 'Not a valid ATL certificate', // 这不是有效的 ATL 证书
    malformedDetail: 'It is not a three-part JWS, the signature algorithm or type does not match, or the certificate content is malformed.', // 不是三段式 JWS、签名算法或类型不符，或证书内容的格式不符。
  },
  detail: {
    untranslated: 'Not translated', // 未翻译
    cert: 'Certificate', // 证书
    scope: ' ({scope})', // （{scope}）
    holder: 'Holder', // 持有人
    holderValue: '{name} · issued {t}', // {name} · 签发于 {t}
    ratio: ' · “verified” share {ratio}', //  · “已核验”占比 {ratio}
    issuer: 'Issuing instance', // 签发实例
    issuerValue: '{origin} · install {install} · public key fingerprint {kid}', // {origin} · 安装 {install} · 公钥指纹 {kid}
    kidTitle: 'Public key fingerprint (kid): {kid}', // 公钥指纹（kid）：{kid}
    revocations: 'Revocation list', // 吊销列表
    revRevoked: 'Revoked (list sequence {seq}, signature valid)', // 已吊销（列表序号 {seq}，签名有效）
    revRollback: 'Possibly stale (sequence {got} < {seen})', // 可能是旧版本（序号 {got} < {seen}）
    revOk: 'Not revoked (list sequence {seq}, signature valid)', // 未吊销（列表序号 {seq}，签名有效）
    revUnknown: 'Unknown (revocation list unavailable)', // 无法确认（吊销列表暂不可用）
    checks: 'automatic {auto} / manual {manual}', // 自动 {auto} / 手动 {manual}
    digest: 'Report digest {d}…', // 报告摘要 {d}…
    noDigest: 'No report digest', // 没有报告摘要
  },
  page: {
    labsCount: 'Included cards ({n})', // 包含的卡片（{n}）
    checkReport: 'Check a report file…', // 核对报告文件…
    computing: 'Computing the digest…', // 正在计算摘要…
    match: 'Report matches: the digest of {name} equals the report digest in the certificate. The file was not uploaded.', // 报告一致：文件 {name} 的摘要与证书中的报告摘要相同。文件未上传。
    notReport: '{name} is not a report JSON file.', // 文件 {name} 不是报告 JSON。
    otherLab: ' (the report in the file belongs to {labId})', // （文件中的报告属于 {labId}）
    mismatch: 'Report mismatch: the digest of {name} ({got}…) differs from the certificate’s ({want}…){other}. The file was not uploaded.', // 报告不一致：文件 {name} 的摘要 {got}… 与证书中的 {want}… 不同{other}。文件未上传。
    pasteFirst: 'Paste a certificate (JWS) or choose a certificate file first.', // 请先粘贴证书（JWS），或选择证书文件。
  },
} satisfies Dict<typeof zh>;
