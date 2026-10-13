// backend/src/cli/platform/path-seen.ts —— `path-seen`（06 PM-16，P0）与 `app-stat`（P1）
//
//   path-seen --segment <模块 id 或 entry> --pattern <正则，≤128 字符> --window <1m..24h> [--min-count n] [--distinct] --json
//     从 LabMetricsStore 的分钟汇总中查找真实请求（探测请求本来就不进汇总，PM-10）的路径签名，对指定段的值
//     （driver[@host][:outcome]）做匹配。输出 {count, distinctValues, firstTs, lastTs, samples[≤3]}。
//     06 要求用 RE2 求值：仓库没有 RE2 依赖，这里拒绝回溯类构造（反向引用、环视、嵌套量词）后用 JS 正则求值，效果等价于 RE2 的子集。
//   app-stat --stat <统计名> [--run <runId>] --json
//     统计名白名单（06 PM-16 的表）；未知统计名退出 2；本轮未实现的统计名退出 3（STAT_UNAVAILABLE）。
import type { Knex } from 'knex';
import type { Command, Option } from 'commander';
import { isModuleId, type PathSeenResult } from '@cloudalbum/contracts';
import { countOf } from '../../db/dialect.js';
import { DEFAULT_RUN_WINDOW_SEC } from '../../observability/bypass.js';
import { getLabRun } from '../../repositories/lab.js';
import { segmentOf } from './lab-metrics.js';
import { action, emit, envDirOf, intArg, notFound, RUN_ID_RE, unavailable, usage, withDb } from './common.js';

/** 拒绝回溯类构造（RE2 不支持的语法）：反向引用、环视、命名反向引用、嵌套量词 */
export function compileSafePattern(pattern: string): RegExp {
  if (!pattern || pattern.length > 128) throw usage('PATTERN_INVALID', '--pattern must be 1..128 characters');
  if (/\\[1-9]|\\k<|\(\?[=!]|\(\?<[=!]/.test(pattern)) throw usage('PATTERN_UNSUPPORTED', 'backreferences and lookarounds are not allowed (RE2 subset)');
  if (/\((?:[^()\\]|\\.)*[+*}](?:[^()\\]|\\.)*\)\s*[+*{]/.test(pattern)) throw usage('PATTERN_UNSUPPORTED', 'nested quantifiers are not allowed (RE2 subset)');
  try {
    return new RegExp(pattern);
  } catch (e) {
    throw usage('PATTERN_INVALID', (e as Error).message);
  }
}

/** --window 1m..24h（分钟级汇总保留 2 天，见 lab.compact） */
export function parseWindow(raw: string): number {
  const m = /^([1-9][0-9]{0,3})(m|h)$/.exec(raw.trim());
  if (!m) throw usage('WINDOW_INVALID', '--window must look like 15m or 2h');
  const minutes = Number(m[1]) * (m[2] === 'h' ? 60 : 1);
  if (minutes < 1 || minutes > 24 * 60) throw usage('WINDOW_INVALID', '--window must be 1m..24h (beyond the minute-level retention)');
  return minutes;
}

export async function pathSeen(db: Knex, q: { segment: string; pattern: RegExp; windowMin: number; distinct?: boolean; now?: Date }): Promise<PathSeenResult> {
  const now = q.now ?? new Date();
  const from = new Date(now.getTime() - q.windowMin * 60_000);
  from.setUTCSeconds(0, 0);
  const rows = (await db('lab_metric_rollups').where({ kind: 'route' }).andWhere('minute', '>=', from.toISOString())
    .select('minute', 'method', 'route', 'path_sig', 'count').orderBy('minute', 'asc')) as Array<Record<string, unknown>>;
  let count = 0;
  const distinct = new Set<string>();
  let firstTs: string | null = null;
  let lastTs: string | null = null;
  const samples: PathSeenResult['samples'] = [];
  for (const r of rows) {
    const value = segmentOf(String(r.path_sig ?? ''), q.segment);
    if (value === undefined || !q.pattern.test(value)) continue;
    const n = Number(r.count ?? 0);
    count += n;
    distinct.add(value);
    const ts = String(r.minute);
    firstTs ??= ts;
    lastTs = ts;
    if (samples.length < 3) samples.push({ ts, route: `${String(r.method ?? '')} ${String(r.route ?? '')}`.trim(), value });
  }
  return { count, distinctValues: [...distinct].sort(), firstTs, lastTs, samples };
}

// ------------------------------------------------------------------------------------------------ app-stat

/** 统计名白名单（06 PM-16）：run = 是否支持 --run（'only' = 只按运行） */
export const APP_STATS: Record<string, { unit: string; run: boolean | 'only'; implemented: boolean }> = {
  'photos.count': { unit: 'count', run: false, implemented: true },
  'users.count': { unit: 'count', run: false, implemented: true },
  'albums.count': { unit: 'count', run: false, implemented: true },
  'jobs.pending': { unit: 'count', run: true, implemented: true },
  'jobs.failed': { unit: 'count', run: true, implemented: true },
  'biz.jobs_lost': { unit: 'count', run: 'only', implemented: false },
  'biz.photo_time_to_ready_p95': { unit: 'ms', run: 'only', implemented: true },
  'queue.dlq_depth': { unit: 'count', run: false, implemented: false },
  'outbox.count': { unit: 'count', run: true, implemented: true },
  'notifications.count': { unit: 'count', run: true, implemented: true },
  'security.findings': { unit: 'count', run: false, implemented: true },
  'cache.hit_ratio_1m': { unit: 'ratio', run: false, implemented: false },
  'lab.seed.photos': { unit: 'count', run: false, implemented: true },
};

async function count(db: Knex, table: string, where: (q: Knex.QueryBuilder) => void = () => undefined): Promise<number> {
  const q = db(table);
  where(q);
  return countOf(await q.count({ count: '*' }).first());
}

export async function appStat(db: Knex, stat: string, runId?: string): Promise<Record<string, unknown>> {
  const def = APP_STATS[stat];
  if (!def) throw usage('STAT_UNKNOWN', `unknown stat ${stat} (${Object.keys(APP_STATS).join(', ')})`);
  if (runId && def.run === false) throw usage('STAT_NO_RUN', `${stat} does not support --run`);
  if (!runId && def.run === 'only') throw usage('STAT_RUN_REQUIRED', `${stat} needs --run`);
  if (!def.implemented) throw unavailable('STAT_UNAVAILABLE', `${stat} is not implemented in this round`);
  let window: { from: string; to: string } | null = null;
  if (runId) {
    const run = await getLabRun(db, runId);
    if (!run) throw notFound('RUN_NOT_FOUND', `runId ${runId} is not registered`);
    const start = Date.parse(run.started_at);
    const end = run.window_sec ? start + Number(run.window_sec) * 1000 : run.finished_at ? Date.parse(run.finished_at) : start + DEFAULT_RUN_WINDOW_SEC * 1000;
    window = { from: new Date(start).toISOString(), to: new Date(end).toISOString() };
  }
  const inWindow = (col: string) => (q: Knex.QueryBuilder) => { if (window) q.where(col, '>=', window.from).andWhere(col, '<=', window.to); };
  let value: number;
  switch (stat) {
    case 'photos.count': value = await count(db, 'photos'); break;
    case 'users.count': value = await count(db, 'users'); break;
    case 'albums.count': value = await count(db, 'albums'); break;
    case 'jobs.pending': value = await count(db, 'job_runs', (q) => { q.where({ status: 'running' }); inWindow('started_at')(q); }); break;
    case 'jobs.failed': value = await count(db, 'job_runs', (q) => { q.where({ status: 'failed' }); inWindow('started_at')(q); }); break;
    case 'outbox.count': value = await count(db, 'outbox_emails', inWindow('created_at')); break;
    case 'notifications.count': value = await count(db, 'notifications', inWindow('created_at')); break;
    case 'security.findings': value = await count(db, 'security_findings', (q) => { q.whereRaw("coalesce(json_extract(detail, '$.owner'), '') <> 'platform'"); }).catch(() => count(db, 'security_findings')); break;
    case 'lab.seed.photos': value = await count(db, 'photos', (q) => { q.where({ seed_id: 'bulk-feed' }); }); break;
    case 'biz.photo_time_to_ready_p95': {
      const rows = (await db('photos').whereNotNull('ready_at').andWhere('created_at', '>=', window!.from).andWhere('created_at', '<=', window!.to)
        .select('created_at', 'ready_at')) as Array<{ created_at: string; ready_at: string }>;
      const d = rows.map((r) => Date.parse(r.ready_at) - Date.parse(r.created_at)).filter((x) => Number.isFinite(x) && x >= 0).sort((a, b) => a - b);
      value = d.length ? d[Math.min(d.length - 1, Math.ceil(0.95 * d.length) - 1)]! : 0;
      break;
    }
    default: throw unavailable('STAT_UNAVAILABLE', `${stat} is not implemented in this round`);
  }
  return { stat, value, unit: def.unit, at: new Date().toISOString(), ...(runId ? { runId } : {}), scope: runId ? 'run' : 'now' };
}

export function registerPathSeen(program: Command, envDirOption: () => Option): void {
  program.command('path-seen')
    .description('路径签名中某段的出现次数（06 PM-16）：真实请求、排除探测流量')
    .addOption(envDirOption())
    .requiredOption('--segment <id>', '模块 id 或 entry')
    .requiredOption('--pattern <regex>', '对段值 driver[@host][:outcome] 的匹配（≤128 字符，RE2 子集）')
    .requiredOption('--window <dur>', '1m..24h')
    .option('--min-count <n>', '至少出现的次数（默认 1）')
    .option('--distinct', '只关心不同取值')
    .option('--json', 'JSON 输出（默认）')
    .action(action(async (opts: { envDir?: string; segment: string; pattern: string; window: string; minCount?: string; distinct?: boolean }) => {
      if (opts.segment !== 'entry' && !isModuleId(opts.segment)) throw usage('SEGMENT_INVALID', '--segment must be a module id or entry');
      const pattern = compileSafePattern(opts.pattern);
      const windowMin = parseWindow(opts.window);
      const minCount = intArg('min-count', opts.minCount, 1, 1_000_000, 1);
      const r = await withDb(envDirOf(opts), (db) => pathSeen(db, { segment: opts.segment, pattern, windowMin, ...(opts.distinct ? { distinct: true } : {}) }));
      emit({ ...r, minCount, satisfied: r.count >= minCount });
    }));

  program.command('app-stat')
    .description('登记的业务统计（06 PM-16）')
    .addOption(envDirOption())
    .requiredOption('--stat <name>', Object.keys(APP_STATS).join(' | '))
    .option('--run <runId>', '按实验运行的时间窗统计')
    .option('--json', 'JSON 输出（默认）')
    .action(action(async (opts: { envDir?: string; stat: string; run?: string }) => {
      const runId = opts.run?.trim().toUpperCase();
      if (runId !== undefined && !RUN_ID_RE.test(runId)) throw usage('ARG_INVALID', '--run must be a ULID');
      if (!APP_STATS[opts.stat]) throw usage('STAT_UNKNOWN', `unknown stat ${opts.stat}`);
      emit(await withDb(envDirOf(opts), (db) => appStat(db, opts.stat, runId)));
    }));
}
