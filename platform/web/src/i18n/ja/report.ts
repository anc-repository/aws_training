/**
 * ja（日本語）：命名空间 report。由 `npm run i18n:sync` 按 zh-CN 词典维护结构：
 * 只填写引号内的译文（空字符串 = 未翻译，运行时按 ja → en → zh-CN 回退）；行尾注释是 zh-CN 原文。
 * 术语与风格见 ../glossary.md（不翻译 AWS 服务名、CLI 命令、代码、资源名、API 路径、环境变量）。
 */
import type { Dict } from '../dict';
import type zh from '../zh-CN/report';

export default {
  revisionReason: {
    finalize: '確定', // 定稿
    cleanup: 'クリーンアップ結果を追記', // 追加清理结果
    'late-ownership': '遅れて確定した帰属を追記', // 追加延迟归属
    ownership: '遅れて確定した帰属を追記', // 追加延迟归属
    rescan: '再スキャン結果を追記', // 追加复扫结果
    quiz: '小テストの成績を追記', // 追加小测成绩
    certificate: '修了証を追記', // 追加证书
    regenerate: '再生成', // 重新生成
    manual: '再生成', // 重新生成
  },
  page: {
    noSession: 'このセッションはありません', // 没有这个会话
    title: 'ラボレポート', // 实验报告
    readingSession: 'セッションを読み込んでいます', // 正在读取会话
    crumbs: 'パンくずリスト', // 面包屑
    mySessions: '実験履歴', // 我的实验
    heading: '{labId} · ラボレポート', // {labId} · 实验报告
    sessionSub: 'セッション {sid}', // 会话 {sid}
    noReportTitle: 'このセッションにはレポートがありません', // 这次会话没有报告
    sessionDetail: 'セッションの詳細', // 会话详情
    noReportBody: '環境の準備前にセッションが終了しました（この試行は回数に数えません）。', // 会话在环境就绪前结束（这次尝试不计入次数）。
    generating: 'レポートを作成しています（最終確認とスナップショット。通常は数分です）。', // 报告正在生成（最终复核与报告快照，通常几分钟）。
    generatingLabel: 'レポートを作成しています', // 报告正在生成
    failed: '終了時にレポートのスナップショットを作成できませんでした（リソースの解放には影響しません）。', // 报告快照未能在结束时生成（不影响资源释放）。
    requesting: '依頼しています…', // 正在请求…
    regenerate: '再生成', // 重新生成
    regenStarted: 'レポートの再生成を開始しました。完了すると自動で更新されます。', // 已开始重新生成报告，完成后自动刷新。
    readingReport: 'レポートを読み込んでいます', // 正在读取报告
    perHour: '/時間', // /小时
    cleanupFailed: '解放未完了（要対応 {n} 件）', // 释放未完成（{n} 项待人工处理）
    cleanupReclaiming: '回収中。完了するとレポートに改訂が追加されます', // 回收进行中，完成后报告会追加修订
    cleanupKept: '環境を保持中', // 环境保留中
    cleanupLive: 'ラボ実行中', // 实验进行中
    cleanupDone: '解放済み', // 已释放
    cleanupRescan: '解放済み（再スキャン中）', // 已释放（复扫进行中）
    previewSub: 'プレビュー（保存されません）· セッション {sid} · {state}', // 预览（不保存）· 会话 {sid} · {state}
    versionSub: '第 {v} 版', // 第 {v} 版
    versionReason: '（{reason}）', // （{reason}）
    generatedAt: ' · {t} 作成', //  · 生成于 {t}
    sessionTail: '· セッション {sid}', // · 会话 {sid}
    version: '版', // 版本
    versionLatest: '第 {v} 版（最新）', // 第 {v} 版（最新）
    export: 'エクスポート…', // 导出…
    share: '共有…', // 分享…
    revisionsNote: '全 {n} 版。ここには最新版を表示しています。以前の版はプラットフォームが対応すると表示できるようになります。', // 共 {n} 版；这里显示最新版，较早的版本平台支持后可在此查看。
    newer: 'レポートが第 {v} 版に更新されました。', // 报告已更新到第 {v} 版。
    view: '表示', // 查看
    previewNote: 'ラボはまだ終了していません。以下はプレビューです（保存されません）。エクスポートと共有はできません。', // 实验尚未结束，以下是预览（不保存）。没有导出与分享。
    summary: '概要', // 摘要
    conclusion: '結果', // 结论
    unverified: '確認できませんでした', // 未能核验
    badgeTitle: ' · バッジ「{title}」', //  · 徽章“{title}”
    evidenceScore: '（証拠スコア {n}）', // （证据分 {n}）
    unverifiedNote: '一部のリソースの帰属がまだ確定していません。再スキャンが終わるとレポートは自動で更新されます。', // 部分资源的归属尚未确认，复扫完成后会自动更新报告。
    incompleteNote: '未完了：{list}', // 未完成：{list}
    listSep: '、', // ；
    idleNote: '未開始：環境の準備後、一度もワークベンチに入りませんでした。', // 未开始：环境就绪后一直没有进入工作台。
    duration: '所要時間', // 用时
    readyAt: '準備完了 {t}', // 就绪 {t}
    endedAt: ' → 終了 {t}', //  → 结束 {t}
    ongoing: ' → 実行中', //  → 进行中
    total: ' · 合計 {t}', //  · 共 {t}
    extensions: ' · 延長 {n} 回', //  · 延长 {n} 次
    checks: 'チェック', // 检查
    stepsDone: 'ステップ {done}/{total}', // 步骤 {done}/{total}
    quality: ' · 信頼度：高 {high} · 中 {medium} · 低 {low}', //  · 可信度：高 {high} · 中 {medium} · 低 {low}
    cost: '費用', // 费用
    costLine: '開始前の見積もり {start} · 実際の時間での再計算は HTML レポートにあります（見積もり · 単価は Price List から取得 · 正式な金額は請求書を確認）', // 开始前估算 {start} · 按实际时长的重算见 HTML 报告（估算 · 单价取自 Price List · 以账单为准）
    unknown: '不明', // 未知
    cleanup: 'クリーンアップ', // 清理
    manualList: 'リスト', // 清单
    environment: '環境', // 环境
    reused: '再利用した環境', // 复用环境
    fresh: '新しい環境', // 全新环境
    account: ' · アカウント {acct}', //  · 账号 {acct}
    startProfile: ' · 開始プロファイル {name}', //  · 起始档位 {name}
    fullNote: 'ここには概要とこのセッションのチェック記録を表示しています。完全なレポート（大きな証拠、小テスト、実際の時間で再計算した費用を含む）：{link}', // 这里显示摘要与本次会话的检测记录；完整报告（含较大的证据、小测与按实际时长重算的费用）请{link}查看。
    downloadHtml: 'HTML レポートをダウンロード', // 下载 HTML 报告
    downloadInExport: 'エクスポートから HTML レポートをダウンロード', // 在导出中下载 HTML 报告
    learnerExports: '受講者がエクスポートした HTML レポート', // 由学员导出 HTML 报告
    toc: 'レポートの目次', // 报告目录
    tocLead: '目次：', // 目录：
    steps: 'ステップごとの証拠', // 逐步证据
    experiments: '比較実験', // 对比实验
    appendix: '付録', // 附录
    fullHistory: 'チェックの全記録', // 完整检查记录
    noExperiments: 'このカードには比較実験がありません。', // 本卡片没有对比实验。
    required: '（必須）', // （必做）
    optional: '（任意）', // （选做）
    openCompare: '比較ビューを開く', // 打开对比视图
    quiz: '小テスト', // 小测
    quizBest: '最高得点 {score} · 回答 {n} 回。', // 最好成绩 {score} · 作答 {n} 次。
    quizInHtml: '小テストの成績は HTML レポートにあります。', // 小测成绩见 HTML 报告。
    quizNote: '記録のみで、完了やバッジには影響しません。', // 只记录，不影响完成与徽章。
    costNote: '開始前の見積もりも実際の時間での再計算も見積もりです（単価は Price List から取得{asOf}）。データ転送や一部のリクエスト課金は含みません。正式な金額は AWS の請求書を確認してください。', // 开始前的估算与按实际时长的重算都是估算（单价取自 Price List{asOf}），不含数据传输与部分按请求计费项，以 AWS 账单为准。
    priceAsOf: '、取得時刻 {t}', // ，取价时间 {t}
    startEstimate: '開始前の見積もり', // 开始前估算
    unknownPrice: '不明（単価を取得できません）', // 未知（单价暂不可得）
    quoteRef: ' · 見積もり {id}', //  · 报价 {id}
    billActual: '請求の実績', // 账单实际
    billNote: 'コスト配分タグを有効にすると、AWS Cost Explorer で atl:session-id ごとに確認できます（データは通常 1 日程度遅れます）。', // 激活成本分配标签后，可在 AWS Cost Explorer 中按 atl:session-id 查看（数据通常有一天左右的延迟）。
    costInDetail: '課金対象のリソースと実際の時間で再計算した見積もりはセッションの詳細で確認 →', // 在会话详情中查看计费资源与按实际时长重算的估算 →
    reclaimed: ' · 回収済み {n} 件', //  · 已回收 {n} 项
    manualPending: ' · 要対応 {n} 件', //  · 待人工处理 {n} 项
    reclaimProgress: '回収の進捗', // 回收进度
    card: 'カード', // 卡片
    cardVersion: 'カードのバージョン', // 卡片版本
    catalogVersion: 'カタログのバージョン', // 目录版本
    variant: '開始バリアント', // 起始变体
    digest: 'レポートの完全性ダイジェスト', // 报告完整性摘要
    copyDigest: 'レポートの完全性ダイジェストをコピー', // 复制报告完整性摘要
    copy: 'コピー', // 复制
    shareLinks: '共有リンク', // 分享链接
    createShare: '共有リンクを作成…', // 创建分享链接…
    printFooter: 'エクスポート日時 {t} · アカウント ID はマスク済み · セルフホストの ATL ラボプラットフォーム（AWS 非公式）', // 导出时间 {t} · 账号 ID 已打码 · 自托管 ATL 实验平台（非 AWS 官方）
  },
  evidence: {
    title: 'ステップごとの証拠', // 逐步证据
    readingSteps: 'ステップを読み込んでいます', // 正在读取步骤
    noSteps: 'ステップの記録はありません。', // 没有步骤记录。
    firstPassed: ' · 初回合格 {t}', //  · 首次达成 {t}
    spent: ' · 所要 {t}', //  · 用时 {t}
    drift: ' · ドリフト {n} 回', //  · 漂移 {n} 次
    stepChecks: 'ステップ {n} のチェック', // 第 {n} 步的检查
    inherited: '引き継ぎ元のセッションから継承', // 继承自交接链中的会话
    thisSession: 'このセッションで完了', // 本次完成
    ownershipPending: '帰属はセッション終了後に確定します', // 归属在会话结束后确认
    manualObserved: '手動確認：確認した値 {v}', // 手动确认：看到的值 {v}
    digest: '証拠ダイジェスト {d}…', // 证据摘要 {d}…
    optional: '（任意）', // （选做）
    trigger: {
      learner: '受講者', // 学员
      user: '受講者', // 学员
      manual: '受講者', // 学员
      auto: '自動', // 自动
      schedule: '自動', // 自动
      wait: 'ポーリング待ち', // 等待轮询
      poll: 'ポーリング待ち', // 等待轮询
      submit: '提出', // 提交
      'expiring-precheck': '期限前チェック', // 到期预检
      precheck: '期限前チェック', // 到期预检
      finalize: '確定', // 定稿
      final: '確定', // 定稿
      ownership: '遅れて確定した帰属', // 延迟归属
      'late-ownership': '遅れて確定した帰属', // 延迟归属
      assistant: 'アシスタント', // 助教
    },
    historyTitle: 'チェックの記録', // 检查记录
    noHistory: 'チェックの記録はありません。', // 没有检查记录。
    filterByResult: '結果で絞り込む', // 按结果筛选
    all: 'すべて', // 全部
    recentOnly: '直近 100 回の検査を表示しています。全記録は HTML レポートにあります。', // 显示最近 100 次检测；完整记录见 HTML 报告。
    caption: 'チェックの全記録', // 完整检查记录
    colTime: '時刻', // 时间
    colCheck: 'チェック', // 检查
    colResult: '結果', // 结果
    colCode: 'エラーコード', // 错误码
    colTrigger: '実行のきっかけ', // 触发方式
    other: 'その他', // 其他
  },
  share: {
    status: {
      publishing: '公開中', // 正在发布
      revoking: '取り消し中', // 正在撤销
      active: '有効', // 有效
      revoked: '取り消し済み', // 已撤销
      expired: '期限切れ', // 已过期
    },
    expiry: {
      d7: '7 日', // 7 天
      d30: '30 日', // 30 天
      d90: '90 日', // 90 天
      never: '無期限', // 不过期
    },
    createTitle: '共有リンクを作成', // 创建分享链接
    close: '閉じる', // 关闭
    cancel: 'キャンセル', // 取消
    creating: '作成しています…', // 正在创建…
    create: 'リンクを作成', // 创建链接
    redactNote: '共有されるのはマスク済みのコピーです。アカウント ID（ARN、バケット名、URL に含まれるものを含む）は末尾 4 桁のみ残し、パブリック IP、リソース ID の中間部、セッション ID、環境名はすべてマスクします。手動確認のメモは含みません。', // 分享的是一份脱敏副本：账号 ID（含 ARN、桶名、URL 中嵌入的）只留后 4 位，公网 IP、资源 ID 的中段、会话 id 与环境名一律打码，不含手动确认备注。
    publicNote: 'リンクを知っている人は誰でもログインせずに開けます。検索エンジンには登録されません。', // 任何拿到链接的人都能打开，无需登录；搜索引擎不收录。
    expiresIn: '有効期限', // 有效期
    uninstallNote: 'プラットフォームをアンインストールするとリンクも無効になります。', // 平台卸载后链接随之失效。
    created: '作成しました：{url}（公開中。通常は数秒で開けます）', // 已创建：{url}（正在发布，通常几秒后可以打开）
    notGenerated: 'レポートがまだ作成されていません。作成後に共有できます', // 报告还没有生成，生成后才能分享
    listTitle: '共有リンク', // 分享链接
    none: '共有リンクはまだありません。', // 还没有分享链接。
    createdAt: '{t} 作成', // 创建 {t}
    expiresAt: ' · {t} に期限切れ', //  · {t} 过期
    noExpiry: ' · 無期限', //  · 不过期
    copyLabel: '共有リンク {url} をコピー', // 复制分享链接 {url}
    copied: 'コピーしました', // 已复制
    copyFailed: 'コピーできませんでした。リンクを手動で選択してください', // 复制失败，请手动选中链接
    copy: 'コピー', // 复制
    open: '開く', // 打开
    revokeLabel: '共有リンク {url} を取り消す', // 撤销分享链接 {url}
    revoke: '取り消す', // 撤销
    revokedAnnounce: '共有リンクを取り消しました', // 已撤销分享链接
    revokeTitle: '共有リンクを取り消す', // 撤销分享链接
    revoking: '取り消しています…', // 正在撤销…
    revokeNote: '取り消し後、リンクはしばらくして無効になります（CDN キャッシュの更新に時間がかかります）。', // 撤销后链接在短时间内失效（CDN 缓存刷新需要时间）。
  },
  export: {
    mixed: '現在、アカウント ID とパブリック IP は両方マスクするか、両方マスクしないかのどちらかしか選べません', // 平台目前只能同时打码或同时不打码账号 ID 与公网 IP
    confirmFirst: 'エクスポートファイルに完全な AWS アカウント ID が含まれることを先に確認してください', // 请先确认导出文件会包含完整的 AWS 账号 ID
    ready: 'エクスポートファイルの準備ができました', // 导出文件已就绪
    title: 'レポートをエクスポート', // 导出报告
    close: '閉じる', // 关闭
    cancel: 'キャンセル', // 取消
    rendering: '作成しています…', // 正在生成…
    export: 'エクスポート', // 导出
    format: '形式', // 格式
    html: 'HTML（1 ファイル。オフラインで開け、PDF として印刷できます）', // HTML（单文件，可离线打开、可打印为 PDF）
    json: 'JSON（正式な形式）', // JSON（权威格式）
    maskAccount: 'アカウント ID をマスク', // 账号 ID 打码
    confirmUnmask: 'エクスポートファイルに完全な AWS アカウント ID が含まれることを確認しました', // 我确认导出文件会包含完整的 AWS 账号 ID
    maskIp: 'パブリック IP をマスク', // 公网 IP 打码
    mixedNote: '現在、アカウント ID とパブリック IP は両方マスクするか、両方マスクしないかのどちらかしか選べません。', // 平台目前只能同时打码或同时不打码账号 ID 与公网 IP。
    contents: 'エクスポートしたレポートには手動確認のメモとチェックの全記録が含まれます。PDF：ブラウザーで HTML レポートを開き、印刷 › PDF として保存 を選びます。', // 导出的报告包含手动确认备注与完整检查记录。PDF：在浏览器中打开 HTML 报告后，选择 打印 › 另存为 PDF。
    notForCert: 'マスクしてエクスポートしたファイルは修了証が参照するレポートとバイト単位で一致しないため、修了証の照合には使えません。照合用のレポート JSON は修了証の詳細からダウンロードしてください。', // 打码导出的文件与证书引用的报告不是同一份字节，不能用于证书核对；核对用的报告 JSON 请在证书详情中下载。
    generating: 'エクスポートファイルを作成しています（通常は数十秒）。このままお待ちください。', // 正在生成导出文件（通常几十秒），可以留在这里等待。
    timeout: 'エクスポートファイルはまだ完成していません。しばらくしてからもう一度お試しください。', // 导出文件还没有生成完，请稍后再试。
    download: '{format} をダウンロード', // 下载 {format}
    validFor: 'リンクの有効期限は 15 分です。', // 链接 15 分钟内有效。
  },
  visual: {
    steps: 'ステップ', // 步骤
    stepsValue: '{done}/{total}', // {done}/{total}
    conclusion: '結果', // 结论
    duration: '所要時間', // 用时
    evidence: '証拠の信頼度', // 证据可信度
    high: '高', // 高
    medium: '中', // 中
    low: '低', // 低
    built: 'このラボで構築した構成', // 这次实验搭建的构成
    details: '詳しく', // 详细说明
  },
} satisfies Dict<typeof zh>;
