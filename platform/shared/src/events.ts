/**
 * Session event types (`SessionEvent.type`, 01 §8.4) and audit actions (`AuditEvent.action`, 01 §8.5).
 * Events are written to `atl-main` and published to the bus `atl-events` with `detail-type` = type.
 */

export const EVENT_BUS = 'atl-events';

export const EVENT_SOURCES = ['atl.lifecycle', 'atl.progress', 'atl.workspace'] as const;
export type EventSource = (typeof EVENT_SOURCES)[number];

/** type → source (01 §8.4). `workspace.*` subtypes (03 §7.4) are matched by prefix, see `eventSourceOf()`. */
export const SESSION_EVENT_TYPES = {
  'session.requested': 'atl.lifecycle',
  'session.state_changed': 'atl.lifecycle',
  'session.phase_changed': 'atl.lifecycle',
  'session.progress': 'atl.lifecycle',
  'session.expiry_warning': 'atl.lifecycle',
  'session.extended': 'atl.lifecycle',
  'session.end_requested': 'atl.lifecycle',
  'session.access_revoked': 'atl.lifecycle',
  'session.keep_started': 'atl.lifecycle',
  'session.keep_extended': 'atl.lifecycle',
  'session.keep_expiry_warning': 'atl.lifecycle',
  'session.handed_over': 'atl.lifecycle',
  'session.outage_window_changed': 'atl.lifecycle',
  'env.degraded': 'atl.lifecycle',
  'env.recovered': 'atl.lifecycle',
  'module_op.started': 'atl.lifecycle',
  'module_op.succeeded': 'atl.lifecycle',
  'module_op.failed': 'atl.lifecycle',
  'reclaim.pass_started': 'atl.lifecycle',
  'reclaim.pass_completed': 'atl.lifecycle',
  'reclaim.item_deleted': 'atl.lifecycle',
  'reclaim.item_manual': 'atl.lifecycle',
  'resource.discovered': 'atl.lifecycle',
  'cleanup.completed': 'atl.lifecycle',
  'cleanup.failed': 'atl.lifecycle',
  'budget.state_changed': 'atl.lifecycle',
  'access_analyzer.finding': 'atl.lifecycle',
  'check_run.completed': 'atl.progress',
  'step.state_changed': 'atl.progress',
  'step.drifted': 'atl.progress',
  'attempt.state_changed': 'atl.progress',
  'manual_confirmation.submitted': 'atl.progress',
  'manual_confirmation.reviewed': 'atl.progress',
  'experiment_run.recorded': 'atl.progress',
  'experiment_run.validated': 'atl.progress',
  'quiz_attempt.graded': 'atl.progress',
  'badge.earned': 'atl.progress',
  'badge.withdrawn': 'atl.progress',
  'mastery.regression': 'atl.progress',
  'track.completed': 'atl.progress',
  'report.generated': 'atl.progress',
  'certificate.issued': 'atl.progress',
  'certificate.revoked': 'atl.progress',
  'terminal.opened': 'atl.workspace',
  'terminal.closed': 'atl.workspace',
  'console_link.issued': 'atl.workspace',
} as const satisfies Record<string, EventSource>;

export type RegisteredEventType = keyof typeof SESSION_EVENT_TYPES;
/** `workspace.*` subtypes are defined by 03 §7.4. */
export type SessionEventType = RegisteredEventType | `workspace.${string}`;

/** Deprecated event names → replacement. */
export const DEPRECATED_EVENT_TYPES = {
  'session.reminder': 'session.expiry_warning',
  'console.link_issued': 'console_link.issued',
  'step.status_changed': 'step.state_changed',
} as const;

export function isSessionEventType(value: unknown): value is SessionEventType {
  return typeof value === 'string' && (value in SESSION_EVENT_TYPES || /^workspace\.[a-z][a-z0-9_.]*$/.test(value));
}

export function eventSourceOf(type: SessionEventType): EventSource {
  if (type.startsWith('workspace.')) return 'atl.workspace';
  return SESSION_EVENT_TYPES[type as RegisteredEventType];
}

/** Actor of a lifecycle event detail (02 §13.3). */
export const EVENT_ACTORS = ['user', 'system', 'scheduler', 'runner', 'sweeper', 'admin'] as const;
export type EventActor = (typeof EVENT_ACTORS)[number];

/** `SessionEvent` item payload (01 §7.3) as stored and as returned by `GET /sessions/{sid}/events`. */
export interface SessionEventRecord<T = Record<string, unknown>> {
  eventId: string;
  sessionId: string;
  at: string;
  type: SessionEventType;
  source: EventSource;
  data: T;
}

/** `phase` values of `session.phase_changed` are not registered in 01 yet (08 §9.2 #8); status values proposed there: */
export const PHASE_STATUSES = ['QUEUED', 'RUNNING', 'RETRYING', 'DONE', 'FAILED', 'SKIPPED'] as const;

// ---------------------------------------------------------------------------------------------------------------
// Audit (01 §8.5). Every 403 is also audited with result=denied.

export const AUDIT_ACTIONS = [
  'session.start',
  'session.extend',
  'session.end',
  'session.keep',
  'session.keep_extend',
  'session.keep_release',
  'session.cleanup_retry',
  'environment.repair',
  'console_link.issue',
  'terminal.start',
  'terminal.stop',
  'app_credentials.reveal',
  'check_run.request',
  'submit',
  'manual_confirmation.submit',
  'manual_confirmation.review',
  'module_op.request',
  'agent.experiment_register',
  'agent.experiment_upload',
  'agent.module_op_report',
  'internal.run_report',
  'resource.resolve',
  'quiz.submit',
  'report.export',
  'report.share',
  'report.share_revoke',
  'certificate.issue',
  'certificate.revoke',
  'certificate.publish',
  'catalog.mark_defective',
  'member.invite',
  'member.remove',
  'settings.update',
  'maintenance.set',
  'uninstall.prepare',
  'export.create',
  'cost.query',
] as const;
export type AuditAction = (typeof AUDIT_ACTIONS)[number];
