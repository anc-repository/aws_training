/**
 * ja（日本語）：命名空间 sessions。由 `npm run i18n:sync` 按 zh-CN 词典维护结构：
 * 只填写引号内的译文（空字符串 = 未翻译，运行时按 ja → en → zh-CN 回退）；行尾注释是 zh-CN 原文。
 * 术语与风格见 ../glossary.md（不翻译 AWS 服务名、CLI 命令、代码、资源名、API 路径、环境变量）。
 */
import type { Dict } from '../dict';
import type zh from '../zh-CN/sessions';

export default {
  events: {
    category: {
      state: '状態、延長、保持', // 状态、延长与保留
      phase: '段階と進捗', // 阶段与进度
      ops: 'プラットフォーム操作', // 平台动作
      workspace: 'ターミナルとコンソール', // 终端与控制台
      checks: 'チェック、提出、成果', // 检测、提交与成果
      reclaim: '回収', // 回收
      env: '環境と予算', // 环境与预算
      other: 'その他', // 其他
    },
    phase: {
      'start.validate': '検証', // 校验
      'start.lock': '環境の確保', // 占用环境
      'start.preflight': '事前チェック', // 预检
      'provision.base': '基本環境', // 基础环境
      'provision.resume': '保持した環境の再開', // 恢复保留的环境
      'provision.workstation': 'ワークベンチ', // 工作台
      'provision.profile': '開始状態', // 起始状态
      'provision.extra-stack': '追加スタック', // 附加栈
      'provision.ssm': '接続', // 连接
      'provision.wire': '組み込み', // 接入
      'provision.health': 'ヘルスチェック', // 健康检查
      'provision.ready': '準備完了', // 就绪
      'end.stop-start': '開始処理の停止', // 停止开始流程
      'end.disarm': 'カウントダウン停止', // 停止倒计时
      'end.revoke': 'アクセスの取り消し', // 收回访问
      'end.finalize': '最終確認', // 最终复核
      'end.seal': 'レポートのスナップショット', // 报告快照
      'end.workstation-down': 'ワークベンチの削除', // 删除工作台
      'end.suspend': '節約モードへ移行', // 进入节省模式
      'clean.destroy': '環境スタックの削除', // 拆除环境栈
      'clean.reclaim': '回収', // 回收
      'clean.verify': '確認', // 校验
      'clean.conclude': '結果', // 结论
    },
    phaseStatus: {
      QUEUED: '待機中', // 排队中
      RUNNING: '実行中', // 进行中
      RETRYING: '再試行中', // 重试中
      DONE: '完了', // 完成
      FAILED: '失敗', // 失败
      SKIPPED: 'スキップ', // 跳过
    },
    passMode: {
      PRIMARY: '主な回収', // 主回收
      RESCAN: '再スキャン', // 复扫
      RETRY: '再試行', // 重试
      UNINSTALL: 'アンインストール', // 卸载
    },
    resource: 'リソース', // 资源
    paren: '（{text}）', // （{text}）
    sep: '、', // ，
    detailTail: ' · {detail}', //  · {detail}
    requested: '受け付けました', // 已受理
    requestedQuote: '見積もり {id}…', // 报价 {id}…
    requestedProfile: '開始プロファイル {name}', // 起始档位 {name}
    phaseLine: '段階 {phase}：{status}', // 阶段 {phase}：{status}
    phaseOther: 'その他', // 其他
    phaseUpdate: '更新', // 更新
    progressMsg: '進捗：{text}', // 进度：{text}
    progressModule: '進捗：モジュール {module}', // 进度：模块 {module}
    progressModuleStatus: '進捗：モジュール {module} {status}', // 进度：模块 {module} {status}
    progressUpdate: '進捗の更新', // 进度更新
    expiryWarning: '期限のお知らせ', // 到期提醒
    expiryWarningMin: '期限のお知らせ：残り {n} 分', // 到期提醒：剩余 {n} 分钟
    extended: '{n} 分延長', // 延长 {n} 分钟
    extendedTo: '{n} 分延長（{t} まで）', // 延长 {n} 分钟（到 {t}）
    endRequested: '終了を依頼（{reason}）', // 请求结束（{reason}）
    accessRevoked: 'アクセスの取り消し：ターミナルを切断し、コンソールとワークベンチの認証情報を失効', // 收回访问：终端断开，控制台与工作台凭证吊销
    keepStarted: '環境の保持を開始', // 开始保留环境
    keepStartedUntil: '環境の保持を開始（{t} まで）', // 开始保留环境（至 {t}）
    keepExtended: '保持を延長', // 延长保留
    keepExtendedUntil: '保持を延長（{t} まで）', // 延长保留（至 {t}）
    keepExpiryWarning: '保持している環境がまもなく自動解放されます', // 保留的环境即将自动释放
    handedOver: '環境は新しいセッションに引き継がれました', // 环境已交接给新的会话
    outageOpen: '予定された中断時間帯が開始（{t} まで）', // 预期中断窗口打开（至 {t}）
    outageClosed: '予定された中断時間帯が終了', // 预期中断窗口结束
    envDegraded: '環境の異常', // 环境异常
    envDegradedDetail: '環境の異常：{detail}', // 环境异常：{detail}
    envRecovered: '環境が回復しました', // 环境已恢复
    budgetState: '予算の状態：{state}', // 预算状态：{state}
    update: '更新', // 更新
    opStarted: '開始', // 开始
    opSucceeded: '成功', // 成功
    opFailed: '失敗', // 失败
    op: 'プラットフォーム操作：{verb}', // 平台动作：{verb}
    opWhat: 'プラットフォーム操作 {what}：{verb}', // 平台动作 {what}：{verb}
    passStarted: '回収 第 {n} 回を開始（{mode}）', // 回收第 {n} 轮开始（{mode}）
    passDefault: '回収', // 回收
    passCompleted: '回収 第 {n} 回が完了：{deleted} 件を削除', // 回收第 {n} 轮完成：删除 {deleted} 项
    passCompletedManual: '回収 第 {n} 回が完了：{deleted} 件を削除、要対応 {manual} 件', // 回收第 {n} 轮完成：删除 {deleted} 项，需人工 {manual} 项
    itemDeleted: '{res} を削除しました', // 已删除 {res}
    itemManual: '要対応：{res}', // 需人工处理：{res}
    discovered: 'リソース {res} を検出', // 发现资源 {res}
    cleanupCompleted: '回収が完了しました', // 回收完成
    cleanupFailed: '解放未完了：自動削除できなかったリソースがあります', // 释放未完成：有资源没能自动删除
    accessFinding: '外部アクセス分析：外部に公開されたリソースを検出', // 外部访问分析：发现对外开放的资源
    checkPass: '{n} 件合格', // {n} 项通过
    checkFail: '{n} 件不合格', // {n} 项未通过
    checkDone: 'チェック完了', // 检测完成
    checkDoneStep: 'チェック完了（ステップ {step}）', // 检测完成（步骤 {step}）
    checkParts: '：{parts}', // ：{parts}
    stepState: 'ステップ {step}：{state}', // 步骤 {step}：{state}
    stateChanged: '状態の変化', // 状态变化
    stepDrifted: 'ステップ {step} がドリフト', // 步骤 {step} 漂移
    attemptState: '試行：{state}', // 尝试：{state}
    manualSubmitted: '手動確認を提出', // 提交手动确认
    manualReviewed: 'アシスタントの確認：{decision}', // 助教复核：{decision}
    rejected: '差し戻し', // 打回
    approved: '承認', // 通过
    expRecorded: '実験の実行結果をアップロード：{name}', // 实验运行已上传：{name}
    expValidated: '実験の検証：{name}', // 实验校验：{name}
    label: '（{label}）', // （{label}）
    quizGraded: '小テストを採点しました（記録のみ）', // 小测已判分（只记录）
    badgeEarned: 'バッジを獲得', // 获得徽章
    badgeEarnedLevel: 'バッジを獲得（{level}）', // 获得徽章（{level}）
    badgeWithdrawn: 'バッジが取り消されました', // 徽章被撤回
    masteryRegression: 'サービスの習熟度：復習が必要です', // 服务掌握度：需要复习
    trackCompleted: '学習パスの修了証の条件を満たしました', // 学习路径的证书条件已满足
    reportGenerated: 'レポート第 {n} 版を作成しました', // 报告第 {n} 版已生成
    certIssued: '修了証を発行', // 签发证书
    certRevoked: '修了証を失効', // 证书已吊销
    terminalOpened: 'ターミナルを開きました', // 打开终端
    terminalOpenedLab: 'ターミナルを開きました（ラボ用インスタンス）', // 打开终端（实验机）
    terminalOpenedWs: 'ターミナルを開きました（ワークベンチ）', // 打开终端（工作台）
    terminalClosed: 'ターミナルを閉じました', // 终端关闭
    consoleIssued: 'コンソールのサインインを発行', // 签发控制台登录
    workspaceOp: 'ワークベンチの操作', // 工作台操作
    platformRecord: 'プラットフォームの記録', // 平台记录
  },
  values: {
    endReason: {
      USER_ENDED: '受講者が終了', // 你结束的
      EXPIRED: '期限切れ', // 到期
      IDLE_NOT_STARTED: '準備後に未着手', // 就绪后未进入
      CANCELLED: '受講者がキャンセル', // 你取消的
      PROVISION_FAILED: 'デプロイ失敗', // 部署失败
      PROVISION_TIMEOUT: 'デプロイのタイムアウト', // 部署超时
      BUDGET_ENFORCED: '予算による強制終了', // 预算强制
      ADMIN_ENDED: '管理者が終了', // 管理员结束
      KEEP_EXPIRED: '保持の期限切れ', // 保留到期
      KEEP_RELEASED: '受講者が解放', // 你释放的
      PLATFORM_UNINSTALL: 'プラットフォームのアンインストール', // 平台卸载
      CLEANUP_RETRY: '回収の再試行', // 回收重试
      HANDED_OVER: '環境を引き継ぎ済み', // 环境已交接
    },
    other: 'その他', // 其他
    discoveredBy: {
      STACK: 'スタック', // 栈
      RETAINED: '保持', // 保留
      OUT_OF_BAND: 'アウトオブバンド', // 带外
      CLOUDTRAIL: 'CloudTrail（コンソールまたは CLI で作成）', // CloudTrail（你在控制台或 CLI 创建）
      DERIVED: '派生', // 派生
      REALTIME: 'リアルタイム', // 实时
      OWNERSHIP_LOOKUP: '対象スキャン', // 定向扫描
      TAG: 'タグ（タグのみで検出）', // 标签（仅凭标签发现）
      INVENTORY: '棚卸し', // 清点
    },
    stage: {
      S0: 'S0 入口とトリガー', // S0 入口与触发
      S1: 'S1 コンピューティング', // S1 计算
      S2: 'S2 データとマネージドサービス', // S2 数据与托管服务
      S3: 'S3 ネットワーク', // S3 网络
      S4: 'S4 イメージとボリューム', // S4 镜像与卷
      S5: 'S5 ID と鍵', // S5 身份与密钥
      S6: 'S6 リセットと環境の状態', // S6 复位与环境状态
      other: 'その他', // 其他
    },
    reportCleanup: {
      pending: '回収中。完了するとレポートに改訂が追加されます', // 回收进行中，完成后报告会追加修订
      clean: '解放済み', // 已释放
      'needs-review': '要確認', // 需复核
      'cleanup-failed': '解放未完了', // 释放未完成
      kept: '環境を保持中', // 环境保留中
    },
    badgeLevel: {
      verified: '検証済み', // 已核验
      attested: '手動確認を含む', // 含手动
      'self-reported': '自己申告中心', // 自述为主
    },
    badgeStatus: {
      valid: '有効', // 有效
      pending: '検証中', // 核验中
      withdrawn: '取り消し済み', // 已撤回
    },
    validityReason: {
      OUT_OF_WINDOW: '登録した時間枠の外です', // 不在登记的时间窗内
      DRIVER_MISMATCH: '実行時のドライバーがこのバリアントの要件と一致しません', // 运行时驱动与该变体要求不符
      NOT_CORROBORATED: 'サーバー側で十分なリクエストを確認できませんでした', // 服务端没有看到足够的请求
      PATH_RATIO: '経路の割合が足りません', // 路径占比不足
      TOO_FEW_SAMPLES: 'サンプルが足りません', // 样本不足
      OUTPUT_TRUNCATED: '出力が途中で切れています', // 输出被截断
      DELIVERY_MISMATCH: '配信方法が登録内容と一致しません', // 交付方式与登记不符
    },
    withDetail: '{text}（{detail}）', // {text}（{detail}）
    compareReason: {
      DIFFERENT_EXPERIMENT: '同じ実験ではありません', // 不是同一个实验
      DIFFERENT_SCENARIO: 'シナリオが異なります', // 场景不一致
      DIFFERENT_CARD_VARIANT: '開始バリアントが異なります', // 起始变体不一致
      DIFFERENT_INSTANCE_TYPE: 'インスタンスタイプが異なります', // 实例类型不一致
      FORCED: '強制実行を使用しました', // 使用了强制运行
    },
    moneyRange: '≈ {low}～{high} {currency}{unit}', // ≈ {low}～{high} {currency}{unit}
    money: '≈ {amount} {currency}{unit}', // ≈ {amount} {currency}{unit}
  },
  list: {
    range: {
      '7': '過去 7 日', // 最近 7 天
      '30': '過去 30 日', // 最近 30 天
      '90': '過去 90 日', // 最近 90 天
      all: 'すべて', // 全部
    },
    cleanupFailed: '解放未完了', // 释放未完成
    pendingItems: '未対応 {n} 件', // {n} 项待处理
    inProgress: '実行中', // 进行中
    kept: '保持中', // 保留中
    released: '解放済み', // 已释放
    colStarted: '開始日時', // 开始时间
    colCard: 'カード', // 卡片
    colState: '状態', // 状态
    colEndReason: '終了理由', // 结束原因
    colAttempt: '試行の結果', // 尝试结果
    seeDetail: '（セッションの詳細で確認）', // （在会话详情中查看）
    colDuration: '所要時間', // 用时
    colCost: '費用の見積もり', // 估算费用
    colCleanup: 'クリーンアップ', // 清理
    title: '実験履歴', // 我的实验
    readOnlySub: '受講者の実験履歴（読み取り専用）', // 学员的实验记录（只读）
    refresh: '更新', // 刷新
    overview: '概要（過去 30 日）', // 概览（最近 30 天）
    overviewLine: 'セッション {n} · 終了 {ended} · ラボ時間の合計 {total} · 費用の見積もり：各セッションの詳細で確認', // 会话 {n} · 已结束 {ended} · 实验时长合计 {total} · 估算费用：在各会话详情中查看
    manualPending: '要対応 {n} 件', // 待人工处理 {n} 项
    manualHourly: '（{n} 件は時間課金）', // （{n} 项按小时计费）
    view: '表示', // 查看
    keptEnv: ' · 保持中の環境：{v}', //  · 保留中的环境：{v}
    yes: 'あり', // 有
    no: 'なし', // 无
    filters: '絞り込み', // 筛选
    state: '状態', // 状态
    all: 'すべて', // 全部
    card: 'カード', // 卡片
    time: '期間', // 时间
    loading: '実験履歴を読み込んでいます', // 正在读取实验记录
    emptyTitle: '実験履歴はまだありません。', // 还没有实验记录。
    toCatalog: 'カード一覧から最初のカードを始める →', // 去卡片目录开始第一张 →
    noMatch: '条件に合うセッションはありません。', // 没有符合条件的会话。
    clearFilters: '絞り込みを解除', // 清除筛选
    olderNotLoaded: '以前の記録はまだ読み込まれていません。さらに読み込めます。', // 较早的记录还没有加载，可以先加载更多。
    caption: '実験セッションの一覧', // 我的实验会话
    loadingMore: '読み込んでいます…', // 正在加载…
    loadMore: 'さらに読み込む', // 加载更多
    loadFailed: '読み込みに失敗しました ·', // 加载失败 ·
    retry: '再試行', // 重试
    footnote: '終了したばかりのセッションは数秒遅れて一覧に表示されることがあります。「更新」を押してください。行はフォーカスでき、Enter でセッションの詳細を開きます。', // 刚结束的会话可能晚几秒出现在列表中，可以点“刷新”。行可聚焦，按 Enter 打开会话详情。
  },
  detail: {
    tab: {
      timeline: 'タイムライン', // 时间线
      resources: 'リソース', // 资源
      cost: '費用', // 费用
      ops: 'プラットフォーム操作', // 平台动作
      audit: '監査', // 审计
    },
    noSession: 'このセッションはありません', // 没有这个会话
    title: 'セッションの詳細', // 会话详情
    reading: 'セッションを読み込んでいます', // 正在读取会话
    crumbs: 'パンくずリスト', // 面包屑
    mySessions: '実験履歴', // 我的实验
    heading: '{labId} · セッション {sid}', // {labId} · 会话 {sid}
    inProgress: '実行中', // 进行中
    env: ' · 環境 {name}', //  · 环境 {name}
    backToWorkspace: 'ワークベンチに戻る', // 回到工作台
    manageKeep: '保持を管理', // 管理保留
    viewReclaim: '回収の進捗を見る', // 查看回收进度
    report: 'レポート', // 报告
    reclaim: '回収', // 回收
    tabs: 'タブ', // 页签
    deniedTail: 'このタブは受講者とアシスタントのみ表示できます。', // 这个页签只对学员与助教开放。
    readingTimeline: 'タイムラインを読み込んでいます', // 正在读取时间线
    timeline: 'タイムライン', // 时间线
    sumRequested: '受け付け', // 已受理
    sumReady: '環境の準備完了', // 环境已就绪
    sumRevoked: 'アクセスの取り消し', // 收回访问
    sumEnded: '終了（{reason}）', // 结束（{reason}）
    filterByCategory: '分類で絞り込む', // 按类别筛选
    allCategories: 'すべての分類', // 全部类别
    truncated: '以前のイベントは保存期間に従って削除されたため、概要のみ表示しています。', // 较早的事件已按保留期清理，只显示摘要。
    summary: '概要', // 摘要
    noEventsInCategory: 'この分類のイベントはありません。', // 这个类别没有事件。
    noEvents: 'イベントはまだありません。', // 还没有事件。
    cleanupState: 'クリーンアップの状態', // 清理状态
    all: 'すべて', // 全部
    resources: 'リソース', // 资源
    resourcesHeading: 'このセッションが作成したリソース（{n} 件）', // 本会话创建的资源（{n} 项）
    resourcesNote: 'ここにはこのセッションが作成したリソースだけを表示します。再利用した環境で、引き継ぎ元の他のセッションが作成したリソースは、それぞれのセッションで確認してください。', // 这里只列出本会话创建的资源；复用环境中由交接链里其他会话创建的资源在各自的会话中查看。
    perHour: '/時間', // /小时
    costNote: '現在または最終の課金（見積もり · 単価は Price List から取得{asOf} · 正式な金額は AWS の請求書を確認）', // 当前或最终的计费（估算 · 单价取自 Price List{asOf} · 以 AWS 账单为准）
    priceAsOf: '、取得時刻 {t}', // ，取价时间 {t}
    colService: 'サービス', // 服务
    colDimension: '課金ディメンション', // 计费维度
    colDetail: '詳細', // 详情
    noDimensions: '開始前の見積もりに課金ディメンションの記録はありません。', // 开始前的报价没有记录计费维度。
    startEstimate: '開始前の見積もり', // 开始前估算
    unknownPrice: '不明（単価を取得できません）', // 未知（单价暂不可得）
    quoteRef: ' · 見積もり {id}', //  · 报价 {id}
    thisSession: 'このセッション', // 本次会话
    recomputed: '{est}（実際の時間で再計算した見積もり）', // {est}（按实际时长重算，估算）
    unknownBill: '≈ 不明（単価を取得できません。請求書を確認してください）', // ≈ 未知（单价暂不可得，以账单为准）
    unestimated: ' · ＋ 見積もりのない手動作成リソース {n} 件', //  · + 未估算的手工资源 {n} 项
    extensions: '延長', // 延长
    extensionLine: '{n} 分延長', // 延长 {n} 分钟
    extensionQuote: '（見積もり {id}…）', // （报价 {id}…）
    cost: '費用', // 费用
    billable: '課金対象のリソース', // 计费资源
    since: ' · {t} から', //  · 自 {t}
    billNote: '実際の請求額を見るには：コスト配分タグを有効にすると、AWS Cost Explorer で atl:session-id ごとに確認できます（データは通常 1 日程度遅れます）。', // 想看实际账单：激活成本分配标签后，可在 AWS Cost Explorer 中按 atl:session-id 查看（数据通常有一天左右的延迟）。
    source: {
      platform: 'プラットフォーム', // 平台
      agent: 'ワークベンチ', // 工作台
      runner: 'ランナー', // 运行器
    },
    ops: 'プラットフォーム操作', // 平台动作
    noOps: 'このセッションにはプラットフォーム操作やモジュール操作がありません。', // 这次会话没有平台动作或模块操作。
    colTime: '時刻', // 时间
    colSource: '実行元', // 来源
    colOp: '操作', // 操作
    colModule: 'モジュール', // 模块
    colResult: '結果', // 结果
    colRunId: '実行 ID', // 运行 ID
    opRunning: '実行中', // 进行中
    opOk: '成功', // 成功
    opFailed: '失敗（終了コード {code}）', // 失败（退出码 {code}）
    result: {
      ok: '成功', // 成功
      success: '成功', // 成功
      denied: '拒否', // 被拒绝
      error: 'エラー', // 出错
    },
    platform: 'プラットフォーム', // 平台
    actorRole: '{name}（{role}）', // {name}（{role}）
    audit: '監査', // 审计
    noAudit: 'このセッションに監査イベントはありません。', // 这次会话没有审计事件。
    colActor: '実行者', // 操作者
    colAction: '操作', // 动作
    colTarget: '対象', // 对象
  },
  visual: {
    sessions: 'セッション', // 会话
    ended: '終了', // 已结束
    total: 'ラボ時間', // 实验时长
    manual: '要対応', // 待人工处理
    kept: '保持中の環境', // 保留中的环境
  },
} satisfies Dict<typeof zh>;
