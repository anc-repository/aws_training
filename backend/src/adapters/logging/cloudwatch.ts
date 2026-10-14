// backend/src/adapters/logging/cloudwatch.ts —— LoggerPort 的 `cloudwatch` 驱动（Amazon CloudWatch Logs；05#logging 第 2、10 节）
//
// 写入侧：本地文件照写（继承 FileLogger：同一个 pino、同一行 JSON），同时
//   - LOG_CW_SHIPPER=sdk（默认）：pino 的第二个输出把每一行交给进程内发送器（cw-sender.ts），批量 PutLogEvents 到
//     LOG_CW_GROUP_APP 的 `{instanceId}/{role}` 日志流；worker 进程另外增量读取 nginx-access.json，转发到
//     LOG_CW_GROUP_NGINX 的 `{instanceId}/access`（nginx-tail.ts）。
//   - LOG_CW_SHIPPER=agent：应用只写本地文件，由 CloudWatch Agent 采集（infra/modules/logging/cwagent.json）；
//     应用不启动发送器，探针改用 DescribeLogStreams 的最近摄取时间与本地文件的修改时间比较。
// 非权威端口：远端故障只体现在 stats() 与探针上（degraded），绝不阻塞请求，也不抛给调用方（总纲 1.2 原则 4）。
// 探针（第 10 节）：
//   - 常规（30 秒，必须在 2 秒内返回）：只看发送器的内存状态，不调用 AWS（agent 方式读缓存的 DescribeLogStreams，
//     过期时在后台刷新，2026-10-14 实机验证的教训：SDK 首个请求可能很慢）；
//   - 深度（管理员或 enable 第 10 步，5 秒预算）：DescribeLogStreams（本实例日志流的 lastIngestionTime、覆盖的实例数）+
//     写一条 canary 日志并用 FilterLogEvents 测摄取延迟；预算内没查到时在后台继续测量，结果写进以后的 detail。
import { randomUUID } from 'node:crypto';
import { statSync } from 'node:fs';
import { hostname } from 'node:os';
import path from 'node:path';
import type { CloudWatchLogsClient } from '@aws-sdk/client-cloudwatch-logs';
import type { DestinationStream } from 'pino';
import type { AdapterDeps } from '../types.js';
import type { AdapterMeta, ProbeResult } from '../../ports/common.js';
import type { LoggerPort } from '../../ports/logger.js';
import { instanceIdentity } from '../../observability/path-header.js';
import { describeAwsError, isAwsAccessDenied, isAwsNotFound, isAwsTransient, loadAwsPackage, withAwsRetry } from '../aws/clients.js';
import { CwLogSender, type SenderStats } from './cw-sender.js';
import { FileLogger } from './file.js';
import { NginxAccessTailer } from './nginx-tail.js';

type LogsSdk = typeof import('@aws-sdk/client-cloudwatch-logs');

/** 发送器超过这个时间没有成功、且有积压 → degraded（第 10 节） */
export const STALE_SUCCESS_MS = 120_000;
/** 摄取延迟超过它 → degraded（第 10 节深度探针） */
export const INGEST_LAG_DEGRADED_MS = 60_000;
/** 深度探针内等待 canary 的时间（总预算 5 秒） */
const CANARY_INLINE_MS = 2500;
/** canary 在后台继续等待的上限 */
const CANARY_BACKGROUND_MS = 90_000;
/** agent 方式：DescribeLogStreams 缓存的有效期 */
const STREAMS_TTL_MS = 60_000;

export interface CwLoggingSettings {
  groupApp: string;
  groupNginx?: string;
  shipper: 'sdk' | 'agent';
  flushMs: number;
  maxBacklog: number;
  retentionDays?: number;
  logDir: string;
}

export function loggingSettings(deps: AdapterDeps): CwLoggingSettings {
  const l = deps.cfg.logging;
  if (l.LOG_DRIVER !== 'cloudwatch') throw new Error('CwLogger：LOG_DRIVER 不是 cloudwatch（container 装配错误）');
  return {
    groupApp: l.LOG_CW_GROUP_APP,
    ...(l.LOG_CW_GROUP_NGINX ? { groupNginx: l.LOG_CW_GROUP_NGINX } : {}),
    shipper: l.LOG_CW_SHIPPER,
    flushMs: l.LOG_CW_FLUSH_MS,
    maxBacklog: l.LOG_CW_MAX_BACKLOG,
    ...(l.LOG_CW_RETENTION_DAYS ? { retentionDays: l.LOG_CW_RETENTION_DAYS } : {}),
    logDir: l.LOG_DIR,
  };
}

/** 日志流名中的实例部分：IMDS 的实例 ID（container 设置后），否则主机名；去掉 CloudWatch 不允许的 `:` 与 `*` */
export function instancePart(): string {
  return (instanceIdentity().instanceId || hostname() || 'unknown').replace(/[:*]/g, '_');
}

export interface IngestMeasurement { lagMs: number; visibleMs: number; at: string; canary: string }

interface StreamsView {
  at: number;
  streams: Array<{ name: string; lastIngestionTime?: number; lastEventTimestamp?: number }>;
  instances: number;
  error?: unknown;
}

export class CwLogger extends FileLogger implements LoggerPort {
  override readonly meta: AdapterMeta = { module: 'logging', driver: 'cloudwatch', awsService: 'Amazon CloudWatch Logs', authoritative: false };
  readonly settings: CwLoggingSettings;
  private readonly app: CwLogSender | undefined;
  private nginx: CwLogSender | undefined;
  private tailer: NginxAccessTailer | undefined;
  private lastDropped = 0;
  private ingest: IngestMeasurement | undefined;
  private canaryRunning = false;
  private streams: StreamsView | undefined;
  private streamsRefresh: Promise<void> | undefined;
  private startedAt = Date.now();

  constructor(deps: AdapterDeps) {
    super(deps);
    this.settings = loggingSettings(deps);
    if (this.settings.shipper === 'sdk') {
      this.app = new CwLogSender({
        group: this.settings.groupApp, stream: () => this.appStream(), flushMs: this.settings.flushMs, maxBacklog: this.settings.maxBacklog,
        client: () => this.client(), sdk: () => this.sdk(),
      });
    }
  }

  private client(): Promise<CloudWatchLogsClient> {
    return this.deps.aws.cloudwatchLogs();
  }

  private sdk(): Promise<LogsSdk> {
    return loadAwsPackage('@aws-sdk/client-cloudwatch-logs', () => import('@aws-sdk/client-cloudwatch-logs'));
  }

  /** `{instanceId}/{role}`（例如 i-0abc…/api） */
  appStream(): string {
    return `${instancePart()}/${this.deps.role}`;
  }

  /** pino 的第二个输出：sdk 方式下把每一行（与本地文件相同的 JSON）交给发送器 */
  protected override tee(): DestinationStream | undefined {
    const sender = this.app;
    if (!sender) return undefined;
    return { write: (line: string) => { sender.enqueue(line); } };
  }

  override async init(): Promise<void> {
    await super.init();
    this.startedAt = Date.now();
    this.app?.start();
    // Nginx 访问日志只由 worker 转发一次（api 可能有多个进程）
    if (this.settings.shipper === 'sdk' && this.deps.role === 'worker' && this.settings.groupNginx) this.startNginxTail();
  }

  /** worker：nginx-access.json → /cloudalbum/<env>/nginx 的 `{instanceId}/access`（测试也直接调用） */
  startNginxTail(opts: { file?: string; intervalMs?: number; fromStart?: boolean } = {}): NginxAccessTailer | undefined {
    if (!this.settings.groupNginx || this.tailer) return this.tailer;
    this.nginx = new CwLogSender({
      group: this.settings.groupNginx, stream: () => `${instancePart()}/access`, flushMs: this.settings.flushMs, maxBacklog: this.settings.maxBacklog,
      client: () => this.client(), sdk: () => this.sdk(),
    });
    this.nginx.start();
    this.tailer = new NginxAccessTailer({
      file: opts.file ?? path.join(this.settings.logDir, 'nginx-access.json'), sink: this.nginx,
      ...(opts.intervalMs ? { intervalMs: opts.intervalMs } : {}), ...(opts.fromStart ? { fromStart: true } : {}),
    });
    this.tailer.start();
    return this.tailer;
  }

  override async flush(): Promise<void> {
    await super.flush();
    this.tailer?.poll();
    await Promise.all([this.app?.flush(), this.nginx?.flush()]);
  }

  async close(): Promise<void> {
    this.tailer?.stop();
    await this.flush();
    this.app?.stop();
    this.nginx?.stop();
  }

  override stats(): { written: number; dropped: number; backlog: number; lastRemoteSuccessAt?: string } {
    const local = super.stats();
    const senders = [this.app?.stats(), this.nginx?.stats()].filter((s): s is SenderStats => Boolean(s));
    const last = senders.map((s) => s.lastRemoteSuccessAt).filter((x): x is string => Boolean(x)).sort().pop();
    return {
      written: local.written,
      dropped: local.dropped + senders.reduce((n, s) => n + s.dropped, 0),
      backlog: senders.reduce((n, s) => n + s.backlog, 0),
      ...(last ? { lastRemoteSuccessAt: last } : {}),
    };
  }

  /** 最近一次 canary 测得的摄取延迟（/lab 卡片：“摄取延迟 n 秒（最近一次探针）”） */
  get lastIngest(): IngestMeasurement | undefined {
    return this.ingest;
  }

  // ---------------------------------------------------------------------------------------------------- 探针

  override async probe(opts: { deep?: boolean } = {}): Promise<ProbeResult> {
    const t0 = Date.now();
    const local = await super.probe();
    const base = this.baseData();
    let r = this.settings.shipper === 'sdk' ? this.sdkStatus(base) : await this.agentStatus(base);
    if (opts.deep && r.status !== 'error') r = await this.deepProbe(r);
    if (local.status !== 'ok') {
      // 本地文件是 cloudwatch 档的兜底，也是 fail2ban 的输入：写不了时至少 degraded
      r = { ...r, status: r.status === 'error' ? 'error' : 'degraded', detail: `${r.detail}；本地文件：${local.detail}` };
    }
    return { latencyMs: Date.now() - t0, confidence: 'confirmed', ...r, data: { ...base, ...(r.data ?? {}) } };
  }

  private baseData(): Record<string, unknown> {
    const s = this.stats();
    return {
      groupApp: this.settings.groupApp,
      ...(this.settings.groupNginx ? { groupNginx: this.settings.groupNginx } : {}),
      shipper: this.settings.shipper,
      stream: this.appStream(),
      ...(this.settings.retentionDays ? { retentionDays: this.settings.retentionDays } : {}),
      written: s.written, dropped: s.dropped, backlog: s.backlog,
      ...(s.lastRemoteSuccessAt ? { lastRemoteSuccessAt: s.lastRemoteSuccessAt } : {}),
      ...(this.app ? { sender: this.app.stats() } : {}),
      ...(this.nginx ? { nginxSender: this.nginx.stats(), nginxLines: this.tailer?.lines ?? 0 } : {}),
      ...(this.ingest ? { ingestLagMs: this.ingest.lagMs, ingestVisibleMs: this.ingest.visibleMs, ingestMeasuredAt: this.ingest.at } : {}),
      instances: this.streams?.instances ?? 1,
    };
  }

  private lagText(): string {
    return this.ingest ? ` · 摄取延迟 ${(this.ingest.lagMs / 1000).toFixed(1)} 秒（最近一次探针）` : '';
  }

  private sdkStatus(data: Record<string, unknown>): ProbeResult {
    const senders = [this.app, this.nginx].filter((s): s is CwLogSender => Boolean(s)).map((s) => s.stats());
    const s = this.stats();
    const missing = senders.find((x) => x.groupMissing);
    if (missing) return { status: 'error', detail: `日志组不存在：${missing.group}（logging 栈被删除或名称不一致；本地文件照常）`, data };
    const denied = senders.find((x) => x.accessDenied && x.consecutiveFailures >= 2);
    if (denied) return { status: 'error', detail: `PutLogEvents 连续被拒绝：${denied.lastError ?? 'AccessDenied'}（检查 PolicyArn 是否已附加；本地文件照常）`, data };
    const failing = senders.find((x) => x.consecutiveFailures > 0);
    if (failing) {
      return { status: 'degraded', transient: !failing.accessDenied,
        detail: `CloudWatch 发送积压 ${s.backlog} 条：最近 ${failing.consecutiveFailures} 次发送失败（${failing.lastError ?? '?'}）；本地文件照常`, data };
    }
    const droppedNow = s.dropped - this.lastDropped;
    this.lastDropped = s.dropped;
    if (droppedNow > 0) return { status: 'degraded', detail: `CloudWatch 发送积压：自上次探针丢弃 ${droppedNow} 条（积压上限 ${this.settings.maxBacklog}）；本地文件照常`, data };
    if (s.backlog >= this.settings.maxBacklog * 0.9) return { status: 'degraded', detail: `CloudWatch 发送积压 ${s.backlog} 条（接近上限 ${this.settings.maxBacklog}）`, data };
    const since = s.lastRemoteSuccessAt ? Date.parse(s.lastRemoteSuccessAt) : this.startedAt;
    if (s.backlog > 0 && Date.now() - since > STALE_SUCCESS_MS) {
      return { status: 'degraded', detail: `CloudWatch 发送积压 ${s.backlog} 条：超过 ${STALE_SUCCESS_MS / 60_000} 分钟没有成功发送`, data };
    }
    const sent = senders.reduce((n, x) => n + x.sent, 0);
    const lag = this.ingest && this.ingest.lagMs > INGEST_LAG_DEGRADED_MS;
    const detail = `CloudWatch Logs · ${this.settings.groupApp} · 流 ${this.appStream()} · 已发送 ${sent} 条 · 积压 ${s.backlog} 条${this.lagText()}`
      + `${this.settings.retentionDays ? ` · 保留 ${this.settings.retentionDays} 天` : ''}`;
    return { status: lag ? 'degraded' : 'ok', detail: lag ? `${detail}（超过 ${INGEST_LAG_DEGRADED_MS / 1000} 秒）` : detail, data };
  }

  // ------------------------------------------------------------------------------------------- agent 方式

  private async agentStatus(data: Record<string, unknown>): Promise<ProbeResult> {
    if (this.deps.cfg.core.IAM_CREDENTIALS !== 'role') {
      return { status: 'error', detail: `LOG_CW_SHIPPER=agent 需要 IAM_CREDENTIALS=role：CloudWatch Agent 只用实例配置文件的凭证，不读 secrets.env 中的密钥（05 组约定 2）；改用 Shipper=sdk`, data };
    }
    const view = await this.cachedStreams(1500);
    if (!view) return { status: 'degraded', transient: true, detail: '正在查询 CloudWatch Logs 日志流（首次请求较慢，下一轮探针给出结论）', data };
    if (view.error) return this.streamsError(view.error, data);
    const own = view.streams.find((s) => s.name === this.appStream());
    const mtime = fileMtime(this.file);
    const ingested = own?.lastIngestionTime;
    const out = { ...data, instances: view.instances, ...(ingested ? { lastIngestionTime: new Date(ingested).toISOString() } : {}),
      ...(mtime ? { localFileModifiedAt: new Date(mtime).toISOString() } : {}) };
    if (!own) {
      return mtime && Date.now() - mtime < 3600_000
        ? { status: 'degraded', detail: `还没有日志流 ${this.appStream()}：CloudWatch Agent 未运行或刚启动（sudo systemctl status amazon-cloudwatch-agent）`, data: out }
        : { status: 'ok', detail: `CloudWatch Logs（Agent 采集）· ${this.settings.groupApp} · 本实例暂无新日志`, data: out };
    }
    if (mtime && ingested && mtime - ingested > STALE_SUCCESS_MS) {
      return { status: 'degraded', detail: `Agent 没有在投递：本地文件 ${Math.round((Date.now() - mtime) / 1000)} 秒前有新内容，CloudWatch 最近摄取于 ${new Date(ingested).toISOString()}`, data: out };
    }
    return { status: 'ok', detail: `CloudWatch Logs（Agent 采集）· ${this.settings.groupApp} · 流 ${this.appStream()} · ${view.instances} 个实例${this.lagText()}`, data: out };
  }

  private streamsError(e: unknown, data: Record<string, unknown>): ProbeResult {
    if (isAwsNotFound(e)) return { status: 'error', detail: `日志组不存在：${this.settings.groupApp}`, data };
    if (isAwsAccessDenied(e)) return { status: 'error', detail: `DescribeLogStreams 被拒绝：${describeAwsError(e)}（检查 PolicyArn）`, data };
    return { status: 'degraded', transient: isAwsTransient(e), detail: `查询日志流失败：${describeAwsError(e)}`, data };
  }

  /** stale-while-revalidate：返回缓存；过期时在后台刷新，最多等 budgetMs */
  private async cachedStreams(budgetMs: number): Promise<StreamsView | undefined> {
    const fresh = this.streams && Date.now() - this.streams.at < STREAMS_TTL_MS;
    if (!fresh && !this.streamsRefresh) {
      this.streamsRefresh = this.describeStreams()
        .then((v) => { this.streams = v; })
        .catch((e: unknown) => { this.streams = { at: Date.now(), streams: this.streams?.streams ?? [], instances: this.streams?.instances ?? 1, error: e }; })
        .finally(() => { this.streamsRefresh = undefined; });
    }
    if (this.streamsRefresh && !fresh) {
      await Promise.race([this.streamsRefresh, new Promise((r) => setTimeout(r, budgetMs).unref?.())]);
    }
    return this.streams;
  }

  /** 本组日志流（最近有事件的 50 个）：本实例日志流的摄取时间 + 覆盖的实例数（最近 24 小时） */
  private async describeStreams(retry: { attempts: number; timeoutMs: number } = { attempts: 2, timeoutMs: 2000 }): Promise<StreamsView> {
    const sdk = await this.sdk();
    const client = await this.client();
    const r = await withAwsRetry(() => client.send(new sdk.DescribeLogStreamsCommand({
      logGroupName: this.settings.groupApp, orderBy: 'LastEventTime', descending: true, limit: 50,
    })), retry);
    const streams = (r.logStreams ?? []).map((s) => ({
      name: s.logStreamName ?? '', ...(s.lastIngestionTime ? { lastIngestionTime: s.lastIngestionTime } : {}),
      ...(s.lastEventTimestamp ? { lastEventTimestamp: s.lastEventTimestamp } : {}),
    }));
    const dayAgo = Date.now() - 86_400_000;
    const instances = new Set(streams.filter((s) => (s.lastEventTimestamp ?? s.lastIngestionTime ?? 0) >= dayAgo).map((s) => s.name.split('/')[0]));
    return { at: Date.now(), streams, instances: Math.max(1, instances.size) };
  }

  // -------------------------------------------------------------------------------------------- 深度探针

  private async deepProbe(r: ProbeResult): Promise<ProbeResult> {
    // 先写 canary（它会建好本实例的日志流），再数日志流与实例
    const measured = await this.canary(CANARY_INLINE_MS);
    let view: StreamsView;
    try {
      view = await this.describeStreams({ attempts: 1, timeoutMs: 1500 });   // 深度探针的总预算是 5 秒（canary 已用掉约 2.5 秒）
      this.streams = view;
    } catch (e) {
      const err = this.streamsError(e, r.data ?? {});
      return err.status === 'error' ? err : { ...r, status: 'degraded', ...(err.transient ? { transient: true } : {}), detail: `${r.detail}；${err.detail}` };
    }
    const own = view.streams.find((s) => s.name === this.appStream());
    const data = {
      ...(r.data ?? {}), instances: view.instances, streams: view.streams.slice(0, 10).map((s) => s.name),
      ...(own?.lastIngestionTime ? { lastIngestionTime: new Date(own.lastIngestionTime).toISOString() } : {}),
      ...(this.ingest ? { ingestLagMs: this.ingest.lagMs, ingestVisibleMs: this.ingest.visibleMs, ingestMeasuredAt: this.ingest.at } : {}),
    };
    const inst = ` · ${view.instances} 个实例`;
    if (!measured) {
      return { ...r, detail: `${r.detail}${inst} · canary 摄取中（后台继续测量，下一轮探针给出摄取延迟）`, data };
    }
    if (measured.lagMs > INGEST_LAG_DEGRADED_MS) {
      return { ...r, status: 'degraded', detail: `CloudWatch Logs 摄取延迟 ${(measured.lagMs / 1000).toFixed(1)} 秒（超过 ${INGEST_LAG_DEGRADED_MS / 1000} 秒）${inst}`, data };
    }
    const detail = r.detail.includes('摄取延迟') ? r.detail.replace(/ · 摄取延迟 [\d.]+ 秒（最近一次探针）/, this.lagText()) : `${r.detail}${this.lagText()}`;
    return { ...r, detail: `${detail}${inst}`, data };
  }

  /**
   * 写一条 canary 日志，测“写入 → CloudWatch 收下”（ingestionTime − timestamp）与“写入 → 可查到”的时间。
   * 预算内查到就返回；否则在后台继续（最多 90 秒），结果写进 lastIngest。
   */
  async canary(inlineMs = CANARY_INLINE_MS): Promise<IngestMeasurement | undefined> {
    if (this.canaryRunning) return undefined;
    this.canaryRunning = true;
    const id = randomUUID();
    const t0 = Date.now();
    this.info('logging.canary', { canary: id });
    const done = (async () => {
      try {
        await super.flush();
        if (this.app) await this.app.flush(1500);
        const deadline = t0 + CANARY_BACKGROUND_MS;
        while (Date.now() < deadline) {
          const found = await this.findCanary(id, t0).catch(() => undefined);
          if (found) {
            this.ingest = { lagMs: Math.max(0, found.ingestionTime - found.timestamp), visibleMs: Date.now() - t0, at: new Date().toISOString(), canary: id };
            return this.ingest;
          }
          await new Promise((r) => setTimeout(r, 1000).unref?.());
        }
        return undefined;
      } finally {
        this.canaryRunning = false;
      }
    })();
    return Promise.race([done, new Promise<undefined>((r) => setTimeout(() => r(undefined), inlineMs).unref?.())]);
  }

  private async findCanary(id: string, t0: number): Promise<{ timestamp: number; ingestionTime: number } | undefined> {
    const sdk = await this.sdk();
    const client = await this.client();
    const r = await client.send(new sdk.FilterLogEventsCommand({
      logGroupName: this.settings.groupApp, logStreamNames: [this.appStream()], startTime: t0 - 60_000,
      filterPattern: `{ $.canary = "${id}" }`, limit: 1,
    }));
    const ev = r.events?.[0];
    if (!ev?.timestamp || !ev.ingestionTime) return undefined;
    return { timestamp: ev.timestamp, ingestionTime: ev.ingestionTime };
  }
}

function fileMtime(file: string): number | undefined {
  try {
    return statSync(file).mtimeMs;
  } catch {
    return undefined;
  }
}
