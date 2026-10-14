/**
 * ja（日本語）：命名空间 learning。由 `npm run i18n:sync` 按 zh-CN 词典维护结构：
 * 只填写引号内的译文（空字符串 = 未翻译，运行时按 ja → en → zh-CN 回退）；行尾注释是 zh-CN 原文。
 * 术语与风格见 ../glossary.md（不翻译 AWS 服务名、CLI 命令、代码、资源名、API 路径、环境变量）。
 */
import type { Dict } from '../dict';
import type zh from '../zh-CN/learning';

export default {
  title: '学習状況', // 我的学习
  subject: '受講者 {name} の学習状況', // 学员 {name} 的学习进度
  subjectAnon: '受講者の学習状況', // 学员的学习进度
  tabSelect: 'タブを切り替え', // 切换页签
  tabs: {
    tracks: '学習パスの進捗', // 路径进度
    mastery: 'サービスの習熟度', // 服务掌握度
    badges: 'バッジ一覧', // 徽章墙
    history: '最近のラボ', // 最近实验
  },
  tracks: {
    currentSuffix: '（現在）', // （当前）
    cert: '修了証：', // 证书：
    revokedNote: '（根拠の証拠が無効と判断されました。関連するカードをやり直すと再度受け取れます）', // （依据的证据被判无效，可以重做相关卡片后重新领取）
    pending: '検証中 {n} 枚：{list}（クロス検証の完了後に加算されます）', // 核验中 {n} 张：{list}（等交叉核验结束后计入）
    next: '次のおすすめ：', // 推荐下一张：
    view: '学習パスを見る', // 查看路径
  },
  mastery: {
    title: 'サービスの習熟度', // 服务掌握度
  },
  badges: {
    title: 'カードのバッジ · {n} / {total}', // 卡片徽章 · {n} / {total}
    onlyEarned: '獲得済みのみ', // 只看已获得
    level: 'レベル', // 等级
    levelAll: 'すべてのレベルと状態', // 全部等级与状态
    empty: '最初のカードを完了するとバッジを獲得できます。', // 完成第一张卡片即获得徽章。
    emptyAction: 'svc-ec2 から始める →', // 从 svc-ec2 开始 →
    drawerTitle: 'バッジ · {title}', // 徽章 · {title}
    evidence: '証拠スコア', // 证据分
    earnedAt: '獲得日時', // 获得时间
    attempt: '根拠となった挑戦', // 依据的尝试
    report: 'レポートを見る', // 查看报告
    variant: '開始方法', // 起始方式
    version: 'コンテンツのバージョン', // 内容版本
    quiz: '小テストの最高成績', // 小测最好成绩
    quizBest: '{s}%（記録のみ）', // {s}%（只记录）
    quizNone: '未解答', // 尚未作答
    credits: '加算されるサービス', // 计入的服务格
    notEarned: '未獲得です。このカードを完了する（最終確認に合格する）とバッジを獲得します。小テストの成績は記録されるだけです。', // 未获得。完成本卡片（最终复核通过）即获得徽章；小测成绩只记录。
    openCard: 'カードを開く', // 打开卡片
  },
  visual: {
    trackRing: '{track}：加算されたカード / 最低完了数', // {track}：计入的卡片 / 最少完成
    masteryRing: '習得済み以上のサービス', // 已掌握及以上的服务
    masteryChart: 'レベル別のサービス数（全 {n} 個）', // 各等级的服务数（共 {n} 个）
    masteryTitleN: '{title}（{n}）', // {title}（{n}）
    level: 'レベル', // 等级
    services: 'サービス数', // 服务数
    badgesRing: '獲得したバッジ', // 已获得的徽章
  },
  history: {
    start: '開始日時', // 开始时间
    card: 'カード', // 卡片
    state: '状態', // 状态
    duration: '所要時間', // 用时
    cleanup: 'クリーンアップ', // 清理
    report: 'レポート', // 报告
    cleanupFailed: '解放が完了していません', // 释放未完成
    cleanupPending: '{n} 件が対応待ち', // {n} 项待处理
    cleanupRunning: '進行中', // 进行中
    cleanupKept: '保持中', // 保留中
    cleanupDone: '解放済み', // 已释放
    empty: 'ラボの記録はまだありません。', // 还没有实验记录。
    emptyAction: 'カード一覧で最初のカードを始める →', // 去卡片目录开始第一张 →
    all: 'すべてのラボ →', // 全部实验 →
  },
} satisfies Dict<typeof zh>;
