// integration 阶段补齐的驱动：iam(none / keys / role)、cdn(direct / cloudfront)、identity-pool(none)、waf(nginx)、autoscaling(single)、
// workflow(inline) 的 describe，以及 net.isLoopback 的 IPv4 映射地址、instrument 的客户端错误判定、只有 CFG-001 时规则引擎照常运行。
// 所有 AWS 调用都由 aws-sdk-client-mock 拦截（不发出任何网络请求）。
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { Readable } from 'node:stream';
import { CloudFrontClient, CreateInvalidationCommand } from '@aws-sdk/client-cloudfront';
import { GetUserCommand, IAMClient } from '@aws-sdk/client-iam';
import { GetCallerIdentityCommand, STSClient } from '@aws-sdk/client-sts';
import { mockClient } from 'aws-sdk-client-mock';
import { afterEach, describe, expect, it } from 'vitest';
import { CloudFrontCdn } from '../../src/adapters/cdn/cloudfront.js';
import { DirectCdn } from '../../src/adapters/cdn/direct.js';
import { PrefixTokenUpload } from '../../src/adapters/identity-pool/none.js';
import { KeysCredentials } from '../../src/adapters/iam/keys.js';
import { NoCredentials } from '../../src/adapters/iam/none.js';
import { RoleCredentials } from '../../src/adapters/iam/role.js';
import { LocalStorage } from '../../src/adapters/storage/local.js';
import { NginxBlocklist, isCidr, parseDenylist } from '../../src/adapters/waf/nginx.js';
import { SingleInstance } from '../../src/adapters/autoscaling/single.js';
import { InlineWorkflow } from '../../src/adapters/workflow/inline.js';
import { isLoopback } from '../../src/config/net.js';
import { validateConfig } from '../../src/config/validate.js';
import { ImdsClient } from '../../src/modules/detectors/ec2.js';
import { isClientError } from '../../src/observability/instrument.js';
import { insertPhoto } from '../../src/repositories/photos.js';
import { recordStep } from '../../src/repositories/job-runs.js';
import { ENABLE, tempEnvDir } from '../helpers/config.js';
import { seedUser, testDb } from '../helpers/media-fixtures.js';
import { makeDeps } from './aws/helpers.js';

const sts = mockClient(STSClient);
const iam = mockClient(IAMClient);
const cloudfront = mockClient(CloudFrontClient);
afterEach(() => {
  sts.reset();
  iam.reset();
  cloudfront.reset();
});

describe('iam 驱动', () => {
  it('none：provider() 为 null，describe() 为 none，探针 ok 且不加载 SDK', async () => {
    const d = new NoCredentials(makeDeps({}, { credentials: false }), {});
    expect(d.provider()).toBeNull();
    expect(await d.describe()).toEqual({ kind: 'none' });
    const p = await d.probe();
    expect(p.status).toBe('ok');
    expect(p.detail).toContain('未调用任何 AWS API');
  });

  it('none：进程环境里残留 AWS_ACCESS_KEY_ID 时在 detail 中指出', async () => {
    const d = new NoCredentials(makeDeps({}, { credentials: false }), { AWS_ACCESS_KEY_ID: 'AKIAEXAMPLE' });
    expect((await d.probe()).detail).toContain('AWS_ACCESS_KEY_ID');
  });

  it('keys：provider() 返回 secrets.env 的 IAM_KEYS_*；探针 = GetCallerIdentity + GetUser，至少 degraded（CRED-002）', async () => {
    const deps = makeDeps({ ...ENABLE.iamKeys });
    const k = new KeysCredentials(deps);
    expect(await k.provider()()).toEqual({ accessKeyId: 'AKIAEXAMPLE', secretAccessKey: 'secret' });
    sts.on(GetCallerIdentityCommand).resolves({ Arn: 'arn:aws:iam::123456789012:user/cloudalbum-lab-demo-keys', Account: '123456789012' });
    iam.on(GetUserCommand).resolves({ User: { UserName: 'cloudalbum-lab-demo-keys', UserId: 'x', Arn: 'arn', Path: '/', CreateDate: new Date() } });
    const p = await k.probe();
    expect(p.status).toBe('degraded');
    expect(p.detail).toContain('CRED-002');
    expect(p.data).toMatchObject({ source: 'static' });
    expect(iam.commandCalls(GetUserCommand)[0]!.args[0].input).toEqual({ UserName: 'cloudalbum-lab-demo-keys' });
    expect(await k.describe()).toMatchObject({ kind: 'user', keyPrefix: 'AKIA' });
    await k.close();
  });

  it('role：凭证缓存到过期前 5 分钟；forceRefresh() 重新取；IMDS 取不到时探针 error', async () => {
    let calls = 0;
    let fail = false;
    const r = new RoleCredentials(makeDeps({ ...ENABLE.iamRole }), async () => async () => {
      calls += 1;
      if (fail) throw new Error('IMDS 不可达');
      return { accessKeyId: `ASIA${calls}`, secretAccessKey: 's', sessionToken: 't', expiration: new Date(Date.now() + 3600_000) };
    });
    const p = r.provider();
    expect((await p()).accessKeyId).toBe('ASIA1');
    expect((await p()).accessKeyId).toBe('ASIA1');
    await r.forceRefresh();
    expect((await p()).accessKeyId).toBe('ASIA2');
    const fresh = new RoleCredentials(makeDeps({ ...ENABLE.iamRole }), async () => async () => { throw new Error('IMDS 不可达'); });
    expect((await fresh.probe()).status).toBe('error');
    fail = true;
    expect((await p()).accessKeyId).toBe('ASIA2');   // 缓存仍有效
  });

  it('role：快过期的凭证会在过期前刷新', async () => {
    let n = 0;
    const r = new RoleCredentials(makeDeps({ ...ENABLE.iamRole }), async () => async () => {
      n += 1;
      return { accessKeyId: `ASIA${n}`, secretAccessKey: 's', expiration: new Date(Date.now() + (n === 1 ? 60_000 : 3600_000)) };
    });
    const p = r.provider();
    expect((await p()).accessKeyId).toBe('ASIA1');
    expect((await p()).accessKeyId).toBe('ASIA2');   // 剩 1 分钟 < 5 分钟：刷新
  });
});

describe('cdn 驱动', () => {
  it('direct：mediaUrl 原样返回、invalidate 为 skipped、探针 ok', async () => {
    const c = new DirectCdn(makeDeps({}, { credentials: false }));
    expect(c.baseUrl).toBeNull();
    expect(c.mediaUrl('variants/p/thumb_200.webp', { visibility: 'public', originUrl: '/media/variants/p/thumb_200.webp' })).toBe('/media/variants/p/thumb_200.webp');
    expect(await c.invalidate(['/media/x'])).toEqual({ id: null, status: 'skipped' });
    expect((await c.probe()).status).toBe('ok');
  });

  it('cloudfront：公开媒体改写到 CDN 域名；私有媒体 ec2 源站保留 exp/sig；DEP-028 时不改写', () => {
    const c = new CloudFrontCdn(makeDeps({ ...ENABLE.iamRole, ...ENABLE.cdn }));
    expect(c.baseUrl).toBe('https://d111111abcdef8.cloudfront.net');
    expect(c.mediaUrl('variants/p/t.webp', { visibility: 'public', originUrl: '/media/variants/p/t.webp' })).toBe('https://d111111abcdef8.cloudfront.net/media/variants/p/t.webp');
    expect(c.mediaUrl('raw/u/p.jpg', { visibility: 'private', originUrl: '/media/raw/u/p.jpg?exp=1&sig=x' })).toBe('https://d111111abcdef8.cloudfront.net/media/raw/u/p.jpg?exp=1&sig=x');
    const dep028 = new CloudFrontCdn(makeDeps({ ...ENABLE.iamRole, ...ENABLE.cdn, ...ENABLE.s3 }));
    const presigned = 'https://cloudalbum-lab-media.s3.ap-northeast-1.amazonaws.com/variants/p/t.webp?X-Amz-Signature=x';
    expect(dep028.mediaUrl('variants/p/t.webp', { visibility: 'public', originUrl: presigned })).toBe(presigned);
    const s3Origin = new CloudFrontCdn(makeDeps({ ...ENABLE.iamRole, ...ENABLE.cdn, ...ENABLE.s3, CDN_MEDIA_ORIGIN: 's3' }));
    expect(s3Origin.mediaUrl('variants/p/t.webp', { visibility: 'public', originUrl: presigned })).toBe('https://d111111abcdef8.cloudfront.net/media/variants/p/t.webp');
    expect(s3Origin.mediaUrl('raw/u/p.jpg', { visibility: 'private', originUrl: presigned })).toBe(presigned);
  });

  it('cloudfront：invalidate → CreateInvalidation（限本分配）', async () => {
    cloudfront.on(CreateInvalidationCommand).resolves({ Invalidation: { Id: 'I123', Status: 'InProgress', CreateTime: new Date(), InvalidationBatch: undefined } });
    const c = new CloudFrontCdn(makeDeps({ ...ENABLE.iamRole, ...ENABLE.cdn, CDN_DISTRIBUTION_ID: 'E123EXAMPLE' }));
    expect(await c.invalidate(['media/a', '/media/a', '/index.html'])).toEqual({ id: 'I123', status: 'submitted' });
    const input = cloudfront.commandCalls(CreateInvalidationCommand)[0]!.args[0].input;
    expect(input.DistributionId).toBe('E123EXAMPLE');
    expect(input.InvalidationBatch?.Paths).toEqual({ Quantity: 2, Items: ['/media/a', '/index.html'] });
  });

  it('cloudfront：边缘探针看 entry=cloudfront；连续 3 次 403 为 error', async () => {
    let status = 200;
    let pathHeader = 'entry=cloudfront>nginx;database=sqlite';
    const fetchImpl = (async () => new Response('{}', { status, headers: { 'x-cloudalbum-path': pathHeader, 'x-cache': 'Miss from cloudfront' } })) as typeof fetch;
    const c = new CloudFrontCdn(makeDeps({ ...ENABLE.iamRole, ...ENABLE.cdn }), fetchImpl);
    expect((await c.edgeProbe()).status).toBe('ok');
    pathHeader = 'entry=nginx';
    expect((await c.edgeProbe()).status).toBe('degraded');
    status = 403;
    await c.edgeProbe();
    await c.edgeProbe();
    const third = await c.edgeProbe();
    expect(third.status).toBe('error');
    expect(third.detail).toContain('403');
  });
});

describe('identity-pool=none（F14 前缀令牌）', () => {
  async function setup() {
    const db = await testDb();
    const deps = makeDeps({ STORAGE_LOCAL_MIN_FREE_PCT: '1' }, { credentials: false, secrets: { 'upload-hmac-key': 'k'.repeat(32) } });
    const storage = new LocalStorage({ ...deps, db });
    const u = new PrefixTokenUpload({ ...deps, db, storage });
    const owner = await seedUser(db);
    const other = await seedUser(db);
    const photo = await insertPhoto(db, {
      id: '11111111-2222-4333-8444-555555555555', ownerId: owner, albumId: null, rawKey: `raw/${owner}/11111111-2222-4333-8444-555555555555.jpg`,
      filename: 'a.jpg', contentType: 'image/jpeg', sizeBytes: null, visibility: 'private', title: null, caption: null,
    });
    const principal = (sub: string) => ({ provider: 'local' as const, subject: sub, email: '', emailVerified: true, groups: ['member'], plan: 'free', expiresAt: 0 });
    return { db, deps, storage, u, owner, other, photo, principal };
  }

  it('签发的令牌只能写本人前缀下、本人且 UPLOADING 的照片；篡改 / 过期被拒', async () => {
    const { u, owner, other, photo, principal, db } = await setup();
    const s = await u.openSession(principal(owner));
    expect(s.mode).toBe('token');
    if (s.mode !== 'token') throw new Error('unreachable');
    expect(s.prefix).toBe(`raw/${owner}/`);
    expect(s.partUrl).toBe('/api/storage/upload');
    const ok = await u.authorizePart(s.token, photo.rawKey, photo.id, 1);
    expect(ok.url).toBeUndefined();
    expect(ok.maxBytes).toBeGreaterThan(0);
    expect(ok.partSize).toBe(8 * 1024 * 1024);
    const maxParts = Math.ceil(ok.maxBytes / ok.partSize);
    await expect(u.authorizePart(s.token, photo.rawKey, photo.id, maxParts)).resolves.toBeTruthy();
    await expect(u.authorizePart(s.token, photo.rawKey, photo.id, maxParts + 1)).rejects.toMatchObject({ status: 413, code: 'TOO_MANY_PARTS' });
    // uploadId 决定 .incoming/<uploadId>/ 的位置：必须等于照片 ID
    await expect(u.authorizePart(s.token, photo.rawKey, 'attacker-chosen-dir', 1)).rejects.toMatchObject({ status: 403, code: 'UPLOAD_ID_MISMATCH' });
    // 令牌里的 maxBytesPerFile 生效（取与运行时上限的较小值）
    const small = await u.sign({ v: 1, uid: owner, prefix: `raw/${owner}/`, exp: Math.floor(Date.now() / 1000) + 60, maxFiles: 1, maxBytesPerFile: 1024, jti: 'j2' });
    expect((await u.authorizePart(small, photo.rawKey, photo.id, 1)).maxBytes).toBe(1024);
    await expect(u.authorizePart(small, photo.rawKey, photo.id, 2)).rejects.toMatchObject({ status: 413 });
    const sb = await u.openSession(principal(other));
    if (sb.mode !== 'token') throw new Error('unreachable');
    await expect(u.authorizePart(sb.token, photo.rawKey, photo.id, 1)).rejects.toMatchObject({ status: 403, code: 'UPLOAD_PREFIX_DENIED' });
    await expect(u.authorizePart(`${s.token}x`, photo.rawKey, photo.id, 1)).rejects.toMatchObject({ status: 401 });
    await expect(u.authorizePart(s.token, `raw/${owner}/99999999-2222-4333-8444-555555555555.jpg`, photo.id, 1)).rejects.toMatchObject({ status: 403 });
    const expired = await u.sign({ v: 1, uid: owner, prefix: `raw/${owner}/`, exp: Math.floor(Date.now() / 1000) - 1, maxFiles: 1, maxBytesPerFile: 1, jti: 'j' });
    await expect(u.authorizePart(expired, photo.rawKey, photo.id, 1)).rejects.toMatchObject({ code: 'UPLOAD_TOKEN_EXPIRED' });
    await db('photos').where({ id: photo.id }).update({ status: 'READY' });
    await expect(u.authorizePart(s.token, photo.rawKey, photo.id, 1)).rejects.toMatchObject({ status: 409 });
    expect((await u.probe({ deep: true })).status).toBe('ok');
  });

  it('complete：按 uploadId = photoId 合并 .incoming 分片到原图键', async () => {
    const { u, storage, photo, principal, owner } = await setup();
    await storage.writePart(photo.id, 1, Readable.from([Buffer.from('hello ')]), { maxBytes: 1024 });
    await storage.writePart(photo.id, 2, Readable.from([Buffer.from('world')]), { maxBytes: 1024 });
    expect(await u.complete(photo.id, principal(owner))).toEqual({ ok: true, rawKey: photo.rawKey });
    const obj = await storage.getObject(photo.rawKey);
    const chunks: Buffer[] = [];
    for await (const c of obj.body) chunks.push(Buffer.from(c as Buffer));
    expect(Buffer.concat(chunks).toString()).toBe('hello world');
    expect(await u.complete('00000000-0000-4000-8000-000000000000', principal(owner))).toMatchObject({ ok: false });
  });
});

describe('waf=nginx（denylist.conf）', () => {
  it('add / list / remove；文件格式能通过 denylist-apply.sh 的逐行校验', async () => {
    const deps = makeDeps({}, { credentials: false });
    const w = new NginxBlocklist(deps);
    expect(await w.list()).toEqual([]);
    await w.add('198.51.100.0/24', 'scanner; rm -rf "#"', undefined);
    await w.add('2001:db8::1', 'manual test', 3600);
    await expect(w.add('not-an-ip', 'x')).rejects.toMatchObject({ status: 400 });
    const list = await w.list();
    expect(list.map((e) => e.cidr)).toEqual(['198.51.100.0/24', '2001:db8::1']);
    expect(list[0]).toMatchObject({ source: 'app', reason: 'scanner  rm -rf' });
    const text = readFileSync(path.join(deps.dataDir, 'security', 'denylist.conf'), 'utf8');
    const v4 = /^\s*([0-9]{1,3}\.){3}[0-9]{1,3}(\/([0-9]|[12][0-9]|3[0-2]))?\s+1;\s*(#.*)?$/;
    const v6 = /^\s*[0-9A-Fa-f]*:[0-9A-Fa-f:]*(\/([0-9]|[1-9][0-9]|1[01][0-9]|12[0-8]))?\s+1;\s*(#.*)?$/;
    for (const line of text.split('\n')) expect(/^\s*(#.*)?$/.test(line) || v4.test(line) || v6.test(line), line).toBe(true);
    await w.remove('198.51.100.0/24');
    expect((await w.list()).map((e) => e.cidr)).toEqual(['2001:db8::1']);
    expect((await w.probe()).detail).toContain('1 条');
    expect(parseDenylist('203.0.113.9 1;  # src=fail2ban ts=2026-10-01T00:00:00Z until=2099-01-01T00:00:00Z note="ssh"')[0])
      .toMatchObject({ source: 'fail2ban', until: '2099-01-01T00:00:00Z' });
    expect([isCidr('10.0.0.0/8'), isCidr('10.0.0.0/33'), isCidr('::1/128'), isCidr('x/1')]).toEqual([true, false, true, false]);
  });
});

describe('autoscaling=single', () => {
  it('开发机：主机名 + az=local；EC2：IMDSv2 的实例 ID 与 AZ', async () => {
    const dev = new SingleInstance(makeDeps({}, { credentials: false }), { onEc2: () => false });
    expect((await dev.identity()).az).toBe('local');
    const imds = new ImdsClient({
      fetch: (async (input: string | URL | Request, init?: RequestInit) => {
        const p = new URL(String(input)).pathname;
        if (p === '/latest/api/token' && init?.method === 'PUT') return new Response('tok');
        if (p === '/latest/meta-data/instance-id') return new Response('i-0123456789abcdef0');
        if (p === '/latest/meta-data/placement/availability-zone') return new Response('ap-northeast-1a');
        return new Response('', { status: 404 });
      }) as typeof fetch,
    });
    const ec2 = new SingleInstance(makeDeps({}, { credentials: false }), { onEc2: () => true, imds });
    expect(await ec2.identity()).toEqual({ instanceId: 'i-0123456789abcdef0', az: 'ap-northeast-1a' });
    expect((await ec2.probe()).confidence).toBe('confirmed');
  });
});

describe('workflow=inline', () => {
  it('describe() 读 job_runs 的 pipeline.* 步骤', async () => {
    const db = await testDb();
    const wf = new InlineWorkflow({ ...makeDeps({}, { credentials: false }), db });
    const t0 = new Date(Date.now() - 1000).toISOString();
    await recordStep(db, { step: 'thumbnail', photoId: 'p1', executor: 'inline', status: 'ok', startedAt: t0 });
    await recordStep(db, { step: 'notify', photoId: 'p1', executor: 'inline', status: 'ok', startedAt: t0 });
    const d = await wf.describe('inline:p1:abcd');
    expect(d.status).toBe('succeeded');
    expect(d.steps.map((s) => s.name)).toEqual(['thumbnail', 'notify']);
    expect((await wf.probe()).status).toBe('ok');
  });
});

describe('小工具', () => {
  it('isLoopback：IPv4 映射的回环地址也算回环', () => {
    expect(isLoopback('::ffff:127.0.0.1')).toBe(true);
    expect(isLoopback('0:0:0:0:0:ffff:127.0.0.1')).toBe(true);
    expect(isLoopback('::ffff:10.0.0.1')).toBe(false);
  });

  it('isClientError：4xx 的 HttpError、permanent 错误与对象不存在不计入被动健康信号', () => {
    expect(isClientError({ status: 403 })).toBe(true);
    expect(isClientError({ permanent: true })).toBe(true);
    expect(isClientError({ status: 503 })).toBe(false);
    expect(isClientError(new Error('boom'))).toBe(false);
  });

  it('只有“未实现的驱动”时规则引擎照常运行：CFG-001 与 ASG-002 一次性列出', async () => {
    const envDir = tempEnvDir({ modules: { autoscaling: { MODULE_AUTOSCALING: 'on', DEPLOY_MODE: 'asg' } } });
    const v = await validateConfig({ role: 'api', envDir, processEnv: { NODE_ENV: 'test' } });
    expect(v.ok).toBe(false);
    expect(v.parsed.config).toBeUndefined();
    expect(v.parsed.errors.map((e) => e.section)).toContain('implementation');
    expect(v.verdict.errors.map((e) => e.rule)).toContain('ASG-002');
  });
});
