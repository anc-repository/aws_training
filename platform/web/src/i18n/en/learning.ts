/**
 * en（English）：命名空间 learning。由 `npm run i18n:sync` 按 zh-CN 词典维护结构：
 * 只填写引号内的译文（空字符串 = 未翻译，运行时按 en → en → zh-CN 回退）；行尾注释是 zh-CN 原文。
 * 术语与风格见 ../glossary.md（不翻译 AWS 服务名、CLI 命令、代码、资源名、API 路径、环境变量）。
 */
import type { Dict } from '../dict';
import type zh from '../zh-CN/learning';

export default {
  title: 'My learning', // 我的学习
  subject: 'Learning progress of {name}', // 学员 {name} 的学习进度
  subjectAnon: 'Learner’s progress', // 学员的学习进度
  tabSelect: 'Switch tab', // 切换页签
  tabs: {
    tracks: 'Path progress', // 路径进度
    mastery: 'Service mastery', // 服务掌握度
    badges: 'Badge wall', // 徽章墙
    history: 'Recent labs', // 最近实验
  },
  tracks: {
    currentSuffix: ' (current)', // （当前）
    cert: 'Certificate: ', // 证书：
    revokedNote: ' (the evidence it relied on was ruled invalid; redo the related cards to claim it again)', // （依据的证据被判无效，可以重做相关卡片后重新领取）
    pending: '{n} being verified: {list} (counted once cross-checking finishes)', // 核验中 {n} 张：{list}（等交叉核验结束后计入）
    next: 'Recommended next: ', // 推荐下一张：
    view: 'View path', // 查看路径
  },
  mastery: {
    title: 'Service mastery', // 服务掌握度
  },
  badges: {
    title: 'Card badges · {n} / {total}', // 卡片徽章 · {n} / {total}
    onlyEarned: 'Earned only', // 只看已获得
    level: 'Level', // 等级
    levelAll: 'All levels and states', // 全部等级与状态
    empty: 'Complete your first card to earn a badge.', // 完成第一张卡片即获得徽章。
    emptyAction: 'Start with svc-ec2 →', // 从 svc-ec2 开始 →
    drawerTitle: 'Badge · {title}', // 徽章 · {title}
    evidence: 'Evidence score', // 证据分
    earnedAt: 'Earned', // 获得时间
    attempt: 'Based on attempt', // 依据的尝试
    report: 'View report', // 查看报告
    variant: 'Way to start', // 起始方式
    version: 'Content version', // 内容版本
    quiz: 'Best quiz score', // 小测最好成绩
    quizBest: '{s}% (recorded only)', // {s}%（只记录）
    quizNone: 'Not taken', // 尚未作答
    credits: 'Counts for services', // 计入的服务格
    notEarned: 'Not earned. Complete this card (pass the final check) to earn the badge; quiz scores are only recorded.', // 未获得。完成本卡片（最终复核通过）即获得徽章；小测成绩只记录。
    openCard: 'Open card', // 打开卡片
  },
  visual: {
    trackRing: '{track}: counted cards / minimum to complete', // {track}：计入的卡片 / 最少完成
    masteryRing: 'Services mastered or better', // 已掌握及以上的服务
    masteryChart: 'Services per level ({n} in total)', // 各等级的服务数（共 {n} 个）
    masteryTitleN: '{title} ({n})', // {title}（{n}）
    level: 'Level', // 等级
    services: 'Services', // 服务数
    badgesRing: 'Badges earned', // 已获得的徽章
  },
  history: {
    start: 'Started', // 开始时间
    card: 'Card', // 卡片
    state: 'State', // 状态
    duration: 'Duration', // 用时
    cleanup: 'Cleanup', // 清理
    report: 'Report', // 报告
    cleanupFailed: 'Release incomplete', // 释放未完成
    cleanupPending: '{n} to handle', // {n} 项待处理
    cleanupRunning: 'In progress', // 进行中
    cleanupKept: 'Kept', // 保留中
    cleanupDone: 'Released', // 已释放
    empty: 'No lab records yet.', // 还没有实验记录。
    emptyAction: 'Start your first card in the catalog →', // 去卡片目录开始第一张 →
    all: 'All labs →', // 全部实验 →
  },
} satisfies Dict<typeof zh>;
