// identity-pool 实验（wave1-identity-pool）：清单与 registry 一致；三个 Node 场景对一个本地替身运行——替身实现 F14 的两种授权
// （应用自签前缀令牌、带前缀策略的“STS 凭证”）与一个按 IAM 策略变量规则判定的路径式假 S3；其余接口（capabilities、/api/lab/runs …）
// 转发给共用的 mock-server。另测 SRP（按同一公式实现的假服务端核对客户端签名）与 SigV4、测试用户文件解析。
import { createHash, createHmac, randomBytes, randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { REGISTRY_DOCUMENT } from '@cloudalbum/contracts/registry';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FaultExecutor } from '../_lib/faults.js';
import { closeSharedDispatcher } from '../_lib/http.js';
import { loadManifest, validateLabel } from '../_lib/manifest.js';
import { EXIT, parseRunnerArgs, runExperiment } from '../_lib/runner.js';
import { validateExperimentManifest, validateResult } from '../_lib/schema.js';
import type { ResultDoc } from '../_lib/types.js';
import { experimentsRoot } from '../_lib/util.js';
import {
  cognitoTimestamp, G, hexHash, hkdf, K, modPow, N, padHex, passwordVerifier, srpLogin, srpStart, type CognitoCall,
} from '../identity-pool/cognito-srp.js';
import { classify, summarize } from '../identity-pool/cross-prefix.js';
import { loadAccounts, parseAccounts } from '../identity-pool/lib.js';
import { signS3 } from '../identity-pool/s3.js';
import { startMockServer, type MockServer } from './mock-server.js';

const STAGING = 'cloudalbum-test-upload-staging';
const RAW = 'cloudalbum-test-raw';
const PART = 1024 * 1024;

interface Photo { id: string; owner: string; rawKey: string; status: string; parts: Map<number, number> }
let mock: MockServer;
let front: http.Server;
let frontUrl = '';
let storageDriver: 'local' | 's3' = 'local';
const tmp = mkdtempSync(path.join(os.tmpdir(), 'exp-identity-pool-'));
const usersFile = path.join(tmp, 'users.json');
const executor: FaultExecutor = async () => ({ via: 'test', exitCode: 0 });
const photos = new Map<string, Photo>();
const objects = new Map<string, number>();                     // "<bucket>/<key>" → size
const mpu = new Map<string, { bucket: string; key: string; parts: Map<number, number> }>();
const identity: Record<string, string> = { usera: `ap-northeast-1:${randomUUID()}`, userb: `ap-northeast-1:${randomUUID()}` };
const tokens: Record<string, string> = { 'tok-usera': 'usera', 'tok-userb': 'userb' };

function send(res: http.ServerResponse, status: number, body: unknown, pathHeader = 'entry=direct;inst=i-mock', extra: Record<string, string> = {}): void {
  const isXml = typeof body === 'string';
  res.writeHead(status, { 'content-type': isXml ? 'application/xml' : 'application/json', 'x-cloudalbum-path': pathHeader, 'server-timing': 'total;dur=2', ...extra });
  res.end(isXml ? body : JSON.stringify(body));
}

const s3Denied = (res: http.ServerResponse) => send(res, 403, '<Error><Code>AccessDenied</Code><Message>Access Denied</Message></Error>');

function forward(req: http.IncomingMessage, body: Buffer, res: http.ServerResponse): void {
  const target = new URL(mock.url);
  const up = http.request({ host: target.hostname, port: target.port, path: req.url, method: req.method, headers: req.headers }, (r) => {
    const chunks: Buffer[] = [];
    r.on('data', (c: Buffer) => chunks.push(c));
    r.on('end', () => {
      const headers = { ...r.headers };
      delete headers['content-length'];
      res.writeHead(r.statusCode ?? 502, headers);
      res.end(Buffer.concat(chunks));
    });
  });
  up.on('error', () => send(res, 502, { error: 'BAD_GATEWAY' }));
  up.end(body);
}

/** 路径式假 S3：按 Authorization 的 AccessKeyId 认出用户，按“只能写 private/<identityId>/”的策略判定 */
function fakeS3(req: http.IncomingMessage, u: URL, body: Buffer, res: http.ServerResponse): void {
  const [, bucket, ...rest] = u.pathname.split('/');
  const key = rest.map(decodeURIComponent).join('/');
  const m = req.method ?? 'GET';
  const user = /Credential=ASIA([A-Z]+)\//.exec(String(req.headers.authorization ?? ''))?.[1]?.toLowerCase();
  const own = user ? `private/${identity[user]}/` : '\u0000';
  if (bucket === RAW) {
    // 预签名的 UploadPart（令牌模式 + storage=s3）
    const up = mpu.get(u.searchParams.get('uploadId') ?? '');
    if (m !== 'PUT' || !up) return s3Denied(res);
    up.parts.set(Number(u.searchParams.get('partNumber')), body.length);
    return send(res, 200, '', '', { etag: `"raw-${u.searchParams.get('partNumber')}"` });
  }
  if (bucket !== STAGING || !user) return s3Denied(res);
  if (m === 'GET' && u.searchParams.get('list-type') === '2') {
    const prefix = u.searchParams.get('prefix') ?? '';
    if (!prefix.startsWith(own)) return s3Denied(res);
    const keys = [...objects.keys()].filter((k) => k.startsWith(`${STAGING}/${prefix}`));
    return send(res, 200, `<ListBucketResult>${keys.map((k) => `<Contents><Key>${k.slice(STAGING.length + 1)}</Key></Contents>`).join('')}</ListBucketResult>`);
  }
  if (!key.startsWith(own) || m === 'DELETE') return s3Denied(res);
  if (m === 'POST' && u.searchParams.has('uploads')) {
    const id = randomUUID();
    mpu.set(id, { bucket, key, parts: new Map() });
    return send(res, 200, `<InitiateMultipartUploadResult><UploadId>${id}</UploadId></InitiateMultipartUploadResult>`);
  }
  const up = mpu.get(u.searchParams.get('uploadId') ?? '');
  if (m === 'PUT' && up && u.searchParams.has('partNumber')) {
    up.parts.set(Number(u.searchParams.get('partNumber')), body.length);
    return send(res, 200, '', '', { etag: `"part-${u.searchParams.get('partNumber')}"` });
  }
  if (m === 'GET' && up) {
    return send(res, 200, `<ListPartsResult><IsTruncated>false</IsTruncated>${[...up.parts.keys()].map((n) => `<Part><PartNumber>${n}</PartNumber><ETag>&quot;part-${n}&quot;</ETag></Part>`).join('')}</ListPartsResult>`);
  }
  if (m === 'POST' && up) {
    objects.set(`${STAGING}/${up.key}`, [...up.parts.values()].reduce((s, n) => s + n, 0));
    return send(res, 200, '<CompleteMultipartUploadResult/>');
  }
  if (m === 'PUT') {
    objects.set(`${STAGING}/${key}`, body.length);
    return send(res, 200, '', '', { etag: '"obj"' });
  }
  return s3Denied(res);
}

function userOf(req: http.IncomingMessage): string | undefined {
  const h = String(req.headers.authorization ?? '');
  return /^Bearer\s+(.+)$/.exec(h)?.[1] ? tokens[/^Bearer\s+(.+)$/.exec(h)![1]!] : undefined;
}

function tokenUser(req: http.IncomingMessage): string | undefined {
  return /^CA-Upload\s+tok:(\w+)$/.exec(String(req.headers.authorization ?? ''))?.[1];
}

/** 令牌模式的授权：键必须在令牌前缀之内，照片属于令牌主人且仍是 UPLOADING（与 adapters/identity-pool/none.ts 相同的规则） */
function authorize(req: http.IncomingMessage, key: string, uploadId: string): Photo | 'denied' {
  const user = tokenUser(req);
  const p = photos.get(uploadId);
  if (!user || !key.startsWith(`raw/${user}/`) || !p || p.owner !== user || p.rawKey !== key || p.status !== 'UPLOADING') return 'denied';
  return p;
}

const s3Uploads = new Map<string, string>();   // photoId → 假 S3 的 UploadId（令牌模式 + storage=s3）

function handle(req: http.IncomingMessage, body: Buffer, res: http.ServerResponse): void {
  const u = new URL(req.url ?? '/', 'http://front');
  const p = u.pathname;
  const m = req.method ?? 'GET';
  if (p.startsWith(`/${STAGING}`) || p.startsWith(`/${RAW}`)) return fakeS3(req, u, body, res);
  const input = body.length && /json/.test(String(req.headers['content-type'] ?? '')) ? JSON.parse(body.toString()) as Record<string, unknown> : {};
  const cognito = idpDriver === 'cognito';
  if (p === '/api/auth/login' && m === 'POST') {
    const name = String(input.email ?? '').split('@')[0]!;
    if (!identity[name] || input.password !== 'pw') return send(res, 401, { error: 'INVALID_CREDENTIALS' });
    return send(res, 200, { kind: 'tokens' }, 'entry=direct;auth=local:login', { 'set-cookie': `ca_at=tok-${name}; Path=/; HttpOnly` });
  }
  if (p === '/api/uploads/session' && m === 'POST') {
    const user = userOf(req);
    if (!user) return send(res, 401, { error: 'UNAUTHENTICATED' });
    if (cognito) return send(res, 201, { mode: 'sts', region: 'ap-northeast-1', bucket: STAGING, prefix: 'private/', partSize: PART, credentialsUrl: '/api/uploads/credentials' }, 'identity-pool=cognito:sts');
    return send(res, 201, { mode: 'token', token: `tok:${user}`, expiresAt: new Date(Date.now() + 900_000).toISOString(), prefix: `raw/${user}/`, partSize: PART,
      partUrl: storageDriver === 'local' ? '/api/storage/upload' : '/api/uploads/parts:sign' }, 'identity-pool=none:token');
  }
  if (p === '/api/uploads/credentials' && m === 'GET') {
    const user = userOf(req);
    if (!user || !cognito) return send(res, user ? 404 : 401, { error: 'NOT_AVAILABLE' });
    const id = identity[user]!;
    return send(res, 200, {
      accessKeyId: `ASIA${user.toUpperCase()}`, secretAccessKey: 'secret', sessionToken: `session-${user}`, expiration: new Date(Date.now() + 3600_000).toISOString(),
      identityId: id, region: 'ap-northeast-1', bucket: STAGING, prefix: `private/${id}/`,
    }, 'identity-pool=cognito:sts');
  }
  if (p === '/api/photos' && m === 'POST') {
    const user = userOf(req);
    if (!user) return send(res, 401, { error: 'UNAUTHENTICATED' });
    const id = randomUUID();
    const rawKey = `raw/${user}/${id}.jpg`;
    photos.set(id, { id, owner: user, rawKey, status: 'UPLOADING', parts: new Map() });
    return send(res, 201, { photoId: id, rawKey, uploadId: id, photo: { id, status: 'UPLOADING' } });
  }
  if (p === '/api/storage/upload' && m === 'PUT') {
    const ph = authorize(req, u.searchParams.get('key') ?? '', u.searchParams.get('uploadId') ?? '');
    if (ph === 'denied') return send(res, 403, { error: 'UPLOAD_PREFIX_DENIED', message: '键不在令牌前缀之内' }, 'identity-pool=none:token');
    ph.parts.set(Number(u.searchParams.get('part')), body.length);
    return send(res, 200, { ok: true }, 'identity-pool=none:token;storage=local:part', { etag: `"l-${u.searchParams.get('part')}"` });
  }
  if (p === '/api/storage/upload/parts' && m === 'GET') {
    const ph = authorize(req, u.searchParams.get('key') ?? '', u.searchParams.get('uploadId') ?? '');
    if (ph === 'denied') return send(res, 403, { error: 'UPLOAD_PREFIX_DENIED' }, 'identity-pool=none:token');
    return send(res, 200, { parts: [...ph.parts.entries()].map(([part, size]) => ({ part, size })) });
  }
  if (p === '/api/uploads/parts:sign' && m === 'POST') {
    const ph = authorize(req, String(input.key ?? ''), String(input.uploadId ?? ''));
    if (ph === 'denied') return send(res, 403, { error: 'UPLOAD_PREFIX_DENIED' }, 'identity-pool=none:token');
    let id = s3Uploads.get(ph.id);
    if (!id) {
      id = randomUUID();
      s3Uploads.set(ph.id, id);
      mpu.set(id, { bucket: RAW, key: ph.rawKey, parts: new Map() });
    }
    return send(res, 200, { url: `${frontUrl}/${RAW}/${ph.rawKey}?partNumber=${String(input.part)}&uploadId=${id}&X-Amz-Signature=x`, method: 'PUT' }, 'identity-pool=none:token;storage=s3:presign');
  }
  const completeMatch = /^\/api\/photos\/([^/]+)\/complete$/.exec(p);
  if (completeMatch && m === 'POST') {
    const ph = photos.get(completeMatch[1]!);
    if (!ph || ph.owner !== userOf(req)) return send(res, 404, { error: 'PHOTO_NOT_FOUND' });
    if (cognito) {
      const staged = `${STAGING}/private/${identity[ph.owner]}/${ph.id}.jpg`;
      if (!objects.has(staged)) return send(res, 409, { error: 'UPLOAD_NOT_FOUND' });
      objects.delete(staged);                                     // 服务端 CopyObject 之后删除暂存对象
    } else if (!ph.parts.size && !(s3Uploads.has(ph.id) && mpu.get(s3Uploads.get(ph.id)!)!.parts.size)) {
      return send(res, 409, { error: 'UPLOAD_NOT_FOUND' });
    }
    ph.status = 'READY';
    return send(res, 200, { photo: { id: ph.id, status: 'READY' }, status: 'READY' }, cognito ? 'identity-pool=cognito:sts;storage=s3:import' : 'identity-pool=none:token');
  }
  const photoMatch = /^\/api\/photos\/([^/]+)$/.exec(p);
  if (photoMatch) {
    const ph = photos.get(photoMatch[1]!);
    const admin = String(req.headers.authorization ?? '') === `Bearer ${mock.adminToken}`;
    if (!ph || (!admin && ph.owner !== userOf(req))) return send(res, 404, { error: 'PHOTO_NOT_FOUND' });
    if (m === 'DELETE') {
      photos.delete(ph.id);
      res.writeHead(204);
      res.end();
      return;
    }
    return send(res, 200, { id: ph.id, status: ph.status });
  }
  if (p === '/api/lab/identity-pool/staging-object' && m === 'GET') {
    if (String(req.headers.authorization ?? '') !== `Bearer ${mock.adminToken}`) return send(res, 403, { error: 'FORBIDDEN' });
    return send(res, 200, { key: u.searchParams.get('key'), exists: objects.has(`${STAGING}/${u.searchParams.get('key')}`) });
  }
  forward(req, body, res);
}

let idpDriver: 'none' | 'cognito' = 'none';
function setDriver(d: 'none' | 'cognito', storage: 'local' | 's3' = 'local'): void {
  idpDriver = d;
  storageDriver = storage;
  mock.setDriver('identity-pool', d, d === 'cognito' ? 'degraded' : 'off');
  mock.setDriver('storage', storage, storage === 's3' ? 'ok' : 'off');
}

beforeAll(async () => {
  mock = await startMockServer({ processingMs: 10 });
  front = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => handle(req, Buffer.concat(chunks), res));
  });
  await new Promise<void>((r) => front.listen(0, '127.0.0.1', r));
  frontUrl = `http://127.0.0.1:${(front.address() as AddressInfo).port}`;
  writeFileSync(usersFile, JSON.stringify([{ username: 'atl-test-1', email: 'usera@example.test', password: 'pw' }, { username: 'atl-test-2', email: 'userb@example.test', password: 'pw' }]));
});

afterAll(async () => {
  await new Promise<void>((r) => front.close(() => r()));
  await mock.close();
  await closeSharedDispatcher();
  rmSync(tmp, { recursive: true, force: true });
});

async function run(id: string, label: string, extra: string[] = []): Promise<ResultDoc> {
  const argv = ['identity-pool', '--scenario', id, '--label', label, '--vus', '1', '--duration', '400ms', '--warmup', '0s', '--force', '--target', frontUrl,
    '--out', path.join(tmp, 'results'), '--param', `users=${usersFile}`, '--param', `s3Endpoint=${frontUrl}`, ...extra];
  const lines: string[] = [];
  const r = await runExperiment(parseRunnerArgs(argv), {
    env: { CLOUDALBUM_ADMIN_TOKEN: mock.adminToken }, repo: tmp, faultExecutor: executor, log: (l) => lines.push(l),
  });
  expect(r.code, `${r.message ?? ''}\n${lines.join('\n')}`).toBe(EXIT.ok);
  const doc = r.result as ResultDoc;
  expect(validateResult(doc).errors).toEqual([]);
  expect(doc.warnings?.filter((w) => w.startsWith('场景出错')) ?? [], lines.join('\n')).toEqual([]);
  return doc;
}

describe('identity-pool experiment manifest', () => {
  it('validates against the schema and covers exactly the registry experiments; scripts, labels and params are consistent', async () => {
    const { readFileSync, existsSync } = await import('node:fs');
    const root = experimentsRoot();
    const raw = JSON.parse(readFileSync(path.join(root, 'identity-pool', 'experiment.json'), 'utf8')) as unknown;
    expect(validateExperimentManifest(raw)).toEqual({ ok: true, errors: [] });
    const manifest = loadManifest('identity-pool', root);
    expect(manifest.experiments.map((e) => e.id).sort()).toEqual([...(REGISTRY_DOCUMENT.modules['identity-pool'].lab.experiments ?? [])].sort());
    for (const e of manifest.experiments) {
      for (const label of Object.keys(e.requires ?? {})) expect(() => validateLabel(e, label)).not.toThrow();
      for (const [k, spec] of Object.entries(e.params ?? {})) expect(spec.default, `${e.id}.${k}`).toBeDefined();
      if (e.scenario.tool === 'node') {
        const file = path.join(root, 'identity-pool', e.scenario.script!);
        expect(existsSync(file), file).toBe(true);
      }
    }
  });
});

describe('identity-pool scenarios (local stand-in)', () => {
  it('cross-prefix before（前缀令牌）：越权由应用返回 403 UPLOAD_PREFIX_DENIED；B 的照片在服务端仍是 UPLOADING', async () => {
    setDriver('none', 'local');
    const f = (await run('cross-prefix', 'before')).scenario!.findings;
    expect(f).toMatchObject({ mode: 'token', deniedByApplication: 3, deniedByS3: 0, unexpected: 0, allowedOwn: 1, serverEvidence: { otherPhotoStatus: 'UPLOADING' } });
    const attempts = f.attempts as Array<{ action: string; status: number; code?: string; deniedBy: string | null }>;
    expect(attempts.find((a) => a.action === 'write-other')).toMatchObject({ status: 403, code: 'UPLOAD_PREFIX_DENIED', deniedBy: 'application' });
  }, 30_000);

  it('cross-prefix after（STS 凭证）：越权由 S3 返回 AccessDenied；服务端确认自己的对象存在、写到别人前缀的对象不存在、别人的对象还在', async () => {
    setDriver('cognito', 's3');
    const f = (await run('cross-prefix', 'after')).scenario!.findings;
    expect(f).toMatchObject({
      mode: 'sts', deniedByApplication: 0, deniedByS3: 3, unexpected: 0, allowedOwn: 2,
      serverEvidence: { ownObjectExists: true, crossObjectExists: false, targetStillExists: true, accessKeyPrefix: 'ASIA…' },
    });
    const attempts = f.attempts as Array<{ action: string; status: number; code?: string }>;
    expect(attempts.filter((a) => a.status === 403).every((a) => a.code === 'AccessDenied')).toBe(true);
  }, 30_000);

  it('upload-bench：token 每片都问 EC2（storage=local 与 storage=s3 两种），sts 对后端只有建档与 complete；sts 的暂存对象在 complete 后已删除', async () => {
    setDriver('none', 'local');
    const local = (await run('upload-bench', 'before', ['--param', 'files=3', '--param', 'fileMb=2.5'])).scenario!.findings;
    expect(local).toMatchObject({ mode: 'token', completed: 3, failed: 0, partsPerFile: 3, backendRequests: 1 + 3 * 5, s3Requests: 0 });
    expect((local.serverEvidence as { photoStatuses: Record<string, number> }).photoStatuses).toEqual({ READY: 3 });

    setDriver('none', 's3');
    const s3token = (await run('upload-bench', 'before', ['--param', 'files=2', '--param', 'fileMb=2.5'])).scenario!.findings;
    expect(s3token).toMatchObject({ mode: 'token', completed: 2, backendRequests: 1 + 2 * 5, s3Requests: 2 * 3 });

    setDriver('cognito', 's3');
    const sts = (await run('upload-bench', 'after', ['--param', 'files=3', '--param', 'fileMb=2.5'])).scenario!.findings;
    expect(sts).toMatchObject({ mode: 'sts', completed: 3, failed: 0, backendRequests: 2 + 3 * 2, s3Requests: 3 * (1 + 3 + 1), backendRequestsPerFile: 2.7 });
    expect(sts.serverEvidence).toMatchObject({ photoStatuses: { READY: 3 }, stagingChecked: 3, stagingLeftovers: 0, bytesThroughEc2: 0 });
  }, 60_000);

  it('resume：两种方式都只补传缺失的分片（token：服务端报告已收分片；sts：ListParts）', async () => {
    setDriver('none', 'local');
    const before = (await run('resume', 'before', ['--param', 'fileMb=3.5', '--param', 'failAtPart=3'])).scenario!.findings;
    expect(before).toMatchObject({ totalParts: 4, partsBeforeInterruption: 2, partsResent: 2, resentParts: [3, 4], onlyMissingResent: true,
      serverEvidence: { partsReportedBeforeResume: 2, reportedBy: 'api:/api/storage/upload/parts', photoStatus: 'READY' } });
    setDriver('cognito', 's3');
    const after = (await run('resume', 'after', ['--param', 'fileMb=3.5', '--param', 'failAtPart=2'])).scenario!.findings;
    expect(after).toMatchObject({ totalParts: 4, partsBeforeInterruption: 1, partsResent: 3, onlyMissingResent: true,
      serverEvidence: { partsReportedBeforeResume: 1, reportedBy: 's3:ListParts', photoStatus: 'READY' } });
  }, 60_000);

  it('没有测试用户：记 note 与 finding，不出错', async () => {
    setDriver('none', 'local');
    const argv = ['identity-pool', '--scenario', 'cross-prefix', '--label', 'before', '--vus', '1', '--duration', '200ms', '--warmup', '0s', '--force',
      '--target', frontUrl, '--out', path.join(tmp, 'results')];
    const r = await runExperiment(parseRunnerArgs(argv), { env: { CLOUDALBUM_ADMIN_TOKEN: mock.adminToken }, repo: tmp, faultExecutor: executor, log: () => undefined });
    expect(r.code).toBe(EXIT.ok);
    expect((r.result as ResultDoc).scenario!.findings.error).toBe('need-two-users');
  }, 30_000);
});

describe('identity-pool/lib 与 cross-prefix 的纯函数', () => {
  it('测试用户：平台种子 JSON、{users:[…]}、CSV；CLOUDALBUM_TEST_USERS_PARAM 经 AWS CLI 读取', () => {
    expect(parseAccounts('[{"username":"atl-test-1","email":"a@example.com","password":"p1"}]')).toEqual([{ email: 'a@example.com', password: 'p1' }]);
    expect(parseAccounts('{"users":[{"email":"b@example.com","password":"p2"}]}')).toEqual([{ email: 'b@example.com', password: 'p2' }]);
    expect(parseAccounts('c@example.com,p3\nd@example.com,p4\n')).toHaveLength(2);
    const asked: string[] = [];
    const r = loadAccounts({ params: {} }, { CLOUDALBUM_TEST_USERS_PARAM: '/cloudalbum/e1/atl/test-users' }, (n) => {
      asked.push(n);
      return '[{"email":"x@example.com","password":"y"}]';
    });
    expect(asked).toEqual(['/cloudalbum/e1/atl/test-users']);
    expect(r).toEqual({ accounts: [{ email: 'x@example.com', password: 'y' }], source: 'ssm:/cloudalbum/e1/atl/test-users' });
    expect(loadAccounts({ params: {} }, {}).accounts).toEqual([]);
  });

  it('classify / summarize：拒绝必须是 403 / 404；由谁拒绝跟随模式', () => {
    expect(classify('token', 'write-other', 'denied', { status: 403, code: 'UPLOAD_PREFIX_DENIED' })).toMatchObject({ outcome: 'denied', deniedBy: 'application', matches: true });
    expect(classify('sts', 'write-other', 'denied', { status: 500 })).toMatchObject({ outcome: 'denied', matches: false });
    expect(classify('sts', 'write-other', 'denied', { status: 200 })).toMatchObject({ outcome: 'allowed', deniedBy: null, matches: false });
    expect(classify('token', 'list-other', 'denied', null, 'n/a')).toMatchObject({ outcome: 'n/a', matches: true });
    expect(summarize([classify('sts', 'write-own', 'allowed', { status: 200 }), classify('sts', 'list-root', 'denied', { status: 403 })]))
      .toEqual({ deniedByApplication: 0, deniedByS3: 1, unexpected: 0, allowedOwn: 1 });
  });

  it('signS3：与 AWS 文档的 GET Object 示例无关的部分（临时凭证头、路径式、标准查询串）', () => {
    const s = signS3({
      method: 'GET', base: 'http://127.0.0.1:4566', pathStyleBucket: 'b', key: 'private/ap-northeast-1:x/a b.jpg', query: { uploadId: 'u', 'part-number-marker': '2' },
      region: 'ap-northeast-1', credentials: { accessKeyId: 'ASIAX', secretAccessKey: 's', sessionToken: 't' }, now: new Date('2026-10-14T00:00:00Z'),
    });
    expect(s.url).toBe('http://127.0.0.1:4566/b/private/ap-northeast-1%3Ax/a%20b.jpg?part-number-marker=2&uploadId=u');
    expect(s.headers['x-amz-security-token']).toBe('t');
    expect(s.headers.authorization).toMatch(/^AWS4-HMAC-SHA256 Credential=ASIAX\/20261014\/ap-northeast-1\/s3\/aws4_request, SignedHeaders=host;x-amz-content-sha256;x-amz-date;x-amz-security-token, Signature=[0-9a-f]{64}$/);
  });
});

describe('cognito-srp（USER_SRP_AUTH）', () => {
  it('N 是 RFC 3526 的 3072 位素数；时间戳格式与 amazon-cognito-identity-js 相同', () => {
    expect(N.toString(16).length).toBe(768);
    expect(N.toString(16).slice(0, 16)).toBe('ffffffffffffffff');
    expect(padHex(N).slice(0, 4)).toBe('00ff');
    expect(padHex(2n)).toBe('02');
    expect(cognitoTimestamp(new Date('2026-10-04T05:03:09Z'))).toBe('Sun Oct 4 05:03:09 UTC 2026');
  });

  it('假服务端（v = g^x，B = k·v + g^b，S = (A·v^u)^b）验证客户端的 PASSWORD_CLAIM_SIGNATURE', async () => {
    const userPoolId = 'ap-northeast-1_AbCdEf123';
    const poolName = 'AbCdEf123';
    const userId = 'c1e2…-uuid-of-user';
    const password = 'Correct-Horse-1!';
    const salt = randomBytes(16).toString('hex');
    const secretBlock = randomBytes(64).toString('base64');
    // 服务端：注册时保存 verifier
    const x = BigInt(`0x${hexHash(`${padHex(salt)}${createHash('sha256').update(`${poolName}${userId}:${password}`).digest('hex')}`)}`);
    const v = modPow(G, x, N);
    const b = BigInt(`0x${randomBytes(64).toString('hex')}`);
    const B = (K * v + modPow(G, b, N)) % N;
    const verify = (A: bigint, resp: { TIMESTAMP: string; PASSWORD_CLAIM_SIGNATURE: string }) => {
      const u = BigInt(`0x${hexHash(`${padHex(A)}${padHex(B)}`)}`);
      const S = modPow(A * modPow(v, u, N), b, N);
      const key = hkdf(Buffer.from(padHex(S), 'hex'), Buffer.from(padHex(u), 'hex'));
      const msg = Buffer.concat([Buffer.from(poolName), Buffer.from(userId), Buffer.from(secretBlock, 'base64'), Buffer.from(resp.TIMESTAMP)]);
      return createHmac('sha256', key).update(msg).digest('base64') === resp.PASSWORD_CLAIM_SIGNATURE;
    };
    const st = srpStart();
    const challenge = { SALT: salt, SRP_B: B.toString(16), SECRET_BLOCK: secretBlock, USER_ID_FOR_SRP: userId };
    expect(verify(st.A, passwordVerifier(st, challenge, { userPoolId, password }))).toBe(true);
    expect(verify(st.A, passwordVerifier(st, challenge, { userPoolId, password: 'wrong' }))).toBe(false);

    // 整个往返：InitiateAuth → RespondToAuthChallenge
    let A = 0n;
    const call: CognitoCall = async (action, body) => {
      if (action === 'InitiateAuth') {
        A = BigInt(`0x${(body.AuthParameters as { SRP_A: string }).SRP_A}`);
        return { status: 200, json: { ChallengeName: 'PASSWORD_VERIFIER', ChallengeParameters: { ...challenge, USERNAME: userId } } };
      }
      const r = body.ChallengeResponses as { TIMESTAMP: string; PASSWORD_CLAIM_SIGNATURE: string; USERNAME: string };
      if (r.USERNAME !== userId || !verify(A, r)) return { status: 400, json: { __type: 'NotAuthorizedException', message: 'Incorrect username or password.' } };
      return { status: 200, json: { AuthenticationResult: { AccessToken: 'at', IdToken: 'it', RefreshToken: 'rt' } } };
    };
    await expect(srpLogin(call, { userPoolId, clientId: 'c', username: 'a@example.com', password })).resolves.toEqual({ accessToken: 'at', idToken: 'it', refreshToken: 'rt' });
    await expect(srpLogin(call, { userPoolId, clientId: 'c', username: 'a@example.com', password: 'nope' })).rejects.toThrow(/NotAuthorizedException/);
  });
});
