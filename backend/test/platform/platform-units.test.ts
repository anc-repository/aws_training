// ATL 平台模式（06）的单元测试：platform.env 的校验与加载顺序、ATL-* 规则、探测令牌、apply-env、lab-metrics、path-seen、
// app-stat、admin:ensure --password-hash、测试数据种子
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type { Knex } from 'knex';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { canonicalJson, isReservedEmailDomain, projectCapabilities, ProjectionError, isModuleId } from '@cloudalbum/contracts';
import { ensureAdminWithHash, parseArgon2idPhc } from '../../src/cli/admin.js';
import { planApply } from '../../src/cli/platform/apply-env.js';
import { CliExit } from '../../src/cli/platform/common.js';
import { labMetricsRun, segmentOf, targetOfEntry } from '../../src/cli/platform/lab-metrics.js';
import { appStat, compileSafePattern, parseWindow, pathSeen } from '../../src/cli/platform/path-seen.js';
import { moduleState } from '../../src/cli/platform/capabilities.js';
import { probeTokenCommand } from '../../src/cli/platform/probe-token.js';
import { dataVolumeMounted } from '../../src/cli/platform/status.js';
import { loadEnvLayersSync } from '../../src/config/load-env.js';
import { validateConfig } from '../../src/config/validate.js';
import { decodeSeedUsers, seedCognitoTestUsers } from '../../src/lab/seeds/cognito-test-users.js';
import { orderSeeds } from '../../src/lab/seeds/index.js';
import { renderGpsSample, GPS_SAMPLES, toExifDms } from '../../src/lab/seeds/gps-sample-photos.js';
import { runAttributable } from '../../src/observability/bypass.js';
import { parseNginxLine } from '../../src/observability/nginx-log.js';
import {
  applyAction, normalizeMode, renderFrameAncestorsSlot, validatePlatformEnv, PlatformEnvSchema,
} from '../../src/platform/env-schema.js';
import { probeTokenPath, setPlatformStateForTests } from '../../src/platform/mode.js';
import {
  deriveKey, generateLocalSecret, issueLabToken, issueProbeToken, verifyLabToken, verifyLocalToken, verifyProbeToken, OTP_INFO,
} from '../../src/platform/probe-token.js';
import { insertHostSamples, insertLabRun, insertRollups } from '../../src/repositories/lab.js';
import { registerNonce, purgeExpiredNonces } from '../../src/repositories/atl-probe-nonces.js';
import { tempEnvDir } from '../helpers/config.js';
import { tempDir, testConfig, testDb } from '../helpers/media-fixtures.js';

const ON = {
  ATL_PLATFORM_MODE: 'on', ATL_SESSION_ID: 's4k7m2q9x1abc', ATL_ENV_ID: '01jc9x3k9cq4m2x8n5b6c0d1e2', ATL_ENV_NAME: 'e7k2m9qx',
  ATL_LAB_ID: 'svc-cdn', ATL_PLATFORM_ORIGIN: 'https://d1234abcd.cloudfront.net',
};

afterEach(() => setPlatformStateForTests(null));

describe('platform.env 的严格校验（PM-01）', () => {
  it('1 / true 归一为 on，0 / false / 空为 off，其他不合法', () => {
    expect(normalizeMode('1')).toBe('on');
    expect(normalizeMode('TRUE')).toBe('on');
    expect(normalizeMode('false')).toBe('off');
    expect(normalizeMode('')).toBe('off');
    expect(normalizeMode('yes')).toBeNull();
    expect(PlatformEnvSchema.safeParse({ ATL_PLATFORM_MODE: '1' }).success).toBe(true);
    expect(PlatformEnvSchema.safeParse({ ATL_PLATFORM_MODE: 'maybe' }).success).toBe(false);
  });

  it('合法的完整配置；ATL_VARIANT 缺省 default；探测密钥缺省路径', () => {
    const v = validatePlatformEnv({ ...ON, ATL_PLATFORM_MODE: 'true' }, { cloudalbumEnv: 'e7k2m9qx' });
    expect(v.valid).toBe(true);
    expect(v.values).toMatchObject({ mode: 'on', variant: 'default', probeTokenFile: '/etc/cloudalbum/atl/probe.token' });
    expect(v.normalized.ATL_PLATFORM_MODE).toBe('on');
  });

  it.each([
    ['ATL_SESSION_ID', 'S4K7M2Q9X1ABC'], ['ATL_SESSION_ID', 's4k7m2q9x1abu'], ['ATL_ENV_ID', '01JC9X'], ['ATL_ENV_NAME', 'e7k2m9q'],
    ['ATL_LAB_ID', 'cdn'], ['ATL_VARIANT', 'Default'], ['ATL_PLATFORM_ORIGIN', 'http://x.example'],
    ['ATL_PLATFORM_ORIGIN', 'https://x.example/'], ['ATL_PROBE_TOKEN_FILE', '/tmp/probe.token'], ['ATL_RELEASE', 'v1'],
  ])('%s=%s 不合法', (k, v) => {
    expect(validatePlatformEnv({ ...ON, [k]: v }, { cloudalbumEnv: 'e7k2m9qx' }).valid).toBe(false);
  });

  it('开启时必填；非 ATL_ 键与未知键报错；ATL_ENV_NAME ≠ CLOUDALBUM_ENV 报错；关闭时不要求必填', () => {
    expect(validatePlatformEnv({ ATL_PLATFORM_MODE: 'on' }).errors.join()).toMatch(/ATL_SESSION_ID 必填/);
    expect(validatePlatformEnv({ ...ON }, { rawKeys: [...Object.keys(ON), 'NODE_ENV'] }).errors.join()).toMatch(/只允许 ATL_/);
    expect(validatePlatformEnv({ ...ON, ATL_FOO: 'x' }).errors.join()).toMatch(/未知的键 ATL_FOO/);
    expect(validatePlatformEnv(ON, { cloudalbumEnv: 'lab' }).errors.join()).toMatch(/不一致/);
    expect(validatePlatformEnv({ ATL_PLATFORM_MODE: 'off' }).valid).toBe(true);
  });

  it('进程处理（--restart auto）：只改展示字段 → reload（SIGHUP）；其余 → restart；没变 → none', () => {
    expect(applyAction(ON, { ...ON, ATL_SESSION_ID: 's00000000000a' }).action).toBe('reload');
    expect(applyAction(ON, { ...ON, ATL_LAB_ID: 'svc-cdn', ATL_VARIANT: 'v2' })).toEqual({ changed: ['ATL_VARIANT'], action: 'reload' });
    expect(applyAction(ON, { ...ON, ATL_PLATFORM_ORIGIN: 'https://other.example' }).action).toBe('restart');
    expect(applyAction(ON, { ...ON }).action).toBe('none');
  });

  it('Nginx 槽位：开启时一条 map 条目，关闭时只有注释', () => {
    expect(renderFrameAncestorsSlot({ mode: 'on', origin: 'https://a.example' })).toContain(`"" "frame-ancestors 'self' https://a.example";`);
    expect(renderFrameAncestorsSlot({ mode: 'off' })).not.toContain('frame-ancestors \'self\'');
  });
});

describe('分层加载第 1b 层与 ATL-* 规则（PM-01、PM-48）', () => {
  it('platform.env 中的非 ATL_ 键 → ATL-CFG-001（且不参与合并）；其他层的 ATL_ 键 → CFG-002', async () => {
    const dir = tempEnvDir({ base: { CLOUDALBUM_ENV: 'e7k2m9qx', ATL_LAB_ID: 'svc-x' }, raw: { 'platform.env': 'ATL_PLATFORM_MODE=off\nNODE_ENV=production\n' } });
    const layers = loadEnvLayersSync(dir, { processEnv: {} });
    expect(layers.merged.NODE_ENV).toBeUndefined();
    expect(layers.merged.ATL_LAB_ID).toBeUndefined();
    expect(layers.issues.map((i) => i.code).sort()).toEqual(['ATL-CFG-001', 'CFG-002']);
    const v = await validateConfig({ role: 'cli', envDir: dir, processEnv: {} });
    expect(v.ok).toBe(false);
    expect(v.verdict.errors.map((e) => e.rule).sort()).toEqual(['ATL-CFG-001', 'CFG-002']);
  });

  it('平台模式开启但 ATL_ENV_NAME ≠ CLOUDALBUM_ENV → ATL-CFG-001（启动 78）；探测密钥缺失 → ATL-CFG-002 警告', async () => {
    const dir = tempEnvDir({ base: { CLOUDALBUM_ENV: 'lab' }, raw: { 'platform.env': Object.entries(ON).map(([k, v]) => `${k}=${v}`).join('\n') } });
    const v = await validateConfig({ role: 'cli', envDir: dir, processEnv: {} });
    expect(v.verdict.errors.map((e) => e.rule)).toContain('ATL-CFG-001');
    const ok = tempEnvDir({ base: { CLOUDALBUM_ENV: 'e7k2m9qx' }, raw: { 'platform.env': Object.entries(ON).map(([k, v]) => `${k}=${v}`).join('\n') } });
    const v2 = await validateConfig({ role: 'cli', envDir: ok, processEnv: {} });
    expect(v2.ok).toBe(true);
    expect(v2.verdict.warnings.map((w) => w.rule)).toContain('ATL-CFG-002');
  });

  it('平台模式关闭（没有 platform.env）时 ATL-* 规则不求值；ATL-NET-001 只在平台模式下报', async () => {
    const priv = { NETWORK_PLACEMENT: 'private', NETWORK_NAT_MODE: 'none', CLOUDALBUM_ENV: 'e7k2m9qx' };
    const off = await validateConfig({ role: 'cli', envDir: tempEnvDir({ base: priv }), processEnv: {}, checkImplemented: false });
    expect([...off.verdict.errors, ...off.verdict.warnings].some((f) => f.rule.startsWith('ATL-'))).toBe(false);
    const on = tempEnvDir({ base: priv, raw: { 'platform.env': Object.entries(ON).map(([k, v]) => `${k}=${v}`).join('\n') } });
    const v = await validateConfig({ role: 'cli', envDir: on, processEnv: {}, checkImplemented: false });
    expect(v.verdict.errors.map((e) => e.rule)).toContain('ATL-NET-001');
    const fixed = tempEnvDir({ base: { ...priv, NETWORK_INTERFACE_ENDPOINTS: 'ssm' }, raw: { 'platform.env': Object.entries(ON).map(([k, v]) => `${k}=${v}`).join('\n') } });
    const v3 = await validateConfig({ role: 'cli', envDir: fixed, processEnv: {}, checkImplemented: false });
    expect(v3.verdict.errors.map((e) => e.rule)).not.toContain('ATL-NET-001');
  });

  it('ASG-014 在平台模式下的修复提示指向 tls-preview off', async () => {
    const env = { CLOUDALBUM_ENV: 'e7k2m9qx', DEPLOY_MODE: 'asg', TLS_MODE: 'letsencrypt' };
    const off = await validateConfig({ role: 'cli', envDir: tempEnvDir({ base: env }), processEnv: {}, checkImplemented: false });
    expect(off.verdict.errors.find((e) => e.rule === 'ASG-014')?.fix).toMatch(/enable tls/);
    const on = tempEnvDir({ base: env, raw: { 'platform.env': Object.entries(ON).map(([k, v]) => `${k}=${v}`).join('\n') } });
    const v = await validateConfig({ role: 'cli', envDir: on, processEnv: {}, checkImplemented: false });
    expect(v.verdict.errors.find((e) => e.rule === 'ASG-014')?.fix).toMatch(/tls-preview off/);
  });
});

describe('探测令牌（PM-09、PM-13、PM-17）', () => {
  const secret = generateLocalSecret();
  const now = 1_790_000_000;

  it('本机密钥格式；本机令牌常量时间比较', () => {
    expect(secret).toMatch(/^atlpk1\.[A-Za-z0-9_-]{43}$/);
    expect(verifyLocalToken(secret, secret)).toBe(true);
    expect(verifyLocalToken(generateLocalSecret(), secret)).toBe(false);
    expect(verifyLocalToken(secret, null)).toBe(false);
  });

  it('一次性令牌：签发上限 60 秒；篡改 exp / 签名 → INVALID；过期 → EXPIRED；未来过远 → INVALID', () => {
    expect(() => issueProbeToken(secret, 61, now)).toThrow(RangeError);
    const { token, exp } = issueProbeToken(secret, 30, now);
    expect(token).toMatch(/^atlpt1\.[A-Za-z0-9_-]{22}\.[0-9]{10}\.[A-Za-z0-9_-]{43}$/);
    expect(verifyProbeToken(token, secret, now)).toMatchObject({ ok: true, exp });
    const [p, n, e, s] = token.split('.');
    expect(verifyProbeToken(`${p}.${n}.${Number(e) + 1}.${s}`, secret, now)).toEqual({ ok: false, code: 'PROBE_TOKEN_INVALID' });
    expect(verifyProbeToken(`${p}.${n}.${e}.${'A'.repeat(43)}`, secret, now)).toEqual({ ok: false, code: 'PROBE_TOKEN_INVALID' });
    expect(verifyProbeToken(token, secret, now + 36)).toEqual({ ok: false, code: 'PROBE_TOKEN_EXPIRED' });
    expect(verifyProbeToken(token, secret, now + 34)).toMatchObject({ ok: true });      // 5 秒时钟偏差
    expect(verifyProbeToken(token, secret, now - 40)).toEqual({ ok: false, code: 'PROBE_TOKEN_INVALID' });
    expect(verifyProbeToken(token, generateLocalSecret(), now)).toEqual({ ok: false, code: 'PROBE_TOKEN_INVALID' });
  });

  it('HKDF 的 info 区分一次性令牌与 lab-token：互相不能冒用', () => {
    expect(deriveKey(secret, OTP_INFO)).toHaveLength(32);
    const lab = issueLabToken(secret, 3600, now);
    expect(verifyLabToken(lab.token, secret, now + 3000)).toMatchObject({ ok: true });
    const forged = lab.token.replace(/^atllt1/, 'atlpt1');
    expect(verifyProbeToken(forged, secret, now)).toMatchObject({ ok: false });
  });

  it('nonce 只能登记一次；过期的 nonce 由 atl.probe-nonce-gc 删除', async () => {
    const db = await testDb();
    try {
      expect(await registerNonce(db, { nonce: 'n'.repeat(22), exp: now, usedAt: now })).toBe(true);
      expect(await registerNonce(db, { nonce: 'n'.repeat(22), exp: now, usedAt: now })).toBe(false);
      expect(await purgeExpiredNonces(db, now + 599)).toBe(0);
      expect(await purgeExpiredNonces(db, now + 601)).toBe(1);
    } finally {
      await db.destroy();
    }
  });

  it('probe-token CLI：--status 只打印指纹；--init 幂等；--rotate 使旧令牌失效；平台模式关闭 → 退出 3', () => {
    const dir = tempEnvDir({ base: { CLOUDALBUM_ENV: 'e7k2m9qx' }, raw: { 'platform.env': Object.entries(ON).map(([k, v]) => `${k}=${v}`).join('\n') } });
    expect(probeTokenCommand({ envDir: dir, status: true })).toEqual({ present: false });
    const init = probeTokenCommand({ envDir: dir, init: true });
    expect(init).toMatchObject({ present: true, created: true });
    expect(probeTokenCommand({ envDir: dir, init: true })).toMatchObject({ created: false, fingerprint: init.fingerprint });
    const issued = probeTokenCommand({ envDir: dir, ttl: '60', count: '2' }) as { tokens: string[] };
    expect(issued.tokens).toHaveLength(2);
    expect(JSON.stringify(probeTokenCommand({ envDir: dir, status: true }))).not.toMatch(/atlpk1/);
    const rotated = probeTokenCommand({ envDir: dir, rotate: true });
    expect(rotated.fingerprint).not.toBe(init.fingerprint);
    expect(() => probeTokenCommand({ envDir: dir, ttl: '61' })).toThrow(CliExit);
    const off = tempEnvDir({ base: { CLOUDALBUM_ENV: 'e7k2m9qx' } });
    probeTokenCommand({ envDir: off, init: true });
    try {
      probeTokenCommand({ envDir: off, ttl: '10' });
      expect.fail('should throw');
    } catch (e) {
      expect((e as CliExit).exitCode).toBe(3);
    }
    expect(probeTokenPath({ envDir: '/x/etc', probeTokenFile: '/etc/cloudalbum/atl/probe.token' })).toBe(path.join('/x/etc', 'atl', 'probe.token'));
  });
});

describe('platform:apply-env（PM-02）', () => {
  const b64 = (text: string) => Buffer.from(text).toString('base64url');

  it('校验失败不写文件；合法时给出规范化文件、槽位与差异', () => {
    const dir = tempEnvDir({ base: { CLOUDALBUM_ENV: 'e7k2m9qx' } });
    const bad = planApply(dir, b64('ATL_PLATFORM_MODE=on\nFOO=1\n'));
    expect(bad.validation.valid).toBe(false);
    const good = planApply(dir, b64(`${Object.entries({ ...ON, ATL_PLATFORM_MODE: '1' }).map(([k, v]) => `${k}=${v}`).join('\n')}\n`));
    expect(good.validation.valid).toBe(true);
    expect(good.file).toContain('ATL_PLATFORM_MODE=on');
    expect(good.slot).toContain("frame-ancestors 'self' https://d1234abcd.cloudfront.net");
    expect(good.action).toBe('restart');
    writeFileSync(path.join(dir, 'platform.env'), good.file);
    const sid = planApply(dir, b64(`${Object.entries({ ...ON, ATL_SESSION_ID: 's000000000001' }).map(([k, v]) => `${k}=${v}`).join('\n')}\n`));
    expect(sid).toMatchObject({ changed: ['ATL_SESSION_ID'], action: 'reload' });
    expect(planApply(dir, b64(good.file)).action).toBe('none');
    expect(() => planApply(dir, 'not base64 !')).toThrow(CliExit);
  });
});

describe('lab-metrics / path-seen / app-stat（PM-14、PM-16）', () => {
  let db: Knex;
  const runId = '01JB3M2C8Y3T5Q6W7E8R9T0Y1V';
  const started = new Date(Date.now() - 5 * 60_000);
  const minute = (offsetMin: number) => { const d = new Date(started.getTime() + offsetMin * 60_000); d.setUTCSeconds(0, 0); return d.toISOString(); };
  const hist = (n: number) => { const h = new Array(66).fill(0); h[20] = n; return h; };

  beforeAll(async () => {
    db = await testDb();
    await insertLabRun(db, { runId, module: 'cdn', experiment: 'media-load', label: 'after', startedAt: started.toISOString(), windowSec: 600,
      variant: { label: 'after', role: 'treatment' } });
    await insertRollups(db, [
      { minute: minute(1), instanceId: 'i-1', role: 'api', kind: 'route', route: '/media/variants/:id/:file', method: 'GET', pathSig: 'entry=nginx;storage=local:accel', runId, label: 'after', statusClass: '2xx', count: 20, errors: 0, sumMs: 100, maxMs: 9, hist: hist(20) },
      { minute: minute(1), instanceId: 'i-1', role: 'api', kind: 'route', route: '/media/variants/:id/:file', method: 'GET', pathSig: 'entry=cloudfront>nginx;storage=local:accel;cdn=cloudfront', runId, label: 'after', statusClass: '2xx', count: 6, errors: 0, sumMs: 30, maxMs: 9, hist: hist(6) },
      { minute: minute(2), instanceId: 'i-1', role: 'api', kind: 'route', route: '/api/photos', method: 'POST', pathSig: 'entry=nginx;queue=sqs:send;storage=s3:presign', statusClass: '4xx', count: 3, errors: 0, sumMs: 30, maxMs: 9, hist: hist(3) },
      { minute: minute(2), instanceId: 'i-1', role: 'api', kind: 'route', route: '/api/photos', method: 'POST', pathSig: 'entry=nginx;queue=sqs:send', count: 2, errors: 1, sumMs: 30, maxMs: 9, hist: hist(2) },
    ]);
    await insertHostSamples(db, [
      { ts: minute(1), instanceId: 'i-1', role: 'api', pid: 1, cpuPct: 10, rssBytes: 1, heapUsedBytes: 1, eventLoopDelayP99Ms: 1, loadavg1: 0, memUsedRatio: 0.1, netTxBytes: 1000, netRxBytes: 50 },
      { ts: minute(3), instanceId: 'i-1', role: 'api', pid: 1, cpuPct: 30, rssBytes: 1, heapUsedBytes: 1, eventLoopDelayP99Ms: 1, loadavg1: 0, memUsedRatio: 0.1, netTxBytes: 4000, netRxBytes: 150 },
    ]);
  });
  afterAll(async () => { await db?.destroy(); });

  it('lab-metrics：app（按目标、按状态、路径签名、路由）+ origin（Nginx 日志 run 字段，排除 probe=1，旧格式行跳过）+ host', async () => {
    const dir = tempDir('cloudalbum-ngx-');
    const log = path.join(dir, 'nginx-access.json');
    const line = (o: Record<string, unknown>) => JSON.stringify({ ts: started.toISOString(), rid: 'r', ip: '1.2.3.4', xff: '', method: 'GET', uri: '/media/x', status: 200, bytes: 10, rt: 0.001, urt: '', cf_id: '', via: '', alb_trace: '', path: '', ...o });
    writeFileSync(log, [
      line({ args: '', port: '80', run: runId, probe: 0 }),
      line({ args: '', port: '8080', run: runId, probe: 0, cf_id: 'abc==' }),
      line({ args: '', port: '80', run: runId, probe: 1 }),
      line({}),                                               // 旧格式：没有 run / port / probe
      'not json',
    ].join('\n'));
    const cfg = testConfig();
    const r = await labMetricsRun(db, cfg, runId, { padSec: 30, nginxLogFiles: [log] });
    expect(r.schema).toBe('cloudalbum.lab-metrics-run/v1');
    expect(r.registered).toMatchObject({ module: 'cdn', experiment: 'media-load', label: 'after', windowSec: 600, variant: { label: 'after', role: 'treatment' } });
    expect(r.open).toBe(true);
    expect(r.app.requests).toBe(26);
    expect(r.app.byTarget).toEqual({ direct: 20, cdn: 6, alb: 0, apigw: 0 });
    expect(r.app.byStatus).toEqual({ '2xx': 26, '4xx': 0, '5xx': 0 });
    expect(r.app.pathSignatures[0]).toEqual({ signature: 'entry=nginx;storage=local:accel', count: 20 });
    expect(r.app.routes['/media/variants/:id/:file']?.count).toBe(26);
    expect(r.origin).toEqual({ source: 'nginx-access-log', requests: 2, byPort: { 80: 1, 8080: 1 }, viaCloudfront: 1, viaAlb: 0 });
    expect(r.excludedProbeRequests).toBe(1);
    expect(r.host).toEqual({ cpuP95: 30, netTxBytes: 3000, netRxBytes: 100 });
    await expect(labMetricsRun(db, cfg, '01JB3M2C8Y3T5Q6W7E8R9T0Y1W')).rejects.toMatchObject({ exitCode: 4 });
  });

  it('path-seen：按段匹配、计数、不同取值与样例；拒绝回溯类模式；窗口 1m..24h', async () => {
    const r = await pathSeen(db, { segment: 'queue', pattern: compileSafePattern('^sqs:'), windowMin: 60 });
    expect(r.count).toBe(5);
    expect(r.distinctValues).toEqual(['sqs:send']);
    expect(r.samples[0]).toMatchObject({ route: 'POST /api/photos', value: 'sqs:send' });
    expect((await pathSeen(db, { segment: 'entry', pattern: compileSafePattern('^cloudfront>'), windowMin: 60 })).count).toBe(6);
    expect((await pathSeen(db, { segment: 'storage', pattern: compileSafePattern('^s3:presign$'), windowMin: 60 })).count).toBe(3);
    expect(() => compileSafePattern('(a)\\1')).toThrow(CliExit);
    expect(() => compileSafePattern('(?=a)b')).toThrow(CliExit);
    expect(() => compileSafePattern('(a+)+$')).toThrow(CliExit);
    expect(parseWindow('15m')).toBe(15);
    expect(parseWindow('24h')).toBe(1440);
    expect(() => parseWindow('25h')).toThrow(CliExit);
    expect(() => parseWindow('0m')).toThrow(CliExit);
  });

  it('app-stat：白名单、--run 的支持、未实现的统计退出 3、未知统计退出 2', async () => {
    expect(await appStat(db, 'photos.count')).toMatchObject({ stat: 'photos.count', value: 0, unit: 'count', scope: 'now' });
    expect(await appStat(db, 'jobs.failed', runId)).toMatchObject({ scope: 'run', runId });
    await expect(appStat(db, 'nope')).rejects.toMatchObject({ exitCode: 2 });
    await expect(appStat(db, 'photos.count', runId)).rejects.toMatchObject({ exitCode: 2 });
    await expect(appStat(db, 'biz.jobs_lost', runId)).rejects.toMatchObject({ exitCode: 3 });
  });

  it('段解析与目标映射', () => {
    expect(segmentOf('entry=cloudfront>alb>nginx;cache=redis@elasticache:hit', 'cache')).toBe('redis@elasticache:hit');
    expect(targetOfEntry('cloudfront>alb>nginx')).toBe('cdn');
    expect(targetOfEntry('alb>waf>nginx')).toBe('alb');
    expect(targetOfEntry('nginx')).toBe('direct');
  });
});

describe('运行归属的时间窗（PM-40）与 Nginx 日志解析（PM-18）', () => {
  it('登记时间窗 + 120 秒宽限，标签必须一致', () => {
    const run = { label: 'after', startedAt: '2026-10-14T00:00:00.000Z', windowSec: 600 };
    const t = Date.parse(run.startedAt);
    expect(runAttributable(run, 'after', t + 700_000)).toBe(true);
    expect(runAttributable(run, 'after', t + 721_000)).toBe(false);
    expect(runAttributable(run, 'before', t + 1000)).toBe(false);
    expect(runAttributable(run, 'after', t - 119_000)).toBe(true);
  });

  it('新旧两种日志行都能解析', () => {
    expect(parseNginxLine('{"ts":"x","status":200,"bytes":1,"args":"atlprobe=abc","port":"8080","run":"R","probe":1}')).toMatchObject({ args: 'atlprobe=abc', port: '8080', run: 'R', probe: true });
    expect(parseNginxLine('{"ts":"x","status":200,"bytes":1,"path":"entry=nginx"}')).toMatchObject({ probe: false, path: 'entry=nginx' });
    expect(parseNginxLine('garbage')).toBeNull();
  });
});

describe('module-state 与 platform-status 的辅助（PM-15、PM-02）', () => {
  it('module-state：新格式的 modules.state.json + modules.d 的开关；兼容旧格式', () => {
    const dir = tempEnvDir({
      modules: { cdn: { MODULE_CDN: 'on', CDN_BASE_URL: 'https://d1.cloudfront.net' }, queue: { QUEUE_DRIVER: 'memory' } },
      raw: { 'modules.state.json': JSON.stringify({ modules: { cdn: { enabled: true, driver: 'cloudfront', version: 3, enabledAt: '2026-10-13T00:00:00Z' }, iam: { status: 'enabled', at: '2026-10-12T00:00:00Z' } },
        history: [{ opId: '01J', op: 'enable', module: 'cdn', at: '2026-10-13T00:00:00Z', operator: 'atl-s4k7m2q9x1abc-ws' }], pending: null }) },
    });
    const s = moduleState(dir) as { modules: Record<string, Record<string, unknown>>; history: unknown[] };
    expect(s.modules.cdn).toMatchObject({ enabled: true, driver: 'cloudfront', version: 3, envFile: true });
    expect(s.modules.iam).toMatchObject({ enabled: true, enabledAt: '2026-10-12T00:00:00Z', envFile: false });
    expect(s.modules.queue).toMatchObject({ enabled: false, driver: 'memory', envFile: true });
    expect((moduleState(dir, 'iam') as { history: unknown[] }).history).toHaveLength(0);
  });

  it('数据卷挂载判定读 mountinfo', () => {
    const mi = '36 35 98:0 / /var/lib/cloudalbum rw,noatime - xfs /dev/nvme1n1 rw\n37 35 98:0 / / rw - xfs /dev/nvme0n1p1 rw\n';
    expect(dataVolumeMounted('/var/lib/cloudalbum', mi)).toBe(true);
    expect(dataVolumeMounted('/data', mi)).toBe(false);
  });
});

describe('admin:ensure --password-hash（PM-07）与种子（PM-43～PM-45）', () => {
  let db: Knex;
  let phc: string;
  beforeAll(async () => {
    db = await testDb();
    const argon2 = await import('@node-rs/argon2');
    phc = await argon2.hash('Correct-Horse-1', { memoryCost: 19456, timeCost: 2, parallelism: 1 });
  });
  afterAll(async () => { await db?.destroy(); });

  it('PHC 解析与参数下限', async () => {
    expect(parseArgon2idPhc(phc)).toMatchObject({ version: 19, m: 19456, t: 2, p: 1 });
    const weak = await (await import('@node-rs/argon2')).hash('x', { memoryCost: 4096, timeCost: 1, parallelism: 1 });
    await expect(ensureAdminWithHash(db, { email: 'atl-admin@example.com', passwordHash: weak })).rejects.toMatchObject({ exitCode: 2, code: 'PASSWORD_HASH_WEAK' });
    await expect(ensureAdminWithHash(db, { email: 'atl-admin@example.com', passwordHash: '$2b$10$abc' })).rejects.toMatchObject({ exitCode: 2 });
  });

  it('三种结果分支；--reset 递增 token_version', async () => {
    expect(await ensureAdminWithHash(db, { email: 'atl-admin@example.com', passwordHash: phc })).toEqual({ created: true });
    expect(await ensureAdminWithHash(db, { email: 'atl-admin@example.com', passwordHash: phc })).toEqual({ created: false });
    const before = await db('users').where({ email: 'atl-admin@example.com' }).first();
    expect(await ensureAdminWithHash(db, { email: 'atl-admin@example.com', passwordHash: phc, reset: true })).toEqual({ updated: true });
    const after = await db('users').where({ email: 'atl-admin@example.com' }).first();
    expect(after.role).toBe('admin');
    expect(after.token_version).toBe(before.token_version + 1);
  });

  it('cognito-test-users：只收哈希、保留域名、幂等、不改动学员自己的同邮箱账号', async () => {
    const users = [1, 2, 3].map((i) => ({ username: `atl-test-${i}`, email: `atl-test-${i}@example.com`, passwordHash: phc }));
    const b64 = Buffer.from(JSON.stringify(users)).toString('base64url');
    const decoded = decodeSeedUsers(b64);
    expect(decoded).toHaveLength(3);
    expect(() => decodeSeedUsers(Buffer.from(JSON.stringify([{ ...users[0], email: 'x@gmail.com' }])).toString('base64url'))).toThrow(CliExit);
    expect(() => decodeSeedUsers(Buffer.from(JSON.stringify([{ ...users[0], password: 'plain' }])).toString('base64url'))).toThrow(CliExit);
    await db('users').insert({ id: 'own', email: 'atl-test-3@example.com', display_name: 'me', password_hash: null, email_verified: false, role: 'member', plan: 'free', auth_provider: 'local', auth_subject: 'own', token_version: 0, created_at: '2026-01-01T00:00:00Z', updated_at: '2026-01-01T00:00:00Z' });
    expect(await seedCognitoTestUsers(db, decoded)).toMatchObject({ created: 2, updated: 0, unchanged: 0, skipped: ['atl-test-3@example.com'] });
    expect(await seedCognitoTestUsers(db, decoded)).toMatchObject({ created: 0, unchanged: 2 });
    const seeded = await db('users').where({ seed_id: 'cognito-test-users' });
    expect(seeded.map((u: { display_name: string }) => u.display_name).sort()).toEqual(['atl-test-1', 'atl-test-2']);
    expect(orderSeeds(['gps-sample-photos', 'cognito-test-users'])).toEqual(['cognito-test-users', 'gps-sample-photos']);
  });

  it('gps-sample-photos：确定性生成、EXIF GPS 可读出', async () => {
    const a = await renderGpsSample(GPS_SAMPLES[0]!);
    const b = await renderGpsSample(GPS_SAMPLES[0]!);
    expect(a.equals(b)).toBe(true);
    const exifr = (await import('exifr')).default;
    const gps = await exifr.gps(a);
    expect(gps.latitude).toBeCloseTo(35.6812, 3);
    expect(gps.longitude).toBeCloseTo(139.7671, 3);
    expect(toExifDms(35.5)).toBe('35/1 30/1 0/100');
  });
});

describe('contracts：capabilities 投影、RFC 8785、保留域名', () => {
  const body = {
    schemaVersion: 2, view: 'admin', app: { profile: 'l0-ec2', entry: { baseUrl: 'http://x', source: 'base' }, platform: { mode: 'on', sessionId: 's1' } },
    https: { trusted: false, via: 'none' }, validation: { errors: [{ rule: 'X', modules: ['cdn'], message: 'm' }], warnings: [], overridden: [] },
    modules: { cdn: { driver: 'direct', status: 'off', localHealth: 'ok', detail: 'd', data: { a: 1 } }, iam: { driver: 'none', status: 'off', detail: 'd' } },
    features: { 'F6.upload': { enabled: true, via: ['storage:local'] } }, lab: { bypassEnabled: true, bypassKeys: [] },
  };

  it('通配、数组、自由子树；非法路径与未知模块报错', () => {
    const r = projectCapabilities(body, { fields: 'app.platform.sessionId,validation.errors[].rule,modules.*.status,modules.cdn.data,features.F6.upload.enabled', isModuleId });
    expect(r.body).toEqual({
      app: { platform: { sessionId: 's1' } }, validation: { errors: [{ rule: 'X' }] },
      modules: { cdn: { status: 'off', data: { a: 1 } }, iam: { status: 'off' } }, features: { 'F6.upload': { enabled: true } },
    });
    expect(() => projectCapabilities(body, { fields: 'app.nope', isModuleId })).toThrow(ProjectionError);
    expect(() => projectCapabilities(body, { fields: 'modules.nope.status', isModuleId })).toThrow(ProjectionError);
    expect(() => projectCapabilities(body, { fields: 'app.profile.x', isModuleId })).toThrow(ProjectionError);
    expect(() => projectCapabilities(body, { modules: 'nope', isModuleId })).toThrow(ProjectionError);
  });

  it('超过上限时按模块 id 字母序截断，带 truncated 与 nextModules', () => {
    const big = { ...body, modules: Object.fromEntries(['iam', 'cdn', 'storage'].map((id) => [id, { driver: 'x', detail: 'y'.repeat(300) }])) };
    const r = projectCapabilities(big, { fields: 'modules.*.detail', isModuleId, maxBytes: 450 });
    expect(r.truncated).toBe(true);
    expect(Object.keys((r.body.modules as Record<string, unknown>))).toEqual(['cdn']);
    expect(r.nextModules).toEqual(['iam', 'storage']);
  });

  it('RFC 8785：键排序、数字形式、undefined 成员省略', () => {
    expect(canonicalJson({ b: 1, a: [true, null, 'x'], c: undefined, d: 1e21, e: 0.1 })).toBe('{"a":[true,null,"x"],"b":1,"d":1e+21,"e":0.1}');
    expect(canonicalJson({ 'é': 1, z: 2, A: 3 })).toBe('{"A":3,"z":2,"é":1}');
  });

  it('保留域名（PM-46）', () => {
    for (const e of ['a@example.com', 'a@sub.example.org', 'a@x.test', 'a@foo.invalid', 'a@b.localhost', 'a@demo.example']) expect(isReservedEmailDomain(e), e).toBe(true);
    for (const e of ['a@gmail.com', 'a@example.co', 'a@notexample.com']) expect(isReservedEmailDomain(e), e).toBe(false);
  });
});

describe('预览方案 B 的有效入口（PM-21 第 4 条）', () => {
  it('TLS_PUBLIC_IP 等于 APP_BASE_URL 的主机且 TLS_DOMAIN 为空 → https，受信（letsencrypt@nginx），hostKind=ip', async () => {
    const { effectiveEntry, httpsState, hostKindOf } = await import('../../src/config/base-url.js');
    const cfg = testConfig({ APP_BASE_URL: 'http://203.0.113.10', TLS_MODE: 'letsencrypt', TLS_LE_PROFILE: 'shortlived', TLS_PUBLIC_IP: '203.0.113.10', TLS_PREVIEW: 'letsencrypt-ip' });
    expect(effectiveEntry(cfg)).toEqual({ baseUrl: 'https://203.0.113.10', source: 'base' });
    expect(httpsState(cfg)).toEqual({ trusted: true, via: 'letsencrypt@nginx' });
    expect(hostKindOf('https://203.0.113.10')).toBe('ip');
    expect(hostKindOf('https://d1.cloudfront.net')).toBe('dns');
    const other = testConfig({ APP_BASE_URL: 'http://203.0.113.10', TLS_MODE: 'letsencrypt', TLS_PUBLIC_IP: '198.51.100.1' });
    expect(effectiveEntry(other).baseUrl).toBe('http://203.0.113.10');
    expect(effectiveEntry(testConfig({ APP_BASE_URL: 'http://203.0.113.10' })).baseUrl).toBe('http://203.0.113.10');
  });
});

describe('dev 环境下的 probe-token 文件位置', () => {
  it('ATL_PROBE_TOKEN_FILE 的 /etc/cloudalbum 前缀映射到配置目录', () => {
    const d = tempDir('cloudalbum-ptk-');
    mkdirSync(path.join(d, 'atl'), { recursive: true });
    expect(probeTokenPath({ envDir: d, probeTokenFile: '/etc/cloudalbum/atl/other.token' })).toBe(path.join(d, 'atl', 'other.token'));
  });
});
