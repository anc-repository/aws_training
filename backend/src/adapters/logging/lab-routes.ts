// backend/src/adapters/logging/lab-routes.ts —— logging 的 /lab 侧路端点（05#logging 第 1、3、5 节；仅管理员）
//
//   GET /api/lab/logs                 ?store=local|cloudwatch&source=api,worker,audit,nginx&level=&q=&requestId=&traceId=&from=&to=&limit=
//                                     local：本机倒序扫描当前文件与 .1（meta.engine=local-scan、scannedBytes、truncated）；
//                                     cloudwatch：requestId / traceId 与关键字走 FilterLogEvents（sync，行带 eventTs / ingestedAt），
//                                     q 以 fields / filter / stats … 开头时走 Logs Insights（async，返回 queryId）
//   GET /api/lab/logs/results/:queryId  Logs Insights 结果（done、rows、meta.scannedBytes = statistics.bytesScanned）
// 同一查询可以在 store=local|cloudwatch 两侧并排执行（cloudwatch 档本地文件照写）。对比实验 experiments/logging 只经这里
// 取服务端证据（本机扫描的字节与用时、CloudWatch 的 ingestionTime 与扫描字节），不在工作台上调用 AWS SDK。
// 注册：与 http/routes/*.ts 相同的 register(app, c) 形状；由集成阶段加入 http/app.ts 的 ROUTE_MODULES（先于 routes/lab.ts）。
import type { Express, Request } from 'express';
import type { Container } from '../../container.js';
import { HttpError } from '../../errors.js';
import { requireAdmin } from '../../http/middleware/admin.js';
import { requireAuth } from '../../http/middleware/auth.js';
import type { LogLevel } from '../../ports/logger.js';
import { describeAwsError, isAwsAccessDenied } from '../aws/clients.js';
import { LOG_SOURCES, createLogReaders, type LogQuery, type LogSource } from './readers.js';

export const PATHS = ['/api/lab/logs', '/api/lab/logs/results/:queryId'] as const;

const LEVELS: readonly LogLevel[] = ['debug', 'info', 'warn', 'error'];
const DEFAULT_WINDOW_MS = 3600_000;
const MAX_WINDOW_MS = 14 * 86_400_000;

type Ctx = Pick<Container, 'config' | 'aws'>;

function str(req: Request, key: string): string | undefined {
  const v = req.query[key];
  return typeof v === 'string' && v !== '' ? v : undefined;
}

/** 查询参数 → LogQuery（400 VALIDATION_FAILED） */
export function parseLogQuery(req: Request, now = Date.now()): { store: 'local' | 'cloudwatch'; query: LogQuery } {
  const store = str(req, 'store') ?? 'local';
  if (store !== 'local' && store !== 'cloudwatch') throw new HttpError(400, 'VALIDATION_FAILED', 'store 只能是 local 或 cloudwatch');
  const to = str(req, 'to') ? Date.parse(str(req, 'to')!) : now;
  const from = str(req, 'from') ? Date.parse(str(req, 'from')!) : to - DEFAULT_WINDOW_MS;
  if (!Number.isFinite(from) || !Number.isFinite(to) || from > to) throw new HttpError(400, 'VALIDATION_FAILED', 'from / to 必须是 ISO 时间且 from ≤ to');
  if (to - from > MAX_WINDOW_MS) throw new HttpError(400, 'VALIDATION_FAILED', '时间范围最多 14 天');
  const limitRaw = str(req, 'limit');
  const limit = limitRaw === undefined ? 100 : Number(limitRaw);
  if (!Number.isInteger(limit) || limit < 1 || limit > 10_000) throw new HttpError(400, 'VALIDATION_FAILED', 'limit 必须是 1～10000 的整数');
  const sources = str(req, 'source')?.split(',').map((s) => s.trim()).filter(Boolean);
  for (const s of sources ?? []) if (!(LOG_SOURCES as readonly string[]).includes(s)) throw new HttpError(400, 'VALIDATION_FAILED', `source 只能是 ${LOG_SOURCES.join(' / ')}`);
  const level = str(req, 'level');
  if (level && !(LEVELS as readonly string[]).includes(level)) throw new HttpError(400, 'VALIDATION_FAILED', 'level 只能是 debug / info / warn / error');
  const q = str(req, 'q');
  if (q && q.length > 2000) throw new HttpError(400, 'VALIDATION_FAILED', 'q 最长 2000 字符');
  const id = /^[A-Za-z0-9._:-]{1,128}$/;
  const requestId = str(req, 'requestId');
  const traceId = str(req, 'traceId');
  if ((requestId && !id.test(requestId)) || (traceId && !id.test(traceId))) throw new HttpError(400, 'VALIDATION_FAILED', 'requestId / traceId 格式无效');
  return {
    store,
    query: {
      from: new Date(from).toISOString(), to: new Date(to).toISOString(), limit,
      ...(q ? { filter: q } : {}), ...(sources?.length ? { sources: sources as LogSource[] } : {}),
      ...(level ? { minLevel: level as LogLevel } : {}), ...(requestId ? { requestId } : {}), ...(traceId ? { traceId } : {}),
    },
  };
}

function awsFailure(e: unknown): HttpError {
  if (e instanceof HttpError) return e;
  if (isAwsAccessDenied(e)) return new HttpError(502, 'LOGGING_ACCESS_DENIED', `CloudWatch Logs 拒绝了查询：${describeAwsError(e)}（检查 PolicyArn）`);
  return new HttpError(502, 'LOGGING_QUERY_FAILED', describeAwsError(e));
}

export function register(app: Express, c: Ctx): void {
  const admin = [requireAuth, requireAdmin];
  const readers = createLogReaders(c.config, c.aws);
  const cloudwatchOff = () => (c.config.logging.LOG_DRIVER !== 'cloudwatch' ? 'LOG_DRIVER=file' : 'IAM_CREDENTIALS=none');

  app.get('/api/lab/logs', ...admin, async (req, res) => {
    res.set('Cache-Control', 'no-store');
    const { store, query } = parseLogQuery(req);
    if (store === 'local') {
      if (query.filter && /^\s*(fields|filter|stats|parse|sort)\b/.test(query.filter)) {
        throw new HttpError(400, 'LOGS_INSIGHTS_ONLY_IN_CLOUDWATCH', '本地查看器只支持关键字；Logs Insights 语句请用 store=cloudwatch');
      }
      const r = await readers.local.query(query);
      res.json({ store, ...r, note: '只覆盖本机当前文件与 .1；Lambda 日志不在本地' });
      return;
    }
    if (!readers.cloudwatch) throw new HttpError(409, 'LOGGING_CLOUDWATCH_OFF', `CloudWatch 一侧不可用（${cloudwatchOff()}）`);
    try {
      res.json({ store, ...(await readers.cloudwatch.query(query)) });
    } catch (e) {
      throw awsFailure(e);
    }
  });

  app.get('/api/lab/logs/results/:queryId', ...admin, async (req, res) => {
    res.set('Cache-Control', 'no-store');
    const id = String(req.params.queryId ?? '');
    if (!/^[A-Za-z0-9-]{8,64}$/.test(id)) throw new HttpError(400, 'VALIDATION_FAILED', 'queryId 格式无效');
    if (!readers.cloudwatch) throw new HttpError(409, 'LOGGING_CLOUDWATCH_OFF', `CloudWatch 一侧不可用（${cloudwatchOff()}）`);
    try {
      res.json({ store: 'cloudwatch', queryId: id, ...(await readers.cloudwatch.results!(id)) });
    } catch (e) {
      throw awsFailure(e);
    }
  });
}
