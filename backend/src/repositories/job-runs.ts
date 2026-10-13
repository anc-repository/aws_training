// backend/src/repositories/job-runs.ts —— job_runs、processed_jobs，以及定时任务的保留期删除（04#scheduler、06#workflow、04#queue）
//
// job_runs 的三类行：
//   - 定时任务：name = ScheduledJobName，(name, scheduled_at) 唯一 = 幂等键；被跳过的触发（skipped-locked / skipped-duplicate）
//     另写一行，scheduled_at 留空（NULL 互不相同），原计划时间放在 detail.scheduledAt；
//   - PhotoPipeline 的步骤：name = pipeline.<step>，subject_id = photoId，scheduled_at 留空，trigger = pipeline；
//   - 队列任务的失败（本地死信，取代文档中的 failed_jobs 表，见 implementation-notes）：name = queue.<JobName>，trigger = queue，
//     status = failed，detail = { jobId, payload, attempts, source }。
import { randomUUID } from 'node:crypto';
import { hostname } from 'node:os';
import type { Knex } from 'knex';
import { countOf, isUniqueViolation, jsonIn, jsonOut, nowIso } from '../db/dialect.js';
import type { JobRun, ScheduledJobName } from '../ports/scheduler.js';

type Row = Record<string, unknown>;
export type RunStatus = JobRun['status'];
export type RunTrigger = JobRun['trigger'] | 'pipeline' | 'queue';

export interface JobRunRow {
  runId: string;
  name: string;
  subjectId: string | null;
  scheduledAt: string | null;
  startedAt: string;
  finishedAt: string | null;
  status: RunStatus;
  host: string;
  trigger: RunTrigger;
  attempt: number;
  executor: string | null;
  error: string | null;
  detail: Record<string, unknown> | null;
}

const toRun = (r: Row): JobRunRow => ({
  runId: String(r.run_id),
  name: String(r.name),
  subjectId: (r.subject_id as string | null) ?? null,
  scheduledAt: (r.scheduled_at as string | null) ?? null,
  startedAt: String(r.started_at),
  finishedAt: (r.finished_at as string | null) ?? null,
  status: r.status as RunStatus,
  host: String(r.host),
  trigger: r.trigger as RunTrigger,
  attempt: Number(r.attempt ?? 1),
  executor: (r.executor as string | null) ?? null,
  error: (r.error as string | null) ?? null,
  detail: jsonIn<Record<string, unknown>>(r.detail, null),
});

/** JobRunRow → 端口的 JobRun（跳过的行从 detail.scheduledAt 取计划时间） */
export function toJobRun(r: JobRunRow): JobRun {
  const scheduledAt = r.scheduledAt ?? (typeof r.detail?.scheduledAt === 'string' ? r.detail.scheduledAt : r.startedAt);
  const trigger = (['cron', 'eventbridge', 'manual'] as const).includes(r.trigger as never) ? (r.trigger as JobRun['trigger']) : 'manual';
  return {
    runId: r.runId, name: r.name as ScheduledJobName, scheduledAt, startedAt: r.startedAt,
    ...(r.finishedAt ? { finishedAt: r.finishedAt } : {}), status: r.status, host: r.host, trigger,
  };
}

// ---------------------------------------------------------------------------------------------
// 定时任务
// ---------------------------------------------------------------------------------------------
/** 插入 running 行；(name, scheduled_at) 已存在时返回 null（调用方记为 skipped-duplicate） */
export async function startScheduledRun(db: Knex, r: {
  name: ScheduledJobName; scheduledAt: string; trigger: JobRun['trigger']; host?: string;
}): Promise<JobRunRow | null> {
  const row = {
    run_id: randomUUID(), name: r.name, subject_id: null, scheduled_at: r.scheduledAt, started_at: nowIso(), finished_at: null,
    status: 'running', host: (r.host ?? hostname()).slice(0, 128), trigger: r.trigger, attempt: 1, executor: null, error: null, detail: null,
  };
  try {
    await db('job_runs').insert(row);
  } catch (e) {
    if (isUniqueViolation(e)) return null;
    throw e;
  }
  return toRun(row);
}

/** 被跳过的触发：单独一行（scheduled_at 为空，原计划时间放进 detail） */
export async function recordSkippedRun(db: Knex, r: {
  name: ScheduledJobName; scheduledAt: string; trigger: JobRun['trigger']; status: 'skipped-locked' | 'skipped-duplicate'; host?: string;
}): Promise<JobRunRow> {
  const now = nowIso();
  const row = {
    run_id: randomUUID(), name: r.name, subject_id: null, scheduled_at: null, started_at: now, finished_at: now,
    status: r.status, host: (r.host ?? hostname()).slice(0, 128), trigger: r.trigger, attempt: 1, executor: null, error: null,
    detail: jsonOut({ scheduledAt: r.scheduledAt }),
  };
  await db('job_runs').insert(row);
  return toRun(row);
}

export async function finishRun(db: Knex, runId: string, r: { status: 'ok' | 'failed'; error?: string; detail?: Record<string, unknown> }): Promise<JobRunRow | undefined> {
  await db('job_runs').where({ run_id: runId }).update({
    status: r.status, finished_at: nowIso(), error: r.error ? r.error.slice(0, 4000) : null,
    ...(r.detail ? { detail: jsonOut(r.detail) } : {}),
  });
  return getRun(db, runId);
}

export async function getRun(db: Knex, runId: string): Promise<JobRunRow | undefined> {
  const r = (await db('job_runs').where({ run_id: runId }).first()) as Row | undefined;
  return r ? toRun(r) : undefined;
}

export async function findScheduledRun(db: Knex, name: string, scheduledAt: string): Promise<JobRunRow | undefined> {
  const r = (await db('job_runs').where({ name, scheduled_at: scheduledAt }).first()) as Row | undefined;
  return r ? toRun(r) : undefined;
}

/** 定时任务的运行记录（不含流水线步骤与队列失败行） */
export async function listScheduledRuns(db: Knex, opts: { limit: number; name?: string }): Promise<JobRunRow[]> {
  const q = db('job_runs').whereNot('name', 'like', 'pipeline.%').whereNot('name', 'like', 'queue.%');
  if (opts.name) q.where({ name: opts.name });
  const rows = (await q.orderBy('started_at', 'desc').limit(Math.max(1, Math.min(1000, opts.limit)))) as Row[];
  return rows.map(toRun);
}

/** 某任务最近一次成功运行（cron 档补跑判断、探针） */
export async function lastOkRun(db: Knex, name: string): Promise<JobRunRow | undefined> {
  const r = (await db('job_runs').where({ name, status: 'ok' }).orderBy('started_at', 'desc').first()) as Row | undefined;
  return r ? toRun(r) : undefined;
}

// ---------------------------------------------------------------------------------------------
// PhotoPipeline 步骤（06#workflow 第 1 节）
// ---------------------------------------------------------------------------------------------
export interface StepRecord {
  step: 'thumbnail' | 'tag' | 'decide' | 'finalize' | 'notify' | string;
  photoId: string;
  executor: string;
  attempt?: number;
  status: 'ok' | 'failed' | 'running';
  startedAt: string;
  finishedAt?: string;
  error?: string;
  detail?: Record<string, unknown>;
}

export async function recordStep(db: Knex, s: StepRecord): Promise<string> {
  const runId = randomUUID();
  await db('job_runs').insert({
    run_id: runId, name: `pipeline.${s.step}`.slice(0, 64), subject_id: s.photoId, scheduled_at: null, started_at: s.startedAt,
    finished_at: s.finishedAt ?? (s.status === 'running' ? null : nowIso()), status: s.status, host: hostname().slice(0, 128),
    trigger: 'pipeline', attempt: s.attempt ?? 1, executor: s.executor, error: s.error ? s.error.slice(0, 4000) : null,
    detail: jsonOut(s.detail ?? null),
  });
  return runId;
}

export async function listSteps(db: Knex, photoId: string): Promise<JobRunRow[]> {
  const rows = (await db('job_runs').where({ subject_id: photoId }).where('name', 'like', 'pipeline.%').orderBy('started_at', 'asc')) as Row[];
  return rows.map(toRun);
}

/** 最近一段时间的流水线统计（workflow 的 capabilities detail） */
export async function pipelineStatsSince(db: Knex, since: string): Promise<{ photos: number; retries: number; failed: number }> {
  const base = () => db('job_runs').where('name', 'pipeline.thumbnail').andWhere('started_at', '>=', since);
  const photos = countOf(await base().countDistinct({ count: 'subject_id' }).first());
  const retries = countOf(await base().where('attempt', '>', 1).count({ count: '*' }).first());
  const failed = countOf(await base().where({ status: 'failed' }).count({ count: '*' }).first());
  return { photos, retries, failed };
}

// ---------------------------------------------------------------------------------------------
// 队列：本地死信与幂等记录
// ---------------------------------------------------------------------------------------------
export async function recordQueueFailure(db: Knex, f: {
  jobId: string; name: string; payload: unknown; attempts: number; error: string; source: 'sync' | 'memory' | 'sqs-dlq'; enqueuedAt?: string;
}): Promise<string> {
  const runId = randomUUID();
  const now = nowIso();
  await db('job_runs').insert({
    run_id: runId, name: `queue.${f.name}`.slice(0, 64), subject_id: f.jobId.slice(0, 64), scheduled_at: null,
    started_at: f.enqueuedAt ?? now, finished_at: now, status: 'failed', host: hostname().slice(0, 128), trigger: 'queue',
    attempt: f.attempts, executor: f.source, error: f.error.slice(0, 4000),
    detail: jsonOut({ jobId: f.jobId, payload: f.payload, attempts: f.attempts, source: f.source }),
  });
  return runId;
}

export async function countQueueFailuresSince(db: Knex, since: string): Promise<number> {
  return countOf(await db('job_runs').where('name', 'like', 'queue.%').andWhere({ status: 'failed' })
    .andWhere('finished_at', '>=', since).count({ count: '*' }).first());
}

export async function listQueueFailures(db: Knex, limit = 50): Promise<JobRunRow[]> {
  const rows = (await db('job_runs').where('name', 'like', 'queue.%').orderBy('finished_at', 'desc').limit(limit)) as Row[];
  return rows.map(toRun);
}

export async function isJobProcessed(db: Knex, key: string): Promise<boolean> {
  return Boolean(await db('processed_jobs').where({ job_key: key.slice(0, 128) }).first());
}

export async function markJobProcessed(db: Knex, key: string, name: string): Promise<void> {
  try {
    await db('processed_jobs').insert({ job_key: key.slice(0, 128), name, processed_at: nowIso() });
  } catch (e) {
    if (!isUniqueViolation(e)) throw e;
  }
}

// ---------------------------------------------------------------------------------------------
// 保留期删除（processed_jobs 等；白名单 + 主键分批，SQLite 与 PostgreSQL 写法相同。outbox_emails、audit_log 用各自仓储的函数）
// ---------------------------------------------------------------------------------------------
const RETENTION_TABLES = {
  processed_jobs: { column: 'processed_at', pk: 'job_key' },
  job_runs: { column: 'started_at', pk: 'run_id' },
  notification_deliveries: { column: 'at', pk: 'id' },
  capability_events: { column: 'ts', pk: 'id' },
} as const;
export type RetentionTable = keyof typeof RETENTION_TABLES;

/** 分批删除 `column < cutoff` 的行；返回删除的行数。onBatch 可在批次间收集被删除的行（例如 .eml 路径） */
export async function purgeBefore(db: Knex, table: RetentionTable, cutoffIso: string, opts: {
  batch?: number; maxBatches?: number; select?: string[]; onBatch?: (rows: Row[]) => Promise<void>;
} = {}): Promise<number> {
  const { column, pk } = RETENTION_TABLES[table];
  const batch = Math.max(1, opts.batch ?? 1000);
  const maxBatches = opts.maxBatches ?? 1000;
  let total = 0;
  for (let i = 0; i < maxBatches; i++) {
    const rows = (await db(table).select([pk, ...(opts.select ?? [])]).where(column, '<', cutoffIso).orderBy(column, 'asc').limit(batch)) as Row[];
    if (!rows.length) break;
    await opts.onBatch?.(rows);
    total += await db(table).whereIn(pk, rows.map((r) => r[pk] as string | number)).del();
    if (rows.length < batch) break;
  }
  return total;
}
