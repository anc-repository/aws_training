// backend/src/adapters/monitoring/lab-routes.ts —— monitoring 的 /lab 侧路端点（05#monitoring 第 2、5 节；仅管理员）
//
//   GET /api/lab/monitoring/alarms                 本地规则与 CloudWatch 告警的当前状态、送达路径、评估器心跳、上报状态
//   GET /api/lab/monitoring/history                ?name=<告警名>&source=local|cloudwatch|both&since=<ISO>&limit=50
//                                                  状态变化历史（本地 alert_events；CloudWatch DescribeAlarmHistory）
//   GET /api/lab/monitoring/series                 ?name=&stat=avg|sum|max|p95&period=60&since=<ISO>&until=&source=local|cloudwatch
//                                                  [&namespace=AWS/EC2|CWAgent|CloudAlbum/App&instanceId=i-…&route=…]
//                                                  曲线（本地：分钟汇总与主机采样；CloudWatch：GetMetricData，缓存 60 秒）
//   GET /api/lab/monitoring/synthetic              ?rate=0.5&status=503：按概率返回 5xx 的合成负载（time-to-alert 的缺省故障源）
// 对比实验（experiments/monitoring）只经这些端点取服务端证据，不在工作台上调用 AWS SDK。
// 注册：与 http/routes/*.ts 相同的 register(app, c) 形状；由集成阶段加入 http/app.ts 的 ROUTE_MODULES（先于 routes/lab.ts）。
import type { Express, Request } from 'express';
import type { Container } from '../../container.js';
import { HttpError } from '../../errors.js';
import { requireAdmin } from '../../http/middleware/admin.js';
import { requireAuth } from '../../http/middleware/auth.js';
import { describeAwsError } from '../aws/clients.js';
import { readEvaluatorHeartbeat } from './alert-evaluator.js';
import { AlertRulesLoader, alertsFile } from './alert-rules.js';
import { CloudWatchMetricsReader, LocalMetricsReader, type AlarmTransition, type SeriesQuery } from './reader.js';

export const PATHS = ['/api/lab/monitoring/alarms', '/api/lab/monitoring/history', '/api/lab/monitoring/series', '/api/lab/monitoring/synthetic'] as const;

type Ctx = Pick<Container, 'config' | 'db' | 'aws' | 'metrics'>;

function cwConfig(c: Ctx): { namespace: string; alarmPrefix: string; topicArn?: string; dashboard?: string } | undefined {
  const m = c.config.monitoring;
  if (m.METRICS_DRIVER !== 'cloudwatch') return undefined;
  return {
    namespace: m.METRICS_CW_NAMESPACE,
    alarmPrefix: m.METRICS_CW_ALARM_PREFIX || `cloudalbum-${c.config.core.CLOUDALBUM_ENV}-`,
    ...(m.METRICS_CW_ALARM_TOPIC_ARN ? { topicArn: m.METRICS_CW_ALARM_TOPIC_ARN } : {}),
    ...(m.METRICS_CW_DASHBOARD ? { dashboard: m.METRICS_CW_DASHBOARD } : {}),
  };
}

function isoParam(req: Request, key: string): Date | undefined {
  const v = req.query[key];
  if (typeof v !== 'string' || !v) return undefined;
  const t = Date.parse(v);
  if (!Number.isFinite(t)) throw new HttpError(400, 'VALIDATION_FAILED', `${key} 必须是 ISO 时间`);
  return new Date(t);
}

function intParam(req: Request, key: string, def: number, min: number, max: number): number {
  const v = req.query[key];
  if (v === undefined || v === '') return def;
  const n = Number(v);
  if (!Number.isInteger(n) || n < min || n > max) throw new HttpError(400, 'VALIDATION_FAILED', `${key} 必须是 ${min}～${max} 的整数`);
  return n;
}

export function register(app: Express, c: Container): void {
  const admin = [requireAuth, requireAdmin];
  const rulesLoader = new AlertRulesLoader(alertsFile(c.config.core.CLOUDALBUM_ENV_DIR));
  const local = new LocalMetricsReader(c.db, () => rulesLoader.load());
  const cw = cwConfig(c);
  const remote = cw && c.aws.enabled ? new CloudWatchMetricsReader(c.aws, cw) : undefined;

  app.get('/api/lab/monitoring/alarms', ...admin, async (_req, res) => {
    res.set('Cache-Control', 'no-store');
    const rules = rulesLoader.load();
    const [localAlarms, evaluator] = await Promise.all([local.alarms(), readEvaluatorHeartbeat(c.db)]);
    let cloudwatch: Record<string, unknown> = { enabled: false, reason: cw ? 'IAM_CREDENTIALS=none：无法读取 CloudWatch（CRED-001）' : 'METRICS_DRIVER=local' };
    if (cw && remote) {
      try {
        cloudwatch = { enabled: true, alarmPrefix: cw.alarmPrefix, topicArn: cw.topicArn ?? null, dashboard: cw.dashboard ?? null, alarms: await remote.alarms() };
      } catch (e) {
        cloudwatch = { enabled: true, alarmPrefix: cw.alarmPrefix, error: describeAwsError(e), alarms: [] };
      }
    }
    const reporter = (c.metrics as Partial<{ cloudwatchStatus(): unknown }>).cloudwatchStatus?.();
    res.json({
      driver: c.config.monitoring.METRICS_DRIVER,
      local: {
        rulesSource: rules.source, evaluateEverySec: rules.evaluateEverySec, alertEmail: rules.alertEmail ?? null, issues: rules.issues,
        evaluator: evaluator ?? null, delivery: '站内信 + EmailPort（worker 内评估；实例宕机即失效）', alarms: localAlarms,
      },
      cloudwatch: { ...cloudwatch, delivery: 'SNS ops-alarms 主题（AWS 侧评估；实例宕机也能发出）', ...(reporter ? { reporter } : {}) },
      at: new Date().toISOString(),
    });
  });

  app.get('/api/lab/monitoring/history', ...admin, async (req, res) => {
    res.set('Cache-Control', 'no-store');
    const name = String(req.query.name ?? '');
    if (!/^[a-z][a-z0-9-]{0,63}$/.test(name)) throw new HttpError(400, 'VALIDATION_FAILED', 'name 必须是告警名（不含前缀），例如 app-heartbeat');
    const source = String(req.query.source ?? 'both');
    if (!['local', 'cloudwatch', 'both'].includes(source)) throw new HttpError(400, 'VALIDATION_FAILED', 'source 只能是 local | cloudwatch | both');
    const since = isoParam(req, 'since');
    const limit = intParam(req, 'limit', 50, 1, 100);
    const out: { name: string; local?: AlarmTransition[]; cloudwatch?: AlarmTransition[]; cloudwatchError?: string } = { name };
    if (source !== 'cloudwatch') out.local = await local.history(name, limit, since);
    if (source !== 'local') {
      if (!remote) out.cloudwatchError = cw ? 'IAM_CREDENTIALS=none' : 'METRICS_DRIVER=local';
      else {
        try {
          out.cloudwatch = await remote.history(name, limit, since);
        } catch (e) {
          out.cloudwatchError = describeAwsError(e);
        }
      }
    }
    res.json(out);
  });

  // 合成错误负载（time-to-alert 的缺省故障源）：以概率 rate 返回 status（默认 503），否则 200。与共享故障注入 error5xx 相比，
  // 它只影响打到这个路由的请求——error5xx 作用于全部请求（包括 healthcheck.sh 的 /api/health/live），会让本机健康检查重启 api 并清掉故障。
  // 请求照常经 LabMetricsStore 记录（route=/api/lab/monitoring/synthetic），本地评估器与 CloudWatch 看到的是同一批 5xx。
  app.get('/api/lab/monitoring/synthetic', ...admin, (req, res) => {
    const rate = Number(req.query.rate ?? 0.5);
    const status = Number(req.query.status ?? 503);
    if (!(rate >= 0 && rate <= 1)) throw new HttpError(400, 'VALIDATION_FAILED', 'rate 必须在 0～1 之间');
    if (![500, 502, 503, 504].includes(status)) throw new HttpError(400, 'VALIDATION_FAILED', 'status 只能是 500 | 502 | 503 | 504');
    res.set('Cache-Control', 'no-store');
    if (Math.random() < rate) {
      res.status(status).json({ error: 'SYNTHETIC_ERROR', message: 'monitoring time-to-alert 的合成错误', status });
      return;
    }
    res.json({ ok: true });
  });

  app.get('/api/lab/monitoring/series', ...admin, async (req, res) => {
    res.set('Cache-Control', 'no-store');
    const name = String(req.query.name ?? '');
    if (!/^[A-Za-z][A-Za-z0-9._-]{0,63}$/.test(name)) throw new HttpError(400, 'VALIDATION_FAILED', 'name 不合法');
    const stat = String(req.query.stat ?? 'avg') as SeriesQuery['stat'];
    if (!['avg', 'sum', 'max', 'p95'].includes(stat)) throw new HttpError(400, 'VALIDATION_FAILED', 'stat 只能是 avg | sum | max | p95');
    const source = String(req.query.source ?? 'local') as SeriesQuery['source'];
    if (source !== 'local' && source !== 'cloudwatch') throw new HttpError(400, 'VALIDATION_FAILED', 'source 只能是 local | cloudwatch');
    const since = isoParam(req, 'since') ?? new Date(Date.now() - 3600_000);
    const until = isoParam(req, 'until');
    const periodSec = intParam(req, 'period', 60, 10, 3600);
    const namespace = typeof req.query.namespace === 'string' && req.query.namespace ? req.query.namespace : undefined;
    if (namespace && !['AWS/EC2', 'CWAgent', cw?.namespace ?? 'CloudAlbum/App'].includes(namespace)) {
      throw new HttpError(400, 'VALIDATION_FAILED', 'namespace 只能是 AWS/EC2、CWAgent 或本模块的命名空间');
    }
    const instanceId = typeof req.query.instanceId === 'string' && /^i-[0-9a-f]{8,17}$/.test(req.query.instanceId) ? req.query.instanceId : undefined;
    const route = typeof req.query.route === 'string' && req.query.route ? req.query.route.slice(0, 255) : undefined;
    const q: SeriesQuery = {
      name, stat, periodSec, since, ...(until ? { until } : {}), source, ...(namespace ? { namespace } : {}),
      ...(route ? { dims: { route } } : {}), ...(instanceId ? { rawDimensions: [{ Name: 'InstanceId', Value: instanceId }] } : {}),
    };
    if (source === 'local') {
      res.json({ source, name, points: await local.series(q) });
      return;
    }
    if (!remote) throw new HttpError(409, 'MONITORING_CLOUDWATCH_OFF', cw ? 'IAM_CREDENTIALS=none：无法读取 CloudWatch' : 'METRICS_DRIVER=local：没有 CloudWatch 一侧');
    try {
      res.json({ source, name, namespace: q.namespace ?? cw!.namespace, points: await remote.series(q) });
    } catch (e) {
      throw new HttpError(502, 'CLOUDWATCH_READ_FAILED', describeAwsError(e));
    }
  });
}
