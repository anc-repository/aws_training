// backend/src/adapters/logging/readers.ts —— LogReader 的两个实现（05#logging 第 1、2、3 节“只读侧”）
//
// 端口 ports/logger.ts 中的 LogReader 是总纲的最小形状（query → mode / rows / queryId）；这里按 05#logging 第 3 节细化：
// 只追加可选字段（sources、minLevel、requestId、traceId）与 results()，返回每次查询的 meta（engine、用时、扫描字节、
// 覆盖的实例），供 /lab 并排对比 store=local|cloudwatch。
//   - FileLogReader（local）：从文件尾部倒序扫描当前文件与 .1（不解压 .gz），逐行 JSON.parse 后过滤，达到 limit 或扫描
//     上限（默认 50 MiB）就停止并返回 truncated=true；只看得到本机最近两天。
//   - CwLogReader（cloudwatch）：requestId / traceId 精确查找走 FilterLogEvents（sync，跨所有日志流）；Logs Insights
//     语句走 StartQuery（async，返回 queryId，results() 轮询 GetQueryResults，statistics.bytesScanned 是计费依据）；
//     其余关键字走 FilterLogEvents 的词语匹配。
// createLogReaders() 给 container / 路由使用：cloudwatch 档下同时提供本地读取器（同一查询在两侧并排执行）。
import { closeSync, openSync, readSync, statSync } from 'node:fs';
import { hostname } from 'node:os';
import path from 'node:path';
import type { CloudWatchLogsClient } from '@aws-sdk/client-cloudwatch-logs';
import type { AppConfig } from '../../config/schema.js';
import type { LogLevel, LogReader } from '../../ports/logger.js';
import { instanceIdentity } from '../../observability/path-header.js';
import { loadAwsPackage, type AwsClients } from '../aws/clients.js';

export type LogSource = 'api' | 'worker' | 'audit' | 'nginx' | 'lambda';
export const LOG_SOURCES: readonly LogSource[] = ['api', 'worker', 'audit', 'nginx'];

export interface LogRecord {
  ts: string;
  level: LogLevel;
  source: LogSource;
  instanceId?: string;
  msg: string;
  requestId?: string;
  traceId?: string;
  fields: Record<string, unknown>;
  /** 原始行的字节数（摄取量估算） */
  sizeBytes?: number;
  /** 仅 cloudwatch：事件时间（PutLogEvents 的 timestamp）与 CloudWatch 收下的时间（ingestionTime）——摄取延迟的服务端证据 */
  eventTs?: string;
  ingestedAt?: string;
}

export interface LogQuery {
  from: string;
  to: string;
  /** local：关键字（子串）；cloudwatch：关键字，或以 fields / filter / stats … 开头的 Logs Insights 语句 */
  filter?: string;
  limit: number;
  sources?: LogSource[];
  minLevel?: LogLevel;
  requestId?: string;
  traceId?: string;
}

export interface LogQueryMeta {
  engine: 'local-scan' | 'filter-log-events' | 'logs-insights';
  tookMs: number;
  scannedBytes?: number;
  instances: string[];
  truncated: boolean;
}

export interface LogQueryResult { mode: 'sync' | 'async'; rows?: LogRecord[]; queryId?: string; meta?: LogQueryMeta }

export interface LabLogReader extends LogReader {
  readonly store: 'local' | 'cloudwatch';
  query(q: LogQuery): Promise<LogQueryResult>;
  results?(queryId: string): Promise<{ done: boolean; rows: LogRecord[]; meta: LogQueryMeta }>;
}

const LEVEL_RANK: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };
const ID_RE = /^[A-Za-z0-9._:-]{1,128}$/;
const INSIGHTS_RE = /^\s*(fields|filter|stats|parse|sort|limit|display|dedup|pattern|unmask)\b/;

function levelOf(v: unknown, status?: unknown): LogLevel {
  if (typeof v === 'string' && v in LEVEL_RANK) return v as LogLevel;
  if (typeof v === 'number') return v >= 50 ? 'error' : v >= 40 ? 'warn' : v >= 30 ? 'info' : 'debug';
  const st = typeof status === 'number' ? status : Number(status);
  if (Number.isFinite(st)) return st >= 500 ? 'error' : st >= 400 ? 'warn' : 'info';
  return 'info';
}

/** 一行 JSON → LogRecord（应用 pino 行与 Nginx cloudalbum_json 行）；不是 JSON 时返回 msg=原文 */
export function toRecord(line: string, source: LogSource, fallbackInstance?: string): LogRecord {
  let o: Record<string, unknown>;
  try {
    o = JSON.parse(line) as Record<string, unknown>;
  } catch {
    return { ts: new Date(0).toISOString(), level: 'info', source, msg: line, ...(fallbackInstance ? { instanceId: fallbackInstance } : {}), fields: {} };
  }
  const { time, ts, level, msg, requestId, rid, traceId, instanceId, ...rest } = o;
  const when = typeof time === 'string' ? time : typeof ts === 'string' ? ts : typeof time === 'number' ? new Date(time).toISOString() : new Date(0).toISOString();
  const isNginx = source === 'nginx';
  const message = typeof msg === 'string' ? msg : isNginx ? `${String(o.method ?? '')} ${String(o.uri ?? '')} ${String(o.status ?? '')}`.trim() : '';
  const reqId = typeof requestId === 'string' ? requestId : typeof rid === 'string' ? rid : undefined;
  const inst = typeof instanceId === 'string' ? instanceId : fallbackInstance;
  return {
    ts: normalizeTs(when), level: levelOf(level, o.status), source, msg: message,
    ...(inst ? { instanceId: inst } : {}), ...(reqId ? { requestId: reqId } : {}), ...(typeof traceId === 'string' ? { traceId } : {}),
    fields: rest, sizeBytes: Buffer.byteLength(line, 'utf8'),
  };
}

function normalizeTs(s: string): string {
  const t = Date.parse(s);
  return Number.isFinite(t) ? new Date(t).toISOString() : s;
}

function matches(r: LogRecord, line: string, q: LogQuery, fromMs: number, toMs: number): boolean {
  const t = Date.parse(r.ts);
  if (Number.isFinite(t) && (t < fromMs || t > toMs)) return false;
  if (q.minLevel && LEVEL_RANK[r.level] < LEVEL_RANK[q.minLevel]) return false;
  if (q.requestId && r.requestId !== q.requestId) return false;
  if (q.traceId && r.traceId !== q.traceId && !line.includes(q.traceId)) return false;
  if (q.filter && !line.includes(q.filter)) return false;
  return true;
}

// ------------------------------------------------------------------------------------------------ local

export interface FileReaderOptions { logDir: string; maxScanBytes?: number; chunkBytes?: number }

export class FileLogReader implements LabLogReader {
  readonly store = 'local' as const;
  private readonly maxScan: number;
  private readonly chunk: number;

  constructor(private readonly opts: FileReaderOptions) {
    this.maxScan = opts.maxScanBytes ?? 50 * 1024 * 1024;
    this.chunk = opts.chunkBytes ?? 64 * 1024;
  }

  fileOf(source: LogSource): string | undefined {
    if (source === 'nginx') return path.join(this.opts.logDir, 'nginx-access.json');
    if (source === 'lambda') return undefined;                                      // Lambda 日志不在本地
    return path.join(this.opts.logDir, `${source}.log`);
  }

  async query(q: LogQuery): Promise<LogQueryResult> {
    const t0 = performance.now();
    const fromMs = Date.parse(q.from);
    const toMs = Date.parse(q.to);
    const sources = (q.sources?.length ? q.sources : LOG_SOURCES).filter((s) => s !== 'lambda');
    const inst = instanceIdentity().instanceId || hostname();
    const rows: LogRecord[] = [];
    let scanned = 0;
    let truncated = false;
    outer: for (const source of sources) {
      const base = this.fileOf(source);
      if (!base) continue;
      for (const file of [base, `${base}.1`]) {
        const r = this.scanFile(file, (line) => {
          const rec = toRecord(line, source, inst);
          if (!matches(rec, line, q, fromMs, toMs)) {
            // 倒序扫描：比 from 更早的行之后（更旧的部分）不必再看
            const t = Date.parse(rec.ts);
            return Number.isFinite(t) && t < fromMs && Date.parse(rec.ts) > 0 ? 'stop' : 'skip';
          }
          rows.push(rec);
          return rows.length >= q.limit ? 'stop' : 'skip';
        }, this.maxScan - scanned);
        scanned += r.bytes;
        if (r.budgetHit) { truncated = true; break outer; }
        if (rows.length >= q.limit) { truncated = true; break outer; }
        if (r.stoppedEarly) break;
      }
    }
    rows.sort((a, b) => a.ts.localeCompare(b.ts));
    return {
      mode: 'sync', rows,
      meta: { engine: 'local-scan', tookMs: Math.round(performance.now() - t0), scannedBytes: scanned, instances: [inst], truncated },
    };
  }

  /** 从文件尾部倒序读行；visit 返回 'stop' 结束本文件 */
  private scanFile(file: string, visit: (line: string) => 'stop' | 'skip', budget: number): { bytes: number; budgetHit: boolean; stoppedEarly: boolean } {
    let size: number;
    try {
      size = statSync(file).size;
    } catch {
      return { bytes: 0, budgetHit: false, stoppedEarly: false };
    }
    const fd = openSync(file, 'r');
    let pos = size;
    let bytes = 0;
    let carry = Buffer.alloc(0);
    try {
      while (pos > 0) {
        if (bytes >= budget) return { bytes, budgetHit: true, stoppedEarly: true };
        const len = Math.min(this.chunk, pos, Math.max(1, budget - bytes));
        pos -= len;
        const buf = Buffer.alloc(len);
        readSync(fd, buf, 0, len, pos);
        bytes += len;
        const all = Buffer.concat([buf, carry]);
        const text = all.toString('utf8');
        const lines = text.split('\n');
        const first = lines.shift() ?? '';                      // 可能不完整：留到下一块
        carry = Buffer.from(first, 'utf8');
        for (let i = lines.length - 1; i >= 0; i -= 1) {
          const l = lines[i]!.trim();
          if (l && visit(l) === 'stop') return { bytes, budgetHit: false, stoppedEarly: true };
        }
      }
      const last = carry.toString('utf8').trim();
      if (last && visit(last) === 'stop') return { bytes, budgetHit: false, stoppedEarly: true };
      return { bytes, budgetHit: false, stoppedEarly: false };
    } finally {
      closeSync(fd);
    }
  }
}

// ------------------------------------------------------------------------------------------- cloudwatch

export interface CwReaderOptions {
  groupApp: string;
  groupNginx?: string;
  /** Lambda 日志组前缀（cloudalbum-<env>-*）；只在显式请求 lambda 来源时纳入 */
  lambdaPrefix?: string;
  aws: AwsClients;
}

type LogsSdk = typeof import('@aws-sdk/client-cloudwatch-logs');

export class CwLogReader implements LabLogReader {
  readonly store = 'cloudwatch' as const;
  private readonly started = new Map<string, { t0: number; groups: string[] }>();

  constructor(private readonly opts: CwReaderOptions) {}

  private sdk(): Promise<LogsSdk> {
    return loadAwsPackage('@aws-sdk/client-cloudwatch-logs', () => import('@aws-sdk/client-cloudwatch-logs'));
  }

  private client(): Promise<CloudWatchLogsClient> {
    return this.opts.aws.cloudwatchLogs();
  }

  /** 来源 → 日志组；app 组内按日志流后缀区分 api / worker / audit */
  groupsFor(sources: readonly LogSource[] | undefined): Array<{ group: string; source: LogSource | 'app' }> {
    const want = sources?.length ? sources : LOG_SOURCES;
    const out: Array<{ group: string; source: LogSource | 'app' }> = [];
    if (want.some((s) => s === 'api' || s === 'worker' || s === 'audit')) out.push({ group: this.opts.groupApp, source: 'app' });
    if (want.includes('nginx') && this.opts.groupNginx) out.push({ group: this.opts.groupNginx, source: 'nginx' });
    return out;
  }

  async query(q: LogQuery): Promise<LogQueryResult> {
    const t0 = performance.now();
    const sdk = await this.sdk();
    const client = await this.client();
    const groups = this.groupsFor(q.sources);
    const startTime = Date.parse(q.from);
    const endTime = Date.parse(q.to);
    if (q.filter && INSIGHTS_RE.test(q.filter)) {
      const r = await client.send(new sdk.StartQueryCommand({
        logGroupNames: groups.map((g) => g.group), startTime: Math.floor(startTime / 1000), endTime: Math.ceil(endTime / 1000),
        queryString: q.filter, limit: Math.min(q.limit, 10_000),
      }));
      if (!r.queryId) throw new Error('StartQuery 没有返回 queryId');
      this.started.set(r.queryId, { t0: Date.now(), groups: groups.map((g) => g.group) });
      return { mode: 'async', queryId: r.queryId };
    }
    let filterPattern: string | undefined;
    if (q.requestId) {
      if (!ID_RE.test(q.requestId)) throw new Error('requestId 格式无效');
    } else if (q.traceId) {
      if (!ID_RE.test(q.traceId)) throw new Error('traceId 格式无效');
      filterPattern = `{ $.traceId = "${q.traceId}" }`;
    } else if (q.filter) {
      filterPattern = `"${q.filter.replace(/["\\]/g, '')}"`;
    }
    const rows: LogRecord[] = [];
    let truncated = false;
    for (const g of groups) {
      // requestId：应用日志的字段是 requestId，Nginx 访问日志的字段是 rid（同一个值，总纲 2.5）
      const pattern = q.requestId ? `{ $.${g.source === 'nginx' ? 'rid' : 'requestId'} = "${q.requestId}" }` : filterPattern;
      let nextToken: string | undefined;
      do {
        const r = await client.send(new sdk.FilterLogEventsCommand({
          logGroupName: g.group, startTime, endTime, ...(pattern ? { filterPattern: pattern } : {}),
          limit: Math.min(q.limit - rows.length, 10_000), ...(nextToken ? { nextToken } : {}),
        }));
        for (const ev of r.events ?? []) {
          const source = g.source === 'nginx' ? 'nginx' : sourceOfStream(ev.logStreamName);
          if (q.sources?.length && !q.sources.includes(source)) continue;
          const rec = toRecord(ev.message ?? '', source, ev.logStreamName?.split('/')[0]);
          if (q.minLevel && LEVEL_RANK[rec.level] < LEVEL_RANK[q.minLevel]) continue;
          if (ev.timestamp) rec.eventTs = new Date(ev.timestamp).toISOString();
          if (ev.ingestionTime) rec.ingestedAt = new Date(ev.ingestionTime).toISOString();
          rows.push(rec);
        }
        nextToken = r.nextToken;
        if (rows.length >= q.limit) { truncated = Boolean(nextToken); break; }
      } while (nextToken);
      if (rows.length >= q.limit) break;
    }
    rows.sort((a, b) => a.ts.localeCompare(b.ts));
    return {
      mode: 'sync', rows,
      meta: { engine: 'filter-log-events', tookMs: Math.round(performance.now() - t0), instances: [...new Set(rows.map((r) => r.instanceId).filter((x): x is string => Boolean(x)))], truncated },
    };
  }

  async results(queryId: string): Promise<{ done: boolean; rows: LogRecord[]; meta: LogQueryMeta }> {
    const sdk = await this.sdk();
    const client = await this.client();
    const r = await client.send(new sdk.GetQueryResultsCommand({ queryId }));
    const done = ['Complete', 'Failed', 'Cancelled', 'Timeout'].includes(String(r.status));
    const rows: LogRecord[] = (r.results ?? []).map((fields) => {
      const o: Record<string, string> = {};
      for (const f of fields) if (f.field) o[f.field] = f.value ?? '';
      const stream = o['@logStream'];
      return {
        ts: normalizeTs(o['@timestamp'] ?? new Date(0).toISOString()), level: levelOf(o.level, o.status),
        source: stream ? sourceOfStream(stream) : 'api', msg: o['@message'] ?? o.msg ?? '',
        ...(stream ? { instanceId: stream.split('/')[0] } : {}), ...(o.requestId || o.rid ? { requestId: o.requestId || o.rid } : {}),
        fields: o,
      };
    });
    const started = this.started.get(queryId);
    if (done) this.started.delete(queryId);
    return {
      done, rows,
      meta: {
        engine: 'logs-insights', tookMs: started ? Date.now() - started.t0 : 0,
        ...(r.statistics?.bytesScanned !== undefined ? { scannedBytes: r.statistics.bytesScanned } : {}),
        instances: [...new Set(rows.map((x) => x.instanceId).filter((x): x is string => Boolean(x)))], truncated: false,
      },
    };
  }
}

/** `i-0abc…/api` → api；`i-0abc…/access` → nginx */
export function sourceOfStream(stream: string | undefined): LogSource {
  const suffix = stream?.split('/').pop() ?? '';
  if (suffix === 'access' || suffix === 'error') return 'nginx';
  if (suffix === 'worker' || suffix === 'audit' || suffix === 'api') return suffix;
  return 'api';
}

/** container / 路由：本地读取器总是存在；cloudwatch 档另有 CloudWatch 读取器（同一查询两侧并排执行） */
export function createLogReaders(cfg: AppConfig, aws: AwsClients): { local: FileLogReader; cloudwatch?: CwLogReader } {
  const local = new FileLogReader({ logDir: cfg.logging.LOG_DIR });
  const l = cfg.logging;
  if (l.LOG_DRIVER !== 'cloudwatch' || !aws.enabled) return { local };
  return {
    local,
    cloudwatch: new CwLogReader({
      groupApp: l.LOG_CW_GROUP_APP, ...(l.LOG_CW_GROUP_NGINX ? { groupNginx: l.LOG_CW_GROUP_NGINX } : {}),
      lambdaPrefix: `/aws/lambda/cloudalbum-${cfg.core.CLOUDALBUM_ENV}-`, aws,
    }),
  };
}
