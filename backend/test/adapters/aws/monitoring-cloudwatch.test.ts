// monitoring=cloudwatch：MetricsPort 契约（aws-sdk-client-mock）+ 驱动细节（批量 PutMetricData、Values/Counts、维度白名单、心跳、
// LabMetricsStore 旁路、EMF、探针的 degraded / error 判据、深度探针）。不发出任何网络请求。
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import {
  CloudWatchClient, DescribeAlarmHistoryCommand, DescribeAlarmsCommand, GetMetricDataCommand, PutMetricDataCommand,
} from '@aws-sdk/client-cloudwatch';
import { GetTopicAttributesCommand, SNSClient } from '@aws-sdk/client-sns';
import { mockClient } from 'aws-sdk-client-mock';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { CwMetrics } from '../../../src/adapters/monitoring/cloudwatch.js';
import { CwBuffer, MAX_VALUES, batches, cwDimensions, cwMetricName, quantize } from '../../../src/adapters/monitoring/cw-buffer.js';
import { datumDocument, requestDocument, tcpEmfSink, type EmfSink } from '../../../src/adapters/monitoring/emf.js';
import { CloudWatchMetricsReader } from '../../../src/adapters/monitoring/reader.js';
import { LabMetricsStore } from '../../../src/observability/lab-metrics.js';
import { setInstanceIdentity } from '../../../src/observability/path-header.js';
import { describeMetricsContract } from '../../contract/ops.contract.js';
import { ENABLE } from '../../helpers/config.js';
import { awsError, makeDeps } from './helpers.js';

const cw = mockClient(CloudWatchClient);
const sns = mockClient(SNSClient);
const TOPIC = 'arn:aws:sns:ap-northeast-1:123456789012:cloudalbum-lab-ops-alarms';
const env = {
  ...ENABLE.iamRole, ...ENABLE.monitoring, METRICS_CW_ALARM_PREFIX: 'cloudalbum-lab-', METRICS_CW_ALARM_TOPIC_ARN: TOPIC,
  METRICS_CW_DASHBOARD: 'CloudAlbum-lab-Overview',
};

beforeEach(() => {
  cw.on(PutMetricDataCommand).resolves({});
  sns.on(GetTopicAttributesCommand).resolves({ Attributes: { SubscriptionsPending: '0', SubscriptionsConfirmed: '1' } });
});
afterEach(() => {
  cw.reset();
  sns.reset();
});

function newMetrics(extra: Record<string, string> = {}, opts: ConstructorParameters<typeof CwMetrics>[1] = {}, role: 'api' | 'worker' | 'cli' = 'api') {
  const deps = makeDeps({ ...env, ...extra });
  deps.role = role;
  const labMetrics = new LabMetricsStore({ role: role === 'cli' ? 'cli' : role });
  deps.labMetrics = labMetrics;
  return { m: new CwMetrics(deps, { timer: false, ...opts }), labMetrics, deps };
}

type Datum = { MetricName: string; Dimensions?: Array<{ Name: string; Value: string }>; Value?: number; Values?: number[]; Counts?: number[]; Unit?: string; Timestamp?: Date };
function sentData(): Datum[] {
  return cw.commandCalls(PutMetricDataCommand).flatMap((c) => (c.args[0].input.MetricData ?? []) as Datum[]);
}
const dimsOf = (d: Datum) => Object.fromEntries((d.Dimensions ?? []).map((x) => [x.Name, x.Value]));

describeMetricsContract('cloudwatch', async () => {
  const { m } = newMetrics();
  await m.init();
  return { port: m, cleanup: () => m.close() };
});

describe('CwBuffer（聚合与维度白名单）', () => {
  it('指标名映射与 PascalCase；维度只取白名单，高基数字段被丢弃', () => {
    expect(cwMetricName('cache.requests')).toBe('CacheRequests');
    expect(cwMetricName('job.duration')).toBe('JobDuration');
    expect(cwMetricName('biz.image_reconcile_recovered')).toBe('BizImageReconcileRecovered');
    expect(cwDimensions({ route: '/api/feed', outcome: 'hit', userId: 'u-1' } as never)).toEqual([
      { Name: 'Route', Value: '/api/feed' }, { Name: 'Outcome', Value: 'hit' },
    ]);
  });

  it('分布按取值聚合为 Values / Counts；不同取值超过上限后改为对数分桶', () => {
    const b = new CwBuffer();
    for (const v of [10, 10, 20]) b.addValue('Latency', [], v, 'Milliseconds');
    b.addCount('Requests', [], 3);
    const [lat, req] = b.drain(new Date(0));
    expect(lat).toMatchObject({ MetricName: 'Latency', Values: [10, 20], Counts: [2, 1], Unit: 'Milliseconds' });
    expect(req).toMatchObject({ MetricName: 'Requests', Value: 3, Unit: 'Count' });
    expect(b.size).toBe(0);
    for (let i = 1; i <= MAX_VALUES + 50; i += 1) b.addValue('Latency', [], i, 'Milliseconds');
    const [q] = b.drain();
    expect(q!.Values!.length).toBeLessThanOrEqual(MAX_VALUES);
    expect(q!.Counts!.reduce((a, x) => a + x, 0)).toBe(MAX_VALUES + 50);
    expect(quantize(100)).toBeGreaterThan(90);
    expect(quantize(100)).toBeLessThan(110);
  });

  it('批次按条数切分；序列上限之外的数据点计入 dropped', () => {
    const data = Array.from({ length: 400 }, (_, i) => ({ MetricName: `M${i}`, Unit: 'Count' as const, Value: 1, Timestamp: new Date(0), StorageResolution: 60 as const }));
    expect(batches(data, 150).map((x) => x.length)).toEqual([150, 150, 100]);
    const small = new CwBuffer(2);
    small.addCount('A', [], 1);
    small.addCount('B', [], 1);
    small.addCount('C', [], 1);
    expect(small.dropped).toBe(1);
  });
});

describe('CwMetrics 上报', () => {
  it('cloudwatch = local + 批量：本地快照照写；flush 一次 PutMetricData（命名空间 CloudAlbum/App），含 Values/Counts 与心跳', async () => {
    const { m } = newMetrics();
    m.counter('cache.requests', 1, { outcome: 'hit' });
    m.counter('cache.requests', 2, { outcome: 'hit', userId: 'x' } as never);
    m.histogram('job.duration', 120, 'ms', { job: 'report.daily' });
    m.gauge('queue.depth', 4);
    expect(m.snapshot().counters['cache.requests{outcome=hit}']).toBe(3);
    await m.flush();
    const calls = cw.commandCalls(PutMetricDataCommand);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.args[0].input.Namespace).toBe('CloudAlbum/App');
    const data = sentData();
    const cache = data.find((d) => d.MetricName === 'CacheRequests')!;
    expect(cache.Value).toBe(3);
    expect(dimsOf(cache)).toEqual({ Outcome: 'hit' });
    expect(data.find((d) => d.MetricName === 'JobDuration')).toMatchObject({ Values: [120], Counts: [1], Unit: 'Milliseconds' });
    expect(data.find((d) => d.MetricName === 'QueueDepth')).toMatchObject({ Values: [4], Unit: 'None' });
    const hb = data.filter((d) => d.MetricName === 'AppHeartbeat');
    expect(hb.length).toBeGreaterThanOrEqual(1);
    expect(hb[0]).toMatchObject({ Value: 1, Unit: 'Count' });
    expect(hb[0]!.Dimensions).toBeUndefined();
    await m.flush();                                  // 同一分钟内不再重复心跳；没有数据时不发请求
    expect(cw.commandCalls(PutMetricDataCommand)).toHaveLength(1);
  });

  it('worker 进程上报 WorkerHeartbeat；cli 进程不上报心跳', async () => {
    const w = newMetrics({}, {}, 'worker').m;
    await w.flush();
    expect(sentData().map((d) => d.MetricName)).toContain('WorkerHeartbeat');
    cw.resetHistory();
    const c = newMetrics({}, {}, 'cli').m;
    await c.flush();
    expect(cw.commandCalls(PutMetricDataCommand)).toHaveLength(0);
  });

  it('LabMetricsStore 的请求与端口调用经旁路进入 Requests / Http5xx（总量与按 Route）、Latency、PortLatency；本地数据不受影响', async () => {
    const { m, labMetrics } = newMetrics();
    await m.init();
    const ts = new Date().toISOString();
    labMetrics.recordRequest({ ts, requestId: 'r1', method: 'GET', route: '/api/feed', status: 200, totalMs: 12, path: '', pathSig: '', modules: {} });
    labMetrics.recordRequest({ ts, requestId: 'r2', method: 'GET', route: '/api/feed', status: 503, totalMs: 30, path: '', pathSig: '', modules: {} });
    labMetrics.onCall({ module: 'database', driver: 'sqlite', method: 'query', ms: 3, ok: true, inRequest: true });
    expect(labMetrics.recent(10)).toHaveLength(2);
    await m.flush();
    const data = sentData();
    const total = data.find((d) => d.MetricName === 'Requests' && !d.Dimensions)!;
    expect(total.Value).toBe(2);
    expect(data.find((d) => d.MetricName === 'Http5xx' && !d.Dimensions)!.Value).toBe(1);
    expect(data.find((d) => d.MetricName === 'Http5xx' && dimsOf(d).Route === '/api/feed')!.Value).toBe(1);
    expect(data.find((d) => d.MetricName === 'Latency')).toMatchObject({ Values: [12, 30], Counts: [1, 1] });
    expect(dimsOf(data.find((d) => d.MetricName === 'PortLatency')!)).toEqual({ Module: 'database', Driver: 'sqlite' });
    await m.close();
  });

  it('只挂一次旁路：同一个 LabMetricsStore 上的第二个实例不重复计数', async () => {
    const { m, labMetrics, deps } = newMetrics();
    await m.init();
    const m2 = new CwMetrics(deps, { timer: false });
    await m2.init();
    labMetrics.recordRequest({ ts: new Date().toISOString(), requestId: 'r', method: 'GET', route: '/x', status: 200, totalMs: 1, path: '', pathSig: '', modules: {} });
    await m.flush();
    expect(sentData().find((d) => d.MetricName === 'Requests' && !d.Dimensions)!.Value).toBe(1);
    await m.close();
  });

  it('路由维度的基数上限：同一周期内超过 50 个不同路由的归入 Route=other', async () => {
    const { m } = newMetrics();
    for (let i = 0; i < 60; i += 1) m.observeRequest({ ts: new Date().toISOString(), route: `/r/${i}`, status: 200, totalMs: 1 });
    await m.flush();
    const routes = new Set(sentData().filter((d) => d.MetricName === 'Requests' && d.Dimensions).map((d) => dimsOf(d).Route));
    expect(routes.size).toBe(51);
    expect(routes.has('other')).toBe(true);
  });

  it('远端失败不抛出（非权威）：瞬时错误 → degraded transient；连续 AccessDenied → error', async () => {
    cw.on(PutMetricDataCommand).rejects(awsError('ThrottlingException', 400, 'Rate exceeded'));
    const { m } = newMetrics();
    m.counter('x');
    await expect(m.flush()).resolves.toBeUndefined();
    const p1 = await m.probe();
    expect(p1).toMatchObject({ status: 'degraded', transient: true });
    expect(p1.detail).toContain('尚未成功上报');
    cw.on(PutMetricDataCommand).rejects(awsError('AccessDenied', 403, 'not authorized to perform cloudwatch:PutMetricData'));
    m.counter('x');
    await m.flush();
    m.counter('x');
    await m.flush();
    const p2 = await m.probe();
    expect(p2.status).toBe('error');
    expect(p2.detail).toContain('AccessDenied');
  });

  it('启动后尚未上报：ok（inferred）；上报成功后落后超过 2 个周期 → degraded', async () => {
    let now = Date.parse('2026-10-14T00:00:00Z');
    const { m } = newMetrics({ METRICS_CW_FLUSH_SEC: '60' }, { now: () => now });
    const p0 = await m.probe();
    expect(p0).toMatchObject({ status: 'ok', confidence: 'inferred' });
    expect(p0.detail).toContain('等待首次上报');
    m.counter('x');
    await m.flush();
    expect((await m.probe()).status).toBe('ok');
    now += 5 * 60_000;
    const p = await m.probe();
    expect(p.status).toBe('degraded');
    expect(p.detail).toContain('上报落后');
  });
});

describe('CwMetrics 探针：Agent、订阅、keys 模式、深度', () => {
  it('订阅未确认 → degraded“告警只在控制台可见”；GetTopicAttributes 结果缓存', async () => {
    sns.on(GetTopicAttributesCommand).resolves({ Attributes: { SubscriptionsPending: '1', SubscriptionsConfirmed: '0' } });
    const { m } = newMetrics();
    const p = await m.probe();
    expect(p.status).toBe('degraded');
    expect(p.detail).toContain('订阅未确认');
    await m.probe();
    expect(sns.commandCalls(GetTopicAttributesCommand)).toHaveLength(1);
  });

  it('安全快照显示 Agent 未运行 → degraded；keys 模式 → degraded（CRED-002）', async () => {
    const { m, deps } = newMetrics();
    const snap = path.join(deps.dataDir, 'snapshot.json');
    writeFileSync(snap, JSON.stringify({ host: { units: { 'amazon-cloudwatch-agent': 'inactive' } } }));
    const withSnap = new CwMetrics(deps, { timer: false, snapshotFile: snap });
    const p = await withSnap.probe();
    expect(p.status).toBe('degraded');
    expect(p.detail).toContain('Agent 未运行');
    writeFileSync(snap, JSON.stringify({ host: { units: { 'amazon-cloudwatch-agent': 'active' } } }));
    expect((await withSnap.probe()).status).toBe('ok');
    void m;
    const keys = newMetrics({ IAM_CREDENTIALS: 'keys', IAM_KEYS_ACCESS_KEY_ID: 'AKIAEXAMPLE', IAM_KEYS_SECRET_ACCESS_KEY: 'x' }).m;
    const pk = await keys.probe();
    expect(pk.status).toBe('degraded');
    expect(pk.detail).toContain('keys 模式');
  });

  it('深度：本模块的心跳告警不存在 → error；存在且 LabProbe 可读回 → ok，CWAgent 指标作为 Agent 的服务端证据', async () => {
    setInstanceIdentity({ instanceId: 'i-0123456789abcdef0', az: 'ap-northeast-1a' });
    cw.on(DescribeAlarmsCommand).resolves({ MetricAlarms: [{ AlarmName: 'cloudalbum-lab-app-5xx-rate', StateValue: 'OK' }] });
    const { m } = newMetrics();
    const bad = await m.probe({ deep: true });
    expect(bad.status).toBe('error');
    expect(bad.detail).toContain('app-heartbeat');

    cw.on(DescribeAlarmsCommand).resolves({
      MetricAlarms: [
        { AlarmName: 'cloudalbum-lab-app-heartbeat', StateValue: 'OK', StateUpdatedTimestamp: new Date() },
        { AlarmName: 'cloudalbum-lab-worker-heartbeat', StateValue: 'OK', StateUpdatedTimestamp: new Date() },
        { AlarmName: 'cloudalbum-lab-audit-root-login', StateValue: 'INSUFFICIENT_DATA', StateUpdatedTimestamp: new Date(0) },
      ],
      CompositeAlarms: [{ AlarmName: 'cloudalbum-lab-app-unhealthy', StateValue: 'OK' }],
    });
    cw.on(GetMetricDataCommand).resolves({ MetricDataResults: [{ Id: 'x', Timestamps: [new Date('2026-10-14T00:00:00Z')], Values: [1] }] });
    const ok = await m.probe({ deep: true });
    expect(ok.status).toBe('ok');
    expect(ok.confidence).toBe('confirmed');
    expect(ok.data).toMatchObject({ alarms: { total: 3 }, labProbe: { ok: true }, agentMemMetricAt: '2026-10-14T00:00:00.000Z' });
    // 别的模块的告警（audit）即使长期 INSUFFICIENT_DATA 也不影响本模块
    expect(ok.detail).not.toContain('INSUFFICIENT_DATA：');
    const put = cw.commandCalls(PutMetricDataCommand).flatMap((c) => c.args[0].input.MetricData ?? []);
    expect(put.some((d) => d.MetricName === 'LabProbe')).toBe(true);
  });

  it('深度：本模块的告警长时间 INSUFFICIENT_DATA → degraded（维度参数不对）', async () => {
    cw.on(DescribeAlarmsCommand).resolves({
      MetricAlarms: [
        { AlarmName: 'cloudalbum-lab-app-heartbeat', StateValue: 'OK' },
        { AlarmName: 'cloudalbum-lab-worker-heartbeat', StateValue: 'OK' },
        { AlarmName: 'cloudalbum-lab-mem-high', StateValue: 'INSUFFICIENT_DATA', StateUpdatedTimestamp: new Date(Date.now() - 3600_000) },
      ],
    });
    cw.on(GetMetricDataCommand).resolves({ MetricDataResults: [{ Id: 'x', Timestamps: [], Values: [] }] });
    const { m } = newMetrics();
    const p = await m.probe({ deep: true });
    expect(p.status).toBe('degraded');
    expect(p.detail).toContain('mem-high');
  });
});

describe('METRICS_CW_MODE=emf', () => {
  class MemorySink implements EmfSink {
    readonly endpoint = 'tcp://127.0.0.1:25888';
    lines: string[] = [];
    fail = false;
    async write(lines: readonly string[]): Promise<void> {
      if (this.fail) throw Object.assign(new Error('connect ECONNREFUSED 127.0.0.1:25888'), { name: 'Error' });
      this.lines.push(...lines);
    }
  }

  it('每个请求一个 EMF 文档：Requests/Http5xx（总量与按 Route）+ Latency（按 Route），requestId 作为属性；不调用 PutMetricData', async () => {
    const sink = new MemorySink();
    const { m } = newMetrics({ METRICS_CW_MODE: 'emf', METRICS_CW_EMF_ENDPOINT: 'tcp://127.0.0.1:25888' }, { emfSink: sink });
    m.observeRequest({ ts: new Date().toISOString(), route: '/api/feed', status: 500, totalMs: 42, requestId: 'req-1', method: 'GET' });
    m.counter('cache.requests', 1, { outcome: 'miss' });
    await m.flush();
    expect(cw.commandCalls(PutMetricDataCommand)).toHaveLength(0);
    const docs = sink.lines.map((l) => JSON.parse(l) as Record<string, unknown> & { _aws: { CloudWatchMetrics: Array<{ Namespace: string; Dimensions: string[][] }>; LogGroupName: string } });
    const req = docs.find((d) => d.requestId === 'req-1')!;
    expect(req).toMatchObject({ Route: '/api/feed', Requests: 1, Http5xx: 1, Latency: 42, status: 500 });
    expect(req._aws.CloudWatchMetrics.map((x) => x.Dimensions)).toEqual([[[]], [['Route']]]);
    expect(req._aws.LogGroupName).toBe('/cloudalbum/lab/metrics-emf');
    expect(docs.some((d) => d.CacheRequests === 1 && d.Outcome === 'miss')).toBe(true);
    expect(docs.some((d) => d.AppHeartbeat === 1)).toBe(true);
    expect((await m.probe()).status).toBe('ok');
  });

  it('Agent 端点不可达 → degraded（非权威，请求不受影响）；端点格式错误 → degraded 并说明', async () => {
    const sink = new MemorySink();
    sink.fail = true;
    const { m } = newMetrics({ METRICS_CW_MODE: 'emf' }, { emfSink: sink });
    m.observeRequest({ ts: new Date().toISOString(), route: '/x', status: 200, totalMs: 1 });
    await m.flush();
    const p = await m.probe();
    expect(p.status).toBe('degraded');
    expect(p.detail).toContain('ECONNREFUSED');
    expect(() => tcpEmfSink('udp://127.0.0.1:25888')).toThrow(/tcp:\/\//);
    const bad = newMetrics({ METRICS_CW_MODE: 'emf', METRICS_CW_EMF_ENDPOINT: 'nonsense' }).m;
    expect((await bad.probe()).detail).toContain('METRICS_CW_EMF_ENDPOINT');
  });

  it('EMF 文档的形状（纯函数）', () => {
    const ctx = { namespace: 'CloudAlbum/App', logGroupName: '/cloudalbum/lab/metrics-emf' };
    const d = requestDocument(ctx, { ts: 1, route: '/a', status: 200, totalMs: 5 });
    expect(d).toMatchObject({ Requests: 1, Http5xx: 0, Latency: 5, Route: '/a' });
    const agg = datumDocument(ctx, { MetricName: 'PortLatency', Dimensions: [{ Name: 'Module', Value: 'cache' }], Unit: 'Milliseconds', Values: [1, 2], Counts: [300, 100], Timestamp: new Date(0), StorageResolution: 60 });
    expect((agg.PortLatency as number[]).length).toBeLessThanOrEqual(100);
    expect(agg.Module).toBe('cache');
  });
});

describe('CloudWatchMetricsReader（/api/lab/monitoring 的 CloudWatch 一侧）', () => {
  it('alarms()：只列本模块的告警，标注送达路径；结果缓存 60 秒', async () => {
    cw.on(DescribeAlarmsCommand).resolves({
      MetricAlarms: [
        { AlarmName: 'cloudalbum-lab-app-heartbeat', StateValue: 'ALARM', AlarmActions: [TOPIC], StateReason: 'missing data treated as breaching' },
        { AlarmName: 'cloudalbum-lab-audit-root-login', StateValue: 'OK', AlarmActions: [TOPIC] },
      ],
    });
    const deps = makeDeps(env);
    const r = new CloudWatchMetricsReader(deps.aws, { namespace: 'CloudAlbum/App', alarmPrefix: 'cloudalbum-lab-', topicArn: TOPIC });
    const a = await r.alarms();
    expect(a).toEqual([expect.objectContaining({ name: 'app-heartbeat', state: 'ALARM', source: 'cloudwatch', delivery: 'sns' })]);
    await r.alarms();
    expect(cw.commandCalls(DescribeAlarmsCommand)).toHaveLength(1);
  });

  it('history()：DescribeAlarmHistory 的 StateUpdate 解析为 from → to；series()：GetMetricData 按时间升序', async () => {
    cw.on(DescribeAlarmHistoryCommand).resolves({
      AlarmHistoryItems: [{
        Timestamp: new Date('2026-10-14T01:00:00Z'), HistoryItemType: 'StateUpdate', HistorySummary: 'Alarm updated from OK to ALARM',
        HistoryData: JSON.stringify({ oldState: { stateValue: 'OK' }, newState: { stateValue: 'ALARM', stateReason: 'Threshold Crossed' } }),
      }],
    });
    cw.on(GetMetricDataCommand).resolves({ MetricDataResults: [{ Id: 'm1', Timestamps: [new Date(2000), new Date(1000)], Values: [2, 1] }] });
    const deps = makeDeps(env);
    const r = new CloudWatchMetricsReader(deps.aws, { namespace: 'CloudAlbum/App', alarmPrefix: 'cloudalbum-lab-' });
    expect(await r.history('app-heartbeat', 10, new Date('2026-10-14T00:00:00Z'))).toEqual([
      { at: '2026-10-14T01:00:00.000Z', from: 'OK', to: 'ALARM', reason: 'Threshold Crossed' },
    ]);
    expect(cw.commandCalls(DescribeAlarmHistoryCommand)[0]!.args[0].input).toMatchObject({ AlarmName: 'cloudalbum-lab-app-heartbeat', HistoryItemType: 'StateUpdate' });
    const pts = await r.series({ name: 'CPUUtilization', namespace: 'AWS/EC2', stat: 'avg', periodSec: 300, since: new Date(0), source: 'cloudwatch', rawDimensions: [{ Name: 'InstanceId', Value: 'i-0123456789abcdef0' }] });
    expect(pts).toEqual([{ t: 1000, v: 1 }, { t: 2000, v: 2 }]);
    const q = cw.commandCalls(GetMetricDataCommand)[0]!.args[0].input.MetricDataQueries![0]!;
    expect(q.MetricStat).toMatchObject({ Period: 300, Stat: 'Average', Metric: { Namespace: 'AWS/EC2', MetricName: 'CPUUtilization' } });
  });
});

describe('定时上报', () => {
  it('init() 在 api / worker 中启动定时器（unref），close() 停止并最后 flush 一次', async () => {
    const deps = makeDeps({ ...env, METRICS_CW_FLUSH_SEC: '10' });
    mkdirSync(deps.dataDir, { recursive: true });
    deps.labMetrics = new LabMetricsStore({ role: 'api' });
    const m = new CwMetrics(deps);
    await m.init();
    m.counter('x');
    await m.close();
    expect(sentData().some((d) => d.MetricName === 'X')).toBe(true);
  });
});
