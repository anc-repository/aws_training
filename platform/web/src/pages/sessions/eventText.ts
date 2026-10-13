/**
 * 会话事件 → 时间线文案（08 P11-D 时间线、§7.4）。事件类型以 01 §8.4 为准；载荷字段按 platform/api 当前写入的形状取用，
 * 缺字段时退化为通用说明。文案不出现事件名等实现细节（§1.6），细节字符串一律经打码器显示。
 */
import type { SessionState } from '@atl/shared';
import type { SessionEvent } from '../../api/types';
import { formatClock } from '../../lib/format';
import { redact } from '../../lib/redact';
import { ATTEMPT_STATUS_META, BUDGET_META, SESSION_STATE_META, STEP_STATE_META, VALIDITY_META, type AttemptStatus, type ExperimentValidity, type StepState } from '../../ui';
import { BADGE_LEVEL_TEXT, discoveredByText, endReasonText } from './sessionText';

export type EventCategory = 'state' | 'phase' | 'ops' | 'workspace' | 'checks' | 'reclaim' | 'env' | 'other';

export const CATEGORY_TEXT: Readonly<Record<EventCategory, string>> = {
  state: '状态、延长与保留',
  phase: '阶段与进度',
  ops: '平台动作',
  workspace: '终端与控制台',
  checks: '检测、提交与成果',
  reclaim: '回收',
  env: '环境与预算',
  other: '其他',
};

export function categoryOf(type: string): EventCategory {
  if (type === 'session.phase_changed' || type === 'session.progress') return 'phase';
  if (type === 'session.outage_window_changed' || type.startsWith('env.') || type === 'budget.state_changed') return 'env';
  if (type.startsWith('session.')) return 'state';
  if (type.startsWith('module_op.')) return 'ops';
  if (type.startsWith('terminal.') || type === 'console_link.issued' || type.startsWith('workspace.')) return 'workspace';
  if (type.startsWith('reclaim.') || type === 'resource.discovered' || type.startsWith('cleanup.') || type === 'access_analyzer.finding') return 'reclaim';
  if (/^(check_run|step|attempt|manual_confirmation|experiment_run|quiz_attempt|badge|mastery|track|report|certificate)\./.test(type)) return 'checks';
  return 'other';
}

const PHASE_TEXT: Readonly<Record<string, string>> = {
  'start.validate': '校验',
  'start.lock': '占用环境',
  'start.preflight': '预检',
  'provision.base': '基础环境',
  'provision.resume': '恢复保留的环境',
  'provision.workstation': '工作台',
  'provision.profile': '起始状态',
  'provision.extra-stack': '附加栈',
  'provision.ssm': '连接',
  'provision.wire': '接入',
  'provision.health': '健康检查',
  'provision.ready': '就绪',
  'end.stop-start': '停止开始流程',
  'end.disarm': '停止倒计时',
  'end.revoke': '收回访问',
  'end.finalize': '最终复核',
  'end.seal': '报告快照',
  'end.workstation-down': '删除工作台',
  'end.suspend': '进入节省模式',
  'clean.destroy': '拆除环境栈',
  'clean.reclaim': '回收',
  'clean.verify': '校验',
  'clean.conclude': '结论',
};

const PHASE_STATUS_TEXT: Readonly<Record<string, string>> = { QUEUED: '排队中', RUNNING: '进行中', RETRYING: '重试中', DONE: '完成', FAILED: '失败', SKIPPED: '跳过' };
const PASS_MODE_TEXT: Readonly<Record<string, string>> = { PRIMARY: '主回收', RESCAN: '复扫', RETRY: '重试', UNINSTALL: '卸载' };

const s = (v: unknown): string | null => (typeof v === 'string' && v ? v : typeof v === 'number' ? String(v) : null);

function stateText(v: unknown): string {
  const k = s(v);
  return k && k in SESSION_STATE_META ? SESSION_STATE_META[k as SessionState].text : '—';
}

export function eventText(e: Pick<SessionEvent, 'type' | 'data'>): string {
  const d = (e.data ?? {}) as Record<string, unknown>;
  const type = String(e.type);
  const res = s(d.resourceType) ?? s(d.type) ?? '资源';
  switch (type) {
    case 'session.requested':
      return `已受理${s(d.quoteId) ? `（报价 ${s(d.quoteId)!.slice(0, 6)}…` : ''}${s(d.startProfile) ? `${s(d.quoteId) ? '，' : '（'}起始档位 ${s(d.startProfile)}` : ''}${s(d.quoteId) || s(d.startProfile) ? '）' : ''}`;
    case 'session.state_changed':
      return `${stateText(d.from)} → ${stateText(d.to)}`;
    case 'session.phase_changed': {
      const ph = s(d.phase) ?? s(d.name);
      return `阶段 ${ph ? (PHASE_TEXT[ph] ?? '其他') : '—'}：${PHASE_STATUS_TEXT[s(d.status) ?? ''] ?? '更新'}${s(d.detail) ? ` · ${redact(s(d.detail)!)}` : ''}`;
    }
    case 'session.progress': {
      const msg = s(d.message) ?? s(d.line);
      if (msg) return `进度：${redact(msg)}`;
      const mod = s(d.module) ?? s(d.moduleId);
      return mod ? `进度：模块 ${mod}${s(d.status) ? ` ${s(d.status)}` : ''}` : '进度更新';
    }
    case 'session.expiry_warning':
      return `到期提醒${s(d.minutesLeft) ?? s(d.minutes) ? `：剩余 ${s(d.minutesLeft) ?? s(d.minutes)} 分钟` : ''}`;
    case 'session.extended':
      return `延长 ${s(d.minutes) ?? '?'} 分钟${s(d.deadlineAt) ? `（到 ${formatClock(s(d.deadlineAt)!)}）` : ''}`;
    case 'session.end_requested':
      return `请求结束（${endReasonText(s(d.reason))}）`;
    case 'session.access_revoked':
      return '收回访问：终端断开，控制台与工作台凭证吊销';
    case 'session.keep_started':
      return `开始保留环境${s(d.until) ? `（至 ${formatClock(s(d.until)!)}）` : ''}`;
    case 'session.keep_extended':
      return `延长保留${s(d.until) ? `（至 ${formatClock(s(d.until)!)}）` : ''}`;
    case 'session.keep_expiry_warning':
      return '保留的环境即将自动释放';
    case 'session.handed_over':
      return '环境已交接给新的会话';
    case 'session.outage_window_changed':
      return s(d.until) ? `预期中断窗口打开（至 ${formatClock(s(d.until)!)}）` : '预期中断窗口结束';
    case 'env.degraded':
      return `环境异常${s(d.detail) ? `：${redact(s(d.detail)!)}` : ''}`;
    case 'env.recovered':
      return '环境已恢复';
    case 'budget.state_changed': {
      const st = s(d.state);
      return `预算状态：${st && st in BUDGET_META ? BUDGET_META[st as keyof typeof BUDGET_META].text : '更新'}`;
    }
    case 'module_op.started':
    case 'module_op.succeeded':
    case 'module_op.failed': {
      const what = [s(d.op), s(d.moduleId) ?? s(d.module), s(d.actionId)].filter(Boolean).join(' ');
      const verb = type.endsWith('started') ? '开始' : type.endsWith('succeeded') ? '成功' : '失败';
      return `平台动作${what ? ` ${what}` : ''}：${verb}${type.endsWith('failed') && s(d.reason) ? `（${redact(s(d.reason)!)}）` : ''}`;
    }
    case 'reclaim.pass_started':
      return `回收第 ${s(d.passNo) ?? '?'} 轮开始（${PASS_MODE_TEXT[s(d.mode) ?? ''] ?? '回收'}）`;
    case 'reclaim.pass_completed':
      return `回收第 ${s(d.passNo) ?? '?'} 轮完成：删除 ${s(d.deleted) ?? 0} 项${Number(d.manual) > 0 ? `，需人工 ${s(d.manual)} 项` : ''}`;
    case 'reclaim.item_deleted':
      return `已删除 ${res}`;
    case 'reclaim.item_manual':
      return `需人工处理：${res}`;
    case 'resource.discovered':
      return `发现资源 ${res}${discoveredByText(s(d.discoveredBy)) ? `（${discoveredByText(s(d.discoveredBy))}）` : ''}`;
    case 'cleanup.completed':
      return '回收完成';
    case 'cleanup.failed':
      return '释放未完成：有资源没能自动删除';
    case 'access_analyzer.finding':
      return '外部访问分析：发现对外开放的资源';
    case 'check_run.completed': {
      const sum = (d.summary ?? {}) as Record<string, unknown>;
      const parts = [Number(sum.pass) ? `${s(sum.pass)} 项通过` : null, Number(sum.fail) ? `${s(sum.fail)} 项未通过` : null].filter(Boolean);
      return `检测完成${s(d.stepId) ? `（步骤 ${s(d.stepId)}）` : ''}${parts.length ? `：${parts.join('，')}` : ''}`;
    }
    case 'step.state_changed': {
      const st = s(d.to) ?? s(d.state);
      return `步骤 ${s(d.stepId) ?? '—'}：${st && st in STEP_STATE_META ? STEP_STATE_META[st as StepState].text : '状态变化'}`;
    }
    case 'step.drifted':
      return `步骤 ${s(d.stepId) ?? '—'} 漂移`;
    case 'attempt.state_changed': {
      const st = s(d.to) ?? s(d.status);
      return `尝试：${st && st in ATTEMPT_STATUS_META ? ATTEMPT_STATUS_META[st as AttemptStatus].text : '状态变化'}`;
    }
    case 'manual_confirmation.submitted':
      return '提交手动确认';
    case 'manual_confirmation.reviewed':
      return `助教复核：${s(d.decision) === 'reject' ? '打回' : '通过'}`;
    case 'experiment_run.recorded':
      return `实验运行已上传：${[s(d.module), s(d.experiment)].filter(Boolean).join('/')}${s(d.label) ? `（${s(d.label)}）` : ''}`;
    case 'experiment_run.validated': {
      const v = s((d.validity as Record<string, unknown> | undefined)?.status) ?? s(d.status);
      return `实验校验：${[s(d.module), s(d.experiment)].filter(Boolean).join('/')}${s(d.label) ? `（${s(d.label)}）` : ''} ${v && v in VALIDITY_META ? VALIDITY_META[v as ExperimentValidity].text : ''}`.trim();
    }
    case 'quiz_attempt.graded':
      return '小测已判分（只记录）';
    case 'badge.earned':
      return `获得徽章${s(d.level) ? `（${BADGE_LEVEL_TEXT[s(d.level)!] ?? s(d.level)}）` : ''}`;
    case 'badge.withdrawn':
      return '徽章被撤回';
    case 'mastery.regression':
      return '服务掌握度：需要复习';
    case 'track.completed':
      return '学习路径的证书条件已满足';
    case 'report.generated':
      return `报告第 ${s(d.revision) ?? '?'} 版已生成`;
    case 'certificate.issued':
      return '签发证书';
    case 'certificate.revoked':
      return '证书已吊销';
    case 'terminal.opened':
      return `打开终端${s(d.target) ? `（${s(d.target) === 'lab' ? '实验机' : '工作台'}）` : ''}`;
    case 'terminal.closed':
      return '终端关闭';
    case 'console_link.issued':
      return '签发控制台登录';
    default:
      return type.startsWith('workspace.') ? '工作台操作' : '平台记录';
  }
}
