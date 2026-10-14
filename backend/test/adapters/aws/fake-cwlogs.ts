// 内存版 CloudWatch Logs（logging / shell-access 测试用，不访问网络）：日志组、日志流、事件（带 ingestionTime）、
// CreateLogStream、PutLogEvents（时间顺序与批内跨度校验、rejectedLogEventsInfo）、DescribeLogStreams、FilterLogEvents
// （只支持 `{ $.field = "value" }` 与 `"词语"` 两种过滤模式）、StartQuery / GetQueryResults（只回放 filter 子句里的 run/status 条件）。
import {
  CloudWatchLogsClient, CreateLogStreamCommand, DescribeLogGroupsCommand, DescribeLogStreamsCommand, FilterLogEventsCommand,
  GetQueryResultsCommand, PutLogEventsCommand, StartQueryCommand,
} from '@aws-sdk/client-cloudwatch-logs';
import { mockClient, type AwsStub } from 'aws-sdk-client-mock';
import { awsError } from './helpers.js';

export interface FakeEvent { timestamp: number; message: string; ingestionTime: number; logStreamName: string }

interface FakeGroup { name: string; retentionInDays?: number; streams: Map<string, FakeEvent[]> }

/** `{ $.a = "b" }` / `{ $.a >= 500 }` / `"word"` → 判定函数 */
export function compileFilter(pattern: string | undefined): (message: string) => boolean {
  if (!pattern) return () => true;
  const json = /^\{\s*\$\.([A-Za-z0-9_.]+)\s*(=|>=|>|<=|<)\s*("?)([^"}]*)\3\s*\}$/.exec(pattern.trim());
  if (json) {
    const [, field, op, quoted, value] = json;
    return (m) => {
      let o: unknown;
      try {
        o = JSON.parse(m);
      } catch {
        return false;
      }
      const v = field!.split('.').reduce<unknown>((acc, k) => (acc && typeof acc === 'object' ? (acc as Record<string, unknown>)[k] : undefined), o);
      if (v === undefined) return false;
      if (quoted || op === '=') return String(v) === value;
      const n = Number(v);
      const x = Number(value);
      return op === '>=' ? n >= x : op === '>' ? n > x : op === '<=' ? n <= x : n < x;
    };
  }
  const word = /^"(.*)"$/.exec(pattern.trim());
  const term = word ? word[1]! : pattern.trim();
  return (m) => m.includes(term);
}

export class FakeCwLogs {
  readonly groups = new Map<string, FakeGroup>();
  readonly mock: AwsStub<object, object, object>;
  /** 摄取延迟（ingestionTime = 到达时刻 + lagMs） */
  lagMs = 0;
  /** 下一次 PutLogEvents 的故障（依次消费） */
  readonly putFailures: Error[] = [];
  readonly puts: Array<{ group: string; stream: string; count: number }> = [];
  private queries = new Map<string, { group: string[]; filter: (m: string) => boolean; scanned: number; rows: FakeEvent[] }>();

  constructor() {
    this.mock = mockClient(CloudWatchLogsClient) as unknown as AwsStub<object, object, object>;
    this.install();
  }

  restore(): void {
    this.mock.restore();
  }

  createGroup(name: string, retentionInDays?: number): void {
    this.groups.set(name, { name, ...(retentionInDays ? { retentionInDays } : {}), streams: new Map() });
  }

  events(group: string, stream?: string): FakeEvent[] {
    const g = this.groups.get(group);
    if (!g) return [];
    return [...g.streams.entries()].filter(([s]) => !stream || s === stream).flatMap(([, ev]) => ev);
  }

  private group(name: string | undefined): FakeGroup {
    const g = name ? this.groups.get(name) : undefined;
    if (!g) throw awsError('ResourceNotFoundException', 400, 'The specified log group does not exist.');
    return g;
  }

  private install(): void {
    const m = this.mock;
    m.on(CreateLogStreamCommand).callsFake((input: { logGroupName?: string; logStreamName?: string }) => {
      const g = this.group(input.logGroupName);
      if (g.streams.has(input.logStreamName!)) throw awsError('ResourceAlreadyExistsException', 400, 'The specified log stream already exists');
      g.streams.set(input.logStreamName!, []);
      return {};
    });
    m.on(PutLogEventsCommand).callsFake((input: { logGroupName?: string; logStreamName?: string; logEvents?: Array<{ timestamp?: number; message?: string }> }) => {
      const f = this.putFailures.shift();
      if (f) throw f;
      const g = this.group(input.logGroupName);
      const s = g.streams.get(input.logStreamName!);
      if (!s) throw awsError('ResourceNotFoundException', 400, 'The specified log stream does not exist.');
      const evs = input.logEvents ?? [];
      for (let i = 1; i < evs.length; i += 1) {
        if ((evs[i]!.timestamp ?? 0) < (evs[i - 1]!.timestamp ?? 0)) throw awsError('InvalidParameterException', 400, 'Log events in a single PutLogEvents request must be in chronological order.');
      }
      const now = Date.now();
      let tooOld: number | undefined;
      evs.forEach((e, i) => { if ((e.timestamp ?? 0) < now - 14 * 86_400_000) tooOld = i; });
      evs.forEach((e, i) => {
        if (tooOld !== undefined && i <= tooOld) return;
        s.push({ timestamp: e.timestamp ?? now, message: e.message ?? '', ingestionTime: now + this.lagMs, logStreamName: input.logStreamName! });
      });
      this.puts.push({ group: g.name, stream: input.logStreamName!, count: evs.length });
      return tooOld !== undefined ? { rejectedLogEventsInfo: { tooOldLogEventEndIndex: tooOld } } : {};
    });
    m.on(DescribeLogStreamsCommand).callsFake((input: { logGroupName?: string; logStreamNamePrefix?: string; limit?: number }) => {
      const g = this.group(input.logGroupName);
      const streams = [...g.streams.entries()]
        .filter(([n]) => !input.logStreamNamePrefix || n.startsWith(input.logStreamNamePrefix))
        .map(([n, ev]) => ({
          logStreamName: n,
          ...(ev.length ? { lastIngestionTime: Math.max(...ev.map((e) => e.ingestionTime)), lastEventTimestamp: Math.max(...ev.map((e) => e.timestamp)) } : {}),
        }))
        .sort((a, b) => (b.lastEventTimestamp ?? 0) - (a.lastEventTimestamp ?? 0))
        .slice(0, input.limit ?? 50);
      return { logStreams: streams };
    });
    m.on(DescribeLogGroupsCommand).callsFake((input: { logGroupNamePrefix?: string }) => ({
      logGroups: [...this.groups.values()].filter((g) => !input.logGroupNamePrefix || g.name.startsWith(input.logGroupNamePrefix))
        .map((g) => ({ logGroupName: g.name, ...(g.retentionInDays ? { retentionInDays: g.retentionInDays } : {}) })),
    }));
    m.on(FilterLogEventsCommand).callsFake((input: { logGroupName?: string; logStreamNames?: string[]; startTime?: number; endTime?: number; filterPattern?: string; limit?: number }) => {
      const g = this.group(input.logGroupName);
      const now = Date.now();
      const f = compileFilter(input.filterPattern);
      const events = this.events(g.name)
        .filter((e) => !input.logStreamNames || input.logStreamNames.includes(e.logStreamName))
        .filter((e) => e.ingestionTime <= now)                              // 还没“摄取”完的事件查不到
        .filter((e) => (input.startTime === undefined || e.timestamp >= input.startTime) && (input.endTime === undefined || e.timestamp <= input.endTime))
        .filter((e) => f(e.message))
        .slice(0, input.limit ?? 10_000);
      return { events: events.map((e) => ({ ...e, eventId: `${e.logStreamName}-${e.timestamp}` })) };
    });
    m.on(StartQueryCommand).callsFake((input: { logGroupNames?: string[]; queryString?: string }) => {
      const id = `0000000${this.queries.size + 1}-aaaa-bbbb-cccc-dddddddddddd`;
      const run = /run\s*=\s*"([^"]+)"/.exec(input.queryString ?? '')?.[1];
      const st = /status\s*>=\s*(\d+)/.exec(input.queryString ?? '')?.[1];
      const filter = (msg: string) => {
        try {
          const o = JSON.parse(msg) as Record<string, unknown>;
          return (!run || o.run === run) && (!st || Number(o.status) >= Number(st));
        } catch {
          return false;
        }
      };
      const all = (input.logGroupNames ?? []).flatMap((n) => this.events(n));
      this.queries.set(id, { group: input.logGroupNames ?? [], filter, scanned: all.reduce((n, e) => n + e.message.length, 0), rows: all.filter((e) => filter(e.message)) });
      return { queryId: id };
    });
    m.on(GetQueryResultsCommand).callsFake((input: { queryId?: string }) => {
      const q = this.queries.get(input.queryId!);
      if (!q) throw awsError('ResourceNotFoundException', 400, 'query not found');
      return {
        status: 'Complete',
        statistics: { recordsMatched: q.rows.length, recordsScanned: q.rows.length, bytesScanned: q.scanned },
        results: q.rows.map((e) => [
          { field: '@timestamp', value: new Date(e.timestamp).toISOString() },
          { field: '@logStream', value: e.logStreamName },
          { field: '@message', value: e.message },
        ]),
      };
    });
  }
}
