/**
 * ja（日本語）：命名空间 certificates。由 `npm run i18n:sync` 按 zh-CN 词典维护结构：
 * 只填写引号内的译文（空字符串 = 未翻译，运行时按 ja → en → zh-CN 回退）；行尾注释是 zh-CN 原文。
 * 术语与风格见 ../glossary.md（不翻译 AWS 服务名、CLI 命令、代码、资源名、API 路径、环境变量）。
 */
import type { Dict } from '../dict';
import type zh from '../zh-CN/certificates';

export default {
  values: {
    revokeReason: {
      superseded: '新しい修了証に置き換え', // 被新证书取代
      'learner-request': '保有者の申請', // 持有人申请
      'evidence-invalidated': '根拠の証拠が無効と判定', // 依据的证据被判无效
      'content-defect': 'コンテンツの不具合', // 内容缺陷
      misissued: '誤発行', // 误签
      'key-compromise': '鍵の漏えい', // 密钥泄露
      'dependency-revoked': '根拠となる旧版の修了証が失効', // 所依据的旧版证书已被吊销
    },
    otherReason: 'その他の理由', // 其他原因
    unspecified: '理由の記載なし', // 未说明
    labWithTitle: '{id}（{title}）', // {id}（{title}）
    requiredMissing: '必修カード {lab} の有効なバッジがまだありません', // 必修卡片 {lab} 还没有有效徽章
    badgePending: '{lab} のバッジは検証中です。終了後に算入されます', // {lab} 的徽章核验中，结束后才能计入
    groupUnmet: '選択グループ {group} は {need} 枚必要で、{have} 枚完了しています', // 选修组 {group} 需要 {need} 张，已完成 {have} 张
    ratioLow: '「検証済み」の割合 {ratio} が要件の {min} を下回っています', // “已核验”占比 {ratio} 低于要求的 {min}
    defective: '使用したコンテンツのバージョン {v} は不具合ありとマークされています', // 所用的内容版本 {v} 已被标记为有缺陷
    trackDisabled: 'この学習パスは修了証を発行しません', // 这条路径不签发证书
    labDisabled: 'このカードは修了証を発行しません', // 这张卡片不签发证书
    unmet: '条件を満たしていません', // 条件未满足
    trackCert: {
      'not-eligible': '未達成', // 未达成
      eligible: '受け取り可能（条件を満たしました）', // 可领取（条件已满足）
      issued: '受け取り済み', // 已领取
      revoked: '失効', // 已吊销
      disabled: '修了証は発行されません', // 不签发证书
    },
    badgeLevel: {
      verified: '検証済み', // 已核验
      attested: '手動確認を含む', // 含手动
      'self-reported': '自己申告中心', // 自述为主
    },
  },
  list: {
    none: '未取得', // 未获得
    pending: '検証中', // 核验中
    withdrawn: '取り消し済み', // 已撤回
    scenario: 'シナリオ', // 场景
    base: '基礎', // 基础
    catLabel: '{id} {label}', // {id} {label}
    title: '修了証とバッジ', // 证书与徽章
    readOnlySub: '受講者の修了証とバッジ（読み取り専用）', // 学员的证书与徽章（只读）
    readOnlySubNamed: '受講者 {name} の修了証とバッジ（読み取り専用）', // 学员 {name} 的证书与徽章（只读）
    trackCerts: '学習パスの修了証', // 路径证书
    cardBadges: 'カードのバッジ', // 卡片徽章
    notice: '修了証はあなた自身の ATL インスタンスが発行する、セルフホストのプラットフォームでの修了証明です。AWS の公式認定ではなく、AWS 認定資格を示すものでもありません。', // 证书由你自己的 ATL 实例签发，是自托管平台的完成证明，不是 AWS 官方认证，也不代表任何 AWS 认证资格。
    readingTracks: '学習パスの修了証を読み込んでいます', // 正在读取路径证书
    colCert: '修了証', // 证书
    colState: '状態', // 状态
    colCond: '条件', // 条件
    colActions: '操作', // 操作
    public: '公開', // 已公开
    notPublic: '非公開', // 未公开
    history: '過去の修了証（{n}）', // 历史证书（{n}）
    revokedReason: '失効（{reason}）', // 已吊销（{reason}）
    valid: '有効', // 有效
    required: '必修 {done}/{total}', // 必修 {done}/{total}
    groups: ' · 選択グループ {done}/{total}', //  · 选修组 {done}/{total}
    ratio: ' · 検証済み {ratio}（{min} 以上が必要）', //  · 已核验 {ratio}（需 ≥ {min}）
    pendingBadges: '{n} 枚のバッジが検証中です。終了後に算入されます', // {n} 张徽章核验中，结束后才能计入
    view: '表示', // 查看
    claim: '受け取る…', // 领取…
    track: '学習パス', // 路径
    myCerts: '自分の修了証', // 我的证书
    badgesCount: 'カードのバッジ · {earned} / {total}', // 卡片徽章 · {earned} / {total}
    onlyEarned: '取得済みのみ表示', // 只看已获得
    readingBadges: 'バッジを読み込んでいます', // 正在读取徽章
    firstBadge: '最初のカードを完了するとバッジを獲得できます。', // 完成第一张卡片即获得徽章。
    startEc2: 'svc-ec2 から始める →', // 从 svc-ec2 开始 →
    badgeLabel: 'バッジ：{title}、{state}', // 徽章：{title}，{state}
    badgeTitle: 'バッジ · {title}', // 徽章 · {title}
    level: 'レベル', // 等级
    evidenceScore: '証拠スコア', // 证据分
    earnedAt: '取得日時', // 获得时间
    attempt: '根拠の試行', // 依据的尝试
    viewReport: 'レポートを見る', // 查看报告
    variant: '開始バリアント', // 起始变体
    contentVersion: 'コンテンツのバージョン', // 内容版本
    catalogVersion: ' · カタログ {v}', //  · 目录 {v}
    quizBest: '小テストの最高得点', // 小测最好成绩
    quizScore: '{score}（記録のみ）', // {score}（只记录）
    quizNone: '未回答', // 尚未作答
    notEarned: '未取得です。このカードを完了する（最終確認に合格する）とバッジを獲得できます。小テストの成績は記録のみで、バッジには影響しません。', // 未获得。完成本卡片（最终复核通过）即获得徽章；小测成绩只记录，不影响徽章。
    openCard: 'カードを開く', // 打开卡片
    withdrawnNote: 'バッジは取り消されました：根拠の証拠が無効と判定されたため、このカードをやり直してください。', // 徽章已撤回：所依据的证据被判无效，请重做这张卡片。
  },
  detail: {
    copied: 'コピーしました', // 已复制
    copyFailed: 'コピーできませんでした。手動で選択してください', // 复制失败，请手动选中
    publishSubmitted: '送信しました。公開状態を更新しています', // 已提交，正在更新公开状态
    missing: 'この修了証はありません', // 没有这张证书
    backToList: '修了証とバッジに戻る', // 回到证书与徽章
    title: '修了証の詳細', // 证书详情
    reading: '修了証を読み込んでいます', // 正在读取证书
    bundleStarted: 'オフライン検証パッケージのダウンロードを開始しました', // 已开始下载离线验证包
    crumbs: 'パンくずリスト', // 面包屑
    certsAndBadges: '修了証とバッジ', // 证书与徽章
    heading: '{title} · {id}', // {title} · {id}
    holder: '保有者 {name}', // 持有人 {name}
    track: ' · 学習パス {id}', //  · 路径 {id}
    ratio: ' · 「検証済み」の割合 {ratio}', //  · “已核验”占比 {ratio}
    validIssued: '有効 · {t} 発行', // 有效 · 签发于 {t}
    revoked: '失効（{reason}）', // 已吊销（{reason}）
    revokedAt: '失効（{reason} · {t}）', // 已吊销（{reason} · {t}）
    notice: 'この証明はあなたのセルフホスト ATL インスタンスが発行した、セルフホストのプラットフォームでの修了証明です。AWS の公式認定ではなく、AWS 認定資格を示すものでもありません。', // 本证明由你的自托管 ATL 实例签发，是自托管平台的完成证明，不是 AWS 官方认证，也不代表任何 AWS 认证资格。
    superseded: '新しい修了証に置き換えられました：{id}', // 已被新证书取代：{id}
    evidenceInvalidated: '修了証の根拠となったバッジが取り消されたため（比較実験の照合が無効になった場合など）、修了証は失効しました。該当するカードをやり直してから、もう一度受け取ってください。', // 证书所依据的徽章被撤回（例如对比实验的交叉核验转为无效），证书已吊销。请重做相关卡片后重新领取。
    labs: '含まれるカード（{n}）', // 包含的卡片（{n}）
    colCard: 'カード', // 卡片
    colLevel: 'レベル', // 等级
    colVerdict: '判定', // 判定
    colCompleted: '完了日時', // 完成于
    colDigest: 'レポートのダイジェスト', // 报告摘要
    colReport: 'レポート', // 报告
    checks: '自動 {auto} · 手動 {manual}', // 自动 {auto} · 手动 {manual}
    viewReport: '{labId} のレポートを見る', // 查看 {labId} 的报告
    report: 'レポート', // 报告
    digestNote: 'レポートの照合には、修了証が参照している版のレポート JSON（マスク前）が必要です。プラットフォームが対応するとここからダウンロードできます。マスクしてエクスポートしたレポートや更新後の版は、検証ページで「不一致」と表示されます。', // 核对报告需要证书引用的那一版报告 JSON（未经导出打码），平台支持后在此下载；打码导出的报告或更新过的版本在验证页会显示“不一致”。
    verifyLink: '検証リンク', // 验证链接
    copy: 'コピー', // 复制
    open: '開く', // 打开
    public: '公開', // 公开
    publicFile: '修了証ファイルを公開済み（{path}）', // 已公开证书文件（{path}）
    notPublic: '非公開：相手はあなたが渡した修了証ファイルか、#jws= 付きのリンクを使う必要があります', // 未公开：对方需要使用你提供的证书文件，或带 #jws= 的链接
    updating: '更新しています…', // 正在更新…
    unpublish: '非公開にする', // 取消公开
    publish: '公開する', // 公开
    copyFragment: '#jws= 付きのリンクをコピー', // 复制带 #jws= 的链接
    signature: '署名', // 签名
    fingerprint: ' · 公開鍵フィンガープリント', //  · 公钥指纹
    copyFingerprint: '公開鍵フィンガープリントをコピー', // 复制公钥指纹
    copyJws: 'JWS をコピー', // 复制 JWS
    preparing: '準備しています…', // 正在准备…
    downloadBundle: 'オフライン検証パッケージをダウンロード', // 下载离线验证包
    fingerprintTip: 'あなたの公開プロフィール（GitHub のプロフィールなど）にもこの公開鍵フィンガープリントを載せておくと、第三者が照合できます。', // 建议在你的公开主页（例如 GitHub 个人页）同时公布这个公钥指纹，第三方即可对照。
    revoke: '修了証を失効させる…', // 吊销证书…
    uninstallNote: 'プラットフォームをアンインストールするとオンラインの検証ページは使えなくなります。先にオフライン検証パッケージをダウンロードしてください。', // 平台卸载后在线验证页失效；请先下载离线验证包。
    reasonHelp: {
      'learner-request': '保有者の申請', // 持有人申请
      'content-defect': 'コンテンツの不具合：根拠のコンテンツのバージョンが不具合ありとマークされた', // 内容缺陷：所依据的内容版本已标记为有缺陷
      misissued: '誤発行', // 误签
    },
    revokedAnnounce: '修了証を失効させました', // 证书已吊销
    revokeTitle: '修了証を失効させる', // 吊销证书
    cancel: 'キャンセル', // 取消
    revoking: '失効させています…', // 正在吊销…
    revokeOk: '失効させる', // 吊销
    revokeNote: '失効は取り消せません。失効後、検証ページには「失効」と理由が表示されます。', // 吊销不可撤销；吊销后验证页显示“已吊销”与原因。
    reason: '理由', // 原因
    reasonItem: '{text}（{code}）', // {text}（{code}）
    keyCompromise: '鍵の漏えい（{text}）はここで 1 枚ずつ扱いません。鍵のローテーション手順で旧鍵を停止し、まとめて失効させます。', // 密钥泄露（{text}）不在这里逐张处理：由密钥轮换流程停用旧密钥并批量吊销。
  },
  claim: {
    nameRequired: '修了証に表示する名前を入力してください', // 请填写证书上显示的名字
    nameTooLong: '名前は 64 文字以内で入力してください', // 名字最多 64 个字符
    title: '受け取り：{title}', // 领取：{title}
    cancel: 'キャンセル', // 取消
    issuing: '発行しています…', // 正在签发…
    issue: '修了証を発行', // 签发证书
    nameLabel: '修了証に表示する名前', // 证书上显示的名字
    nameHint: '既定ではプロフィールの修了証用署名を使います。', // 默认取个人资料中的证书署名。
    public: '修了証ファイルを公開：誰でも /verify/ATL-… で直接検証できます。公開しない場合は、あなたが渡したファイルかリンクでのみ検証できます', // 公开证书文件：任何人可以通过 /verify/ATL-… 直接验证；不公开时只能用你提供的文件或链接验证
    records: '修了証に記録される内容：学習パスとバージョン、算入されたカードとバッジのレベル、「検証済み」の割合、各カードのレポートのダイジェスト。', // 证书会记录：路径与版本、计入的卡片与徽章等级、“已核验”占比、每张卡片的报告摘要。
    notRecords: '記録されない内容：メールアドレス、AWS アカウント ID、小テストの成績。', // 不会记录：你的邮箱、AWS 账号 ID、小测成绩。
    nature: '同じ学習パスで有効な修了証は 1 枚だけです。後で成績が上がったら再度受け取れ、旧い修了証は自動で失効します（新しい修了証に置き換え）。この証明はあなたのセルフホスト ATL インスタンスが発行したもので、AWS の公式認定ではありません。', // 同一路径只保留一张有效证书；以后成绩提高可以重新领取，旧证书会自动吊销（被新证书取代）。本证明由你的自托管 ATL 实例签发，不是 AWS 官方认证。
    notEligible: 'まだ受け取りの条件を満たしていません：', // 还不满足领取条件：
  },
  visual: {
    required: '必修カード', // 必修卡片
    earned: '取得済みのバッジ', // 已获得的徽章
    verified: '「検証済み」の割合', // “已核验”占比
    category: '{label}の取得済みバッジ', // {label}已获得的徽章
  },
} satisfies Dict<typeof zh>;
