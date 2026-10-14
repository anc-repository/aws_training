/**
 * monitoring 与 cost 的 node 场景：对共享 mock 服务器（test/mock-server.ts）运行，前面再挂一个小前端，模拟这两个模块自己的
 * /api/lab/monitoring/*、/api/lab/cost* 与 kill-test 的宕机窗口（/api/health/live），其余请求转发给共享 mock。
 * 故障脚本由测试执行器代替（不执行任何 shell / AWS CLI）；Cost Explorer 的确认词与“没有确认就不调用”都在这里验证。
 */
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FaultExecutor } from '../_lib/faults.js';
import { closeSharedDispatcher } from '../_lib/http.js';
import { loadManifest } from '../_lib/manifest.js';
import { EXIT, parseRunnerArgs, runExperiment } from '../_lib/runner.js';
import { validateResult } from '../_lib/schema.js';
import type { ResultDoc } from '../_lib/types.js';
import { experimentsRoot } from '../_lib/util.js';
import { phaseProblem, resolvePhase } from '../monitoring/kill-test.js';
import { startMockServer, type MockServer } from './mock-server.js';

let mock: MockServer;
let front: http.Server;
let base: string;
const tmp = mkdtempSync(path.join(os.tmpdir(), 'exp-moncost-'));
const executor: FaultExecutor = async () => ({ via: 'test', exitCode: 0 });

/** 前端的可变状态（每个测试按需设置） */
const state = {
  outage: { untilMs: 0, armed: false },
  ceCalls: 0,
  costMode: 'budgets',
  synthetic: 0,
};

function json(res: http.ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
}

async function proxy(req: http.IncomingMessage, res: http.ServerResponse, body: Buffer): Promise<void> {
  const headers: Record<string, string> = {};
  for (const [k, v] of Object.entries(req.headers)) if (typeof v === 'string' && k !== 'host' && k !== 'content-length') headers[k] = v;
  const r = await fetch(`${mock.url}${req.url ?? '/'}`, { method: req.method ?? 'GET', headers, ...(body.length ? { body } : {}) });
  const out = Buffer.from(await r.arrayBuffer());
  const h: Record<string, string> = {};
  r.headers.forEach((v, k) => { if (k !== 'content-length' && k !== 'transfer-encoding' && k !== 'connection') h[k] = v; });
  res.writeHead(r.status, h);
  res.end(out);
}

function transition(to: string, offsetMs = 0) {
  return { at: new Date(Date.now() + offsetMs).toISOString(), from: 'OK', to, reason: 'test' };
}

beforeAll(async () => {
  mock = await startMockServer({ processingMs: 20 });
  front = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      const u = new URL(req.url ?? '/', 'http://front');
      const p = u.pathname;
      const body = Buffer.concat(chunks);
      if (p === '/api/health/live') {
        // kill-test：第一次探测之后宕机 1.5 秒
        if (state.outage.armed && state.outage.untilMs === 0) state.outage.untilMs = Date.now() + 1500;
        if (state.outage.untilMs && Date.now() < state.outage.untilMs) { json(res, 502, { error: 'down' }); return; }
        json(res, 200, { status: 'live' });
        return;
      }
      if (p === '/api/lab/monitoring/alarms') {
        json(res, 200, {
          driver: 'cloudwatch',
          local: { rulesSource: 'default', evaluator: { at: new Date().toISOString(), holder: 'h' }, alarms: [{ name: 'app-5xx-rate', state: 'OK', since: null, source: 'local', delivery: 'local' }] },
          cloudwatch: { enabled: true, alarms: [{ name: 'app-5xx-rate', state: 'OK', since: null, source: 'cloudwatch', delivery: 'sns' }] },
        });
        return;
      }
      if (p === '/api/lab/monitoring/history') {
        const name = u.searchParams.get('name');
        const source = u.searchParams.get('source');
        if (name === 'app-5xx-rate') {
          json(res, 200, { name, local: [transition('ALARM', 500)], ...(source === 'both' ? { cloudwatch: [transition('ALARM', 900)] } : {}) });
        } else if (name === 'app-heartbeat') {
          json(res, 200, { name, cloudwatch: [{ at: new Date(Date.now() - 1000).toISOString(), from: 'OK', to: 'ALARM', reason: 'breaching' }] });
        } else {
          json(res, 200, { name, local: [] });
        }
        return;
      }
      if (p === '/api/lab/monitoring/series') {
        const now = Date.now();
        const name = u.searchParams.get('name');
        const points = name === 'MemoryUtilization' ? [] : Array.from({ length: 6 }, (_, i) => ({ t: now - (5 - i) * 1000, v: name === 'host.memUsedRatio' ? 0.4 + i * 0.05 : 10 + i }));
        json(res, 200, { source: u.searchParams.get('source'), name, points });
        return;
      }
      if (p === '/api/lab/monitoring/synthetic') {
        state.synthetic += 1;
        json(res, state.synthetic % 2 ? 503 : 200, {});
        return;
      }
      if (p === '/api/lab/cost' && req.method === 'GET') {
        json(res, 200, {
          mode: state.costMode,
          local: {
            detail: '当前按小时计费的资源：EC2 实例 ×1（2 小时）', resourceHoursMonth: 4, usage: [],
            hourly: [
              { module: 'ec2', resource: 'EC2 实例（按需）', hourly: true, quantity: 1, enabledAt: null, runningHours: 2, monthHours: 2 },
              { module: 'database', resource: 'RDS 实例', hourly: true, quantity: 1, enabledAt: new Date(Date.now() - 3600_000).toISOString(), runningHours: 1, monthHours: 1 },
            ],
          },
          ...(state.costMode === 'budgets' ? {
            budgets: { items: [
              { name: 'cloudalbum-lab-project-monthly', role: 'project', exists: true, actual: { amount: 1, unit: 'USD' }, limit: { amount: 10, unit: 'USD' } },
              { name: 'cloudalbum-lab-account-monthly', role: 'account', exists: true, actual: { amount: 1.5, unit: 'USD' }, limit: { amount: 20, unit: 'USD' } },
            ] },
            tagStatus: { key: 'Project', status: 'Active' },
          } : {}),
          reminders: [],
        });
        return;
      }
      if (p === '/api/lab/cost/refresh' && req.method === 'POST') {
        const b = body.length ? JSON.parse(body.toString()) as { confirm?: string } : {};
        if (b.confirm !== 'ce-charges') { json(res, 428, { error: 'CONFIRMATION_REQUIRED' }); return; }
        state.ceCalls += 1;
        json(res, 200, { at: new Date().toISOString(), byModule: [{ module: 'ec2', amount: 2, unit: 'USD' }, { module: '', amount: 2, unit: 'USD' }], untaggedShare: 50, truncated: false, cached: state.ceCalls > 1 });
        return;
      }
      void proxy(req, res, body).catch((e: unknown) => json(res, 502, { error: String(e) }));
    });
  });
  await new Promise<void>((r) => front.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${(front.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise<void>((r) => front.close(() => r()));
  await mock.close();
  await closeSharedDispatcher();
  rmSync(tmp, { recursive: true, force: true });
});

async function run(module: string, id: string, label: string, extra: string[] = []) {
  const argv = [module, '--scenario', id, '--label', label, '--duration', '3s', '--warmup', '0s', '--force', '--target', base, '--out', path.join(tmp, 'results'), ...extra];
  const lines: string[] = [];
  const r = await runExperiment(parseRunnerArgs(argv), {
    env: { CLOUDALBUM_ADMIN_TOKEN: mock.adminToken }, repo: tmp, faultExecutor: executor, log: (l) => lines.push(l),
  });
  return { r, lines, doc: r.result as ResultDoc | undefined };
}

describe('manifests', () => {
  it('monitoring and cost declare the experiments of registry lab.experiments', () => {
    const root = experimentsRoot();
    expect(loadManifest('monitoring', root).experiments.map((e) => e.id)).toEqual(['time-to-alert', 'kill-test', 'mem-visibility', 'resolution', 'notify-path']);
    expect(loadManifest('cost', root).experiments.map((e) => e.id)).toEqual(['visibility-lag', 'tag-coverage', 'threshold-alert', 'idle-reminder', 'budget-action-canary']);
  });
});

describe('monitoring scenarios（mock）', () => {
  beforeAll(() => mock.setDriver('monitoring', 'cloudwatch', 'ok'));

  it('time-to-alert：合成 5xx 负载 + 服务端状态变化历史 → 本地与 CloudWatch 的告警时延', async () => {
    const { r, lines, doc } = await run('monitoring', 'time-to-alert', 'after', ['--param', 'pollSec=1', '--param', 'rps=20']);
    expect(r.code, lines.join('\n')).toBe(EXIT.ok);
    expect(validateResult(doc!).errors).toEqual([]);
    expect(doc!.server.business).toMatchObject({ local_alarm: 1, cw_alarm: 1 });
    expect(doc!.server.business.local_detect_sec).toBeGreaterThanOrEqual(0);
    expect(doc!.scenario!.findings.synthetic5xx as number).toBeGreaterThan(0);
    expect(doc!.client.latencyMs['GET /api/lab/monitoring/synthetic']).toBeDefined();
  }, 30_000);

  it('kill-test：观察到宕机窗口，宕机期间本地 0 条状态变化，CloudWatch 心跳告警进入 ALARM', async () => {
    state.outage = { untilMs: 0, armed: true };
    const { r, lines, doc } = await run('monitoring', 'kill-test', 'after', ['--param', 'phase=service', '--param', 'pollSec=1', '--duration', '20s']);
    state.outage = { untilMs: 0, armed: false };
    expect(r.code, lines.join('\n')).toBe(EXIT.ok);
    expect(doc!.scenario!.findings.phase).toBe('service');
    expect(doc!.server.business).toMatchObject({ local_alerts_during_outage: 0, cw_heartbeat_alarm: 1 });
  }, 40_000);

  it('kill-test：phase 解析与 PM-M30 的组合约束', () => {
    expect(resolvePhase('auto', true)).toBe('service');
    expect(resolvePhase('auto', false)).toBe('all');
    expect(phaseProblem('stop-instance', 'service', false)).toContain('phase=instance');
    expect(phaseProblem('after', 'all', true)).toContain('平台模式');
    expect(phaseProblem('after', 'all', false)).toBeUndefined();
    expect(phaseProblem('before', 'service', true)).toBeUndefined();
  });

  it('mem-visibility 与 resolution：三条曲线 / 三种粒度都经服务端读取', async () => {
    const m = await run('monitoring', 'mem-visibility', 'after', ['--param', 'holdSec=1', '--param', 'settleSec=0']);
    expect(m.r.code, m.lines.join('\n')).toBe(EXIT.ok);
    expect(m.doc!.server.business).toMatchObject({ ec2_mem_points: 0 });
    expect(m.doc!.faults).toEqual([]);
    const res = await run('monitoring', 'resolution', 'after', ['--duration', '1s', '--param', 'spikeSec=10', '--param', 'waitSec=0']);
    expect(res.r.code, res.lines.join('\n')).toBe(EXIT.ok);
    expect(res.doc!.scenario!.findings.spike).toBeDefined();
  }, 40_000);
});

describe('cost scenarios（mock）', () => {
  beforeAll(() => mock.setDriver('cost', 'budgets', 'ok'));

  it('visibility-lag：本地清单与预算并排；要调用 Cost Explorer 必须显式确认', async () => {
    state.ceCalls = 0;
    const a = await run('cost', 'visibility-lag', 'after');
    expect(a.r.code, a.lines.join('\n')).toBe(EXIT.ok);
    expect(a.doc!.server.business).toMatchObject({ local_hourly_items: 2, local_module_items: 1, budgets_project_actual: 1 });
    expect(state.ceCalls).toBe(0);
    const refused = await run('cost', 'visibility-lag', 'after', ['--param', 'refreshCe=true']);
    expect(refused.r.code).toBe(EXIT.failed);
    expect(state.ceCalls).toBe(0);
    const ok = await run('cost', 'visibility-lag', 'after', ['--param', 'refreshCe=true', '--param', 'confirmCharges=yes']);
    expect(ok.r.code, ok.lines.join('\n')).toBe(EXIT.ok);
    expect(state.ceCalls).toBe(1);
    expect(ok.doc!.server.business).toMatchObject({ ce_modules_with_cost: 0, modules_not_yet_in_ce: 1 });
  }, 30_000);

  it('tag-coverage：无标签占比与两个预算的差额；没有确认词时不调用', async () => {
    state.ceCalls = 0;
    const no = await run('cost', 'tag-coverage', 'after');
    expect(no.r.code).toBe(EXIT.failed);
    expect(state.ceCalls).toBe(0);
    const yes = await run('cost', 'tag-coverage', 'after', ['--param', 'confirmCharges=yes']);
    expect(yes.r.code, yes.lines.join('\n')).toBe(EXIT.ok);
    expect(yes.doc!.server.business).toMatchObject({ untagged_share_pct: 50, ce_groups: 2, project_account_gap: 0.5 });
  }, 30_000);

  it('手工实验只打印指引', async () => {
    const r = await run('cost', 'threshold-alert', 'after');
    expect(r.r.code).toBe(EXIT.ok);
    expect(r.r.message).toContain('README');
  });
});
