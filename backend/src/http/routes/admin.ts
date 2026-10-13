// backend/src/http/routes/admin.ts —— F12：管理后台 API（应用层 RBAC：users.role='admin' → Principal.groups 含 admin）
//
//   GET   /api/admin/users                 ?q&role&cursor → Page<AdminUser>
//   PATCH /api/admin/users/:id             {role?, disabled?, plan?} → AdminUser（经 AuthPort.adminSetGroups / adminDisableUser）
//   GET   /api/admin/outbox                ?to&category&status&cursor → Page<OutboxEmailSummary>（全部“发出”的邮件）
//   GET   /api/admin/outbox/:id            → OutboxEmailDetail（含正文；前端用 iframe sandbox + srcdoc 预览）
//   GET   /api/admin/outbox/:id/eml        → message/rfc822 下载
//   GET   /api/admin/jobs                  → JobsOverview（队列语义与统计、定时任务最近一次运行、失败的运行）
//   GET   /api/admin/jobs/runs             ?name&status&limit → Page<JobRun>
//   POST  /api/admin/jobs/:name/run        → JobRun（SchedulerPort.triggerNow）
//   POST  /api/admin/jobs/failed/:id/replay → 501（DLQ 重放需要 queue=sqs，本轮未实现）
//   GET   /api/admin/audit                 ?actor&action&since&until&cursor → Page<AuditEntry>
//   GET   /api/admin/audit/verify          → {ok, checked, brokenAt, detail}（哈希链校验）
//   GET   /api/admin/audit.csv             导出 CSV
//   GET   /api/admin/notifications/deliveries ?eventId → 站外投递记录
// 每个管理操作写 audit_log（admin.user.role_change、admin.user.disable、admin.job.run …）。
import { readFileSync } from 'node:fs';
import type { Express } from 'express';
import { z } from 'zod';
import type { Container } from '../../container.js';
import { HttpError, isNotImplemented } from '../../errors.js';
import { driverOf } from '../../modules/registry.js';
import type { JobRun, ScheduledJobDef, ScheduledJobName } from '../../ports/scheduler.js';
import { auditDetails, listAudit, verifyAuditChain, type AuditRow } from '../../repositories/audit.js';
import { listDeliveries } from '../../repositories/notifications.js';
import { findOutboxEmail, listOutbox } from '../../repositories/outbox.js';
import { findUserById, listUsers, photoCountsByOwner, updateUser } from '../../repositories/users.js';
import { toOutboxSummary } from '../../services/notifications.js';
import { toAdminUser } from '../../services/user-directory.js';
import { requireAdmin } from '../middleware/admin.js';
import { audit } from '../middleware/audit.js';
import { currentUser, requireAuth } from '../middleware/auth.js';
import { notImplementedRoute } from './_stub.js';
import { outboxDetail, parseBody } from './auth.js';

export const SCHEDULED_JOB_NAMES: readonly ScheduledJobName[] = [
  'report.daily', 'share.cleanup', 'image.reconcile', 'outbox.retention', 'lab.compact', 'lab.heartbeat', 'analytics.retention', 'audit.retention',
];

const PatchUserBody = z.object({
  role: z.enum(['admin', 'member']).optional(),
  disabled: z.boolean().optional(),
  plan: z.string().trim().min(1).max(32).optional(),
}).refine((v) => Object.keys(v).length > 0, { message: '至少修改一个字段' });

function auditEntryView(r: AuditRow): Record<string, unknown> {
  return {
    id: r.id, ts: r.ts, actorType: r.actor_type, actorId: r.actor_id, actorEmail: r.actor_email, action: r.action, targetType: r.target_type,
    targetId: r.target_id, result: r.result, sourceIp: r.source_ip, userAgent: r.user_agent, requestId: r.request_id, traceId: r.trace_id,
    awsPrincipal: r.aws_principal, details: auditDetails(r), prevHash: r.prev_hash, hash: r.hash,
  };
}

function csvCell(v: unknown): string {
  const s = v === null || v === undefined ? '' : typeof v === 'string' ? v : JSON.stringify(v);
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

async function optional<T>(fn: () => Promise<T>): Promise<{ value?: T; error?: string }> {
  try {
    return { value: await fn() };
  } catch (e) {
    return { error: isNotImplemented(e) ? '尚未实现' : (e as Error).message };
  }
}

export function register(app: Express, c: Container): void {
  app.use('/api/admin', requireAuth, requireAdmin);

  // ------------------------------------------------------------------------------------ 用户
  app.get('/api/admin/users', async (req, res) => {
    const q = typeof req.query.q === 'string' ? req.query.q : undefined;
    const role = req.query.role === 'admin' || req.query.role === 'member' ? req.query.role : undefined;
    const cursor = typeof req.query.cursor === 'string' ? req.query.cursor : undefined;
    const limit = Math.min(Math.max(Number(req.query.limit ?? 50) || 50, 1), 200);
    const page = await listUsers(c.dbRead, { limit, ...(q ? { q } : {}), ...(role ? { role } : {}), ...(cursor ? { cursor } : {}) });
    const counts = await photoCountsByOwner(c.dbRead, page.items.map((u) => u.id));
    res.set('Cache-Control', 'no-store').json({ items: page.items.map((u) => toAdminUser(u, counts[u.id] ?? 0)), nextCursor: page.nextCursor });
  });

  app.patch('/api/admin/users/:id', async (req, res) => {
    const me = currentUser();
    const body = parseBody(PatchUserBody, req.body);
    const target = await findUserById(c.db, String(req.params.id));
    if (!target) throw new HttpError(404, 'USER_NOT_FOUND', '用户不存在');
    if (target.id === me.userId && (body.role === 'member' || body.disabled === true)) {
      throw new HttpError(409, 'CANNOT_DEMOTE_SELF', '不能降级或禁用自己（防止系统里没有管理员）');
    }
    if (body.role && body.role !== target.role) {
      await c.auth.adminSetGroups(target.auth_subject, [body.role]);
      await updateUser(c.db, target.id, { role: body.role });
      await audit(c, { action: 'admin.user.role_change', targetType: 'user', targetId: target.id, details: { from: target.role, to: body.role } });
    }
    if (body.disabled === true) {
      await c.auth.adminDisableUser(target.auth_subject);
      await updateUser(c.db, target.id, { disabled: true });
      await audit(c, { action: 'admin.user.disable', targetType: 'user', targetId: target.id });
    } else if (body.disabled === false) {
      await updateUser(c.db, target.id, { disabled: false, failed_logins: 0, locked_until: null });
      await audit(c, { action: 'admin.user.enable', targetType: 'user', targetId: target.id });
    }
    if (body.plan && body.plan !== target.plan) {
      await updateUser(c.db, target.id, { plan: body.plan });
      await audit(c, { action: 'admin.user.plan_change', targetType: 'user', targetId: target.id, details: { from: target.plan, to: body.plan } });
    }
    const updated = (await findUserById(c.db, target.id))!;
    const counts = await photoCountsByOwner(c.db, [updated.id]);
    res.json(toAdminUser(updated, counts[updated.id] ?? 0));
  });

  // ------------------------------------------------------------------------------------ outbox
  app.get('/api/admin/outbox', async (req, res) => {
    const str = (k: string) => (typeof req.query[k] === 'string' && req.query[k] ? String(req.query[k]) : undefined);
    const limit = Math.min(Math.max(Number(req.query.limit ?? 50) || 50, 1), 200);
    const page = await listOutbox(c.dbRead, {
      limit, ...(str('to') ? { to: str('to')! } : {}), ...(str('category') ? { category: str('category')! } : {}),
      ...(str('status') ? { status: str('status')! } : {}), ...(str('cursor') ? { cursor: str('cursor')! } : {}),
    });
    res.set('Cache-Control', 'no-store').json({ items: page.items.map(toOutboxSummary), nextCursor: page.nextCursor, transport: driverOf(c.env, 'email') });
  });

  app.get('/api/admin/outbox/:id', async (req, res) => {
    const row = await findOutboxEmail(c.db, String(req.params.id));
    if (!row) throw new HttpError(404, 'NOT_FOUND', '邮件不存在');
    res.set('Cache-Control', 'no-store')
      .set('Content-Security-Policy', "default-src 'none'; img-src data:; style-src 'unsafe-inline'; frame-ancestors 'self'")
      .json(outboxDetail(c, row, `/api/admin/outbox/${encodeURIComponent(row.id)}/eml`));
  });

  app.get('/api/admin/outbox/:id/eml', async (req, res) => {
    const row = await findOutboxEmail(c.db, String(req.params.id));
    const resolver = c.email as { resolveEmlPath?: (p: string) => string };
    if (!row?.eml_path || typeof resolver.resolveEmlPath !== 'function') throw new HttpError(404, 'NOT_FOUND', '该邮件没有保存 .eml');
    let raw: string;
    try {
      raw = readFileSync(resolver.resolveEmlPath(row.eml_path), 'utf8');
    } catch {
      throw new HttpError(404, 'NOT_FOUND', '.eml 文件已被保留期任务删除');
    }
    res.set('Cache-Control', 'no-store').type('message/rfc822')
      .set('Content-Disposition', `attachment; filename="${row.message_id}.eml"`).send(raw);
  });

  // ------------------------------------------------------------------------------------ 任务
  const runView = (r: JobRun) => ({ ...r });

  app.get('/api/admin/jobs', async (_req, res) => {
    const runs = await optional(() => c.scheduler.listRuns(200));
    const stats = await optional(() => c.queue.stats());
    const defs = (c.scheduler as { definitions?: () => ScheduledJobDef[] }).definitions?.() ?? [];
    const lastByName = new Map<string, JobRun>();
    for (const r of runs.value ?? []) if (!lastByName.has(r.name)) lastByName.set(r.name, r);
    const semantics = (() => {
      try {
        return c.queue.semantics;
      } catch {
        return undefined;
      }
    })();
    res.set('Cache-Control', 'no-store').json({
      queue: {
        driver: driverOf(c.env, 'queue'),
        ...(stats.value ?? {}),
        ...(semantics ? { semantics } : {}),
        ...(stats.error ? { detail: stats.error } : {}),
      },
      scheduler: {
        driver: driverOf(c.env, 'scheduler'),
        ...(runs.error ? { detail: runs.error } : {}),
        jobs: SCHEDULED_JOB_NAMES.map((name) => {
          const def = defs.find((d) => d.name === name);
          return { name, schedule: def ? `${def.cron} (${def.timezone})` : '', lastRun: lastByName.get(name) ?? null };
        }),
      },
      failed: (runs.value ?? []).filter((r) => r.status === 'failed').slice(0, 20).map((r) => ({
        id: r.runId, name: r.name, attempts: 1, failedAt: r.finishedAt ?? r.startedAt, lastError: null,
      })),
    });
  });

  app.get('/api/admin/jobs/runs', async (req, res) => {
    const limit = Math.min(Math.max(Number(req.query.limit ?? 100) || 100, 1), 500);
    const name = typeof req.query.name === 'string' ? req.query.name : undefined;
    const status = typeof req.query.status === 'string' ? req.query.status : undefined;
    const runs = await c.scheduler.listRuns(limit);
    const items = runs.filter((r) => (!name || r.name === name) && (!status || r.status === status)).map(runView);
    res.set('Cache-Control', 'no-store').json({ items, nextCursor: null });
  });

  // 失败任务重放需要持久队列的 DLQ（queue=sqs 的 redrive）；QueuePort 没有对应方法，本轮未实现
  app.post('/api/admin/jobs/failed/:id/replay', notImplementedRoute('admin.jobs.replay'));

  app.post('/api/admin/jobs/:name/run', async (req, res) => {
    const name = String(req.params.name) as ScheduledJobName;
    if (!SCHEDULED_JOB_NAMES.includes(name)) throw new HttpError(404, 'UNKNOWN_JOB', `未知的定时任务：${name}`);
    const run = await c.scheduler.triggerNow(name);
    await audit(c, { action: 'admin.job.run', targetType: 'job', targetId: name, details: { runId: run.runId, status: run.status } });
    res.json(runView(run));
  });

  // ------------------------------------------------------------------------------------ 审计
  const auditFilter = (q: Record<string, unknown>) => {
    const s = (k: string) => (typeof q[k] === 'string' && q[k] ? String(q[k]) : undefined);
    return {
      ...(s('actor') ? { actor: s('actor')! } : {}), ...(s('action') ? { action: s('action')! } : {}),
      ...(s('targetType') ? { targetType: s('targetType')! } : {}), ...(s('targetId') ? { targetId: s('targetId')! } : {}),
      ...(s('since') ? { since: s('since')! } : {}), ...(s('until') ? { until: s('until')! } : {}),
      ...(s('cursor') ? { cursor: s('cursor')! } : {}),
    };
  };

  app.get('/api/admin/audit', async (req, res) => {
    const limit = Math.min(Math.max(Number(req.query.limit ?? 50) || 50, 1), 500);
    const page = await listAudit(c.dbRead, { ...auditFilter(req.query as Record<string, unknown>), limit });
    res.set('Cache-Control', 'no-store').json({ items: page.items.map(auditEntryView), nextCursor: page.nextCursor, mode: c.config.core.AUDIT_MODE });
  });

  app.get('/api/admin/audit/verify', async (_req, res) => {
    const r = await verifyAuditChain(c.db);
    res.set('Cache-Control', 'no-store').json({ ...r, hashChain: c.config.core.AUDIT_HASH_CHAIN });
  });

  app.get('/api/admin/audit.csv', async (req, res) => {
    const page = await listAudit(c.dbRead, { ...auditFilter(req.query as Record<string, unknown>), limit: 500 });
    const cols = ['id', 'ts', 'actor_type', 'actor_id', 'actor_email', 'action', 'target_type', 'target_id', 'result', 'source_ip', 'request_id', 'details'] as const;
    const lines = [cols.join(','), ...page.items.map((r) => cols.map((k) => csvCell(r[k])).join(','))];
    res.set('Cache-Control', 'no-store').type('text/csv; charset=utf-8')
      .set('Content-Disposition', 'attachment; filename="audit.csv"').send(`${lines.join('\r\n')}\r\n`);
  });

  // ------------------------------------------------------------------------------------ 通知投递
  app.get('/api/admin/notifications/deliveries', async (req, res) => {
    const eventId = typeof req.query.eventId === 'string' ? req.query.eventId : undefined;
    const rows = await listDeliveries(c.dbRead, { limit: 200, ...(eventId ? { eventId } : {}) });
    res.set('Cache-Control', 'no-store').json({ items: rows, nextCursor: null, driver: driverOf(c.env, 'notification') });
  });

  // 其余 /api/admin/* 一律 404（避免落到通用 404 前被别的路由误匹配）
  app.all('/api/admin/*rest', (req, res) => {
    res.status(404).json({ error: 'NOT_FOUND', path: req.path });
  });
}
