/**
 * en（English）：命名空间 experiments。由 `npm run i18n:sync` 按 zh-CN 词典维护结构：
 * 只填写引号内的译文（空字符串 = 未翻译，运行时按 en → en → zh-CN 回退）；行尾注释是 zh-CN 原文。
 * 术语与风格见 ../glossary.md（不翻译 AWS 服务名、CLI 命令、代码、资源名、API 路径、环境变量）。
 */
import type { Dict } from '../dict';
import type zh from '../zh-CN/experiments';

export default {
  metrics: {
    'server.app.requests': 'Requests received by the origin', // 源站收到的请求数
    'server.origin.requests': 'Origin requests via Nginx', // 经 Nginx 的源站请求
    'client.requests': 'Client requests', // 客户端请求数
    'client.errors': 'Client errors', // 客户端错误数
    'client.cdnHitRatio': 'CDN hit ratio', // CDN 命中率
    'client.hitRatio': 'Hit ratio', // 命中率
  },
  pctLabel: {
    ttfb: 'Time to first byte', // 首字节时间
    latency: 'Latency', // 延迟
    duration: 'Duration', // 耗时
  },
  pctMetric: '{name} {p} (ms)', // {name} {p}（毫秒）
  delta: {
    same: 'No clear difference', // 差异不明显
    toZero: '▼ Down to 0', // ▼ 变为 0
    down: '▼ Down', // ▼ 下降
    up: '▲ Up', // ▲ 上升
    faster: ' · faster', //  · 更快
    slower: ' · slower', //  · 更慢
  },
  chart: {
    barsTitle: 'Bar comparison: metrics for {labels}', // 条形对照：{labels} 的各项指标
    ladderTitle: 'Percentile ladder: {ps}, {labels}', // 分位阶梯：{ps}，{labels}
    and: ' and ', //  与 
    descItem: '{label}: {values}', // {label}：{values}
    itemSep: ', ', // ，
    sep: '; ', // ；
  },
  page: {
    noSession: 'Session not found', // 没有这个会话
    title: 'Comparison experiment', // 对比实验
    reading: 'Loading the session', // 正在读取会话
    crumbs: 'Breadcrumb', // 面包屑
    mySessions: 'My labs', // 我的实验
    heading: '{labId} › Comparison experiment · {key}', // {labId} › 对比实验 · {key}
    required: ' (required)', // （必做）
    optional: ' (optional)', // （选做）
    session: 'Session {sid} · {state}', // 会话 {sid} · {state}
  },
  compare: {
    status: {
      none: 'No runs yet', // 还没有记录
      running: 'Running or not uploaded', // 运行中或未上传
      simulated: 'Simulated baseline (measured out of band)', // 模拟基线（旁路补测）
    },
    track: {
      registered: 'Registered', // 已登记
      uploaded: 'Uploaded', // 已上传
      crosscheck: 'Cross-checking', // 交叉校验中
      invalid: 'Invalid', // 无效
      simulated: 'Simulated baseline', // 模拟基线
      valid: 'Valid', // 有效
    },
    uploadProgress: 'Upload progress', // 上传进度
    readingRuns: 'Loading experiment runs', // 正在读取实验记录
    notDeclaredTitle: 'This card does not declare this experiment.', // 这张卡片没有声明这个实验。
    notDeclared: 'Experiment {key} is not in this card’s list of experiments. The link may be wrong.', // 实验 {key} 不在本卡片的实验列表中，链接可能有误。
    runLabel: 'Run {label}', // 运行 {label}
    noRunsTitle: 'This experiment has not been run yet.', // 还没有运行这个实验。
    noRunsSingle: 'Run it in the workbench terminal. The results are uploaded and cross-checked automatically.', // 在工作台终端运行它，结果会自动上传并交叉校验。
    noRunsPair: 'First run {a} in the workbench terminal, then run {b} after you have wired the service into the app.', // 先在工作台终端运行 {a}，再完成接入应用后运行 {b}。
    commandsHidden: 'Run commands are hidden (the session has ended, or your role cannot use the workbench terminal).', // 运行命令已隐藏（会话已结束或你的角色不能使用工作台终端）。
    registeredAt: 'Registered {t}', // 登记于 {t}
    crosscheckDelay: 'Server-side corroboration lags by a few minutes (for example CloudFront metrics). It is rechecked automatically.', // 服务端佐证有数分钟延迟（例如 CloudFront 指标），稍后自动复核。
    uploadFailed: 'The upload may have failed. Check the runner output in the workbench terminal.', // 可能上传失败：请看工作台终端中运行器的输出。
    invalid: 'Invalid: {reason}', // 无效：{reason}
    fromSession: 'From session {sid}{kind}', // 来自会话 {sid}{kind}
    handover: ' (earlier session in the hand-over chain)', // （交接链中的会话）
    crossSession: ' (cross-session comparison)', // （跨会话比较）
    runs: '{n, plural, one {# run} other {# runs}}', // 记录 {n} 次
    pickRun: 'Choose the {label} run to compare', // 选择 {label} 用于比较的记录
    notUploaded: 'Not uploaded', // 未上传
    sessionShort: ' · session {sid}…', //  · 会话 {sid}…
    latestValid: ' · the latest valid run is used by default', //  · 默认使用最近一次有效记录
    functional: 'Functional experiment', // 功能型实验
    functionalNote: 'Valid when these checks pass within the experiment’s time window:', // 以下检查在实验时间窗内通过即视为有效：
    metrics: 'Metrics', // 指标
    metricsNote: 'Server-corrected values; flagged when client and server differ by more than 10%', // 服务端校正后的值；客户端与服务端差异 > 10% 时标注
    caption: 'Metrics for {key}', // {key} 的指标对照
    colMetric: 'Metric', // 指标
    colDelta: 'Difference', // 差异
    clientServer: 'Client {client} · server {server}', // 客户端 {client} · 服务端 {server}
    mismatch: 'Client and server counts disagree', // 客户端与服务端统计不一致
    valueLine: '{label}: {value}', // {label}：{value}
    deltaLine: 'Difference: {delta}', // 差异：{delta}
    noMetrics: 'The selected runs have no comparable metrics yet (they appear after the upload or cross-check finishes).', // 所选记录还没有可比较的指标（上传或交叉校验完成后显示）。
    charts: 'Charts', // 图表
    chartsView: 'Bars and percentiles', // 条形对照与分位阶梯
    tableView: 'Show data table', // 查看数据表
    tableNote: 'The data table is the metrics table above (screen reader view).', // 数据表即上方的指标表（读屏视图）。
    directionNote: 'The direction of a difference shows change, not better or worse: a higher single-request latency after enabling a managed service can be the correct result. No red or green: {a} is neutral grey, {b} is celadon.', // 差异方向只说明变化，不代表好坏：启用托管服务后单次延迟变高也可能是正确结论。不用红绿：{a} 中性灰，{b} 青瓷。
    others: 'others', // 其余
    pair: 'Pair comparison', // 成对比较
    pairLabel: '{a} ↔ {b}: ', // {a} ↔ {b}：
    missing: '{label} missing', // 缺少 {label}
    comparable: 'Comparable', // 可比
    comparableNote: ' (same scenario, start variant and instance type; neither run was forced)', // （场景、起始变体、实例类型一致；都不是强制运行）
    notComparable: 'Not comparable', // 不可比
    reasons: ' ({list})', // （{list}）
    reasonSep: '; ', // ；
    unknown: 'Cannot tell right now', // 暂时无法判断
    comparing: 'Comparing…', // 正在比较…
    across: 'Comparison allowed across: {list} (comparisons across instance types are clearly marked)', // 允许跨维度比较：{list}（跨实例类型比较时显著标注）
    listSep: ', ', // 、
    validity: 'Validity checks', // 有效性校验
    validityOf: 'Validity checks ({label})', // 有效性校验（{label}）
    howToRun: 'How to run (in the workbench terminal)', // 怎么运行（在工作台终端）
    allValid: 'Every variant has a valid run.', // 所有变体都已有有效记录。
    history: 'History (this session)', // 历史记录（本会话）
    crossToggle: 'Compare across sessions: pick a run of the same experiment from an earlier session in the second column', // 跨会话对比：在第二列选择之前会话的同一实验记录
    noOther: 'Earlier sessions have no runs of this experiment.', // 之前的会话没有这个实验的记录。
    noRun: 'No runs yet.', // 还没有记录。
    validAll: 'Structure and integrity, registration, time window, driver and server-side corroboration all pass', // 结构与完整性、登记、时间窗、驱动、服务端佐证均通过
    simulatedLow: 'Simulated baseline: lower evidence weight', // 模拟基线：证据权重较低
    crosscheckWait: 'Server-side corroboration: waiting (metrics lag by a few minutes)', // 服务端佐证：等待中（指标有数分钟延迟）
    waitUpload: 'Waiting for upload', // 等待上传
    cloudshell: 'In saving mode the experiment results cannot be uploaded, so the related checks are downgraded by rule.', // 省钱模式下对比实验结果无法上传，相关检查只能按规则降级。
    ending: 'The lab has ended. Runs registered before it ended can still upload.', // 实验已结束：进入结束前已登记的运行仍会接收上传。
    readOnly: 'Read-only: your role cannot use the workbench terminal.', // 只读：你的角色不能使用工作台终端。
  },
  visual: {
    details: 'How to read these charts', // 怎么读这些图
  },
} satisfies Dict<typeof zh>;
