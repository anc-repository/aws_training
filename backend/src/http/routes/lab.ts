// backend/src/http/routes/lab.ts —— /api/lab/*（§7.3、§8）：实验运行登记、指标、最近请求、自检、故障注入、结果（全部仅管理员）
//
//   POST   /api/lab/runs                 {module,experiment,label,params?,forced?,notes?,runId?} → {runId,startedAt}
//   GET    /api/lab/runs                 ?module&limit
//   GET    /api/lab/runs/:runId
//   POST   /api/lab/runs/:runId/finish   {notes?}
//   GET    /api/lab/metrics              ?from&to&route&groupBy=path|driver|instance|route&run → 分钟汇总 + 环形缓冲即时分布 + 主机 / 源站采样
//   GET    /api/lab/requests/recent      ?limit&run&route → Page<LabRequestRecord>
//   GET    /api/lab/self-check           已加载的 AWS SDK 清单（L0 必须为空）、ec2 检查项、密钥指纹、进程心跳
//   GET    /api/lab/echo                 请求头回显（Host、X-Forwarded-*、X-Amzn-Trace-Id、客户端 IP；dns / load-balancer 卡片用）
//   POST   /api/lab/faults               {type,target?,rate?,ms?,durationSec}（总开关 featureFlags['lab.faults']，§8.4）
//   GET    /api/lab/faults
//   DELETE /api/lab/faults[/:id]
//   POST   /api/lab/results              result.schema.json（runner --upload）
//   GET    /api/lab/results              ?module&experiment&label&limit → Page<LabResultRow>
//   GET    /api/lab/results/:runId
//   GET    /api/lab/capability-events    ?module&since&limit（模块状态时间线）
// 模块自己的侧路 / 功能对照端点（/api/lab/storage/*、/api/lab/iam/*、/api/lab/db-proxy/compare …）由各模块的路由文件
// 先于本文件注册；其余 /api/lab/* 返回 501。
import { cpus, totalmem, freemem, loadavg, hostname } from 'node:os';
import type { Express } from 'express';
import { ulid } from 'ulid';
import { z } from 'zod';
import { MODULE_IDS } from '@cloudalbum/contracts';
import { awsSdkLoadReport } from '../../adapters/aws/clients.js';
import type { Container } from '../../container.js';
import { currentKeyFingerprint } from '../../config/key-fingerprint.js';
import { HttpError } from '../../errors.js';
import type { FaultSpec } from '../../observability/faults.js';
import { instanceIdentity } from '../../observability/path-header.js';
import { currentContext } from '../../observability/request-context.js';
import {
  finishLabRun, getLabResult, getLabRun, insertLabRun, listCapabilityEvents, listLabResults, listLabRuns, queryHostSamples,
  queryOriginSamples, queryRollups, upsertLabResult, type LabResultRow,
} from '../../repositories/lab.js';
import { getMeta, META_KEYS } from '../../repositories/system-meta.js';
import { requireAdmin } from '../middleware/admin.js';
import { audit } from '../middleware/audit.js';
import { requireAuth } from '../middleware/auth.js';
import { notImplementedRoute } from './_stub.js';
import { parseBody } from './auth.js';

const slug = z.string().trim().min(1).max(64).regex(/^[A-Za-z0-9._:-]+$/, '只能含字母、数字、. _ : -');
const RunBody = z.object({
  runId: z.string().trim().regex(/^[0-9A-HJKMNP-TV-Z]{26}$/i, 'runId 必须是 ULID').optional(),
  module: slug, experiment: slug, label: slug,
  params: z.record(z.string(), z.unknown()).optional(),
  forced: z.boolean().optional(),
  notes: z.string().max(2000).optional(),
});
const FinishBody = z.object({ notes: z.string().max(2000).optional() });
const FaultBody = z.object({
  type: z.enum(['error5xx', 'latency', 'error', 'mem']),
  target: z.enum(MODULE_IDS as unknown as [string, ...string[]]).optional(),
  rate: z.number().min(0).max(1).optional(),
  ms: z.number().int().min(0).max(60_000).optional(),
  durationSec: z.number().int().min(1).max(3600),
});
const ResultBody = z.object({
  schemaVersion: z.number().int().min(1),
  runId: z.string().trim().min(1).max(32),
  module: slug, experiment: slug, label: slug,
  forced: z.boolean().optional().default(false),
  startedAt: z.string().min(10).max(40),
  finishedAt: z.string().min(10).max(40),
}).passthrough();

const isoOrUndef = (v: unknown): string | undefined => (typeof v === 'string' && v ? v : undefined);

function resultRowView(r: LabResultRow): Record<string, unknown> {
  return {
    runId: r.run_id, module: r.module, experiment: r.experiment, label: r.label, startedAt: r.started_at, finishedAt: r.finished_at,
    forced: r.forced === true || r.forced === 1, uploadedAt: r.uploaded_at, ...(r.result !== undefined ? { result: r.result } : {}),
  };
}

export function register(app: Express, c: Container): void {
  app.use('/api/lab', requireAuth, requireAdmin);

  // ------------------------------------------------------------------------------------ 运行登记
  app.post('/api/lab/runs', async (req, res) => {
    const body = parseBody(RunBody, req.body);
    const runId = (body.runId ?? ulid()).toUpperCase();
    if (await getLabRun(c.db, runId)) throw new HttpError(409, 'RUN_EXISTS', `runId ${runId} 已登记`);
    const row = await insertLabRun(c.db, {
      runId, module: body.module, experiment: body.experiment, label: body.label, createdBy: currentContext()?.userId ?? null,
      params: body.params ?? null, forced: body.forced ?? false, notes: body.notes ?? null,
    });
    await audit(c, { action: 'lab.run.start', targetType: 'lab_run', targetId: runId, details: { module: body.module, experiment: body.experiment, label: body.label, forced: body.forced ?? false } });
    res.status(201).json({ runId, startedAt: row.started_at, headers: { 'X-Experiment-Run': runId, 'X-Experiment-Label': body.label } });
  });

  app.get('/api/lab/runs', async (req, res) => {
    const module = isoOrUndef(req.query.module);
    const rows = await listLabRuns(c.dbRead, { limit: Number(req.query.limit ?? 50) || 50, ...(module ? { module } : {}) });
    res.json({ items: rows, nextCursor: null });
  });

  app.get('/api/lab/runs/:runId', async (req, res) => {
    const row = await getLabRun(c.dbRead, String(req.params.runId).toUpperCase());
    if (!row) throw new HttpError(404, 'RUN_NOT_FOUND', '实验运行不存在');
    res.json(row);
  });

  app.post('/api/lab/runs/:runId/finish', async (req, res) => {
    const body = parseBody(FinishBody, req.body);
    const runId = String(req.params.runId).toUpperCase();
    if (!(await finishLabRun(c.db, runId, new Date().toISOString(), body.notes))) throw new HttpError(404, 'RUN_NOT_FOUND', '实验运行不存在');
    res.json(await getLabRun(c.db, runId));
  });

  // ------------------------------------------------------------------------------------ 指标
  app.get('/api/lab/metrics', async (req, res) => {
    const run = isoOrUndef(req.query.run)?.toUpperCase();
    const route = isoOrUndef(req.query.route);
    const from = isoOrUndef(req.query.from);
    const to = isoOrUndef(req.query.to);
    const groupByRaw = isoOrUndef(req.query.groupBy);
    const groupBy = groupByRaw === 'driver' || groupByRaw === 'instance' || groupByRaw === 'route' ? groupByRaw : 'path';
    // 先把本进程尚未落库的汇总写进去，这样刚跑完的实验马上就能查到
    await c.labMetrics.flush().catch(() => undefined);
    const window = { ...(from ? { from } : {}), ...(to ? { to } : {}) };
    const filter = { ...window, ...(route ? { route } : {}), ...(run ? { runId: run } : {}) };
    const [routes, ports, host, origin] = await Promise.all([
      queryRollups(c.dbRead, { ...filter, kind: 'route', groupBy }),
      queryRollups(c.dbRead, { ...window, ...(run ? { runId: run } : {}), kind: 'port', groupBy: groupBy === 'path' ? 'driver' : groupBy }),
      queryHostSamples(c.dbRead, { ...window, limit: 360 }),
      queryOriginSamples(c.dbRead, { ...window, limit: 360 }),
    ]);
    res.set('Cache-Control', 'no-store').json({
      query: { ...filter, groupBy },
      run: run ? (await getLabRun(c.dbRead, run)) ?? null : null,
      routes,
      ports,
      recent: c.labMetrics.summarizeRecent({ ...(run ? { runId: run } : {}), ...(route ? { route } : {}), groupBy: groupBy === 'route' ? 'route' : 'path' }),
      host,
      origin,
      store: c.labMetrics.status(),
    });
  });

  app.get('/api/lab/requests/recent', (req, res) => {
    const limit = Math.min(Math.max(Number(req.query.limit ?? 200) || 200, 1), 5000);
    const run = isoOrUndef(req.query.run)?.toUpperCase();
    const route = isoOrUndef(req.query.route);
    const items = c.labMetrics.recent(limit, { ...(run ? { runId: run } : {}), ...(route ? { route } : {}) }).map((r) => ({
      at: r.ts, method: r.method, route: r.route, status: r.status, durationMs: Math.round(r.totalMs * 10) / 10, path: r.path,
      pathSig: r.pathSig, modules: r.modules, requestId: r.requestId, ...(r.runId ? { runId: r.runId } : {}),
      ...(r.label ? { label: r.label } : {}), ...(r.bypass ? { bypass: r.bypass } : {}),
    }));
    res.set('Cache-Control', 'no-store').json({ items, nextCursor: null });
  });

  // ------------------------------------------------------------------------------------ 自检（冒烟测试 S18）
  app.get('/api/lab/self-check', async (_req, res) => {
    const sdk = awsSdkLoadReport();
    const snapshot = c.capabilities.snapshot('admin');
    const ec2 = snapshot.modules.ec2;
    let fingerprint: Record<string, unknown>;
    try {
      const current = await currentKeyFingerprint(c.secrets);
      const recorded = await getMeta(c.db, META_KEYS.localMasterKeyFingerprint);
      fingerprint = { current, recorded, match: Boolean(current && recorded && current === recorded) };
    } catch (e) {
      fingerprint = { error: (e as Error).message };
    }
    const awsLoaded = [...new Set([...sdk.viaFactory, ...sdk.inRequireCache])];
    res.set('Cache-Control', 'no-store').json({
      ok: awsLoaded.length === 0 || c.config.core.IAM_CREDENTIALS !== 'none',
      awsSdk: { ...sdk, loaded: awsLoaded, expectedNone: c.config.core.IAM_CREDENTIALS === 'none' },
      ec2: { status: ec2.status, detail: ec2.detail, checks: ec2.checks ?? [] },
      keyFingerprint: fingerprint,
      heartbeats: c.labMetrics.heartbeatsSnapshot(),
      process: {
        role: c.role, pid: process.pid, node: process.version, uptimeSec: Math.round(process.uptime()), rssBytes: process.memoryUsage().rss,
        hostname: hostname(), instance: instanceIdentity(), cpus: cpus().length, loadavg: loadavg(), memTotal: totalmem(), memFree: freemem(),
        execArgv: process.execArgv, nodeOptions: c.env.NODE_OPTIONS ?? null,
      },
      validation: snapshot.validation,
      store: c.labMetrics.status(),
    });
  });

  app.get('/api/lab/echo', (req, res) => {
    const pick = (h: string) => req.get(h) ?? null;
    res.set('Cache-Control', 'no-store').json({
      method: req.method, path: req.path, ip: req.ip ?? null, remoteAddress: req.socket.remoteAddress ?? null, protocol: req.protocol,
      host: pick('host'), headers: {
        'x-forwarded-for': pick('x-forwarded-for'), 'x-forwarded-proto': pick('x-forwarded-proto'), 'x-amzn-trace-id': pick('x-amzn-trace-id'),
        'x-amz-cf-id': pick('x-amz-cf-id'), via: pick('via'), 'x-cloudalbum-entry': pick('x-cloudalbum-entry'), 'x-request-id': pick('x-request-id'),
        'user-agent': pick('user-agent'),
      },
      entry: currentContext()?.entry ?? 'direct',
    });
  });

  // ------------------------------------------------------------------------------------ 故障注入（§8.4）
  const faultsEnabled = () => c.runtimeConfig().featureFlags['lab.faults'] === true;

  app.post('/api/lab/faults', async (req, res) => {
    if (!faultsEnabled()) throw new HttpError(403, 'FAULTS_DISABLED', "故障注入总开关关闭：运行时配置 featureFlags['lab.faults']=true 后才能使用");
    const body = parseBody(FaultBody, req.body);
    let fault;
    try {
      fault = c.faults.add(body as FaultSpec);
    } catch (e) {
      throw new HttpError(400, 'INVALID_FAULT', (e as Error).message);
    }
    await audit(c, { action: 'lab.fault', targetType: 'fault', targetId: fault.id, details: { ...body } });
    res.status(201).json(fault);
  });

  app.get('/api/lab/faults', (_req, res) => {
    res.set('Cache-Control', 'no-store').json({ enabled: faultsEnabled(), items: c.faults.list() });
  });

  app.delete('/api/lab/faults', async (_req, res) => {
    const n = c.faults.list().length;
    c.faults.clear();
    await audit(c, { action: 'lab.fault.clear', targetType: 'fault', details: { cleared: n } });
    res.json({ cleared: n });
  });

  app.delete('/api/lab/faults/:id', async (req, res) => {
    if (!c.faults.remove(String(req.params.id))) throw new HttpError(404, 'FAULT_NOT_FOUND', '故障不存在或已过期');
    await audit(c, { action: 'lab.fault.clear', targetType: 'fault', targetId: String(req.params.id) });
    res.status(204).end();
  });

  // ------------------------------------------------------------------------------------ 结果
  app.post('/api/lab/results', async (req, res) => {
    const body = parseBody(ResultBody, req.body);
    await upsertLabResult(c.db, {
      runId: body.runId, module: body.module, experiment: body.experiment, label: body.label, startedAt: body.startedAt,
      finishedAt: body.finishedAt, forced: body.forced, result: req.body,
    });
    await audit(c, { action: 'lab.result.upload', targetType: 'lab_run', targetId: body.runId, details: { module: body.module, experiment: body.experiment, label: body.label } });
    res.status(201).json({ runId: body.runId });
  });

  app.get('/api/lab/results', async (req, res) => {
    const s = (k: string) => isoOrUndef(req.query[k]);
    const rows = await listLabResults(c.dbRead, {
      limit: Number(req.query.limit ?? 50) || 50, withResult: req.query.full === '1',
      ...(s('module') ? { module: s('module')! } : {}), ...(s('experiment') ? { experiment: s('experiment')! } : {}),
      ...(s('label') ? { label: s('label')! } : {}),
    });
    res.set('Cache-Control', 'no-store').json({ items: rows.map(resultRowView), nextCursor: null });
  });

  app.get('/api/lab/results/:runId', async (req, res) => {
    const row = await getLabResult(c.dbRead, String(req.params.runId));
    if (!row) throw new HttpError(404, 'RESULT_NOT_FOUND', '实验结果不存在');
    res.set('Cache-Control', 'no-store').json(resultRowView(row));
  });

  app.get('/api/lab/capability-events', async (req, res) => {
    const module = isoOrUndef(req.query.module);
    const since = isoOrUndef(req.query.since);
    const items = await listCapabilityEvents(c.dbRead, { limit: Number(req.query.limit ?? 200) || 200, ...(module ? { module } : {}), ...(since ? { since } : {}) });
    res.set('Cache-Control', 'no-store').json({ items, nextCursor: null });
  });

  // 其余 /api/lab/*：模块实验端点（tagger/analyze、email/compare、notification/compare、runs/:id/photos 清理…）尚未实现
  app.all('/api/lab/*rest', notImplementedRoute('lab'));
}
