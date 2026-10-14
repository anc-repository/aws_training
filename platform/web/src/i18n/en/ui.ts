/**
 * en（English）：命名空间 ui。由 `npm run i18n:sync` 按 zh-CN 词典维护结构：
 * 只填写引号内的译文（空字符串 = 未翻译，运行时按 en → en → zh-CN 回退）；行尾注释是 zh-CN 原文。
 * 术语与风格见 ../glossary.md（不翻译 AWS 服务名、CLI 命令、代码、资源名、API 路径、环境变量）。
 */
import type { Dict } from '../dict';
import type zh from '../zh-CN/ui';

export default {
  semantics: {
    sessionState: {
      REQUESTED: 'Validating', // 正在校验
      PROVISIONING: 'Preparing environment', // 正在准备环境
      READY: 'Environment ready', // 环境已就绪
      RUNNING: 'Lab in progress', // 实验中
      EXPIRING: 'Expiring soon', // 即将到期
      OVERDUE: 'Expired · ending', // 已到期 · 正在结束
      ENDING: 'Ending', // 正在结束
      CLEANING: 'Releasing resources', // 正在释放资源
      KEPT: 'Environment kept', // 环境保留中
      ENDED: 'Ended', // 已结束
      FAILED: 'Start failed', // 启动失败
      CLEANUP_FAILED: 'Cleanup incomplete', // 释放未完成
    },
    checkResult: {
      not_run: 'Not run', // 未检测
      queued: 'Queued', // 排队中
      running: 'Checking', // 核验中
      pass: 'Passed', // 通过
      fail: 'Failed', // 未通过
      pending: 'Pending', // 等待中
      error: 'Checker error', // 检测器出错
      unavailable: 'Cannot check', // 无法检测
      skipped: 'Not applicable', // 不适用
      needs_manual: 'Needs manual confirmation', // 待手动确认
      manual: 'Confirmed manually', // 已手动确认
      manual_evidence: 'Confirmed manually (with evidence)', // 已手动确认（带证据）
    },
    source: {
      LOCAL: 'Local', // 本地
      PROBE: 'Probe', // 探针
      AWS: 'AWS', // AWS
      EXP: 'Experiment', // 实验
      MANUAL: 'Manual', // 手动
    },
    stepState: {
      locked: 'Locked', // 未解锁
      available: 'Available', // 可开始
      verifying: 'Checking', // 核验中
      failed: 'Failed', // 未通过
      error: 'Checker error', // 检测器出错
      needs_manual: 'Needs manual confirmation', // 待手动确认
      done: 'Done', // 已达成
      done_manual: 'Done (includes manual)', // 已达成（含手动）
      drifted: 'Drifted', // 漂移
      skipped: 'Skipped', // 已跳过
    },
    attemptStatus: {
      active: 'In progress', // 进行中
      verifying: 'Final check', // 最终复核中
      completed: 'Completed (fully automatic)', // 已完成（全自动）
      completed_manual: 'Completed (includes manual)', // 已完成（含手动）
      incomplete: 'Incomplete', // 未完成
      unverified: 'Could not verify', // 未能核验
      void: 'Not counted', // 不计入
    },
    cleanupState: {
      TRACKED: 'Tracked', // 跟踪中
      DELETING: 'Deleting', // 删除中
      DELETED: 'Deleted', // 已删除
      RETAINED: 'Kept', // 保留
      REVIEW: 'Needs review', // 需复核
      MANUAL_REQUIRED: 'Needs you', // 需人工处理
      RESOLVED_BY_LEARNER: 'Handled by you', // 你已处理
      FAILED: 'Failed', // 失败
    },
    severity: {
      BLOCKING: 'Blocking', // 阻塞
      REVIEW: 'Review', // 需复核
      INFO: 'Info', // 信息
    },
    validity: {
      valid: 'Valid', // 有效
      simulated: 'Simulated baseline', // 模拟基线
      'pending-crosscheck': 'Cross-checking', // 交叉校验中
      invalid: 'Invalid', // 无效
    },
    budget: {
      OK: 'OK', // 正常
      WARN: 'Near limit', // 接近
      EXCEEDED: 'Exceeded', // 超限
    },
    costTier: {
      low: 'low', // 低
      medium: 'medium', // 中
      high: 'high', // 高
    },
    manualSub: {
      native: 'native', // 原生
      degraded: 'degraded', // 降级
      evidence: 'with evidence', // 带证据
    },
    billing: {
      hourly: 'Hourly', // 按小时
      storage: 'By storage', // 按存储量
      monthly: 'Monthly', // 按月
      usage: 'By usage', // 按用量
      none: 'Not billed', // 不计费
    },
    urgencyAnnounce: {
      U1: '15 minutes left in the lab', // 实验剩余 15 分钟
      U2: '5 minutes left in the lab', // 实验剩余 5 分钟
      U3: '1 minute left in the lab', // 实验剩余 1 分钟
      U4: 'Lab time is up; ending now', // 实验时间已到，正在结束
    },
    checkResultSpecial: {
      ownershipPending: 'Confirming ownership', // 归属确认中
      expectedOutage: 'Expected outage', // 预期中断
    },
  },
  command: {
    runsOn: {
      workstation: 'Workbench', // 工作台
      ops: 'Workbench', // 工作台
      cloudshell: 'CloudShell', // CloudShell
      lab: 'Lab instance', // 实验机
      ec2: 'Lab instance', // 实验机
      local: 'This computer', // 本机
      browser: 'Browser', // 浏览器
    },
    target: {
      workstation: 'workbench', // 工作台
      lab: 'lab instance', // 实验机
    },
    copied: 'Copied', // 已复制
    selected: 'Command selected; press Ctrl+C to copy', // 已选中命令，按 Ctrl+C 复制
    useTextarea: 'Press Ctrl+C in the text box to copy', // 请在文本框中按 Ctrl+C 复制
    unresolved: '{n, plural, one {# variable is} other {# variables are}} not filled in', // 有 {n} 个变量未填写
    hasSecret: 'The command contains a secret placeholder and cannot be pasted', // 命令含密钥占位，不能粘贴
    tooLarge: 'The command exceeds 16 KB and can only be copied', // 命令超过 16KB，只能复制
    unfilled: 'Not filled in: {name}', // 未填写：{name}
    runsOnLabel: 'Runs on: {where}', // 运行于：{where}
    observe: ' · for observation; not counted in results', //  · 观察用，不计入结果
    masked: ' · shown masked; copies the full command', //  · 显示已打码，复制为完整命令
    danger: 'Deletes or disables resources', // 会删除或停用资源
    copyLabel: 'Copy command: {line}', // 复制命令：{line}
    copyLabelUnresolved: 'Copy command: {line} (variables not filled in)', // 复制命令：{line}（有未填写的变量）
    copy: 'Copy', // 复制
    copyWarn: 'Copy (!)', // 复制 (!)
    pasteLabel: 'Paste into the {target} terminal', // 粘贴到{target}终端
    pasteTo: 'Paste to {target}', // 粘贴到 {target}
    morePaste: 'More paste options', // 更多粘贴方式
    pasteNewTab: 'Paste in a new terminal tab', // 在新的终端子标签中粘贴
    pasteExecute: 'Paste and run', // 粘贴并执行
    selectedNote: 'Command selected; press Ctrl+C to copy.', // 已选中命令，按 Ctrl+C 复制。
    rawLabel: 'Command text (press Ctrl+C to copy)', // 命令原文（按 Ctrl+C 复制）
    dangerTitle: 'Copy a dangerous command', // 复制危险命令
    cancel: 'Cancel', // 取消
    dangerConfirm: 'I understand, copy', // 我了解，复制
    dangerNote: 'This command deletes or disables resources and cannot be undone. It is copied to the clipboard only after you confirm.', // 这条命令会删除或停用资源，影响无法撤销。确认后才会复制到剪贴板。
  },
  resource: {
    verifying: 'Checking', // 核对中
    reason: 'Reason: {v} · ', // 原因：{v} · 
    source: 'Source: {v} · ', // 来源：{v} · 
    creator: 'Created by session {name} · ', // 创建者会话名 {name} · 
    attempts: '{n, plural, one {# attempt} other {# attempts}}', // 已尝试 {n} 次
    lastAttempt: ' · last tried {t}', //  · 最后尝试 {t}
    console: 'Console', // 控制台
    openConsole: 'Open in the AWS console', // 在 AWS 控制台中打开
    ownLogin: ' (opens with your own AWS sign-in; the platform does not issue a new federated sign-in)', // （以你自己的 AWS 登录打开，平台不签发新的联合登录）
    cleanupCommand: 'Cleanup command for {type}', // {type} 的清理命令
    verifyingBusy: 'Checking…', // 正在核对…
    resolveLabel: 'Handled {name}, recheck', // 我已处理 {name}，重新核对
    resolve: 'Handled, recheck', // 我已处理，重新核对
    retryLabel: 'Retry reclaiming {name}', // 重试回收 {name}
    retry: 'Retry reclaim', // 重试回收
  },
  check: {
    sourceTitle: 'Judged by: {source}', // 判定来源：{source}
    sourceTitleSub: 'Judged by: {source} ({sub})', // 判定来源：{source}（{sub}）
    trustMedium: '·medium confidence', // ·中可信
    trustLow: '·low confidence', // ·低可信
    stale: '·stale', // ·过期
    withReason: ' ({reason})', // （{reason}）
    manual: 'manual', // 手动
    auto: 'automatic', // 自动
    reviewPending: 'Waiting for assistant review', // 等待助教复核
    reviewApproved: 'Reviewed by an assistant', // 助教已复核
    reviewRejected: 'Rejected by an assistant', // 助教已打回
    srResult: ', {text}', // ，{text}
  },
  countdown: {
    notStarted: 'Countdown not started', // 倒计时未开始
    keepUntil: 'until {t} ({left} left)', // 至 {t}（剩余 {left}）
    overdue: 'Expired · ending', // 已到期 · 正在结束
    expiresAt: 'Expires {t} (local time)', // {t} 到期（本地时间）
    serverTime: 'Based on server time', // 按服务器时间计算
  },
  costTier: {
    label: 'Cost tier {tier}', // 费用档位{tier}
    optional: ' (optional → {tier})', // （选做 → {tier}）
    sources: 'Main cost sources: {list}.', // 主要计费来源：{list}。
    tip: 'The exact amount is calculated from current prices before you start.', // 具体金额在开始前按当前价格计算。
  },
  button: {
    busy: 'Working…', // 正在处理…
  },
} satisfies Dict<typeof zh>;
