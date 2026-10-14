/**
 * ja（日本語）：命名空间 settings。由 `npm run i18n:sync` 按 zh-CN 词典维护结构：
 * 只填写引号内的译文（空字符串 = 未翻译，运行时按 ja → en → zh-CN 回退）；行尾注释是 zh-CN 原文。
 * 术语与风格见 ../glossary.md（不翻译 AWS 服务名、CLI 命令、代码、资源名、API 路径、环境变量）。
 */
import type { Dict } from '../dict';
import type zh from '../zh-CN/settings';

export default {
  title: '設定', // 设置
  navLabel: '設定', // 设置
  selectLabel: '設定のタブ', // 设置页签
  tabs: {
    profile: 'プロフィールと表示設定', // 个人资料与偏好
    platform: '概要と点検', // 关于与体检
    guardrails: 'ガードレールと予算', // 护栏与预算
    workspace: 'ワークベンチとプレビュー', // 工作台与预览
    members: 'メンバー', // 成员
    content: 'コンテンツのバージョン', // 内容版本
    audit: '監査', // 审计
    upgrade: 'アップグレード', // 升级
    uninstall: 'アンインストール', // 卸载
  },
  readonly: 'プラットフォームをアンインストール中のため、このタブは読み取り専用です。', // 平台卸载中：本页签只读。
  save: '保存', // 保存
  saving: '保存しています…', // 正在保存…
  saved: '保存しました', // 已保存
  savedNext: '保存しました · 次にラボを開始したときに反映されます', // 已保存 · 下一次开始实验时生效
  conflict: '設定が変更されたため（別のタブからの可能性があります）、最新の状態に更新しました。もう一度操作してください。', // 设置刚被修改（可能在另一个标签页），已刷新。请重新操作。
  activeNote: '一部の設定は実行中のラボには反映されません。', // 部分设置对进行中的实验不生效。
  profile: {
    displayName: '表示名', // 显示名
    certName: '修了証用の氏名', // 证书署名
    nameRequired: '表示名を入力してください', // 显示名不能为空
    theme: 'テーマ', // 主题
    themeSystem: 'システムに合わせる', // 跟随系统
    themeLight: 'ライト', // 亮
    themeDark: 'ダーク', // 暗
    shortcuts: '単一キーのショートカットを有効にする（G W、/、? など。オフにすると Ctrl+K と Esc だけが残ります）', // 启用单键快捷键（G W、/、? 等；关闭后只保留 Ctrl+K 与 Esc）
    leader: 'ワークベンチのリーダーキー', // 工作台前导键
    fontSize: 'ターミナルの文字サイズ', // 终端字号
    screenReader: 'ターミナルのスクリーンリーダーモード', // 终端读屏模式
    notify: 'ブラウザー通知（ページが表示されていないときだけ送信し、確実な配信は保証しません。通知文にリソース ID やアカウント ID は含みません）', // 浏览器通知（只在页面不可见时发送，尽力送达；文案不含资源 ID 与账号 ID）
    notifyDenied: 'ブラウザーが通知の権限を拒否しました。ブラウザーのサイト設定から再度許可できます。', // 浏览器拒绝了通知权限，可以在浏览器的网站设置中重新允许。
    localNote: 'テーマ、ショートカット、ターミナルの設定はこのブラウザーにだけ保存され、変更するとすぐに反映されます。', // 主题、快捷键与终端偏好只保存在这个浏览器中，修改后立即生效。
    revisit: '初回設定をもう一度見る', // 重看首次设置
  },
  platform: {
    version: 'プラットフォームのバージョン', // 平台版本
    dev: '開発版', // 开发版本
    catalog: 'カタログのバージョン', // 目录版本
    region: 'リージョン', // 区域
    dr: 'DR リージョン', // 灾备区域
    drNone: '未設定', // 未设置
    installation: 'インストール ID', // 安装 ID
    url: 'プラットフォームの URL', // 平台 URL
    features: 'オプションのコンポーネント', // 可选组件
    featureText: 'ターミナルの録画 {rec} · プラットフォームの証跡 {trail} · 外部アクセスアナライザー {aa}', // 终端录制 {rec} · 平台 trail {trail} · 外部访问分析器 {aa}
    on: 'オン', // 开
    off: 'オフ', // 关
    preflight: '点検結果（インストール時）', // 体检结果（安装时）
    preflightCounts: '要対応 {fix} 件 · 注意 {warn} 件 · 合格 {pass} 件 · 検出不可 {unknown} 件', // 需处理 {fix} 项 · 提示 {warn} 项 · 通过 {pass} 项 · 无法检测 {unknown} 项
    preflightNone: 'インストール時の点検結果はまだ書き込まれていません。', // 安装时的体检结果还没有写入。
    details: '詳細を見る', // 查看详情
    regionNote: 'リージョンは画面から切り替えられません（リージョンを変えるには再インストールが必要です）。', // 区域不可在界面中切换（换区域需要重新安装）。
  },
  guardrails: {
    limits: '上限（インストール時のパラメーター、読み取り専用）', // 限额（来自安装参数，只读）
    value: '値', // 取值
    maxSession: '1 セッションの合計時間', // 单次会话总时长
    extension: '延長', // 延长
    extensionValue: '{n} 回 × {m} 分', // {n} 次 × {m} 分钟
    keep: '保持の上限', // 保留上限
    envAge: '環境の最長寿命', // 环境最长寿命
    readyIdle: '準備完了後の待機上限', // 就绪空闲时限
    instanceTypes: '使用できるインスタンスタイプ', // 允许的实例类型
    minutes: '{n} 分', // {n} 分钟
    hours: '{n} 時間', // {n} 小时
    days: '{n} 日', // {n} 天
    budget: '予算 atl-platform-guard', // 预算 atl-platform-guard
    budgetUnset: '予算のガードレールは設定されていません。CloudFormation で atl スタックの MonthlyBudgetAmount と BudgetEnforcement を更新できます（実行中のラボがないときに行ってください）。', // 未设置预算护栏。可以在 CloudFormation 中更新 atl 栈的 MonthlyBudgetAmount 与 BudgetEnforcement（只在没有进行中的实验时操作）。
    enforcement: '対応方法 {e} · 状態 ', // 处理方式 {e} · 状态 
    maintenance: 'メンテナンスモード', // 维护模式
    maintenanceHint: 'オンにすると新しいラボを開始できなくなります。実行中のラボには影響しません。', // 开启后不能开始新实验；进行中的实验不受影响。
    enter: 'メンテナンスモードにする', // 进入维护模式
    exit: 'メンテナンスモードを解除', // 退出维护模式
    busy: '切り替えています…', // 正在切换…
    activeBlocks: '実行中または保持中の環境があるため、メンテナンスモードにできません。', // 仍有进行中或保留中的环境，不能进入维护模式。
  },
  workspace: {
    lead: 'プラットフォームの設定はインストール時のパラメーターの上限を超えられません。一部の設定は新しいセッションにだけ反映されます。', // 平台设置不超过安装参数给出的上限；部分设置只对新会话生效。
    limitsTitle: 'セッションと保持', // 会话与保留
    terminalTitle: 'ターミナルとワークベンチ', // 终端与工作台
    previewTitle: 'プレビュー、アップロード、回収', // 预览、上传与回收
    readyIdle: '準備完了後の待機上限（分）', // 就绪空闲时限（分钟）
    maxKeep: '保持の上限（時間）', // 保留上限（小时）
    maxSession: '1 セッションの合計時間の上限（分）', // 单次会话总时长上限（分钟）
    extMinutes: '1 回の延長（分）', // 每次延长（分钟）
    extCount: '延長回数', // 延长次数
    persistence: 'ターミナルセッションの維持（terminal.persistence）', // 终端会话保持（terminal.persistence）
    signing: 'ターミナルストリーム URL の署名（terminal.streamUrlSigning）', // 终端流地址签名（terminal.streamUrlSigning）
    keepalive: 'ターミナルのキープアライブ間隔（秒、terminal.keepalive）', // 终端保活间隔（秒，terminal.keepalive）
    recording: 'ターミナルの録画（読み取り専用。インストール時のパラメーター TerminalRecording を反映）', // 终端录制（只读，反映安装参数 TerminalRecording）
    instanceType: 'ワークベンチのインスタンスタイプ（読み取り専用、インストール時のパラメーター）', // 工作台实例类型（只读，安装参数）
    longSession: 'コンソールの長時間セッション（console.longSession、既定はオフ）', // 控制台长会话（console.longSession，默认关）
    directHttps: 'プレビューの HTTPS 直接接続の既定値（カードで上書き可、preview.directHttps）', // 预览直连 HTTPS 的缺省值（卡片可覆盖，preview.directHttps）
    lateUpload: '比較実験の結果を確定後にアップロードするフォールバック（agent.lateUploadFallback）', // 对比实验结果的定稿上传回退（agent.lateUploadFallback）
    residual: '未解放の残存リソースがあるときに新しいラボを開始（reclaim.blockStartOnResidual）', // 有未释放的残留时开始新实验（reclaim.blockStartOnResidual）
    residualAck: 'ack：確認すれば開始できる（既定）', // ack：确认后可以开始（默认）
    residualBlock: 'block：先に残存リソースの処理が必要', // block：必须先处理残留
    residualIgnore: 'ignore：通知のみ', // ignore：只提示
    ownership: '所有権確認の最大待ち時間（分、ownership.maxWaitMinutes）', // 归属确认的最长等待（分钟，ownership.maxWaitMinutes）
    capError: 'インストール時のパラメーターの上限を超えられません：{detail}', // 不能超过安装参数的上限：{detail}
    on: 'オン', // 开
    off: 'オフ', // 关
  },
  members: {
    note: '受講者は唯一の learner で、削除や降格はできません。受講者のメールアドレスを変更するには Cognito コンソールで操作します。', // 学员是唯一的 learner，不能删除或降级；更换学员邮箱需要在 Cognito 控制台操作。
    member: 'メンバー', // 成员
    role: 'ロール', // 角色
    invitedAt: '招待日時', // 邀请时间
    remove: '削除', // 删除
    removeLabel: 'メンバー {name} を削除', // 删除成员 {name}
    removeTitle: 'メンバーを削除', // 删除成员
    removeBody: '{name}（{role}）を削除すると、そのメンバーはプラットフォームにログインできなくなります。', // 删除 {name}（{role}）后，对方不能再登录平台。
    inviteEmail: '招待するメールアドレス', // 邀请邮箱
    inviteRole: 'ロール', // 角色
    invite: '招待', // 邀请
    inviting: '招待しています…', // 正在邀请…
    invited: '招待を送りました。相手には一時パスワードを記載したメールが届きます。', // 已发送邀请：对方会收到一封带临时密码的邮件。
    emailInvalid: '有効なメールアドレスを入力してください', // 请填写有效的邮箱地址
    empty: 'メンバーはまだいません。', // 还没有成员。
  },
  content: {
    version: '現在のカタログのバージョン', // 当前目录版本
    publishedAt: '公開日時', // 发布时间
    digest: 'コンテンツのダイジェスト', // 内容摘要
    defective: '状態', // 状态
    defectiveYes: '不具合ありとしてマーク済み', // 已标记为有缺陷
    defectiveNo: '正常', // 正常
    mark: '不具合ありとしてマーク…', // 标记为有缺陷…
    markTitle: 'カタログのバージョンを不具合ありとしてマーク', // 标记目录版本为有缺陷
    markBody: 'マークすると、このバージョンでは新しい修了証を発行しません。発行済みの修了証は自動では失効しません。修了証とバッジ › 修了証の詳細 で 1 枚ずつ「コンテンツの不具合」または「誤発行」として失効させるか、そのまま残してください。', // 标记后该版本不再签发新证书。已签发的证书不会自动吊销：在 证书与徽章 › 证书详情 中逐张以“内容缺陷”或“误签”吊销，或保留。
    reason: '理由（任意）', // 原因（可选）
    confirm: 'マークする', // 标记
    busy: 'マークしています…', // 正在标记…
  },
  audit: {
    session: 'セッション ID', // 会话 ID
    from: '開始', // 从
    to: '終了', // 到
    apply: '絞り込む', // 筛选
    time: '日時', // 时间
    actor: '操作者とロール', // 操作者与角色
    action: '操作', // 动作
    target: '対象', // 对象
    result: '結果', // 结果
    source: '送信元', // 来源
    resultOk: '成功', // 成功
    resultDenied: '拒否', // 被拒绝
    resultError: 'エラー', // 出错
    via: {
      web: 'Web', // 网页
      agent: 'CLI', // CLI
      internal: 'プラットフォーム', // 平台
      system: 'プラットフォーム', // 平台
    },
    showIp: '送信元 IP をすべて表示', // 显示完整来源 IP
    hideIp: 'マスクに戻す', // 恢复打码
    ipOnlyLearner: '送信元 IP は受講者にだけ表示されます。', // 来源 IP 只对学员显示。
    empty: 'この期間の監査イベントはありません。', // 这段时间没有审计事件。
  },
  upgrade: {
    current: '現在のバージョン {v}', // 当前版本 {v}
    latest: '新しいバージョン {v} があります', // 有新版本 {v}
    notes: 'リリースノート', // 更新说明
    upToDate: '最新のバージョンです', // 已是最新版本
    devVersion: '開発版では更新を確認しません', // 开发版本不检查更新
    failed: '更新を確認できません', // 无法检查更新
    prereq: 'アップグレードの前提：実行中や保持中の環境がなく、再スキャン期間中のセッションもないこと。', // 升级前提：没有进行中或保留中的环境，也没有处在复扫窗口内的会话。
    prereqOk: '満たしています', // 满足
    prereqActive: '現在 {labId} が {state} です', // 当前有 {labId} {state}
    toSession: '現在のラボに戻る', // 回到当前实验
    step1: 'メンテナンスモードにする（この間は新しいラボを開始できません）', // 进入维护模式（期间不能开始新实验）
    step1On: 'メンテナンスモードになりました', // 已进入维护模式
    step2: 'CloudFormation で atl スタックの変更セットを作成して確認する（パラメーターは以前の値を使用）', // 在 CloudFormation 中为 atl 栈创建变更集并审阅（参数沿用旧值）
    openCfn: 'CloudFormation コンソールを開く', // 打开 CloudFormation 控制台
    step3: '変更セットを実行し、スタックの更新完了を待つ（失敗すると CloudFormation が自動でロールバックし、旧バージョンの成果物も残ります）', // 执行变更集，等待栈更新完成（失败时 CloudFormation 自动回滚，旧版本制品仍保留）
    step4: 'このページを更新してバージョンを確認し、メンテナンスモードを解除する', // 刷新本页确认版本，然后退出维护模式
    templatePlaceholder: '<新しいテンプレートの URL>', // <新模板 URL>
  },
  uninstall: {
    warning: 'アンインストールするとプラットフォームのデータはすべて削除され、レポート、バッジ、修了証、オンライン検証ページ、共有リンクはすべて使えなくなります。先にエクスポートしてください。', // 卸载会删除平台的全部数据：报告、徽章、证书、在线验证页、分享链接都会失效。请先导出。
    s1: '1 エクスポート', // 1 导出
    archive: '学習アーカイブ（レポート HTML、修了証 JWS、公開鍵 jwks.json、比較実験の結果）', // 学习档案（报告 HTML、证书 JWS、公钥 jwks.json、对比实验结果）
    generate: '作成してダウンロード', // 生成并下载
    generating: '作成しています…', // 生成中…
    generatedAt: '{t} に作成しました', // 已生成 {t}
    download: 'ダウンロード', // 下载
    exportTimeout: '作成に 10 分以上かかっています。しばらくしてからもう一度お試しください。', // 生成时间超过 10 分钟，请稍后再试。
    manualList: '要対応リスト（Markdown / JSON。CLI の削除コマンド付き）', // 待人工处理清单（Markdown / JSON，含 CLI 删除命令）
    exportMd: 'Markdown でエクスポート', // 导出 Markdown
    exportJson: 'JSON でエクスポート', // 导出 JSON
    s2: '2 すべて終了して回収', // 2 结束全部并回收
    blockers: '妨げになっている項目', // 阻塞项
    blockSession: 'セッション {sid}（{labId}）がまだ {state} です', // 会话 {sid}（{labId}）仍在 {state}
    blockManual: '手動対応が必要な残存リソース {n} 件', // 待人工处理的残留 {n} 项
    blockRevocations: '失効エントリがまだ期限切れになっていません（約 {t} 後に自動で削除されます）', // 吊销条目尚未过期（约 {t} 后自动清理）
    viewList: '一覧を見る', // 查看清单
    noBlockers: '妨げになっている項目はありません。', // 没有阻塞项。
    confirmLabel: '確認のため atl と入力', // 输入 atl 以确认
    confirmHint: 'すべてのラボを終了し（保持は不可）、すべての環境を回収します。', // 会结束全部实验（不允许保留）并回收全部环境。
    prepare: 'すべてのラボを終了して回収', // 结束全部实验并回收
    preparing: '回収しています…', // 回收进行中…
    slow: '回収はバックグラウンドで続いています。しばらくしてからスタックを削除してください。', // 回收仍在后台进行，请稍后再删除栈。
    s3: '3 プラットフォームのスタックを削除', // 3 删除平台栈
    s3Hidden: '妨げになっている項目がすべて解消されると表示されます。', // 全部阻塞项解除后出现。
    s3Text: 'プラットフォームが atl スタックの削除保護を解除しました。CloudFormation コンソールで atl スタックを削除してください。', // 平台已关闭 atl 栈的终止保护。请在 CloudFormation 控制台删除 atl 栈。
    s3Warn: '削除に失敗した場合（DELETE_FAILED）、再試行するときに UninstallGuard などのリソースを保持する設定を選ばないでください。保持するとプラットフォームの回収機能が削除され、課金中のラボのリソースが回収されなくなります。', // 如果删除失败（DELETE_FAILED），重试删除时不要选择保留 UninstallGuard 等资源：那样平台的回收能力会被删除，仍在计费的实验资源将无人回收。
    s3After: '削除が完了すると、アカウントに atl-*、ATL*、cloudalbum-* のリソースは残らないはずです。/aws/lambda/atl-* のロググループも確認できます。', // 删除完成后，账号中不应残留 atl-*、ATL*、cloudalbum-* 资源；可检查 /aws/lambda/atl-* 日志组。
    statusFailed: 'アンインストールの状態を読み取れません。', // 暂时无法读取卸载状态。
  },
} satisfies Dict<typeof zh>;
