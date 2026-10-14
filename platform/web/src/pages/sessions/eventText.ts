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

import { t } from '../../i18n';
import { SN } from './strings';
export type EventCategory = 'state' | 'phase' | 'ops' | 'workspace' | 'checks' | 'reclaim' | 'env' | 'other';

const E = SN.events;

export const CATEGORY_TEXT: Readonly<Record<EventCategory, string>> = E.category;

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

const PHASE_TEXT: Readonly<Record<string, string>> = E.phase;

const PHASE_STATUS_TEXT: Readonly<Record<string, string>> = E.phaseStatus;
const PASS_MODE_TEXT: Readonly<Record<string, string>> = E.passMode;

const s = (v: unknown): string | null => (typeof v === 'string' && v ? v : typeof v === 'number' ? String(v) : null);

function stateText(v: unknown): string {
  const k = s(v);
  return k && k in SESSION_STATE_META ? SESSION_STATE_META[k as SessionState].text : '—';
}

export function eventText(e: Pick<SessionEvent, 'type' | 'data'>): string {
  const d = (e.data ?? {}) as Record<string, unknown>;
  const type = String(e.type);
  const res = s(d.resourceType) ?? s(d.type) ?? E.resource;
  const paren = (text: string) => t(E.paren, { text });
  switch (type) {
    case 'session.requested':
    {
      const parts = [s(d.quoteId) ? t(E.requestedQuote, { id: s(d.quoteId)!.slice(0, 6) }) : null, s(d.startProfile) ? t(E.requestedProfile, { name: s(d.startProfile) }) : null].filter((x): x is string => !!x);
      return `${E.requested}${parts.length ? paren(parts.join(E.sep)) : ''}`;
    }
    case 'session.state_changed':
      return `${stateText(d.from)} → ${stateText(d.to)}`;
    case 'session.phase_changed': {
      const ph = s(d.phase) ?? s(d.name);
      return `${t(E.phaseLine, { phase: ph ? (PHASE_TEXT[ph] ?? E.phaseOther) : '—', status: PHASE_STATUS_TEXT[s(d.status) ?? ''] ?? E.phaseUpdate })}${s(d.detail) ? t(E.detailTail, { detail: redact(s(d.detail)!) }) : ''}`;
    }
    case 'session.progress': {
      const line = s(d.message) ?? s(d.line);
      if (line) return t(E.progressMsg, { text: redact(line) });
      const mod = s(d.module) ?? s(d.moduleId);
      return mod ? (s(d.status) ? t(E.progressModuleStatus, { module: mod, status: s(d.status) }) : t(E.progressModule, { module: mod })) : E.progressUpdate;
    }
    case 'session.expiry_warning':
      return s(d.minutesLeft) ?? s(d.minutes) ? t(E.expiryWarningMin, { n: s(d.minutesLeft) ?? s(d.minutes) }) : E.expiryWarning;
    case 'session.extended':
      return s(d.deadlineAt) ? t(E.extendedTo, { n: s(d.minutes) ?? '?', t: formatClock(s(d.deadlineAt)!) }) : t(E.extended, { n: s(d.minutes) ?? '?' });
    case 'session.end_requested':
      return t(E.endRequested, { reason: endReasonText(s(d.reason)) });
    case 'session.access_revoked':
      return E.accessRevoked;
    case 'session.keep_started':
      return s(d.until) ? t(E.keepStartedUntil, { t: formatClock(s(d.until)!) }) : E.keepStarted;
    case 'session.keep_extended':
      return s(d.until) ? t(E.keepExtendedUntil, { t: formatClock(s(d.until)!) }) : E.keepExtended;
    case 'session.keep_expiry_warning':
      return E.keepExpiryWarning;
    case 'session.handed_over':
      return E.handedOver;
    case 'session.outage_window_changed':
      return s(d.until) ? t(E.outageOpen, { t: formatClock(s(d.until)!) }) : E.outageClosed;
    case 'env.degraded':
      return s(d.detail) ? t(E.envDegradedDetail, { detail: redact(s(d.detail)!) }) : E.envDegraded;
    case 'env.recovered':
      return E.envRecovered;
    case 'budget.state_changed': {
      const st = s(d.state);
      return t(E.budgetState, { state: st && st in BUDGET_META ? BUDGET_META[st as keyof typeof BUDGET_META].text : E.update });
    }
    case 'module_op.started':
    case 'module_op.succeeded':
    case 'module_op.failed': {
      const what = [s(d.op), s(d.moduleId) ?? s(d.module), s(d.actionId)].filter(Boolean).join(' ');
      const verb = type.endsWith('started') ? E.opStarted : type.endsWith('succeeded') ? E.opSucceeded : E.opFailed;
      return `${what ? t(E.opWhat, { what, verb }) : t(E.op, { verb })}${type.endsWith('failed') && s(d.reason) ? paren(redact(s(d.reason)!)) : ''}`;
    }
    case 'reclaim.pass_started':
      return t(E.passStarted, { n: s(d.passNo) ?? '?', mode: PASS_MODE_TEXT[s(d.mode) ?? ''] ?? E.passDefault });
    case 'reclaim.pass_completed':
      return Number(d.manual) > 0
        ? t(E.passCompletedManual, { n: s(d.passNo) ?? '?', deleted: s(d.deleted) ?? 0, manual: s(d.manual) })
        : t(E.passCompleted, { n: s(d.passNo) ?? '?', deleted: s(d.deleted) ?? 0 });
    case 'reclaim.item_deleted':
      return t(E.itemDeleted, { res });
    case 'reclaim.item_manual':
      return t(E.itemManual, { res });
    case 'resource.discovered':
      return `${t(E.discovered, { res })}${discoveredByText(s(d.discoveredBy)) ? paren(discoveredByText(s(d.discoveredBy))!) : ''}`;
    case 'cleanup.completed':
      return E.cleanupCompleted;
    case 'cleanup.failed':
      return E.cleanupFailed;
    case 'access_analyzer.finding':
      return E.accessFinding;
    case 'check_run.completed': {
      const sum = (d.summary ?? {}) as Record<string, unknown>;
      const parts = [Number(sum.pass) ? t(E.checkPass, { n: s(sum.pass) }) : null, Number(sum.fail) ? t(E.checkFail, { n: s(sum.fail) }) : null].filter(Boolean);
      return `${s(d.stepId) ? t(E.checkDoneStep, { step: s(d.stepId) }) : E.checkDone}${parts.length ? t(E.checkParts, { parts: parts.join(E.sep) }) : ''}`;
    }
    case 'step.state_changed': {
      const st = s(d.to) ?? s(d.state);
      return t(E.stepState, { step: s(d.stepId) ?? '—', state: st && st in STEP_STATE_META ? STEP_STATE_META[st as StepState].text : E.stateChanged });
    }
    case 'step.drifted':
      return t(E.stepDrifted, { step: s(d.stepId) ?? '—' });
    case 'attempt.state_changed': {
      const st = s(d.to) ?? s(d.status);
      return t(E.attemptState, { state: st && st in ATTEMPT_STATUS_META ? ATTEMPT_STATUS_META[st as AttemptStatus].text : E.stateChanged });
    }
    case 'manual_confirmation.submitted':
      return E.manualSubmitted;
    case 'manual_confirmation.reviewed':
      return t(E.manualReviewed, { decision: s(d.decision) === 'reject' ? E.rejected : E.approved });
    case 'experiment_run.recorded':
      return `${t(E.expRecorded, { name: [s(d.module), s(d.experiment)].filter(Boolean).join('/') })}${s(d.label) ? t(E.label, { label: s(d.label) }) : ''}`;
    case 'experiment_run.validated': {
      const v = s((d.validity as Record<string, unknown> | undefined)?.status) ?? s(d.status);
      return `${t(E.expValidated, { name: [s(d.module), s(d.experiment)].filter(Boolean).join('/') })}${s(d.label) ? t(E.label, { label: s(d.label) }) : ''} ${v && v in VALIDITY_META ? VALIDITY_META[v as ExperimentValidity].text : ''}`.trim();
    }
    case 'quiz_attempt.graded':
      return E.quizGraded;
    case 'badge.earned':
      return s(d.level) ? t(E.badgeEarnedLevel, { level: BADGE_LEVEL_TEXT[s(d.level)!] ?? s(d.level) }) : E.badgeEarned;
    case 'badge.withdrawn':
      return E.badgeWithdrawn;
    case 'mastery.regression':
      return E.masteryRegression;
    case 'track.completed':
      return E.trackCompleted;
    case 'report.generated':
      return t(E.reportGenerated, { n: s(d.revision) ?? '?' });
    case 'certificate.issued':
      return E.certIssued;
    case 'certificate.revoked':
      return E.certRevoked;
    case 'terminal.opened':
      return s(d.target) ? (s(d.target) === 'lab' ? E.terminalOpenedLab : E.terminalOpenedWs) : E.terminalOpened;
    case 'terminal.closed':
      return E.terminalClosed;
    case 'console_link.issued':
      return E.consoleIssued;
    default:
      return type.startsWith('workspace.') ? E.workspaceOp : E.platformRecord;
  }
}
