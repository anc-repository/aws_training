// backend/src/adapters/monitoring/cloudwatch.ts —— MetricsPort 的 `cloudwatch` 驱动（Amazon CloudWatch；05#monitoring 第 2、3、10 节）
//
// cloudwatch = local + 批量上报（总纲 4.2）：
//   - LocalMetrics（父类）、LabMetricsStore 与本地告警评估器照常工作；同样的数据每 METRICS_CW_FLUSH_SEC（默认 60 秒）批量上报一次，
//     命名空间 METRICS_CW_NAMESPACE（默认 CloudAlbum/App）。回滚到 local 没有数据缺口。
//   - 上报的指标：Requests、Http5xx、Latency（不带维度的总量 + 按 Route；Latency 为毫秒 Values/Counts，总量供 app-p95-latency 告警）、PortLatency（按 Module、
//     Driver）、业务代码显式上报的指标（CacheRequests、JobDuration、QueueDepth…，维度只取白名单）、AppHeartbeat / WorkerHeartbeat
//     （每个进程每分钟 1，不带维度；心跳告警 TreatMissingData=breaching，进程死亡或实例停止时数据缺失即告警）。
//     请求与端口调用来自 LabMetricsStore（init() 时挂一个旁路观察，不改变本地数据）。
//   - METRICS_CW_MODE=emf：同样的数据以 EMF 写给本机 CloudWatch Agent（METRICS_CW_EMF_ENDPOINT），每个请求一个文档，
//     requestId、pathSig 留作属性（Logs Insights 可查），由 CloudWatch Logs 抽取指标；需要 Agent，即 IAM_CREDENTIALS=role。
// 非权威端口：远端失败只记录并让 probe() 报 degraded，绝不影响请求；连续 AccessDenied 才报 error（文档第 10 节）。
// 探针：常规——最近一次上报成功时间、本机 Agent 是否运行（security/snapshot.json 的 host.units，应用不需要 root）、告警订阅是否
// 已确认（sns:GetTopicAttributes 的 SubscriptionsPending）；深度——DescribeAlarms（本模块的告警是否存在、是否长时间
// INSUFFICIENT_DATA）与 LabProbe 指标的 GetMetricData 读回。控制面调用经 withAwsRetry（每次尝试单独超时，只重试瞬时错误）。
import { readFileSync } from 'node:fs';
import path from 'node:path';
import type { AdapterDeps } from '../types.js';
import type { ProbeResult } from '../../ports/common.js';
import type { AdapterMeta } from '../../ports/common.js';
import type { Dims } from '../../ports/metrics.js';
import type { PortCallEvent } from '../../observability/instrument.js';
import type { LabMetricsStore, RequestRecord } from '../../observability/lab-metrics.js';
import { instanceIdentity } from '../../observability/path-header.js';
import {
  awsErrorName, describeAwsError, isAwsAccessDenied, isAwsNotFound, isAwsTransient, loadAwsPackage, withAwsRetry,
} from '../aws/clients.js';
import { readEvaluatorHeartbeat } from './alert-evaluator.js';
import { CwBuffer, RouteLimiter, batches, cwDimensions, cwMetricName, unitOf, type CwDimension, type MetricDatumLike } from './cw-buffer.js';
import { datumDocument, requestDocument, tcpEmfSink, type EmfContext, type EmfSink } from './emf.js';
import { LocalMetrics } from './local.js';

/**
 * monitoring 栈可能创建的告警（infra/modules/monitoring.yaml；名称 = METRICS_CW_ALARM_PREFIX + 下列名称）。前缀 cloudalbum-<env>-
 * 也可能被别的模块的告警使用（例如 audit），所以探针与 /lab 只看这份清单里的告警。
 */
export const MODULE_ALARMS = [
  'ec2-status-system', 'ec2-status-instance', 'cpu-high', 'cpu-credits-low', 'mem-high', 'data-disk-high',
  'app-5xx-rate', 'app-p95-latency', 'app-heartbeat', 'worker-heartbeat', 'app-unhealthy', 'log-errors',
  'alb-target-5xx', 'alb-target-latency', 'sqs-oldest-age', 'sqs-dlq-depth', 'rds-cpu-high', 'rds-free-storage-low',
  'cache-cpu-high', 'cache-evictions', 'thumb-lambda-errors', 'thumb-lambda-throttles', 'social-api-5xx', 'workflow-failed',
] as const;
/** 必须存在的告警：缺失说明栈被手工删改（探针 error） */
export const REQUIRED_ALARMS = ['app-heartbeat', 'worker-heartbeat'] as const;
/** EMF 每个 flush 周期最多缓存的请求文档数（超出的只计数，不阻塞请求） */
const EMF_MAX_PENDING = 5000;
const TOPIC_CACHE_MS = 60_000;
const INSUFFICIENT_GRACE_MS = 10 * 60_000;

interface CwStatus {
  lastAttemptAt?: string;
  lastOkAt?: string;
  lastError?: { at: string; name: string; message: string; transient: boolean; denied: boolean };
  consecutiveDenied: number;
  flushes: number;
  datumsSent: number;
  emfLinesSent: number;
  emfDropped: number;
}

interface TopicInfo { at: number; pending?: number; confirmed?: number; error?: string }

export interface CwMetricsOptions {
  now?: () => number;
  /** 测试：替换 EMF 写入端 */
  emfSink?: EmfSink;
  /** security/snapshot.json 的路径（默认 <CLOUDALBUM_DATA_DIR>/security/snapshot.json） */
  snapshotFile?: string;
  /** 测试：不启动定时器 */
  timer?: boolean;
}

type CwConfig = {
  METRICS_CW_NAMESPACE: string; METRICS_CW_MODE: 'putmetricdata' | 'emf'; METRICS_CW_FLUSH_SEC: number;
  METRICS_CW_ALARM_PREFIX?: string | undefined; METRICS_CW_ALARM_TOPIC_ARN?: string | undefined; METRICS_CW_DASHBOARD?: string | undefined;
  METRICS_CW_EMF_ENDPOINT?: string | undefined;
};

const TAPPED = Symbol.for('cloudalbum.monitoring.cwTap');

export class CwMetrics extends LocalMetrics {
  override readonly meta: AdapterMeta = { module: 'monitoring', driver: 'cloudwatch', awsService: 'Amazon CloudWatch', authoritative: false };
  private readonly cw: CwConfig;
  private readonly buf = new CwBuffer();
  private readonly routes = new RouteLimiter();
  private readonly status: CwStatus = { consecutiveDenied: 0, flushes: 0, datumsSent: 0, emfLinesSent: 0, emfDropped: 0 };
  private readonly startedAt: number;
  private readonly now: () => number;
  private readonly snapshotFile: string;
  private emf?: EmfSink;
  private emfError?: string;
  private emfPending: string[] = [];
  private timer?: NodeJS.Timeout;
  private flushing?: Promise<void>;
  private lastHeartbeatMinute = 0;
  private topic?: TopicInfo;
  private untap?: () => void;

  constructor(deps: AdapterDeps, private readonly opts: CwMetricsOptions = {}) {
    super(deps);
    const m = deps.cfg.monitoring;
    if (m.METRICS_DRIVER !== 'cloudwatch') throw new Error('CwMetrics: METRICS_DRIVER 不是 cloudwatch');
    this.cw = m;
    this.now = opts.now ?? (() => Date.now());
    this.startedAt = this.now();
    this.snapshotFile = opts.snapshotFile ?? path.join(deps.cfg.core.CLOUDALBUM_DATA_DIR, 'security', 'snapshot.json');
    if (this.cw.METRICS_CW_MODE === 'emf') {
      try {
        this.emf = opts.emfSink ?? tcpEmfSink(this.cw.METRICS_CW_EMF_ENDPOINT || 'tcp://127.0.0.1:25888');
      } catch (e) {
        this.emfError = (e as Error).message;
      }
    }
  }

  private get flushMs(): number {
    return Math.max(10, this.cw.METRICS_CW_FLUSH_SEC) * 1000;
  }

  private get alarmPrefix(): string {
    return this.cw.METRICS_CW_ALARM_PREFIX || `cloudalbum-${this.deps.cfg.core.CLOUDALBUM_ENV}-`;
  }

  private get emfContext(): EmfContext {
    return { namespace: this.cw.METRICS_CW_NAMESPACE, logGroupName: `/cloudalbum/${this.deps.cfg.core.CLOUDALBUM_ENV}/metrics-emf` };
  }

  /** 定时上报（api / worker）；cli 进程不启动定时器 */
  async init(): Promise<void> {
    this.tap(this.deps.labMetrics);
    if (this.opts.timer === false || this.deps.role === 'cli') return;
    this.lastHeartbeatMinute = minuteOf(this.now()) - 1;
    this.timer = setInterval(() => { void this.flush(); }, this.flushMs);
    this.timer.unref?.();
  }

  async close(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    delete this.timer;
    await this.flush();
    this.untap?.();
  }

  // ------------------------------------------------------------------------------------------ 写入（热路径：只聚合，不做 I/O）
  override counter(name: string, value = 1, dims?: Dims): void {
    super.counter(name, value, dims);
    this.buf.addCount(cwMetricName(name), cwDimensions(dims), value, 'Count');
  }

  override histogram(name: string, value: number, unit: 'ms' | 'bytes' | 'count', dims?: Dims): void {
    super.histogram(name, value, unit, dims);
    this.buf.addValue(cwMetricName(name), cwDimensions(dims), value, unitOf(unit));
  }

  override gauge(name: string, value: number, dims?: Dims): void {
    super.gauge(name, value, dims);
    this.buf.addValue(cwMetricName(name), cwDimensions(dims), value, 'None');
  }

  /** LabMetricsStore 记录的每个请求（由 tap 调用；也供测试直接调用） */
  observeRequest(r: Pick<RequestRecord, 'ts' | 'route' | 'status' | 'totalMs'> & Partial<RequestRecord>): void {
    if (this.cw.METRICS_CW_MODE === 'emf') {
      if (this.emfPending.length >= EMF_MAX_PENDING) {
        this.status.emfDropped += 1;
        return;
      }
      const route = this.routes.admit(r.route);
      this.emfPending.push(JSON.stringify(requestDocument(this.emfContext, {
        ts: Date.parse(r.ts) || this.now(), route, status: r.status, totalMs: r.totalMs,
        ...(r.requestId ? { requestId: r.requestId } : {}), ...(r.method ? { method: r.method } : {}),
        ...(r.pathSig ? { pathSig: r.pathSig } : {}), ...(r.runId ? { runId: r.runId } : {}),
      })));
      return;
    }
    const route: CwDimension[] = [{ Name: 'Route', Value: this.routes.admit(r.route) }];
    const err = r.status >= 500 ? 1 : 0;
    this.buf.addCount('Requests', [], 1);
    this.buf.addCount('Requests', route, 1);
    this.buf.addCount('Http5xx', [], err);
    this.buf.addCount('Http5xx', route, err);
    // 总量（app-p95-latency 告警）与按 Route（仪表板、/lab 并排）各一份
    this.buf.addValue('Latency', [], r.totalMs, 'Milliseconds');
    this.buf.addValue('Latency', route, r.totalMs, 'Milliseconds');
  }

  /** 端口调用耗时（instrument 代理 → LabMetricsStore.onCall → tap） */
  observePortCall(e: Pick<PortCallEvent, 'module' | 'driver' | 'ms'>): void {
    this.buf.addValue('PortLatency', cwDimensions({ module: e.module, driver: e.driver }), e.ms, 'Milliseconds');
  }

  /**
   * 在 LabMetricsStore 上挂旁路观察：recordRequest / onCall 先照常写本地，再交给本驱动聚合。
   * 只挂一次（同一个 store 被多个实例共享时也不会重复计数）。集成阶段若给 LabMetricsStore 增加正式的监听接口，可替换本函数。
   */
  private tap(store: LabMetricsStore | undefined): void {
    if (!store) return;
    const s = store as LabMetricsStore & { [TAPPED]?: boolean };
    if (s[TAPPED]) return;
    const origRecord = store.recordRequest;
    const origOnCall = store.onCall;
    s[TAPPED] = true;
    store.recordRequest = (r: RequestRecord) => {
      origRecord.call(store, r);
      try { this.observeRequest(r); } catch { /* 指标不影响请求 */ }
    };
    store.onCall = (e: PortCallEvent) => {
      origOnCall.call(store, e);
      try { this.observePortCall(e); } catch { /* 同上 */ }
    };
    this.untap = () => {
      store.recordRequest = origRecord;
      store.onCall = origOnCall;
      s[TAPPED] = false;
    };
  }

  /** 心跳：自上次 flush 以来每个整分钟一个点（flush 周期大于 60 秒时也不出现“缺分钟”） */
  private heartbeatData(now: number): MetricDatumLike[] {
    const name = this.deps.role === 'worker' ? 'WorkerHeartbeat' : this.deps.role === 'api' ? 'AppHeartbeat' : undefined;
    if (!name) return [];
    const cur = minuteOf(now);
    const from = Math.max(this.lastHeartbeatMinute + 1, cur - 4);
    const out: MetricDatumLike[] = [];
    for (let m = from; m <= cur; m += 1) {
      out.push({ MetricName: name, Unit: 'Count', Value: 1, Timestamp: new Date(m * 60_000), StorageResolution: 60 });
    }
    this.lastHeartbeatMinute = cur;
    return out;
  }

  // ------------------------------------------------------------------------------------------ 上报
  override async flush(): Promise<void> {
    if (this.flushing) return this.flushing;
    this.flushing = this.doFlush().finally(() => { delete this.flushing; });
    return this.flushing;
  }

  private async doFlush(): Promise<void> {
    const now = this.now();
    this.routes.reset();
    const data = [...this.buf.drain(new Date(now)), ...(this.deps.role === 'cli' ? [] : this.heartbeatData(now))];
    if (this.cw.METRICS_CW_MODE === 'emf') {
      const lines = this.emfPending.splice(0);
      for (const d of data) lines.push(JSON.stringify(datumDocument(this.emfContext, d)));
      if (!lines.length) return;
      this.status.lastAttemptAt = new Date(now).toISOString();
      if (!this.emf) {
        this.recordFailure(new Error(this.emfError ?? 'EMF 端点未配置'));
        return;
      }
      try {
        await this.emf.write(lines);
        this.recordSuccess(0, lines.length);
      } catch (e) {
        this.recordFailure(e);
      }
      return;
    }
    if (!data.length) return;
    this.status.lastAttemptAt = new Date(now).toISOString();
    try {
      const sdk = await loadAwsPackage('@aws-sdk/client-cloudwatch', () => import('@aws-sdk/client-cloudwatch'));
      const client = await this.deps.aws.cloudwatch();
      let sent = 0;
      for (const batch of batches(data)) {
        await withAwsRetry(() => client.send(new sdk.PutMetricDataCommand({ Namespace: this.cw.METRICS_CW_NAMESPACE, MetricData: batch })),
          { attempts: 2, timeoutMs: 5000 });
        sent += batch.length;
      }
      this.recordSuccess(sent, 0);
    } catch (e) {
      this.recordFailure(e);
    }
  }

  private recordSuccess(datums: number, lines: number): void {
    this.status.lastOkAt = new Date(this.now()).toISOString();
    this.status.flushes += 1;
    this.status.datumsSent += datums;
    this.status.emfLinesSent += lines;
    this.status.consecutiveDenied = 0;
  }

  private recordFailure(e: unknown): void {
    const denied = isAwsAccessDenied(e);
    this.status.consecutiveDenied = denied ? this.status.consecutiveDenied + 1 : 0;
    this.status.lastError = {
      at: new Date(this.now()).toISOString(), name: awsErrorName(e), message: (e as Error)?.message ?? String(e), transient: isAwsTransient(e), denied,
    };
    this.deps.logger?.warn('monitoring.cloudwatch.flush failed', { error: describeAwsError(e), mode: this.cw.METRICS_CW_MODE });
  }

  /** 上报状态（/api/lab/monitoring 与测试使用） */
  cloudwatchStatus(): Readonly<CwStatus> & { mode: string; namespace: string; flushSec: number; bufferedSeries: number; droppedSeries: number } {
    return {
      ...this.status, mode: this.cw.METRICS_CW_MODE, namespace: this.cw.METRICS_CW_NAMESPACE, flushSec: this.cw.METRICS_CW_FLUSH_SEC,
      bufferedSeries: this.buf.size, droppedSeries: this.buf.dropped,
    };
  }

  // ------------------------------------------------------------------------------------------ 探针
  override async probe(opts: { deep?: boolean } = {}): Promise<ProbeResult> {
    const now = this.now();
    const problems: string[] = [];
    const notes: string[] = [];
    let status: ProbeResult['status'] = 'ok';
    let transient = false;
    const degrade = (why: string) => {
      if (status === 'ok') status = 'degraded';
      problems.push(why);
    };
    const s = this.status;
    const data: Record<string, unknown> = {
      mode: this.cw.METRICS_CW_MODE, namespace: this.cw.METRICS_CW_NAMESPACE, flushSec: this.cw.METRICS_CW_FLUSH_SEC,
      alarmPrefix: this.alarmPrefix, ...(this.cw.METRICS_CW_ALARM_TOPIC_ARN ? { alarmTopicArn: this.cw.METRICS_CW_ALARM_TOPIC_ARN } : {}),
      ...(this.cw.METRICS_CW_DASHBOARD ? { dashboard: this.cw.METRICS_CW_DASHBOARD } : {}),
      lastOkAt: s.lastOkAt ?? null, lastAttemptAt: s.lastAttemptAt ?? null, flushes: s.flushes, datumsSent: s.datumsSent,
      ...(s.lastError ? { lastError: s.lastError } : {}), ...(this.cw.METRICS_CW_MODE === 'emf' ? { emfLinesSent: s.emfLinesSent, emfDropped: s.emfDropped } : {}),
      local: this.deps.labMetrics?.status() ?? null,
    };

    // 1) 上报（PutMetricData / EMF）
    if (s.consecutiveDenied >= 2) {
      return {
        status: 'error', confidence: 'observed', data,
        detail: `${this.cw.METRICS_CW_MODE === 'emf' ? 'EMF' : 'PutMetricData'} 连续 ${s.consecutiveDenied} 次 AccessDenied：${s.lastError?.message ?? ''}（PolicyArn 未附加？）`,
      };
    }
    if (s.lastOkAt) {
      const lagMs = now - Date.parse(s.lastOkAt);
      if (lagMs > 2 * this.flushMs) degrade(`CloudWatch 上报落后 ${Math.round(lagMs / 60_000)} 分钟${s.lastError ? `（${s.lastError.name}）` : ''}`);
    } else if (s.lastError) {
      degrade(`尚未成功上报：${s.lastError.name}：${s.lastError.message}`);
      transient = s.lastError.transient;
    } else if (now - this.startedAt > 2 * this.flushMs + 10_000 && this.deps.role !== 'cli') {
      degrade('启动后一直没有上报（定时器未运行？）');
    } else {
      notes.push(`等待首次上报（每 ${this.cw.METRICS_CW_FLUSH_SEC} 秒批量一次）`);
    }
    if (this.emfError) degrade(this.emfError);

    // 2) 本机 CloudWatch Agent（内存、磁盘指标；EMF 方式的接收端）
    const agent = this.agentState();
    data.agent = agent;
    if (this.deps.cfg.core.IAM_CREDENTIALS === 'keys') {
      degrade('keys 模式：Agent 不读取 secrets.env 中的密钥，内存、磁盘指标与 EMF 不可用（CRED-002；改用 role）');
    } else if (agent === 'active') {
      notes.push('Agent 运行中');
    } else if (agent === 'unknown') {
      notes.push('Agent 状态未知（安全快照中没有该单元）');
    } else {
      degrade(`缺少内存、磁盘指标：Agent 未运行（${agent}）`);
    }

    // 3) 本地告警评估器（始终开启，与驱动无关）
    const ev = this.deps.db ? await readEvaluatorHeartbeat(this.deps.db).catch(() => null) : null;
    if (ev) data.localEvaluator = ev;

    // 4) 告警订阅（sns:GetTopicAttributes）
    const topic = await this.topicInfo();
    if (topic) {
      data.subscriptions = { pending: topic.pending ?? null, confirmed: topic.confirmed ?? null, ...(topic.error ? { error: topic.error } : {}) };
      if (topic.error) notes.push(`告警主题不可读：${topic.error}`);
      else if ((topic.pending ?? 0) > 0) degrade('订阅未确认：告警只在控制台可见');
      else if ((topic.confirmed ?? 0) === 0) notes.push('告警主题没有订阅（AlertEmail 为空）');
      else notes.push(`SNS 订阅已确认 ${topic.confirmed} 个`);
    }

    // 5) 深度：DescribeAlarms + LabProbe 读回
    let confidence: ProbeResult['confidence'] = s.lastOkAt ? 'observed' : 'inferred';
    if (opts.deep && this.deps.aws.enabled) {
      try {
        const deep = await this.deepProbe(now);
        Object.assign(data, deep.data);
        confidence = 'confirmed';
        if (deep.missing.length) {
          return { status: 'error', confidence, data, detail: `本模块的告警不存在：${deep.missing.join('、')}（栈被手工删改？重新执行 scripts/module enable monitoring）` };
        }
        if (deep.stale.length) degrade(`告警长时间处于 INSUFFICIENT_DATA：${deep.stale.join('、')}（通常是维度参数不对）`);
        // Agent 的服务端证据：CWAgent mem_used_percent 最近 15 分钟是否有数据点（快照不含 Agent 单元时以它为准）
        if (deep.agentMetricAt === null && agent !== 'active' && this.deps.cfg.core.IAM_CREDENTIALS !== 'keys') {
          degrade('最近 15 分钟没有 CWAgent mem_used_percent（Agent 未运行或片段未投放）');
        } else if (deep.agentMetricAt) {
          notes.push(`CWAgent 内存指标最新点 ${deep.agentMetricAt}`);
        }
        notes.push(deep.summary);
      } catch (e) {
        if (isAwsAccessDenied(e)) degrade(`深度探针无权限：${describeAwsError(e)}`);
        else {
          degrade(`深度探针失败：${describeAwsError(e)}`);
          transient = transient || isAwsTransient(e);
        }
      }
    }

    const head = s.lastOkAt ? `CloudWatch ${this.cw.METRICS_CW_MODE === 'emf' ? 'EMF' : 'PutMetricData'} 最近成功 ${s.lastOkAt}` : 'CloudWatch 上报';
    return {
      status, confidence, data,
      detail: [head, ...problems, ...notes].join(' · '),
      ...(transient && status !== 'ok' ? { transient: true } : {}),
    };
  }

  /**
   * security/snapshot.json 的 host.units['amazon-cloudwatch-agent']（systemctl is-active 的输出：active / inactive / failed …）；
   * 快照不存在、或快照中没有这个单元时为 unknown（不据此降级）。
   */
  private agentState(): string {
    try {
      const snap = JSON.parse(readFileSync(this.snapshotFile, 'utf8')) as { host?: { units?: Record<string, string> } };
      return snap.host?.units?.['amazon-cloudwatch-agent'] ?? 'unknown';
    } catch {
      return 'unknown';
    }
  }

  private async topicInfo(): Promise<TopicInfo | undefined> {
    const arn = this.cw.METRICS_CW_ALARM_TOPIC_ARN;
    if (!arn || !this.deps.aws.enabled) return undefined;
    const now = this.now();
    if (this.topic && now - this.topic.at < TOPIC_CACHE_MS) return this.topic;
    try {
      const sdk = await loadAwsPackage('@aws-sdk/client-sns', () => import('@aws-sdk/client-sns'));
      const sns = await this.deps.aws.sns();
      const r = await withAwsRetry(() => sns.send(new sdk.GetTopicAttributesCommand({ TopicArn: arn })), { attempts: 2, timeoutMs: 3000 });
      const a = r.Attributes ?? {};
      this.topic = { at: now, pending: Number(a.SubscriptionsPending ?? 0), confirmed: Number(a.SubscriptionsConfirmed ?? 0) };
    } catch (e) {
      this.topic = { at: now, error: isAwsNotFound(e) ? `主题不存在（${arn}）` : describeAwsError(e) };
    }
    return this.topic;
  }

  private async deepProbe(now: number): Promise<{
    data: Record<string, unknown>; missing: string[]; stale: string[]; summary: string; agentMetricAt: string | null | undefined;
  }> {
    const sdk = await loadAwsPackage('@aws-sdk/client-cloudwatch', () => import('@aws-sdk/client-cloudwatch'));
    const client = await this.deps.aws.cloudwatch();
    const prefix = this.alarmPrefix;
    const r = await withAwsRetry(() => client.send(new sdk.DescribeAlarmsCommand({
      AlarmNamePrefix: prefix, AlarmTypes: ['MetricAlarm', 'CompositeAlarm'], MaxRecords: 100,
    })), { attempts: 2, timeoutMs: 4000 });
    const own = new Set<string>(MODULE_ALARMS);
    const alarms = [...(r.MetricAlarms ?? []), ...(r.CompositeAlarms ?? [])]
      .map((a) => ({ name: (a.AlarmName ?? '').slice(prefix.length), state: a.StateValue ?? 'INSUFFICIENT_DATA', since: a.StateUpdatedTimestamp }))
      .filter((a) => own.has(a.name));
    const byState: Record<string, number> = {};
    for (const a of alarms) byState[a.state] = (byState[a.state] ?? 0) + 1;
    const names = new Set(alarms.map((a) => a.name));
    const missing = REQUIRED_ALARMS.filter((n) => !names.has(n));
    const stale = alarms.filter((a) => a.state === 'INSUFFICIENT_DATA' && a.since && now - new Date(a.since).getTime() > INSUFFICIENT_GRACE_MS)
      .map((a) => a.name);

    // LabProbe：上报一个点并尝试读回（指标出现延迟为分钟级，读不到不算失败）
    let readBack: { ok: boolean; latest?: string } = { ok: false };
    if (this.cw.METRICS_CW_MODE === 'putmetricdata') {
      try {
        await client.send(new sdk.PutMetricDataCommand({ Namespace: this.cw.METRICS_CW_NAMESPACE, MetricData: [{ MetricName: 'LabProbe', Value: 1, Unit: 'Count', Timestamp: new Date(now) }] }));
        const g = await withAwsRetry(() => client.send(new sdk.GetMetricDataCommand({
          StartTime: new Date(now - 30 * 60_000), EndTime: new Date(now + 60_000), ScanBy: 'TimestampDescending',
          MetricDataQueries: [{ Id: 'probe', MetricStat: { Metric: { Namespace: this.cw.METRICS_CW_NAMESPACE, MetricName: 'LabProbe' }, Period: 60, Stat: 'SampleCount' } }],
        })), { attempts: 2, timeoutMs: 4000 });
        const ts = g.MetricDataResults?.[0]?.Timestamps?.[0];
        readBack = ts ? { ok: true, latest: new Date(ts).toISOString() } : { ok: false };
      } catch (e) {
        readBack = { ok: false };
        if (isAwsAccessDenied(e)) throw e;
      }
    }
    // CWAgent 内存指标（只在实例 ID 已知时查询；undefined = 未查询）
    const id = instanceIdentity();
    let agentMetricAt: string | null | undefined;
    if (id?.instanceId?.startsWith('i-')) {
      try {
        const g = await withAwsRetry(() => client.send(new sdk.GetMetricDataCommand({
          StartTime: new Date(now - 15 * 60_000), EndTime: new Date(now + 60_000), ScanBy: 'TimestampDescending',
          MetricDataQueries: [{ Id: 'mem', MetricStat: { Metric: { Namespace: 'CWAgent', MetricName: 'mem_used_percent', Dimensions: [{ Name: 'InstanceId', Value: id.instanceId }] }, Period: 60, Stat: 'Average' } }],
        })), { attempts: 2, timeoutMs: 4000 });
        const ts = g.MetricDataResults?.[0]?.Timestamps?.[0];
        agentMetricAt = ts ? new Date(ts).toISOString() : null;
      } catch (e) {
        if (isAwsAccessDenied(e)) throw e;
      }
    }
    return {
      data: {
        alarms: { total: alarms.length, byState, names: [...names].sort() }, labProbe: readBack,
        ...(id?.instanceId ? { instanceId: id.instanceId } : {}), ...(agentMetricAt !== undefined ? { agentMemMetricAt: agentMetricAt } : {}),
      },
      missing, stale, agentMetricAt,
      summary: `告警 ${alarms.length} 个（${Object.entries(byState).map(([k, v]) => `${k} ${v}`).join('，') || '—'}）${readBack.ok ? ` · LabProbe 可读回（${readBack.latest}）` : ''}`,
    };
  }
}

function minuteOf(ms: number): number {
  return Math.floor(ms / 60_000);
}
