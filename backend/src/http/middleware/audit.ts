// backend/src/http/middleware/audit.ts —— 应用审计的写入点（05#audit 第 1 节）
//
// audit(c, …) 由路由与管理操作显式调用：自动补全 actor（来自请求上下文的 Principal）、source_ip、user_agent、request_id，
// 写入 audit_log（带哈希链，AUDIT_HASH_CHAIN），并以 source=audit 镜像一行到 LOG_DIR/audit.log（logging 启用后随之进入 CloudWatch）。
// 审计写入失败不影响业务请求（记 error 日志）。auditBypass(c) 是 bypassGuard 的 audit 回调（总纲 8.3 第 6 条）。
import { appendFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import type { Container } from '../../container.js';
import type { BypassAuditEntry } from '../../observability/bypass.js';
import { currentContext } from '../../observability/request-context.js';
import { appendAudit, type AuditActorType, type AuditResult } from '../../repositories/audit.js';

export interface AuditEvent {
  action: string;
  targetType?: string | null;
  targetId?: string | null;
  result?: AuditResult;
  details?: Record<string, unknown> | null;
  /** 不在请求上下文中（worker / CLI）或需要覆盖时显式给出 */
  actor?: { type: AuditActorType; id?: string | null; email?: string | null };
}

type AuditDeps = Pick<Container, 'db' | 'config' | 'logger'>;

export async function audit(c: AuditDeps, e: AuditEvent): Promise<void> {
  const ctx = currentContext();
  const actorType: AuditActorType = e.actor?.type ?? (ctx?.principal ? (ctx.isAdmin ? 'admin' : 'user') : ctx ? 'anonymous' : 'system');
  const locals = ctx?.locals ?? {};
  try {
    const row = await appendAudit(c.db, {
      actorType,
      actorId: e.actor?.id ?? ctx?.userId ?? null,
      actorEmail: e.actor?.email ?? ctx?.principal?.email ?? null,
      action: e.action,
      targetType: e.targetType ?? null,
      targetId: e.targetId ?? null,
      result: e.result ?? 'success',
      sourceIp: typeof locals.clientIp === 'string' ? locals.clientIp : null,
      userAgent: typeof locals.userAgent === 'string' ? locals.userAgent : null,
      requestId: ctx?.requestId ?? null,
      awsPrincipal: typeof locals.awsPrincipal === 'string' ? locals.awsPrincipal : null,
      details: e.details ?? null,
    }, { hashChain: c.config.core.AUDIT_HASH_CHAIN !== 'off' });
    const file = path.join(c.config.logging.LOG_DIR, 'audit.log');
    await mkdir(path.dirname(file), { recursive: true });
    await appendFile(file, `${JSON.stringify({ source: 'audit', ...row })}\n`, 'utf8');
  } catch (err) {
    c.logger.error('audit write failed', { action: e.action, error: err as Error });
  }
}

/** bypassGuard 的 audit 回调：http/app.ts 中 `audit: auditBypass(c)` */
export function auditBypass(c: AuditDeps): (entry: BypassAuditEntry) => Promise<void> {
  return (entry) => audit(c, {
    action: 'lab.bypass', targetType: 'route', targetId: `${entry.method} ${entry.route}`.slice(0, 128),
    details: { keys: entry.keys, ...(entry.runId ? { runId: entry.runId } : {}) },
  });
}
