/**
 * ja（日本語）：命名空间 ui。由 `npm run i18n:sync` 按 zh-CN 词典维护结构：
 * 只填写引号内的译文（空字符串 = 未翻译，运行时按 ja → en → zh-CN 回退）；行尾注释是 zh-CN 原文。
 * 术语与风格见 ../glossary.md（不翻译 AWS 服务名、CLI 命令、代码、资源名、API 路径、环境变量）。
 */
import type { Dict } from '../dict';
import type zh from '../zh-CN/ui';

export default {
  semantics: {
    sessionState: {
      REQUESTED: '検証中', // 正在校验
      PROVISIONING: '環境を準備中', // 正在准备环境
      READY: '環境の準備完了', // 环境已就绪
      RUNNING: 'ラボ実行中', // 实验中
      EXPIRING: 'まもなく期限', // 即将到期
      OVERDUE: '期限切れ · 終了処理中', // 已到期 · 正在结束
      ENDING: '終了処理中', // 正在结束
      CLEANING: 'リソースを解放中', // 正在释放资源
      KEPT: '環境を保持中', // 环境保留中
      ENDED: '終了', // 已结束
      FAILED: '起動失敗', // 启动失败
      CLEANUP_FAILED: '解放未完了', // 释放未完成
    },
    checkResult: {
      not_run: '未チェック', // 未检测
      queued: '待機中', // 排队中
      running: '確認中', // 核验中
      pass: '合格', // 通过
      fail: '不合格', // 未通过
      pending: '待機中', // 等待中
      error: 'チェッカーのエラー', // 检测器出错
      unavailable: 'チェック不可', // 无法检测
      skipped: '対象外', // 不适用
      needs_manual: '手動確認待ち', // 待手动确认
      manual: '手動確認済み', // 已手动确认
      manual_evidence: '手動確認済み（証拠あり）', // 已手动确认（带证据）
    },
    source: {
      LOCAL: 'ローカル', // 本地
      PROBE: 'プローブ', // 探针
      AWS: 'AWS', // AWS
      EXP: '実験', // 实验
      MANUAL: '手動', // 手动
    },
    stepState: {
      locked: 'ロック中', // 未解锁
      available: '開始可能', // 可开始
      verifying: '確認中', // 核验中
      failed: '不合格', // 未通过
      error: 'チェッカーのエラー', // 检测器出错
      needs_manual: '手動確認待ち', // 待手动确认
      done: '達成', // 已达成
      done_manual: '達成（手動確認を含む）', // 已达成（含手动）
      drifted: 'ドリフト', // 漂移
      skipped: 'スキップ済み', // 已跳过
    },
    attemptStatus: {
      active: '実行中', // 进行中
      verifying: '最終確認中', // 最终复核中
      completed: '完了（すべて自動）', // 已完成（全自动）
      completed_manual: '完了（手動確認を含む）', // 已完成（含手动）
      incomplete: '未完了', // 未完成
      unverified: '確認できませんでした', // 未能核验
      void: '算入しない', // 不计入
    },
    cleanupState: {
      TRACKED: '追跡中', // 跟踪中
      DELETING: '削除中', // 删除中
      DELETED: '削除済み', // 已删除
      RETAINED: '保持', // 保留
      REVIEW: '要確認', // 需复核
      MANUAL_REQUIRED: '要対応', // 需人工处理
      RESOLVED_BY_LEARNER: '対応済み', // 你已处理
      FAILED: '失敗', // 失败
    },
    severity: {
      BLOCKING: 'ブロック', // 阻塞
      REVIEW: '要確認', // 需复核
      INFO: '情報', // 信息
    },
    validity: {
      valid: '有効', // 有效
      simulated: '模擬ベースライン', // 模拟基线
      'pending-crosscheck': '照合中', // 交叉校验中
      invalid: '無効', // 无效
    },
    budget: {
      OK: '正常', // 正常
      WARN: '上限に近い', // 接近
      EXCEEDED: '超過', // 超限
    },
    costTier: {
      low: '低', // 低
      medium: '中', // 中
      high: '高', // 高
    },
    manualSub: {
      native: 'ネイティブ', // 原生
      degraded: '格下げ', // 降级
      evidence: '証拠あり', // 带证据
    },
    billing: {
      hourly: '時間課金', // 按小时
      storage: 'ストレージ量課金', // 按存储量
      monthly: '月額', // 按月
      usage: '使用量課金', // 按用量
      none: '課金なし', // 不计费
    },
    urgencyAnnounce: {
      U1: 'ラボの残り時間は 15 分です', // 实验剩余 15 分钟
      U2: 'ラボの残り時間は 5 分です', // 实验剩余 5 分钟
      U3: 'ラボの残り時間は 1 分です', // 实验剩余 1 分钟
      U4: 'ラボの時間が終了しました。終了処理をしています', // 实验时间已到，正在结束
    },
    checkResultSpecial: {
      ownershipPending: '帰属を確認中', // 归属确认中
      expectedOutage: '予定された中断', // 预期中断
    },
  },
  command: {
    runsOn: {
      workstation: 'ワークベンチ', // 工作台
      ops: 'ワークベンチ', // 工作台
      cloudshell: 'CloudShell', // CloudShell
      lab: 'ラボ用インスタンス', // 实验机
      ec2: 'ラボ用インスタンス', // 实验机
      local: 'この端末', // 本机
      browser: 'ブラウザー', // 浏览器
    },
    target: {
      workstation: 'ワークベンチ', // 工作台
      lab: 'ラボ用インスタンス', // 实验机
    },
    copied: 'コピーしました', // 已复制
    selected: 'コマンドを選択しました。Ctrl+C でコピーしてください', // 已选中命令，按 Ctrl+C 复制
    useTextarea: 'テキストボックスで Ctrl+C を押してコピーしてください', // 请在文本框中按 Ctrl+C 复制
    unresolved: '未入力の変数が {n} 個あります', // 有 {n} 个变量未填写
    hasSecret: 'コマンドに秘密情報のプレースホルダーが含まれるため、貼り付けできません', // 命令含密钥占位，不能粘贴
    tooLarge: 'コマンドが 16KB を超えるため、コピーのみ可能です', // 命令超过 16KB，只能复制
    unfilled: '未入力：{name}', // 未填写：{name}
    runsOnLabel: '実行場所：{where}', // 运行于：{where}
    observe: ' · 観察用。結果には算入されません', //  · 观察用，不计入结果
    masked: ' · 表示はマスク済み。コピーすると完全なコマンドになります', //  · 显示已打码，复制为完整命令
    danger: 'リソースを削除または停止します', // 会删除或停用资源
    copyLabel: 'コマンドをコピー：{line}', // 复制命令：{line}
    copyLabelUnresolved: 'コマンドをコピー：{line}（未入力の変数あり）', // 复制命令：{line}（有未填写的变量）
    copy: 'コピー', // 复制
    copyWarn: 'コピー (!)', // 复制 (!)
    pasteLabel: '{target}のターミナルに貼り付け', // 粘贴到{target}终端
    pasteTo: '{target}に貼り付け', // 粘贴到 {target}
    morePaste: 'その他の貼り付け方法', // 更多粘贴方式
    pasteNewTab: '新しいターミナルのサブタブに貼り付け', // 在新的终端子标签中粘贴
    pasteExecute: '貼り付けて実行', // 粘贴并执行
    selectedNote: 'コマンドを選択しました。Ctrl+C でコピーしてください。', // 已选中命令，按 Ctrl+C 复制。
    rawLabel: 'コマンドの原文（Ctrl+C でコピー）', // 命令原文（按 Ctrl+C 复制）
    dangerTitle: '危険なコマンドをコピー', // 复制危险命令
    cancel: 'キャンセル', // 取消
    dangerConfirm: '理解しました。コピーする', // 我了解，复制
    dangerNote: 'このコマンドはリソースを削除または停止し、元に戻せません。確認後にクリップボードへコピーします。', // 这条命令会删除或停用资源，影响无法撤销。确认后才会复制到剪贴板。
  },
  resource: {
    verifying: '確認中', // 核对中
    reason: '理由：{v} · ', // 原因：{v} · 
    source: '検出元：{v} · ', // 来源：{v} · 
    creator: '作成したセッション名 {name} · ', // 创建者会话名 {name} · 
    attempts: '{n} 回試行済み', // 已尝试 {n} 次
    lastAttempt: ' · 最終試行 {t}', //  · 最后尝试 {t}
    console: 'コンソール', // 控制台
    openConsole: 'AWS コンソールで開く', // 在 AWS 控制台中打开
    ownLogin: '（ご自身の AWS ログインで開きます。プラットフォームは新しいフェデレーションログインを発行しません）', // （以你自己的 AWS 登录打开，平台不签发新的联合登录）
    cleanupCommand: '{type} のクリーンアップコマンド', // {type} 的清理命令
    verifyingBusy: '確認しています…', // 正在核对…
    resolveLabel: '{name} は対応済み、再確認', // 我已处理 {name}，重新核对
    resolve: '対応済み、再確認', // 我已处理，重新核对
    retryLabel: '{name} の回収を再試行', // 重试回收 {name}
    retry: '回収を再試行', // 重试回收
  },
  check: {
    sourceTitle: '判定元：{source}', // 判定来源：{source}
    sourceTitleSub: '判定元：{source}（{sub}）', // 判定来源：{source}（{sub}）
    trustMedium: '·信頼度 中', // ·中可信
    trustLow: '·信頼度 低', // ·低可信
    stale: '·期限切れ', // ·过期
    withReason: '（{reason}）', // （{reason}）
    manual: '手動', // 手动
    auto: '自動', // 自动
    reviewPending: 'アシスタントの確認待ち', // 等待助教复核
    reviewApproved: 'アシスタントが確認済み', // 助教已复核
    reviewRejected: 'アシスタントが差し戻し', // 助教已打回
    srResult: '、{text}', // ，{text}
  },
  countdown: {
    notStarted: 'カウントダウンは未開始', // 倒计时未开始
    keepUntil: '{t} まで（残り {left}）', // 至 {t}（剩余 {left}）
    overdue: '期限切れ · 終了処理中', // 已到期 · 正在结束
    expiresAt: '{t} に期限切れ（ローカル時刻）', // {t} 到期（本地时间）
    serverTime: 'サーバー時刻で計算', // 按服务器时间计算
  },
  costTier: {
    label: 'コスト区分{tier}', // 费用档位{tier}
    optional: '（任意 → {tier}）', // （选做 → {tier}）
    sources: '主な課金元：{list}。', // 主要计费来源：{list}。
    tip: '具体的な金額は開始前に現在の価格で計算します。', // 具体金额在开始前按当前价格计算。
  },
  button: {
    busy: '処理しています…', // 正在处理…
  },
} satisfies Dict<typeof zh>;
