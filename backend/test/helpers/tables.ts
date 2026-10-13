// db/migrations 应建出的表（SQLite 与 PostgreSQL 的迁移测试共用）
export const EXPECTED_TABLES = [
  'system_meta', 'users', 'auth_tokens', 'albums', 'photos', 'photo_labels', 'moderation_results', 'upload_sessions',
  'likes', 'comments', 'photo_counters', 'share_links', 'notifications', 'notification_prefs', 'notification_deliveries',
  'outbox_emails', 'click_events', 'job_runs', 'processed_jobs', 'audit_log', 'capability_events', 'lab_runs', 'lab_results',
  'lab_metric_rollups', 'lab_host_samples', 'lab_origin_samples', 'alert_events', 'security_findings', 'compliance_evaluations',
];
