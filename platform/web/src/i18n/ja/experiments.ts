/**
 * ja（日本語）：命名空间 experiments。由 `npm run i18n:sync` 按 zh-CN 词典维护结构：
 * 只填写引号内的译文（空字符串 = 未翻译，运行时按 ja → en → zh-CN 回退）；行尾注释是 zh-CN 原文。
 * 术语与风格见 ../glossary.md（不翻译 AWS 服务名、CLI 命令、代码、资源名、API 路径、环境变量）。
 */
import type { Dict } from '../dict';
import type zh from '../zh-CN/experiments';

export default {
  metrics: {
    'server.app.requests': 'オリジンが受けたリクエスト数', // 源站收到的请求数
    'server.origin.requests': 'Nginx 経由のオリジンリクエスト', // 经 Nginx 的源站请求
    'client.requests': 'クライアントのリクエスト数', // 客户端请求数
    'client.errors': 'クライアントのエラー数', // 客户端错误数
    'client.cdnHitRatio': 'CDN ヒット率', // CDN 命中率
    'client.hitRatio': 'ヒット率', // 命中率
  },
  pctLabel: {
    ttfb: '最初のバイトまでの時間', // 首字节时间
    latency: 'レイテンシ', // 延迟
    duration: '所要時間', // 耗时
  },
  pctMetric: '{name} {p}（ミリ秒）', // {name} {p}（毫秒）
  delta: {
    same: '有意な差はありません', // 差异不明显
    toZero: '▼ 0 になりました', // ▼ 变为 0
    down: '▼ 減少', // ▼ 下降
    up: '▲ 増加', // ▲ 上升
    faster: ' · 速くなりました', //  · 更快
    slower: ' · 遅くなりました', //  · 更慢
  },
  chart: {
    barsTitle: '棒グラフ比較：{labels} の各指標', // 条形对照：{labels} 的各项指标
    ladderTitle: 'パーセンタイル比較：{ps}、{labels}', // 分位阶梯：{ps}，{labels}
    and: ' と ', //  与 
    descItem: '{label}：{values}', // {label}：{values}
    itemSep: '、', // ，
    sep: '。', // ；
  },
  page: {
    noSession: 'このセッションはありません', // 没有这个会话
    title: '比較実験', // 对比实验
    reading: 'セッションを読み込んでいます', // 正在读取会话
    crumbs: 'パンくずリスト', // 面包屑
    mySessions: '実験履歴', // 我的实验
    heading: '{labId} › 比較実験 · {key}', // {labId} › 对比实验 · {key}
    required: '（必須）', // （必做）
    optional: '（任意）', // （选做）
    session: 'セッション {sid} · {state}', // 会话 {sid} · {state}
  },
  compare: {
    status: {
      none: '記録はまだありません', // 还没有记录
      running: '実行中または未アップロード', // 运行中或未上传
      simulated: '模擬ベースライン（別経路で補測）', // 模拟基线（旁路补测）
    },
    track: {
      registered: '登録済み', // 已登记
      uploaded: 'アップロード済み', // 已上传
      crosscheck: '照合中', // 交叉校验中
      invalid: '無効', // 无效
      simulated: '模擬ベースライン', // 模拟基线
      valid: '有効', // 有效
    },
    uploadProgress: 'アップロードの進捗', // 上传进度
    readingRuns: '実験の記録を読み込んでいます', // 正在读取实验记录
    notDeclaredTitle: 'このカードはこの実験を宣言していません。', // 这张卡片没有声明这个实验。
    notDeclared: '実験 {key} はこのカードの実験一覧にありません。リンクが誤っている可能性があります。', // 实验 {key} 不在本卡片的实验列表中，链接可能有误。
    runLabel: '{label} を実行', // 运行 {label}
    noRunsTitle: 'この実験はまだ実行されていません。', // 还没有运行这个实验。
    noRunsSingle: 'ワークベンチのターミナルで実行してください。結果は自動でアップロードされ、照合されます。', // 在工作台终端运行它，结果会自动上传并交叉校验。
    noRunsPair: 'まずワークベンチのターミナルで {a} を実行し、アプリへの組み込みが終わったら {b} を実行します。', // 先在工作台终端运行 {a}，再完成接入应用后运行 {b}。
    commandsHidden: '実行コマンドは非表示です（セッションが終了しているか、このロールではワークベンチのターミナルを使えません）。', // 运行命令已隐藏（会话已结束或你的角色不能使用工作台终端）。
    registeredAt: '{t} に登録', // 登记于 {t}
    crosscheckDelay: 'サーバー側の裏付けには数分の遅れがあります（CloudFront のメトリクスなど）。後で自動的に再確認します。', // 服务端佐证有数分钟延迟（例如 CloudFront 指标），稍后自动复核。
    uploadFailed: 'アップロードに失敗した可能性があります。ワークベンチのターミナルでランナーの出力を確認してください。', // 可能上传失败：请看工作台终端中运行器的输出。
    invalid: '無効：{reason}', // 无效：{reason}
    fromSession: 'セッション {sid} の記録{kind}', // 来自会话 {sid}{kind}
    handover: '（引き継ぎ元のセッション）', // （交接链中的会话）
    crossSession: '（セッションをまたいだ比較）', // （跨会话比较）
    runs: '記録 {n} 件', // 记录 {n} 次
    pickRun: '比較に使う {label} の記録を選択', // 选择 {label} 用于比较的记录
    notUploaded: '未アップロード', // 未上传
    sessionShort: ' · セッション {sid}…', //  · 会话 {sid}…
    latestValid: ' · 既定では最新の有効な記録を使います', //  · 默认使用最近一次有效记录
    functional: '機能確認型の実験', // 功能型实验
    functionalNote: '次のチェックが実験の時間枠内に合格すれば有効です：', // 以下检查在实验时间窗内通过即视为有效：
    metrics: '指標', // 指标
    metricsNote: 'サーバー側で補正した値です。クライアントとサーバーの差が 10% を超えると印を付けます', // 服务端校正后的值；客户端与服务端差异 > 10% 时标注
    caption: '{key} の指標比較', // {key} 的指标对照
    colMetric: '指標', // 指标
    colDelta: '差', // 差异
    clientServer: 'クライアント {client} · サーバー {server}', // 客户端 {client} · 服务端 {server}
    mismatch: 'クライアントとサーバーの集計が一致しません', // 客户端与服务端统计不一致
    valueLine: '{label}：{value}', // {label}：{value}
    deltaLine: '差：{delta}', // 差异：{delta}
    noMetrics: '選択した記録には比較できる指標がまだありません（アップロードまたは照合の完了後に表示されます）。', // 所选记录还没有可比较的指标（上传或交叉校验完成后显示）。
    charts: 'グラフ', // 图表
    chartsView: '棒グラフとパーセンタイル', // 条形对照与分位阶梯
    tableView: 'データ表を表示', // 查看数据表
    tableNote: 'データ表は上の指標表です（スクリーンリーダー向けの表示）。', // 数据表即上方的指标表（读屏视图）。
    directionNote: '差の向きは変化を示すだけで、良し悪しではありません。マネージドサービスを有効にすると 1 回あたりのレイテンシが増えるのも正しい結果になり得ます。赤と緑は使いません：{a} は中立のグレー、{b} は青磁色です。', // 差异方向只说明变化，不代表好坏：启用托管服务后单次延迟变高也可能是正确结论。不用红绿：{a} 中性灰，{b} 青瓷。
    others: 'その他', // 其余
    pair: 'ペア比較', // 成对比较
    pairLabel: '{a} ↔ {b}：', // {a} ↔ {b}：
    missing: '{label} がありません', // 缺少 {label}
    comparable: '比較可能', // 可比
    comparableNote: '（シナリオ、開始バリアント、インスタンスタイプが同じで、どちらも強制実行ではありません）', // （场景、起始变体、实例类型一致；都不是强制运行）
    notComparable: '比較不可', // 不可比
    reasons: '（{list}）', // （{list}）
    reasonSep: '、', // ；
    unknown: '現在は判定できません', // 暂时无法判断
    comparing: '比較しています…', // 正在比较…
    across: '次の項目をまたいだ比較を許可：{list}（インスタンスタイプをまたぐ比較は目立つように表示します）', // 允许跨维度比较：{list}（跨实例类型比较时显著标注）
    listSep: '、', // 、
    validity: '有効性の確認', // 有效性校验
    validityOf: '有効性の確認（{label}）', // 有效性校验（{label}）
    howToRun: '実行方法（ワークベンチのターミナルで）', // 怎么运行（在工作台终端）
    allValid: 'すべてのバリアントに有効な記録があります。', // 所有变体都已有有效记录。
    history: '履歴（このセッション）', // 历史记录（本会话）
    crossToggle: 'セッションをまたいで比較：2 列目で以前のセッションの同じ実験の記録を選びます', // 跨会话对比：在第二列选择之前会话的同一实验记录
    noOther: '以前のセッションにこの実験の記録はありません。', // 之前的会话没有这个实验的记录。
    noRun: '記録はまだありません。', // 还没有记录。
    validAll: '構造と完全性、登録、時間枠、ドライバー、サーバー側の裏付けがすべて合格', // 结构与完整性、登记、时间窗、驱动、服务端佐证均通过
    simulatedLow: '模擬ベースライン：証拠としての重みは低めです', // 模拟基线：证据权重较低
    crosscheckWait: 'サーバー側の裏付け：待機中（メトリクスは数分遅れます）', // 服务端佐证：等待中（指标有数分钟延迟）
    waitUpload: 'アップロード待ち', // 等待上传
    cloudshell: '節約モードでは比較実験の結果をアップロードできないため、関連するチェックは規則に従って格下げされます。', // 省钱模式下对比实验结果无法上传，相关检查只能按规则降级。
    ending: '実験は終了しました。終了前に登録された実行のアップロードは引き続き受け付けます。', // 实验已结束：进入结束前已登记的运行仍会接收上传。
    readOnly: '読み取り専用：このロールではワークベンチのターミナルを使えません。', // 只读：你的角色不能使用工作台终端。
  },
  visual: {
    details: 'グラフの読み方', // 怎么读这些图
  },
} satisfies Dict<typeof zh>;
