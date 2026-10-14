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
      REQUESTED: '', // 正在校验
      PROVISIONING: '', // 正在准备环境
      READY: '', // 环境已就绪
      RUNNING: '', // 实验中
      EXPIRING: '', // 即将到期
      OVERDUE: '', // 已到期 · 正在结束
      ENDING: '', // 正在结束
      CLEANING: '', // 正在释放资源
      KEPT: '', // 环境保留中
      ENDED: '', // 已结束
      FAILED: '', // 启动失败
      CLEANUP_FAILED: '', // 释放未完成
    },
    checkResult: {
      not_run: '', // 未检测
      queued: '', // 排队中
      running: '', // 核验中
      pass: '', // 通过
      fail: '', // 未通过
      pending: '', // 等待中
      error: '', // 检测器出错
      unavailable: '', // 无法检测
      skipped: '', // 不适用
      needs_manual: '', // 待手动确认
      manual: '', // 已手动确认
      manual_evidence: '', // 已手动确认（带证据）
    },
    source: {
      LOCAL: '', // 本地
      PROBE: '', // 探针
      AWS: '', // AWS
      EXP: '', // 实验
      MANUAL: '', // 手动
    },
    stepState: {
      locked: '', // 未解锁
      available: '', // 可开始
      verifying: '', // 核验中
      failed: '', // 未通过
      error: '', // 检测器出错
      needs_manual: '', // 待手动确认
      done: '', // 已达成
      done_manual: '', // 已达成（含手动）
      drifted: '', // 漂移
      skipped: '', // 已跳过
    },
    attemptStatus: {
      active: '', // 进行中
      verifying: '', // 最终复核中
      completed: '', // 已完成（全自动）
      completed_manual: '', // 已完成（含手动）
      incomplete: '', // 未完成
      unverified: '', // 未能核验
      void: '', // 不计入
    },
    cleanupState: {
      TRACKED: '', // 跟踪中
      DELETING: '', // 删除中
      DELETED: '', // 已删除
      RETAINED: '', // 保留
      REVIEW: '', // 需复核
      MANUAL_REQUIRED: '', // 需人工处理
      RESOLVED_BY_LEARNER: '', // 你已处理
      FAILED: '', // 失败
    },
    severity: {
      BLOCKING: '', // 阻塞
      REVIEW: '', // 需复核
      INFO: '', // 信息
    },
    validity: {
      valid: '', // 有效
      simulated: '', // 模拟基线
      'pending-crosscheck': '', // 交叉校验中
      invalid: '', // 无效
    },
    budget: {
      OK: '', // 正常
      WARN: '', // 接近
      EXCEEDED: '', // 超限
    },
    costTier: {
      low: '', // 低
      medium: '', // 中
      high: '', // 高
    },
    manualSub: {
      native: '', // 原生
      degraded: '', // 降级
      evidence: '', // 带证据
    },
    billing: {
      hourly: '', // 按小时
      storage: '', // 按存储量
      monthly: '', // 按月
      usage: '', // 按用量
      none: '', // 不计费
    },
    urgencyAnnounce: {
      U1: '', // 实验剩余 15 分钟
      U2: '', // 实验剩余 5 分钟
      U3: '', // 实验剩余 1 分钟
      U4: '', // 实验时间已到，正在结束
    },
    checkResultSpecial: {
      ownershipPending: '', // 归属确认中
      expectedOutage: '', // 预期中断
    },
  },
  command: {
    runsOn: {
      workstation: '', // 工作台
      ops: '', // 工作台
      cloudshell: '', // CloudShell
      lab: '', // 实验机
      ec2: '', // 实验机
      local: '', // 本机
      browser: '', // 浏览器
    },
    target: {
      workstation: '', // 工作台
      lab: '', // 实验机
    },
    copied: '', // 已复制
    selected: '', // 已选中命令，按 Ctrl+C 复制
    useTextarea: '', // 请在文本框中按 Ctrl+C 复制
    unresolved: '', // 有 {n} 个变量未填写
    hasSecret: '', // 命令含密钥占位，不能粘贴
    tooLarge: '', // 命令超过 16KB，只能复制
    unfilled: '', // 未填写：{name}
    runsOnLabel: '', // 运行于：{where}
    observe: '', //  · 观察用，不计入结果
    masked: '', //  · 显示已打码，复制为完整命令
    danger: '', // 会删除或停用资源
    copyLabel: '', // 复制命令：{line}
    copyLabelUnresolved: '', // 复制命令：{line}（有未填写的变量）
    copy: '', // 复制
    copyWarn: '', // 复制 (!)
    pasteLabel: '', // 粘贴到{target}终端
    pasteTo: '', // 粘贴到 {target}
    morePaste: '', // 更多粘贴方式
    pasteNewTab: '', // 在新的终端子标签中粘贴
    pasteExecute: '', // 粘贴并执行
    selectedNote: '', // 已选中命令，按 Ctrl+C 复制。
    rawLabel: '', // 命令原文（按 Ctrl+C 复制）
    dangerTitle: '', // 复制危险命令
    cancel: '', // 取消
    dangerConfirm: '', // 我了解，复制
    dangerNote: '', // 这条命令会删除或停用资源，影响无法撤销。确认后才会复制到剪贴板。
  },
  resource: {
    verifying: '', // 核对中
    reason: '', // 原因：{v} · 
    source: '', // 来源：{v} · 
    creator: '', // 创建者会话名 {name} · 
    attempts: '', // 已尝试 {n} 次
    lastAttempt: '', //  · 最后尝试 {t}
    console: '', // 控制台
    openConsole: '', // 在 AWS 控制台中打开
    ownLogin: '', // （以你自己的 AWS 登录打开，平台不签发新的联合登录）
    cleanupCommand: '', // {type} 的清理命令
    verifyingBusy: '', // 正在核对…
    resolveLabel: '', // 我已处理 {name}，重新核对
    resolve: '', // 我已处理，重新核对
    retryLabel: '', // 重试回收 {name}
    retry: '', // 重试回收
  },
  check: {
    sourceTitle: '', // 判定来源：{source}
    sourceTitleSub: '', // 判定来源：{source}（{sub}）
    trustMedium: '', // ·中可信
    trustLow: '', // ·低可信
    stale: '', // ·过期
    withReason: '', // （{reason}）
    manual: '', // 手动
    auto: '', // 自动
    reviewPending: '', // 等待助教复核
    reviewApproved: '', // 助教已复核
    reviewRejected: '', // 助教已打回
    srResult: '', // ，{text}
  },
  countdown: {
    notStarted: '', // 倒计时未开始
    keepUntil: '', // 至 {t}（剩余 {left}）
    overdue: '', // 已到期 · 正在结束
    expiresAt: '', // {t} 到期（本地时间）
    serverTime: '', // 按服务器时间计算
  },
  costTier: {
    label: '', // 费用档位{tier}
    optional: '', // （选做 → {tier}）
    sources: '', // 主要计费来源：{list}。
    tip: '', // 具体金额在开始前按当前价格计算。
  },
  button: {
    busy: '', // 正在处理…
  },
} satisfies Dict<typeof zh>;
