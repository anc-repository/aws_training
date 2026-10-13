// backend/src/cli/platform/lab-metrics.ts —— `cloudalbum lab-metrics --run <runId> [--pad 0..120] --json`（06 PM-14）
//
// 平台对对比实验做服务端佐证（01 §9.5、04 §7.4 第 5～7 步）：
//   app    ← LabMetricsStore 中带该 runId 的分钟汇总（实验请求按 runId 单独成组）；byTarget 由路径签名的 entry 段映射
//            （nginx → direct；cloudfront>… → cdn；alb>… → alb；apigw>… → apigw）；pathSignatures 取前 20 项
//   origin ← Nginx 访问日志中 run 等于该 runId 的行（覆盖 Nginx 直接返回的静态文件与经 8080 回源的请求）；byPort 按 port 字段
//   两部分都排除平台探测请求（probe=1；应用侧的探测请求本来就不进汇总，PM-10）
// runId 未登记 → 退出 4；时间窗尚未结束时照样输出，并带 "open": true。
import path from 'node:path';
import type { Knex } from 'knex';
import type { Command, Option } from 'commander';
import type { LabMetricsRun } from '@cloudalbum/contracts';
import type { AppConfig } from '../../config/schema.js';
import { jsonIn } from '../../db/dialect.js';
import { DEFAULT_RUN_WINDOW_SEC } from '../../observability/bypass.js';
import { LogHistogram } from '../../observability/lab-metrics.js';
import { scanNginxLog } from '../../observability/nginx-log.js';
import { getLabRun } from '../../repositories/lab.js';
import { action, emit, envDirOf, intArg, notFound, RUN_ID_RE, usage, withDb } from './common.js';

/** 路径签名中某段的值（`entry=cloudfront>nginx;storage=s3:presign` → entry → cloudfront>nginx） */
export function segmentOf(signature: string, segment: string): string | undefined {
  for (const part of signature.split(';')) {
    const eq = part.indexOf('=');
    if (eq > 0 && part.slice(0, eq).trim() === segment) return part.slice(eq + 1).trim();
  }
  return undefined;
}

export function targetOfEntry(entry: string | undefined): 'direct' | 'cdn' | 'alb' | 'apigw' {
  if (!entry) return 'direct';
  if (entry.startsWith('cloudfront>')) return 'cdn';
  if (entry.startsWith('alb>')) return 'alb';
  if (entry.startsWith('apigw>')) return 'apigw';
  return 'direct';
}

function percentile(values: number[], p: number): number {
  if (!values.length) return 0;
  const s = [...values].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.max(0, Math.ceil((p / 100) * s.length) - 1))]!;
}

export interface LabMetricsOptions { padSec?: number; now?: Date; nginxLogFiles?: string[] }

export async function labMetricsRun(db: Knex, cfg: AppConfig, runId: string, opts: LabMetricsOptions = {}): Promise<LabMetricsRun> {
  const run = await getLabRun(db, runId);
  if (!run) throw notFound('RUN_NOT_FOUND', `runId ${runId} is not registered (POST /api/lab/runs)`);
  const padSec = opts.padSec ?? 30;
  const now = opts.now ?? new Date();
  const started = Date.parse(run.started_at);
  const finished = run.finished_at ? Date.parse(run.finished_at) : NaN;
  const windowSec = run.window_sec ? Number(run.window_sec)
    : Number.isFinite(finished) ? Math.max(1, Math.round((finished - started) / 1000)) : DEFAULT_RUN_WINDOW_SEC;
  const from = new Date(started - padSec * 1000);
  const to = new Date(started + (windowSec + padSec) * 1000);

  // ---- app：分钟汇总
  const rows = (await db('lab_metric_rollups').where({ kind: 'route', run_id: runId })) as Array<Record<string, unknown>>;
  const byTarget = { direct: 0, cdn: 0, alb: 0, apigw: 0 };
  const byStatus = { '2xx': 0, '4xx': 0, '5xx': 0 };
  const sigs = new Map<string, number>();
  const routes = new Map<string, LogHistogram>();
  let requests = 0;
  for (const r of rows) {
    const count = Number(r.count ?? 0);
    const errors = Number(r.errors ?? 0);
    requests += count;
    const sig = String(r.path_sig ?? '');
    byTarget[targetOfEntry(segmentOf(sig, 'entry'))] += count;
    const sc = r.status_class === null || r.status_class === undefined ? null : String(r.status_class);
    if (sc === '5xx') byStatus['5xx'] += count;
    else if (sc === '4xx') byStatus['4xx'] += count;
    else if (sc === null) { byStatus['5xx'] += errors; byStatus['2xx'] += count - errors; }
    else byStatus['2xx'] += count;                       // 2xx 与 3xx（304 等）都记为成功
    sigs.set(sig, (sigs.get(sig) ?? 0) + count);
    const route = String(r.route ?? '');
    const h = routes.get(route) ?? new LogHistogram();
    h.merge({ counts: jsonIn<number[]>(r.hist, []) ?? [], count, sum: Number(r.sum_ms ?? 0), max: Number(r.max_ms ?? 0) });
    routes.set(route, h);
  }

  // ---- origin：Nginx 访问日志（新格式的 run / port / probe 字段；旧格式的行被跳过）
  const logDir = path.join(cfg.core.CLOUDALBUM_DATA_DIR, 'logs');
  const files = opts.nginxLogFiles ?? [path.join(logDir, 'nginx-access.json.1'), path.join(logDir, 'nginx-access.json')];
  const origin = { source: 'nginx-access-log' as const, requests: 0, byPort: {} as Record<string, number>, viaCloudfront: 0, viaAlb: 0 };
  let excludedProbeRequests = 0;
  await scanNginxLog(files, (l) => {
    if (!l.run || l.run.toUpperCase() !== runId) return;
    if (l.probe) { excludedProbeRequests += 1; return; }
    origin.requests += 1;
    const port = l.port ?? 'unknown';
    origin.byPort[port] = (origin.byPort[port] ?? 0) + 1;
    if (l.cfId) origin.viaCloudfront += 1;
    if (l.albTrace) origin.viaAlb += 1;
  });

  // ---- host：时间窗内的主机采样
  const samples = (await db('lab_host_samples').where('ts', '>=', from.toISOString()).andWhere('ts', '<=', to.toISOString())
    .select('instance_id', 'cpu_pct', 'net_tx_bytes', 'net_rx_bytes')) as Array<Record<string, unknown>>;
  const cpu = samples.map((s) => Number(s.cpu_pct)).filter((v) => Number.isFinite(v));
  const delta = (col: string) => {
    const per = new Map<string, number[]>();
    for (const s of samples) {
      const v = Number(s[col]);
      if (!Number.isFinite(v) || s[col] === null) continue;
      const k = String(s.instance_id);
      per.set(k, [...(per.get(k) ?? []), v]);
    }
    let sum = 0;
    for (const vs of per.values()) sum += Math.max(...vs) - Math.min(...vs);
    return sum;
  };

  return {
    schema: 'cloudalbum.lab-metrics-run/v1',
    runId,
    registered: {
      module: run.module, experiment: run.experiment, label: run.label, startedAt: run.started_at, windowSec,
      ...(run.variant ? { variant: run.variant } : {}),
    },
    window: { from: from.toISOString(), to: to.toISOString(), padSec },
    ...(now.getTime() < started + windowSec * 1000 ? { open: true } : {}),
    app: {
      requests, byTarget, byStatus,
      pathSignatures: [...sigs.entries()].sort((a, b) => b[1] - a[1]).slice(0, 20).map(([signature, count]) => ({ signature, count })),
      routes: Object.fromEntries([...routes.entries()].map(([r, h]) => [r, { count: h.count, p50: h.percentile(50), p95: h.percentile(95) }])),
    },
    origin,
    host: { cpuP95: percentile(cpu, 95), netTxBytes: delta('net_tx_bytes'), netRxBytes: delta('net_rx_bytes') },
    excludedProbeRequests,
  };
}

export function registerLabMetrics(program: Command, envDirOption: () => Option): void {
  program.command('lab-metrics')
    .description('按 runId 汇总服务端指标（06 PM-14：对比实验的服务端佐证）')
    .addOption(envDirOption())
    .requiredOption('--run <runId>', '实验运行 ID（ULID）')
    .option('--pad <sec>', '时间窗前后的余量 0..120 秒（默认 30）')
    .option('--json', 'JSON 输出（默认）')
    .action(action(async (opts: { envDir?: string; run: string; pad?: string }) => {
      const runId = opts.run.trim().toUpperCase();
      if (!RUN_ID_RE.test(runId)) throw usage('ARG_INVALID', '--run must be a ULID');
      const padSec = intArg('pad', opts.pad, 0, 120, 30);
      emit(await withDb(envDirOf(opts), (db, cfg) => labMetricsRun(db, cfg, runId, { padSec })));
    }));
}
