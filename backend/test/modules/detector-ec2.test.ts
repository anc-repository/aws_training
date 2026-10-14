// ec2 感知器：IMDSv2、数据卷（mountinfo / NVMe 序列号推断卷 ID）、磁盘、内存、Nginx、快照派生检查项、开发机降级。
// 本机文件全部放在临时目录（procRoot / sysRoot / 数据目录），IMDS 与 Nginx 用注入的 fetch 模拟，不访问网络。
import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { lazyAwsClients } from '../../src/adapters/aws/clients.js';
import { parseConfig } from '../../src/config/schema.js';
import { Ec2Detector, ImdsClient, detectEc2Host, parseMountinfo } from '../../src/modules/detectors/ec2.js';
import type { CapabilityCheck } from '@cloudalbum/contracts';

interface World {
  root: string;
  dataDir: string;
  envDir: string;
  procRoot: string;
  sysRoot: string;
}

function world(opts: { mountData?: boolean; symlinkEtc?: boolean; snapshot?: Record<string, unknown> | null } = {}): World {
  const root = mkdtempSync(path.join(os.tmpdir(), 'cloudalbum-ec2-'));
  const dataDir = path.join(root, 'data');
  const envDir = path.join(root, 'etc-cloudalbum');
  const procRoot = path.join(root, 'proc');
  const sysRoot = path.join(root, 'sys');
  mkdirSync(path.join(dataDir, 'etc'), { recursive: true });
  mkdirSync(path.join(procRoot, 'self'), { recursive: true });
  mkdirSync(path.join(sysRoot, 'block/nvme1n1/device'), { recursive: true });
  if (opts.symlinkEtc !== false) symlinkSync(path.join(dataDir, 'etc'), envDir, 'junction');
  const esc = (p: string) => path.resolve(p).replace(/ /g, '\\040');
  const lines = ['22 1 259:1 / / rw,noatime shared:1 - xfs /dev/nvme0n1p1 rw,attr2'];
  if (opts.mountData !== false) lines.push(`40 22 259:3 / ${esc(dataDir)} rw,noatime shared:20 - xfs /dev/nvme1n1 rw,attr2`);
  writeFileSync(path.join(procRoot, 'self/mountinfo'), `${lines.join('\n')}\n`);
  writeFileSync(path.join(procRoot, 'meminfo'), 'MemTotal:        2000000 kB\nMemFree:          100000 kB\nMemAvailable:    1000000 kB\n');
  writeFileSync(path.join(procRoot, 'swaps'), 'Filename\tType\tSize\tUsed\tPriority\n/swapfile file 1048572 0 -2\n');
  writeFileSync(path.join(sysRoot, 'block/nvme1n1/device/serial'), 'vol0abc123def456\n');
  if (opts.snapshot !== null) {
    mkdirSync(path.join(dataDir, 'security'), { recursive: true });
    writeFileSync(path.join(dataDir, 'security', 'snapshot.json'), JSON.stringify(opts.snapshot ?? {
      schemaVersion: 1, generatedAt: new Date().toISOString(),
      host: {
        units: { nginx: 'active', 'cloudalbum-api': 'active', 'cloudalbum-worker': 'active', 'cloudalbum-backup.timer': 'active', 'cloudalbum-healthcheck.timer': 'active' },
        time: { synchronized: true, source: '169.254.169.123', offsetMs: 0.4 },
        nginx: { lastReloadAt: '2026-10-13T00:00:00Z', lastReloadOk: true, denylistRejectedLines: 0 },
        manualDropins: [], release: '2026.10.13-1',
      },
      fail2ban: { available: true, jails: [{}] },
    }));
    mkdirSync(path.join(dataDir, 'backup'), { recursive: true });
    writeFileSync(path.join(dataDir, 'backup', 'last-run.json'), JSON.stringify({ lastSuccessAt: new Date().toISOString() }));
  }
  return { root, dataDir, envDir, procRoot, sysRoot };
}

interface FakeNet { imdsV1Status?: number; imdsDown?: boolean; nginxDown?: boolean; tags?: boolean }

function fakeFetch(net: FakeNet = {}): typeof fetch {
  const meta: Record<string, string> = {
    'instance-id': 'i-0123456789abcdef0', 'instance-type': 't4g.small', 'placement/availability-zone': 'ap-northeast-1a',
    'placement/availability-zone-id': 'apne1-az4', 'ami-id': 'ami-0abc', 'public-ipv4': '203.0.113.10', 'placement/region': 'ap-northeast-1',
  };
  return (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    const headers = new Headers(init?.headers);
    if (url.startsWith('http://127.0.0.1/_ca/nginx-health')) {
      if (net.nginxDown) throw new TypeError('fetch failed');
      return new Response(null, { status: 204 });
    }
    if (net.imdsDown) throw new TypeError('fetch failed');
    const p = new URL(url).pathname;
    if (p === '/latest/api/token' && init?.method === 'PUT') return new Response('tok-1', { status: 200 });
    if (!headers.get('X-aws-ec2-metadata-token')) return new Response('', { status: net.imdsV1Status ?? 401 });
    if (p === '/latest/meta-data/tags/instance/') return new Response('Name', { status: net.tags === false ? 404 : 200 });
    const key = p.replace('/latest/meta-data/', '');
    return meta[key] !== undefined ? new Response(meta[key], { status: 200 }) : new Response('', { status: 404 });
  }) as typeof fetch;
}

function detector(w: World, opts: { net?: FakeNet; isEc2?: boolean; platform?: NodeJS.Platform; env?: Record<string, string> } = {}) {
  const parsed = parseConfig({ CLOUDALBUM_ROLE: 'api', NODE_ENV: 'test', CLOUDALBUM_DATA_DIR: w.dataDir, CLOUDALBUM_ENV_DIR: w.envDir, ...(opts.env ?? {}) });
  const cfg = parsed.config!;
  const f = fakeFetch(opts.net);
  return new Ec2Detector({ cfg, env: parsed.effective, aws: lazyAwsClients({ region: 'ap-northeast-1', credentials: null }) }, {
    imds: new ImdsClient({ fetch: f, negativeCacheMs: 0 }), fetch: f, procRoot: w.procRoot, sysRoot: w.sysRoot,
    platform: opts.platform ?? 'linux', isEc2: opts.isEc2 ?? true,
  });
}

const byId = (checks: unknown, id: string) => (checks as CapabilityCheck[]).find((c) => c.id === id);

describe('Ec2Detector（EC2 上）', () => {
  it('全部检查项健康：IMDSv2 强制、数据卷独立挂载（推断卷 ID）、/etc/cloudalbum → 数据卷、快照新鲜', async () => {
    const w = world();
    const r = await detector(w).detect({});
    const checks = r.data!.checks as CapabilityCheck[];
    expect(checks.map((c) => c.id)).toEqual(expect.arrayContaining([
      'imdsv2', 'data-volume', 'nginx', 'processes', 'disk', 'memory', 'time-sync', 'timers', 'fail2ban', 'security-snapshot', 'manual-dropins',
    ]));
    for (const id of ['imdsv2', 'data-volume', 'nginx', 'processes', 'memory', 'time-sync', 'timers', 'fail2ban', 'security-snapshot', 'manual-dropins']) {
      expect(byId(checks, id)?.status, `${id}: ${byId(checks, id)?.detail}`).toBe('ok');
    }
    expect(r.data).toMatchObject({ instanceId: 'i-0123456789abcdef0', instanceType: 't4g.small', az: 'ap-northeast-1a', azId: 'apne1-az4', dataVolume: 'vol-0abc123def456（inferred）', release: '2026.10.13-1' });
    expect(r.detail).toContain('t4g.small · ap-northeast-1a');
    expect(r.detail).toContain('IMDSv2 强制');
    expect(r.confidence).toBe('observed');
    expect(byId(checks, 'data-volume')!.detail).toContain('→ 数据卷');
  });

  it('IMDS 无令牌也返回 200（HttpTokens=optional）→ degraded；实例标签不可读 → degraded；IMDS 不可达 → error', async () => {
    const w = world();
    expect(byId((await detector(w, { net: { imdsV1Status: 200 } }).detect({})).data!.checks, 'imdsv2')!.status).toBe('degraded');
    expect(byId((await detector(w, { net: { tags: false } }).detect({})).data!.checks, 'imdsv2')!.detail).toContain('实例标签不可读');
    const down = await detector(w, { net: { imdsDown: true } }).detect({});
    expect(byId(down.data!.checks, 'imdsv2')!.status).toBe('error');
    expect(down.status).toBe('error');
  });

  it('数据目录不是独立挂载点 → error（会写到根卷上）；/etc/cloudalbum 不是符号链接 → degraded', async () => {
    const unmounted = world({ mountData: false });
    expect(byId((await detector(unmounted).detect({})).data!.checks, 'data-volume')!.status).toBe('error');
    const noLink = world({ symlinkEtc: false });
    const r = await detector(noLink).detect({});
    expect(byId(r.data!.checks, 'data-volume')).toMatchObject({ status: 'degraded' });
  });

  it('深度探针：数据卷写-读-删', async () => {
    const r = await detector(world()).detect({ deep: true });
    expect(byId(r.data!.checks, 'data-volume')!.detail).toContain('写-读-删测试文件通过');
  });

  it('Nginx 不可达 → error；最近一次 reload 失败 → degraded', async () => {
    const w = world();
    expect(byId((await detector(w, { net: { nginxDown: true } }).detect({})).data!.checks, 'nginx')!.status).toBe('error');
    const w2 = world({ snapshot: { generatedAt: new Date().toISOString(), host: { nginx: { lastReloadOk: false, lastReloadAt: 'x' }, time: { synchronized: true } }, fail2ban: { available: true } } });
    expect(byId((await detector(w2).detect({})).data!.checks, 'nginx')!.status).toBe('degraded');
  });

  it('快照过期 → security-snapshot degraded，置信度降为 inferred；快照缺失 → degraded', async () => {
    const stale = world({ snapshot: { generatedAt: new Date(Date.now() - 10 * 60_000).toISOString(), host: { time: { synchronized: true } }, fail2ban: { available: true } } });
    const r = await detector(stale).detect({});
    expect(byId(r.data!.checks, 'security-snapshot')!.status).toBe('degraded');
    expect(r.confidence).toBe('inferred');
    const missing = world({ snapshot: null });
    expect(byId((await detector(missing).detect({})).data!.checks, 'security-snapshot')!.detail).toContain('不存在');
  });

  it('时间未同步、fail2ban 缺失、手工 drop-in、worker 单元异常 → degraded', async () => {
    const w = world({ snapshot: {
      generatedAt: new Date().toISOString(),
      host: { units: { 'cloudalbum-api': 'active', 'cloudalbum-worker': 'failed' }, time: { synchronized: false }, manualDropins: ['/etc/systemd/system/cloudalbum-api.service.d/99-local.conf'] },
      fail2ban: { available: false },
    } });
    writeFileSync(path.join(w.dataDir, 'etc', 'local.override.env'), 'X=1\n');
    const r = await detector(w).detect({});
    for (const id of ['time-sync', 'fail2ban', 'manual-dropins', 'processes']) expect(byId(r.data!.checks, id)!.status, id).toBe('degraded');
    expect(byId(r.data!.checks, 'manual-dropins')!.detail).toContain('local.override.env');
    expect(r.status === 'degraded' || r.status === 'error').toBe(true);
  });

  it('attach()：密钥指纹不一致 → error；进程心跳超过 2 分钟 → degraded', async () => {
    const w = world();
    const d = detector(w);
    d.attach({
      keyFingerprint: async () => ({ ok: false, detail: '指纹不一致（3fa1… ≠ 9c1e…）' }),
      heartbeats: () => ({ api: new Date().toISOString(), worker: new Date(Date.now() - 180_000).toISOString() }),
    });
    const r = await d.detect({});
    expect(byId(r.data!.checks, 'key-fingerprint')!.status).toBe('error');
    expect(byId(r.data!.checks, 'processes')!.status).toBe('degraded');
    expect(r.status).toBe('error');
  });
});

describe('Ec2Detector（开发机）', () => {
  it('非 EC2：跳过 IMDS / 数据卷 / Nginx，只报告磁盘与内存，detail 注明开发机', async () => {
    const w = world({ snapshot: null });
    const r = await detector(w, { isEc2: false, platform: 'win32' }).detect({});
    const ids = (r.data!.checks as CapabilityCheck[]).map((c) => c.id);
    expect(ids).toEqual(['disk', 'memory']);
    expect(r.detail).toContain('非 EC2 环境');
    expect(r.confidence).toBe('inferred');
  });
});

describe('IMDS 与本机辅助函数', () => {
  it('ImdsClient：令牌缓存；不可达后进入负缓存', async () => {
    let puts = 0;
    let calls = 0;
    const f = (async (input: string | URL | Request, init?: RequestInit) => {
      calls += 1;
      if (init?.method === 'PUT') {
        puts += 1;
        return new Response('tok', { status: 200 });
      }
      return new Response(String(input).endsWith('instance-id') ? 'i-1' : '', { status: 200 });
    }) as typeof fetch;
    const imds = new ImdsClient({ fetch: f });
    expect(await imds.text('/latest/meta-data/instance-id')).toBe('i-1');
    expect(await imds.text('/latest/meta-data/instance-id')).toBe('i-1');
    expect(puts).toBe(1);
    const down = new ImdsClient({ fetch: (async () => { calls += 1; throw new TypeError('fetch failed'); }) as typeof fetch });
    const before = calls;
    expect(await down.token()).toBeNull();
    expect(await down.token()).toBeNull();
    // 默认重试 2 次：第一次 token() 共尝试 3 次，之后进入负缓存，第二次 token() 不再发请求
    expect(calls - before).toBe(3);
    expect(down.unreachable).toBe(true);
  });

  it('retries a slow first IMDS answer instead of reporting unreachable (process just restarted)', async () => {
    let attempts = 0;
    const flaky = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      attempts += 1;
      if (attempts === 1) throw new DOMException('The operation was aborted due to timeout', 'TimeoutError');
      return new Response(init?.method === 'PUT' ? 'tok' : '', { status: 200 });
    }) as typeof fetch;
    const imds = new ImdsClient({ fetch: flaky });
    expect(await imds.token()).toBe('tok');
    expect(attempts).toBe(2);
    expect(imds.unreachable).toBe(false);
  });

  it('parseMountinfo 处理八进制转义；detectEc2Host 只在 Linux 上读 DMI', () => {
    const m = parseMountinfo('40 22 259:3 / /var/lib/cloud\\040album rw,noatime shared:20 - xfs /dev/nvme1n1 rw\n');
    expect(m).toEqual([{ majorMinor: '259:3', mountPoint: '/var/lib/cloud album', options: 'rw,noatime', fsType: 'xfs', source: '/dev/nvme1n1' }]);
    const sys = mkdtempSync(path.join(os.tmpdir(), 'cloudalbum-sys-'));
    mkdirSync(path.join(sys, 'devices/virtual/dmi/id'), { recursive: true });
    writeFileSync(path.join(sys, 'devices/virtual/dmi/id/board_asset_tag'), 'i-0123456789abcdef0\n');
    expect(detectEc2Host(sys, 'linux')).toBe(true);
    expect(detectEc2Host(sys, 'win32')).toBe(false);
    expect(detectEc2Host(path.join(sys, 'missing'), 'linux')).toBe(false);
  });
});
