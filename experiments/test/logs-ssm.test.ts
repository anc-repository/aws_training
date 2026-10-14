/**
 * wave1-logs-ssm：logging 与 shell-access 的对比实验场景（不经运行器：伪造 ScenarioContext 与 /api/lab/logs、AWS CLI 的应答）。
 */
import { createServer, type Server } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import type { ExpResponse } from '../_lib/http.js';
import type { ScenarioContext } from '../_lib/scenario.js';
import ingestLag from '../logging/ingest-lag.js';
import { errorsByUri, logsPath, statsByUri } from '../logging/logs-api.js';
import queryCompare from '../logging/query-compare.js';
import { setAwsRunner } from '../shell-access/aws-cli.js';
import probePort, { probeOnce, rules22, summarize } from '../shell-access/probe-port.js';
import sessionAudit, { align, isPlatformSession, trailSessions } from '../shell-access/session-audit.js';

const RUN = '01JABCDEFGHJKMNPQRSTVWXYZ0';

function response(status: number, body: unknown, headers: Record<string, string> = {}): ExpResponse {
  const buf = Buffer.from(typeof body === 'string' ? body : JSON.stringify(body));
  return {
    status, ok: status < 400, url: 'http://x', headers, setCookie: [], body: buf, totalMs: 1, serverTiming: [], path: {} as never,
    text: () => buf.toString('utf8'), json: <T>() => JSON.parse(buf.toString('utf8')) as T,
  };
}

function fakeCtx(get: (p: string) => ExpResponse | Promise<ExpResponse>, extra: Partial<ScenarioContext> = {}): { ctx: ScenarioContext; findings: Record<string, unknown>; notes: string[] } {
  const findings: Record<string, unknown> = {};
  const notes: string[] = [];
  const ctx = {
    module: 'x', label: 'after', runId: RUN, target: 'http://127.0.0.1', phase: 'measure', vus: 1, durationMs: 200, repeat: 1, ab: false,
    params: {}, signal: new AbortController().signal,
    capabilities: { app: { region: 'ap-northeast-1', instance: { id: 'i-0abc' } }, modules: {} },
    client: { get: async (p: string) => get(p), post: async () => response(200, {}) },
    log: () => undefined, finding: (k: string, v: unknown) => { findings[k] = v; }, business: () => undefined, note: (t: string) => notes.push(t),
    cleanupLater: () => undefined, elapsedMs: () => 0, remainingMs: () => 0,
    ...extra,
  } as unknown as ScenarioContext;
  return { ctx, findings, notes };
}

describe('logging/logs-api', () => {
  it('logsPath / errorsByUri / statsByUri', () => {
    expect(logsPath({ store: 'local', source: 'nginx', q: RUN, limit: 10 })).toBe(`/api/lab/logs?store=local&source=nginx&q=${RUN}&limit=10`);
    const rows = [503, 200, 503, 500].map((status, i) => ({ ts: '', level: 'error', source: 'nginx', msg: '', fields: { status, uri: i === 3 ? '/b' : '/a' } }));
    expect(errorsByUri(rows)).toEqual({ '/a': 2, '/b': 1 });
    expect(statsByUri([{ ts: '', level: 'info', source: 'nginx', msg: '', fields: { uri: '/a', errors: '2' } }])).toEqual({ '/a': 2 });
  });
});

describe('logging/ingest-lag', () => {
  it('本地立即可见；CloudWatch 轮询到全部 rid；服务端延迟 = ingestedAt − eventTs', async () => {
    let n = 0;
    let polls = 0;
    const rids: string[] = [];
    const { ctx, findings } = fakeCtx((p) => {
      if (p === '/api/lab/now') {
        n += 1;
        rids.push(`r${n}`);
        return response(200, {}, { 'x-cloudalbum-request-id': `r${n}` });
      }
      const u = new URL(p, 'http://x');
      const store = u.searchParams.get('store');
      if (store === 'local') return response(200, { store, mode: 'sync', rows: rids.map((r) => ({ requestId: r, fields: {} })), meta: { tookMs: 3 } });
      polls += 1;
      const visible = polls === 1 ? rids.slice(0, 1) : rids;
      return response(200, { store, mode: 'sync', rows: visible.map((r) => ({ requestId: r, instanceId: 'i-0abc', eventTs: '2026-10-14T00:00:00.000Z', ingestedAt: '2026-10-14T00:00:02.500Z', fields: {} })) });
    }, { params: { requests: 3, timeoutSec: 30 } });
    await ingestLag.run(ctx);
    expect(findings).toMatchObject({ requests: 3, found: 3, missing: 0, ingestLagP50Ms: 2500, ingestLagMaxMs: 2500, cloudwatchAvailable: true, instances: 1 });
    expect(findings.local).toMatchObject({ foundImmediately: 3 });
    expect(polls).toBe(2);
  }, 15_000);

  it('CloudWatch 一侧 409（LOG_DRIVER=file）：记为不可用并结束', async () => {
    const { ctx, findings, notes } = fakeCtx((p) => (p === '/api/lab/now' ? response(200, {}, { 'x-cloudalbum-request-id': 'r1' })
      : new URL(p, 'http://x').searchParams.get('store') === 'local' ? response(200, { rows: [] }) : response(409, { error: 'LOGGING_CLOUDWATCH_OFF', message: 'LOG_DRIVER=file' })),
    { params: { requests: 1 } });
    await ingestLag.run(ctx);
    expect(findings.cloudwatchAvailable).toBe(false);
    expect(notes.join()).toContain('LOG_DRIVER=file');
  });
});

describe('logging/query-compare', () => {
  it('after：本地扫描与 Insights 的 5xx 计数互相印证，并与客户端 503 个数一致', async () => {
    let i = 0;
    const nginx = (status: number, rid: string) => ({ requestId: rid, level: status >= 500 ? 'error' : 'info', fields: { status, uri: '/api/lab/now' } });
    const failed: string[] = [];
    const { ctx, findings } = fakeCtx((p) => {
      if (p === '/api/lab/now') {
        i += 1;
        const st = i % 3 === 0 ? 503 : 200;
        if (st === 503) failed.push(`r${i}`);
        return response(st, {}, { 'x-cloudalbum-request-id': `r${i}` });
      }
      if (p.startsWith('/api/lab/logs/results/')) {
        return response(200, { done: true, rows: [{ fields: { uri: '/api/lab/now', errors: String(failed.length) } }], meta: { engine: 'logs-insights', tookMs: 900, scannedBytes: 12345, instances: [] } });
      }
      const u = new URL(p, 'http://x');
      const store = u.searchParams.get('store');
      if (u.searchParams.get('q')?.startsWith('filter run')) return response(200, { store, mode: 'async', queryId: '00000001-aaaa-bbbb-cccc-dddddddddddd' });
      if (u.searchParams.get('requestId')) return response(200, { store, mode: 'sync', rows: [nginx(503, failed[0]!)], meta: { tookMs: 7, instances: ['i-0abc'] } });
      return response(200, { store, mode: 'sync', rows: failed.map((r) => nginx(503, r)), meta: { engine: store === 'local' ? 'local-scan' : 'filter-log-events', tookMs: 5, scannedBytes: 999, instances: [] } });
    }, { capabilities: { app: { region: 'ap-northeast-1', instance: { id: 'i-0abc' } }, modules: { logging: { driver: 'cloudwatch' } } } as never, params: { vus: 1, waitSec: 5 }, durationMs: 800 });
    await queryCompare.run(ctx);
    expect(findings.client5xx).toBe(failed.length);
    expect(findings.agreeLocal).toBe(true);
    expect(findings.agreeCloudwatch).toBe(true);
    expect(findings.local).toMatchObject({ errors: failed.length, scannedBytes: 999, lookupRows: 1 });
    expect(findings.cloudwatch).toMatchObject({ available: true, errors: failed.length, bytesScanned: 12345, instances: 1 });
  }, 15_000);
});

describe('shell-access/probe-port', () => {
  let server: Server | undefined;
  afterEach(() => { server?.close(); server = undefined; });

  it('probeOnce：open / refused；summarize；rules22（协议 -1 也算）', async () => {
    server = createServer((s) => s.end());
    await new Promise<void>((r) => server!.listen(0, '127.0.0.1', () => r()));
    const port = (server.address() as { port: number }).port;
    expect((await probeOnce('127.0.0.1', port, 1000)).outcome).toBe('open');
    server.close();
    await new Promise((r) => setTimeout(r, 50));
    expect((await probeOnce('127.0.0.1', port, 1000)).outcome).toBe('refused');
    expect(summarize(['timeout', 'timeout'])).toBe('filtered');
    expect(summarize(['refused', 'timeout'])).toBe('closed');
    expect(summarize(['timeout', 'open'])).toBe('open');
    expect(rules22([
      { IsEgress: false, IpProtocol: 'tcp', FromPort: 22, ToPort: 22, CidrIpv4: '10.0.0.5/32' },
      { IsEgress: false, IpProtocol: '-1', FromPort: -1, ToPort: -1, CidrIpv4: '0.0.0.0/0' },
      { IsEgress: false, IpProtocol: 'tcp', FromPort: 443, ToPort: 443, CidrIpv4: '0.0.0.0/0' },
      { IsEgress: true, IpProtocol: '-1', CidrIpv4: '0.0.0.0/0' },
    ])).toHaveLength(2);
  });

  it('target=private-ip：私网地址与安全组来自 AWS CLI；记录 22 端口规则数（服务端证据）', async () => {
    server = createServer((s) => s.end());
    await new Promise<void>((r) => server!.listen(0, '127.0.0.1', () => r()));
    const port = (server.address() as { port: number }).port;
    const restore = setAwsRunner(async (args) => {
      if (args[1] === 'describe-instances') return { code: 0, stdout: JSON.stringify({ Reservations: [{ Instances: [{ PrivateIpAddress: '127.0.0.1', SecurityGroups: [{ GroupId: 'sg-1' }] }] }] }), stderr: '' };
      return { code: 0, stdout: JSON.stringify({ SecurityGroupRules: [{ IsEgress: false, IpProtocol: 'tcp', FromPort: 22, ToPort: 22, CidrIpv4: '172.31.5.9/32' }] }), stderr: '' };
    });
    try {
      const { ctx, findings } = fakeCtx(() => response(200, {}), { params: { target: 'private-ip', ports: String(port), attempts: 2, timeoutMs: 500 } });
      await probePort.run(ctx);
      expect(findings.target).toMatchObject({ kind: 'private-ip', host: '127.0.0.1' });
      expect(findings[`port${port}`]).toMatchObject({ result: 'open', open: 2 });
      expect(findings).toMatchObject({ sgRules22: 1, sgSources22: ['172.31.5.9/32'], sgOpenToWorld: false });
    } finally {
      restore();
    }
  });
});

describe('shell-access/session-audit', () => {
  it('排除平台终端会话；按会话 ID 对齐会话历史、日志流与 StartSession', async () => {
    const sessions = [
      { SessionId: 'atl-s1-ws-0abc', Owner: 'arn:aws:sts::1:assumed-role/ATLLearnerRole/atl-s1-ws', DocumentName: 'SSM-SessionManagerRunShell', StartDate: '2026-10-14T00:00:00Z' },
      { SessionId: 'atl-s1-ws-0fwd', DocumentName: 'AWS-StartPortForwardingSession' },
      { SessionId: 'atl-s1-term-0zzz', DocumentName: 'ATL-SessionShell' },
    ];
    expect(isPlatformSession(sessions[2]!)).toBe(true);
    const trail = trailSessions([{ Username: 'atl-s1-ws', CloudTrailEvent: JSON.stringify({ responseElements: { sessionId: 'atl-s1-ws-0abc' }, requestParameters: { target: 'i-0abc' } }) }]);
    expect(align(sessions, new Set(['atl-s1-ws-0abc']), trail).map((s) => [s.id, s.shell, s.hasLog, s.trailed])).toEqual([
      ['atl-s1-ws-0abc', true, true, true], ['atl-s1-ws-0fwd', false, false, false],
    ]);
    const restore = setAwsRunner(async (args) => {
      const out = args[0] === 'ssm' ? { Sessions: sessions }
        : args[0] === 'logs' ? { logStreams: [{ logStreamName: 'atl-s1-ws-0abc' }] }
          : { Events: [{ Username: 'atl-s1-ws', CloudTrailEvent: JSON.stringify({ responseElements: { sessionId: 'atl-s1-ws-0abc' } }) },
            { Username: 'atl-s1-ws', CloudTrailEvent: JSON.stringify({ responseElements: { sessionId: 'atl-s1-ws-0fwd' } }) }] };
      return { code: 0, stdout: JSON.stringify(out), stderr: '' };
    });
    try {
      const { ctx, findings } = fakeCtx(() => response(200, {}), {
        capabilities: { app: { region: 'ap-northeast-1', instance: { id: 'i-0abc' } }, modules: { 'shell-access': { driver: 'ssm', data: { logGroup: '/cloudalbum/lab/ssm-sessions' } } } } as never,
        params: { waitMin: 0 },
      });
      await sessionAudit.run(ctx);
      expect(findings).toMatchObject({ platformSessionsExcluded: 1, sessions: 2, shellSessions: 1, withLog: 1, withTrail: 2, aligned: 1 });
    } finally {
      restore();
    }
  });
});
