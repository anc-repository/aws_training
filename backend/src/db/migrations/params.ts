// 迁移参数：由 `cli db:migrate`（migrateLatest）按启动配置设置，例如 audit_log 的保留期（AUDIT_RETENTION_DAYS）
export interface MigrationParams { auditRetentionDays: number }

let params: MigrationParams = { auditRetentionDays: 365 };

export function setMigrationParams(p: Partial<MigrationParams>): void {
  params = { ...params, ...p };
}

export function migrationParams(): Readonly<MigrationParams> {
  return params;
}
