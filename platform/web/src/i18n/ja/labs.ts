/**
 * ja（日本語）：命名空间 labs。由 `npm run i18n:sync` 按 zh-CN 词典维护结构：
 * 只填写引号内的译文（空字符串 = 未翻译，运行时按 ja → en → zh-CN 回退）；行尾注释是 zh-CN 原文。
 * 术语与风格见 ../glossary.md（不翻译 AWS 服务名、CLI 命令、代码、资源名、API 路径、环境变量）。
 */
import type { Dict } from '../dict';
import type zh from '../zh-CN/labs';

export default {
  difficulty: {
    intro: '入門', // 入门
    beginner: '初級', // 初级
    intermediate: '中級', // 中级
    advanced: '上級', // 高级
  },
  domain: {
    secure: 'セキュリティ', // 安全
    resilient: '弾力性', // 弹性
    performance: '高性能', // 高性能
    cost: 'コスト最適化', // 成本
  },
  duration: {
    short: '1 時間以内', // ≤ 1 小时
    medium: '1～2 時間', // 1～2 小时
    long: '2 時間超', // > 2 小时
  },
  provision: {
    A: '速い', // 较快
    B: '普通', // 中等
    C: '遅め', // 较慢
    D: 'かなり遅い', // 很慢
  },
  provisionHint: {
    A: '速い（A）：開始状態は L0 とすぐに作成できるリソースだけです。所要時間（分）は表示しません。このプラットフォームの記録が十分にたまると、実際の所要時間を表示します。', // 较快（A）：起始状态只有 L0 与快速创建的资源。不写分钟数；本平台积累足够记录后会显示实际耗时。
    B: '普通（B）：開始状態に CloudFront ディストリビューション、ALB、Cognito ユーザープール、インスタンスの置き換えのうち 1～2 つを含みます。', // 中等（B）：起始状态含 CloudFront 分配、ALB、Cognito 用户池或实例替换中的一两项。
    C: '遅め（C）：開始状態に RDS または ElastiCache のどちらかを含みます。', // 较慢（C）：起始状态含 RDS 或 ElastiCache 之一。
    D: 'かなり遅い（D）：RDS / ElastiCache に加えて、ALB、別のデータベース、またはインスタンスの置き換えを含みます。', // 很慢（D）：RDS / ElastiCache 再叠加 ALB、另一个数据库或实例替换。
  },
  costTierHint: {
    low: '$ 低：ラボ用インスタンスとワークベンチ以外に時間課金のリソースはありません。具体的な金額は開始前に現在の料金で計算します。', // $ 低：除实验机与工作台外没有按小时计费的资源。具体金额在开始前按当前价格计算。
    medium: '$$ 中：時間課金のリソースが 1 つ追加されるか、アカウント単位の従量課金サービスを有効にします。具体的な金額は開始前に現在の料金で計算します。', // $$ 中：额外有 1 个按小时计费的资源，或会开启账号级按量服务。具体金额在开始前按当前价格计算。
    high: '$$$ 高：時間課金のリソースが 2 つ以上追加されます。具体的な金額は開始前に現在の料金で計算します。', // $$$ 高：额外有 2 个及以上按小时计费的资源。具体金额在开始前按当前价格计算。
  },
  flag: {
    'needs-advance': '事前準備が必要', // 需提前准备
    limited: '一部利用不可', // 部分不可用
    'needs-domain': 'ドメインが必要', // 需要域名
    'domain-optional': 'ドメインは任意', // 域名可选
    'needs-email': 'メール確認が必要', // 需要邮箱确认
    'account-impact': 'アカウント全体に影響', // 账号级影响
    'long-wait': '待ち時間が長い', // 等待较长
    beta: 'ベータ版', // 测试版
    'new-version': '新しいバージョンあり', // 有新版本
  },
  mastery: {
    not_started: '未着手', // 未开始
    touched: '着手済み', // 已接触
    mastered: '習得済み', // 已掌握
    proficient: '熟練', // 熟练
  },
  badgeLevel: {
    verified: '検証済み', // 已核验
    attested: '手動確認を含む', // 含手动
    'self-reported': '自己申告中心', // 自述为主
  },
  roleInTrack: {
    required: '必修', // 必修
    optional: '任意', // 可选
    group: '選択グループ', // 选修组成员
  },
  input: {
    domain: {
      label: 'ドメイン名', // 域名
      need: 'NS レコードを変更できるドメイン', // 一个可以修改 NS 记录的域名
      hint: '小文字で入力します（例：lab.example.com）。IP アドレスとワイルドカードは使えません', // 小写，例如 lab.example.com；不接受 IP 与通配符
    },
    'hosted-zone': {
      label: 'Route 53 ホストゾーン ID', // Route 53 托管区域 ID
      need: 'Route 53 ホストゾーン ID', // Route 53 托管区域 ID
      hint: 'Z0123456789ABC のような形式です', // 形如 Z0123456789ABC
    },
    'ses-identity': {
      label: 'SES 送信元 ID', // SES 发信身份
      need: '検証できるメールアドレスまたはドメイン', // 一个可以验证的邮箱或域名
      hint: 'メールアドレスまたはドメインです。今回のラボの ID 検証にだけ使います', // 邮箱或域名；只用于本次实验的身份验证
    },
    'notify-email': {
      label: '通知先メールアドレス', // 通知邮箱
      need: '受信できるメールアドレス', // 能收信的邮箱
      hint: '今回のラボのサブスクリプションと ID 検証にだけ使い、修了証や公開ページには載せません', // 只用于本次实验的订阅与身份验证，不写入证书与公开页面
    },
    'alert-email': {
      label: 'アラート用メールアドレス', // 告警邮箱
      need: '受信できるアラート用メールアドレス', // 能收信的告警邮箱
      hint: '今回のラボのサブスクリプションと ID 検証にだけ使い、修了証や公開ページには載せません', // 只用于本次实验的订阅与身份验证，不写入证书与公开页面
    },
    'recipient-emails': {
      label: '宛先メールアドレス（2 件まで、カンマ区切り）', // 收件人邮箱（最多 2 个，用逗号分隔）
      need: '受信できるメールアドレス 1～2 件', // 1～2 个能收信的邮箱
      hint: '今回のラボにだけ使い、修了証や公開ページには載せません', // 只用于本次实验，不写入证书与公开页面
    },
    'budget-amounts': {
      label: '予算額 2 つ（カンマ区切り）', // 两个预算金额（用逗号分隔）
      need: '予算額 2 つ', // 两个预算金额
      hint: '正の数で、小数点以下 2 桁までです。ご自身の許容範囲で決めてください。プラットフォームは参考値を示しません', // 正数，最多两位小数；由你按自己的承受能力填写，平台不给参考值
    },
    'cost-tags-active': {
      label: 'コスト配分タグ', // 成本分配标签
      need: 'コスト配分タグを 24～48 時間前に有効化', // 提前 24～48 小时激活成本分配标签
      hint: 'チェックすると、プラットフォーム操作「コスト配分タグを有効化」を実行して反映を待ったことを表します（公式ドキュメントを優先してください）', // 勾选表示已执行平台动作“激活成本分配标签”并等待生效（以官方文档为准）
    },
  },
  stepType: {
    observe: '観察', // 观察
    experiment: '比較実験', // 对比实验
    script: 'スクリプト', // 脚本
    cli: 'CLI', // 命令行
    console: 'コンソール', // 控制台
    read: '読む', // 阅读
    manual: '手動確認', // 手动确认
    'platform-action': 'プラットフォーム操作', // 平台动作
    wire: '組み込み', // 接入
  },
  ui: {
    catalog: {
      title: 'カード一覧', // 卡片目录
      sub: '{n} 枚 · サービスカード {svc} 枚 · シナリオカード {sc} 枚 · カタログ {v}', // {n} 张卡片 · {svc} 张单服务 · {sc} 张场景 · 目录 {v}
      searchPlaceholder: 'カード、サービス、出題範囲、Lab 番号で検索…', // 搜索卡片、服务、考点、Lab 编号…
      searchLabel: 'カードを検索（ショートカット /）', // 搜索卡片（快捷键 /）
      viewLabel: '表示', // 视图
      viewGrid: 'カード', // 卡片网格
      viewMap: 'サービスマップ', // 服务地图
      viewTracks: '学習パス', // 路径
      group: 'グループ', // 分组
      groupKind: '種類別', // 按类型
      groupCategory: 'サービス分類別', // 按服务类别
      groupDomain: '試験分野別', // 按考试领域
      groupNone: 'グループなし', // 不分组
      sort: '並べ替え', // 排序
      sortPath: 'おすすめ順', // 推荐顺序
      sortDuration: '所要時間', // 预计时长
      sortCost: 'コスト区分', // 费用档位
      sortRecent: '最近の挑戦', // 最近尝试
      filters: '絞り込み（{n}）', // 筛选（{n}）
      facetKind: '種類', // 类型
      facetDomain: '分野', // 领域
      facetDifficulty: '難易度', // 难度
      facetDuration: '所要時間', // 时长
      facetCost: 'コスト', // 费用
      facetStatus: '状況', // 状态
      facetService: 'サービス', // 服务
      kindService: 'サービス', // 单服务
      kindScenario: 'シナリオ', // 场景
      onlyPrimary: '主分野のみ', // 只看主领域
      noManual: '手動の事前準備が不要なもののみ', // 只看无需人工前置
      pickService: 'サービスを選択…', // 选择服务…
      removeService: 'サービス {name} を外す', // 移除服务 {name}
      shown: '{total} 枚中 {n} 枚を表示', // 显示 {n} / {total} 张
      shownAnnounce: '{total} 枚中 {n} 枚のカードを表示しています', // 显示 {n} / {total} 张卡片
      clear: '絞り込みを解除', // 清除筛选
      cleared: '絞り込みを解除しました。{total} 枚中 {total} 枚のカードを表示しています', // 已清除筛选，显示 {total} / {total} 张卡片
      emptyTitle: '条件に合うカードはありません', // 没有符合条件的卡片
      emptyNoManual: '「手動の事前準備が不要なもののみ」により、ドメイン・メール確認・事前準備が必要なカードが非表示になっています。', // 其中“只看无需人工前置”隐藏了需要域名、邮箱确认或提前准备的卡片。
      sectionCount: '{n} 枚 · 完了 {done} / {n}', // {n} 张 · 已完成 {done} / {n}
      sectionService: 'サービスカード · {cat}', // 单服务卡片 · {cat}
      sectionScenario: 'シナリオカード', // 场景卡片
      sectionAll: 'すべてのカード', // 全部卡片
      alsoDomain: '関連（副分野）', // 也涉及（次领域）
      costPrimaryOnlyHint: 'コスト最適化の出題範囲は複数のカードに分かれています。「主分野のみ」を外すと表示されます。', // 成本优化考点分布在多张卡片中，取消“只看主领域”查看。
      otherTracks: 'ほかの学習パス', // 其他学习路径
      shelfItem: '{counted}/{min} · {cert}', // {counted}/{min} · {cert}
      certEligible: '修了証を受け取れます', // 证书可领取
      certNotYet: '修了証は未達成', // 证书未达成
      certClaimed: '修了証は受け取り済み', // 证书已领取
      statusUnavailable: '状況を取得できません', // 状态暂不可用
      masteryUnavailable: '習熟度を取得できません', // 掌握度暂不可用
      retry: '再試行', // 重试
      statusFacetOff: '個人の状況を取得できないため、「状況」の絞り込みは一時的に使えません', // 个人状态暂不可用，“状态”筛选暂时不能使用
      skippedSetup: '初回設定をスキップしました。設定 › プラットフォーム からもう一度確認できます。', // 首次设置已跳过：可在 设置 › 平台 中重看。
      catalogError: 'カード一覧を読み込めません。', // 卡片目录暂时无法加载。
      notPublished: 'カード一覧はまだ公開されていません。', // 还没有发布卡片目录。
    },
    card: {
      kindService: 'サービス · {cat}', // 单服务 · {cat}
      kindScenario: 'シナリオ · サービス {n} 個', // 场景 · 包含 {n} 个服务
      legacy: '旧 Lab {n}', // 原 Lab {n}
      minutes: '約 {n} 分', // 约 {n} 分钟
      hours: '約 {n} 時間', // 约 {n} 小时
      limit: '上限 {t}', // 上限 {t}
      provision: '環境準備：{t}', // 环境准备：{t}
      attempts: '挑戦 {n} 回', // 尝试 {n} 次
      noAttempts: '未挑戦', // 尚未尝试
      badgeNone: '未獲得', // 未获得
      badgePending: '検証中', // 核验中
      badgeWithdrawn: '取り消し済み', // 已撤回
      backToWorkspace: 'ワークベンチに戻る', // 回到工作台
      viewProgress: '進行状況を見る', // 查看进度
      planned: '近日公開', // 即将推出
      plannedNote: 'このカードは作成中です。概要は読めますが、ラボはまだ開始できません。', // 这张卡片还在编写中：可以先看简介，暂时不能开始实验。
      deprecated: 'このカードは提供を終了しました', // 本卡片已停用
      newVersion: '新しいバージョンあり', // 有新版本
      services: 'サービス：{list}', // 服务：{list}
      scenarioOptional: '（任意 / 条件付きの対象）', // （选做 / 条件目标）
    },
    state: {
      preparing: '準備中', // 准备中
      running: '実行中 · 残り {t}', // 进行中 · 剩余 {t}
      ending: '終了処理中', // 正在结束
      cleaning: '解放中', // 正在释放
      kept: '環境を保持中 · {t} まで', // 环境保留中 · 至 {t}
      cleanupFailed: '解放が完了していません', // 释放未完成
      completed: '完了', // 已完成
      completedManual: '完了（手動確認を含む）', // 已完成（含手动）
      incomplete: '未完了', // 未完成
      notStarted: '未着手', // 未开始
    },
    env: {
      region: '現在の環境', // 当前环境
      elapsed: '経過 {t}', // 已用 {t}
      remaining: '残り {t}', // 剩余 {t}
      provision: '環境準備：{t}', // 环境准备：{t}
      hourly: '時間課金 {n} 件', // 按小时计费 {n} 项
      deleted: '削除済み {n}/{m}', // 已删除 {n}/{m}
      until: '{t} まで', // 至 {t}
      saveMode: '節約モード', // 节省模式
      toWorkspace: 'ワークベンチに戻る', // 回到工作台
      cancel: 'キャンセル…', // 取消…
      extend: '延長…', // 延长…
      end: 'ラボを終了…', // 结束实验…
      reclaim: '回収の進行状況を見る', // 查看回收进度
      manageKeep: '保持を管理', // 管理保留
      reuseNext: '次のカードで再利用', // 在下一张卡片中复用
      residual: '{what}に未解放のリソースが {n} 件あります{hourly}', // {what}有 {n} 项资源未释放{hourly}
      residualHourly: '（うち時間課金 {n} 件）', // ，其中 {n} 项按小时计费
      residualOf: '{labId}（{at} のラボ）', // {labId}（{at} 的实验）
      residualPrevious: '以前のラボ', // 之前的实验
      viewList: '一覧を見る', // 查看清单
      maintenance: 'プラットフォームはメンテナンス中のため、新しいラボを開始できません。', // 平台维护中，暂时不能开始新实验。
      uninstalling: 'プラットフォームをアンインストール中のため、新しいラボを開始できません。', // 平台正在卸载，暂时不能开始新实验。
      extendBlocked: '現在は延長できません', // 延长暂不可用
    },
    cont: {
      title: '学習を続ける', // 继续学习
      path: '{track} · {stage} · 必修 {done}/{total}', // {track} · {stage} · 必修 {done}/{total}
      pathNoStage: '{track} · 必修 {done}/{total}', // {track} · 必修 {done}/{total}
      recommend: 'おすすめ', // 推荐
      recommendAfter: '現在の環境の次におすすめ', // 当前环境之后推荐
      view: '見る →', // 查看 →
      newLearner: '{labId} から始める（{track}の 1 枚目）', // 从 {labId} 开始（{track}第 1 张）
      quickPath: '7 組の比較だけを見たい場合 → クイックパス', // 只想看七组点名对比？→ 快速路径
      done: '{track}のカードはすべて完了しました。修了証を受け取れます。', // {track}的卡片都已完成：可以领取证书。
      reuseHint: '↳ {labId} の保持環境で続けられます', // ↳ 可在 {labId} 的保留环境中继续
    },
    map: {
      legend: '凡例：', // 图例：
      legendLevel: '{level} {n} サービス', // {level} {n} 项服务
      legendTail: '· 破線枠 = 手動確認を含む · ! = 要復習 · * シナリオカードで加算するにはドメインが必要 · † シナリオカードなし', // · 虚线框 = 含手动 · ! = 需复习 · * 需要域名才能由场景卡计入 · † 没有场景卡
      help: 'スコアは進捗リングにだけ使い、レベルは規則に従って判定します。サービスをクリックするとサイドパネルが開きます。Tab でマップに入り、矢印キーで移動できます。', // 分数只用于进度环；等级文字按规则判定。点击服务格打开侧栏；Tab 进入地图后用方向键在格子之间移动。
      cellLabel: '{name}、{fn}、{level}、{score} 点', // {name}，{fn}，{level}，{score} 分
      needsReview: '要復習', // 需复习
      domainNote: 'シナリオカードで加算するにはドメインが必要', // 需要域名才能由场景卡计入
      noScenario: 'シナリオカードなし', // 没有场景卡
      single: 'サービスカード {mark} · シナリオ {done}/{total}', // 单服务 {mark} · 场景 {done}/{total}
      panelMastery: '習熟度', // 掌握度
      panelScore: '{score} / 100', // {score} / 100
      panelSvcCard: 'サービスカード', // 单服务卡
      panelCredited: 'このサービスに加算されるシナリオカード', // 计入本服务的场景卡
      panelNoScenario: 'シナリオカードはありません（「熟練」はサービスカードと小テストで判定します）', // 没有场景卡（“熟练”按单服务卡 + 小测判定）
      panelAppears: 'ほかの登場カード（加算なし）', // 也出现在（不计入）
      panelTracks: '含まれる学習パス', // 所在路径
      panelTopics: '出題範囲', // 考点
      panelFeatures: '関連サービス', // 附属服务
      panelReview: '! 要復習：その後のラボでこのサービスの設定ドリフトが見つかりました', // ! 需复习：在之后的实验中发现了本服务的配置漂移
      panelQuiz: '小テスト {r}', // 小测 {r}
      summary: 'サービスの習熟度（{n}）· 熟練 {pro} · 習得済み {m} · 着手済み {t} · 未着手 {none} · 要復習 {review}', // 服务掌握度（{n}）· 熟练 {pro} · 已掌握 {m} · 已接触 {t} · 未开始 {none} · 需复习 {review}
      rowLabel: '{cat}', // {cat}
      labelSep: '、', // ，
      legendSvc: 'サービスカード', // 单服务卡
      legendSc: 'シナリオカード', // 场景卡
      panelSvcCardLine: '{label}：', // {label}：
    },
    track: {
      pick: '学習パス', // 路径
      detail: '学習パスの詳細と修了証 →', // 路径详情与证书 →
      head: '必修 {done}/{total}', // 必修 {done}/{total}
      groups: ' · 選択グループ {done}/{total}', //  · 选修组 {done}/{total}
      verified: ' · 検証済み {pct}（{min} 以上が必要）', //  · 已核验 {pct}（需 ≥ {min}）
      counted: ' · 加算 {n}/{min}', //  · 计入 {n}/{min}
      cert: '修了証：', // 证书：
      current: '現在の学習パス', // 当前路径
      setCurrent: '現在の学習パスにする', // 设为当前路径
      setCurrentDone: '現在の学習パスにしました：{name}', // 已设为当前路径：{name}
      hours: '{who} · 必修 約 {req} 時間 · 全体 約 {all} 時間（環境準備を除く）', // {who} · 必修约 {req} 小时 · 全部约 {all} 小时（不含环境准备）
      stageCount: '{done}/{total}', // {done}/{total}
      stageLegacy: '旧 Lab {n}', // 原 Lab {n}
      groupLabel: '選択グループ：{pick} 枚を選択、完了 {done} 枚', // 选修组：选 {pick} 张，已完成 {done} 张
      groupText: '◇ {title}：{pick} 枚を選択', // ◇ {title}：选 {pick} 张
      groupDone: ' · 達成', //  · 已满足
      recommended: 'おすすめ', // 推荐
      reuseFrom: '↳ {labId} の保持環境で続けられます', // ↳ 可在 {labId} 的保留环境中继续
      segLabel: '検証済み {a} 枚、手動確認を含む {m} 枚、進行中 {p} 枚。最低 {min} 枚の完了が必要です', // 已核验 {a} 张、含手动 {m} 张、进行中 {p} 张，最少完成 {min} 张
      certTitle: '修了証：{title}', // 证书：{title}
      certAside: 'セルフホストのプラットフォームが発行します。AWS の公式認定ではありません', // 由自托管平台签发，不是 AWS 官方认证
      condition: '条件', // 条件
      status: '状況', // 状态
      condRequired: 'すべての必修カードに有効なバッジがある', // 必修卡片全部有有效徽章
      condGroups: '各選択グループで {pick} 枚以上', // 每个选修组至少 {pick} 张
      condGroupsNone: '—（この学習パスに選択グループはありません）', // —（本路径没有选修组）
      condGroupsMissing: '（{list} のグループが未達成）', // （{list} 的组未完成）
      condRatio: '「検証済み」バッジの割合が {min} 以上（「自己申告中心」は数えません）', // “已核验”徽章占比 ≥ {min}（“自述为主”不计入）
      condDefect: '加算される挑戦がすべて「不具合あり」のコンテンツバージョンではない', // 计入的尝试都不在“有缺陷”的内容版本中
      condPending: '検証中のバッジ（比較実験のクロス検証待ち）', // 核验中的徽章（等待对比实验交叉核验）
      none: 'なし', // 无
      yes: 'はい', // 是
      no: 'いいえ', // 否
      claim: '修了証を受け取る', // 领取证书
      claimBlocked: '条件を満たしていません：{list}。サーバーが返す理由を優先します。', // 条件未满足：{list}。以服务端返回的原因为准。
      reasonRequired: '必修があと {n} 枚', // 还差必修 {n} 张
      reasonGroups: '選択グループ {n} 個', // 选修组 {n} 个
      reasonRatio: '検証済みの割合が不足', // 已核验占比不足
      reasonPending: '検証中のバッジがあります', // 有徽章仍在核验中
      reasonDefect: '「不具合あり」のコンテンツバージョンでの挑戦があります', // 有尝试在“有缺陷”的内容版本中
      reasonDisabled: 'この学習パスは修了証を発行しません', // 本路径不签发证书
      stages: 'ステージとカード', // 阶段与卡片
      history: '過去の修了証', // 历史证书
      historyNone: 'この学習パスの修了証はまだ発行されていません。', // 还没有签发过本路径的证书。
      historyRow: '{id} · {status}', // {id} · {status}
      certDetail: '修了証の詳細 →', // 证书详情 →
      currentCert: '現在の修了証：{id}', // 当前证书：{id}
      notFoundTitle: 'この学習パスはありません', // 没有这条学习路径
      notFound: 'この学習パス（{id}）はありません。', // 没有这条学习路径（{id}）。
      eligibleTag: '受け取り可能', // 可领取
      notYetTag: '未達成', // 未达成
      claimedTag: '受け取り済み', // 已领取
      revokedTag: '失効済み', // 已吊销
    },
    visual: {
      more: '詳しく', // 详细
      ringCounted: '加算されたカード', // 计入的卡片
    },
    claim: {
      title: '受け取り：{cert}', // 领取：{cert}
      name: '修了証に表示する名前（既定はプロフィールの修了証用氏名）', // 证书上显示的名字（默认取个人资料中的证书署名）
      public: '修了証ファイルを公開する：誰でも検証リンクから直接検証できます。公開しない場合は、あなたが渡したファイルやリンクでのみ検証できます', // 公开证书文件：任何人可以通过验证链接直接验证；不公开时只能用你提供的文件或链接验证
      records: '修了証に記録される内容：学習パスとバージョン、加算されたカードとバッジのレベル、「検証済み」の割合、各カードのレポートの要約。', // 证书会记录：路径与版本、计入的卡片与徽章等级、“已核验”占比、每张卡片的报告摘要。
      notRecords: '記録されない内容：メールアドレス、AWS アカウント ID、小テストの成績。', // 不会记录：你的邮箱、AWS 账号 ID、小测成绩。
      nature: '同じ学習パスで有効な修了証は 1 枚だけです。あとで成績が上がったら受け取り直すことができ、古い修了証は自動的に失効します。この証明はあなたのセルフホスト ATL インスタンスが発行するもので、AWS の公式認定ではありません。', // 同一路径只保留一张有效证书；以后成绩提高可以重新领取，旧证书会自动吊销。本证明由你的自托管 ATL 实例签发，不是 AWS 官方认证。
      submit: '修了証を発行', // 签发证书
      busy: '発行しています…', // 正在签发…
      notEligible: 'まだ受け取りの条件を満たしていません：{list}', // 还不满足领取条件：{list}
      done: '修了証を発行しました：{id}', // 证书已签发：{id}
    },
  },
  section: {
    scenario: 'シナリオ', // 场景
    constraints: '制約', // 约束
    antiPatterns: 'よくある誤った案', // 常见的错误方案
    background: '背景', // 背景
    why: 'しくみ', // 原理
    objectives: '学べること', // 你将学到
    resources: 'ラボのリソース', // 实验资源
    cost: '費用の目安', // 预计费用
    steps: 'ステップの概要', // 步骤概览
    experiments: '比較実験の予告', // 对比实验预告
    topics: '出題範囲', // 考点
    confusables: '混同しやすい点', // 易混
    prereq: '開始前の準備', // 开始前准备
    timing: '時間と終了', // 时间与结束
    costShort: '費用', // 费用
    badge: 'バッジ', // 徽章
    tracks: '含まれる学習パス', // 所属路径
    reuse: '再利用できる保持環境', // 可复用的保留环境
    attempts: 'これまでの挑戦', // 历次尝试
  },
} satisfies Dict<typeof zh>;
