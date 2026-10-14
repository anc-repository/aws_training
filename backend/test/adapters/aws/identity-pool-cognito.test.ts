// identity-pool=cognito：DirectUploadPort 的 AWS 驱动（Cognito Identity Pool + 暂存桶 + 服务端 CopyObject 导入）。
// Cognito Identity 由 aws-sdk-client-mock 拦截；S3 用内存替身 FakeS3（暂存桶、原图桶都在里面，CopyObject 真实复制字节）。
// 覆盖：会话（sts / bypass / 故障回退）、换取凭证（User Pool ID 令牌、开发者认证身份、声明核对、失败语义）、complete
// （大小、类型、魔数、导入、删除暂存对象、令牌会话交给 none 驱动）、探针（ok / degraded / error / 瞬时）、平台探测与服务端证据。
import {
  CognitoIdentityClient, DescribeIdentityPoolCommand, GetCredentialsForIdentityCommand, GetIdCommand, GetOpenIdTokenForDeveloperIdentityCommand,
} from '@aws-sdk/client-cognito-identity';
import { HeadBucketCommand, PutObjectCommand } from '@aws-sdk/client-s3';
import { mockClient } from 'aws-sdk-client-mock';
import type { Knex } from 'knex';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  CognitoDirectUpload, decodeJwtPayload, EXCHANGE_FAILURE_RATIO, isIdentityId,
} from '../../../src/adapters/identity-pool/cognito.js';
import { idTokenOf, identityPoolLabProbe } from '../../../src/adapters/identity-pool/lab-routes.js';
import { PrefixTokenUpload } from '../../../src/adapters/identity-pool/none.js';
import { S3Storage } from '../../../src/adapters/storage/s3.js';
import type { AdapterDeps } from '../../../src/adapters/types.js';
import { createRequestContext, runWithContext, type RequestContext } from '../../../src/observability/request-context.js';
import type { Principal } from '../../../src/ports/auth.js';
import { DEFAULT_RUNTIME_CONFIG, type ConfigPort } from '../../../src/ports/config.js';
import { getPhoto, insertPhoto } from '../../../src/repositories/photos.js';
import { findUserById } from '../../../src/repositories/users.js';
import { ENABLE } from '../../helpers/config.js';
import { seedUser, testDb } from '../../helpers/media-fixtures.js';
import { FakeS3 } from './fake-s3.js';
import { awsError, makeDeps } from './helpers.js';

const RAW = 'cloudalbum-lab-raw';
const MEDIA = 'cloudalbum-lab-media';
const STAGING = ENABLE.identityPool.IDENTITY_STAGING_BUCKET;
const POOL = ENABLE.identityPool.IDENTITY_POOL_ID;
const USER_POOL = ENABLE.cognito.COGNITO_USER_POOL_ID;
const CLIENT = ENABLE.cognito.COGNITO_CLIENT_ID;
const PROVIDER = `cognito-idp.ap-northeast-1.amazonaws.com/${USER_POOL}`;
const IDENTITY_A = 'ap-northeast-1:aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa';
const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0x10, 0x4a, 0x46, 0x49, 0x46, 0, 1]), Buffer.alloc(200, 7)]);
const env = { ...ENABLE.iamRole, ...ENABLE.s3, ...ENABLE.cognito, ...ENABLE.identityPool };

const ci = mockClient(CognitoIdentityClient);
let fake: FakeS3;
beforeEach(() => {
  fake = new FakeS3([RAW, MEDIA, STAGING]);
  ci.reset();
});
afterEach(() => fake.restore());

function jwt(claims: Record<string, unknown>): string {
  const b = (o: unknown) => Buffer.from(JSON.stringify(o)).toString('base64url');
  return `${b({ alg: 'RS256', kid: 'k1' })}.${b(claims)}.c2ln`;
}

function idToken(sub: string, extra: Record<string, unknown> = {}): string {
  return jwt({
    token_use: 'id', sub, aud: CLIENT, iss: `https://cognito-idp.ap-northeast-1.amazonaws.com/${USER_POOL}`,
    exp: Math.floor(Date.now() / 1000) + 3600, email: 'a@example.com', ...extra,
  });
}

const cognitoPrincipal = (sub: string): Principal => ({ provider: 'cognito', subject: sub, email: 'a@example.com', emailVerified: true, groups: ['member'], plan: 'free', expiresAt: 0 });
const localPrincipal = (id: string): Principal => ({ provider: 'local', subject: id, email: 'a@example.com', emailVerified: true, groups: ['member'], plan: 'free', expiresAt: 0 });

function runtime(maxUploadMb: number): ConfigPort {
  return { current: () => ({ ...DEFAULT_RUNTIME_CONFIG, maxUploadMb }) } as unknown as ConfigPort;
}

interface Setup { db: Knex; drv: CognitoDirectUpload; owner: string; photoId: string; rawKey: string; deps: AdapterDeps }

async function setup(extraEnv: Record<string, string> = {}, opts: { maxUploadMb?: number } = {}): Promise<Setup> {
  const db = await testDb();
  const base = makeDeps({ ...env, ...extraEnv }, { secrets: { 'upload-hmac-key': 'k'.repeat(32) } });
  const storage = new S3Storage({ ...base, db });
  const deps: AdapterDeps = { ...base, db, storage, ...(opts.maxUploadMb !== undefined ? { runtime: runtime(opts.maxUploadMb) } : {}) };
  const drv = new CognitoDirectUpload(deps);
  const owner = await seedUser(db);
  const photoId = '11111111-2222-4333-8444-555555555555';
  const rawKey = `raw/${owner}/${photoId}.jpg`;
  await insertPhoto(db, {
    id: photoId, ownerId: owner, albumId: null, rawKey, filename: 'a.jpg', contentType: 'image/jpeg', sizeBytes: null,
    visibility: 'private', title: null, caption: null,
  });
  return { db, drv, owner, photoId, rawKey, deps };
}

function inCtx<T>(userId: string, fn: () => Promise<T>): Promise<{ result: T; ctx: RequestContext }> {
  const ctx = createRequestContext({ userId });
  return runWithContext(ctx, fn).then((result) => ({ result, ctx }));
}

function mockExchange(identityId = IDENTITY_A): void {
  ci.on(GetIdCommand).resolves({ IdentityId: identityId });
  ci.on(GetCredentialsForIdentityCommand).resolves({
    IdentityId: identityId,
    Credentials: { AccessKeyId: 'ASIAEXAMPLEUPLOADER', SecretKey: 'sk', SessionToken: 'st', Expiration: new Date(Date.now() + 3600_000) },
  });
}

function mockPool(extra: Record<string, unknown> = {}): void {
  ci.on(DescribeIdentityPoolCommand).resolves({
    IdentityPoolId: POOL, IdentityPoolName: 'cloudalbum_lab_uploads', AllowUnauthenticatedIdentities: false,
    CognitoIdentityProviders: [{ ProviderName: PROVIDER, ClientId: CLIENT, ServerSideTokenCheck: false }], ...extra,
  });
}

async function stage(key: string, body: Buffer, contentType = 'image/jpeg'): Promise<void> {
  const { S3Client } = await import('@aws-sdk/client-s3');
  await new S3Client({ region: 'ap-northeast-1', credentials: { accessKeyId: 'x', secretAccessKey: 'y' } })
    .send(new PutObjectCommand({ Bucket: STAGING, Key: key, Body: body, ContentType: contentType }));
}

describe('辅助函数', () => {
  it('decodeJwtPayload / isIdentityId / idTokenOf', () => {
    expect(decodeJwtPayload(idToken('s1'))?.sub).toBe('s1');
    expect(decodeJwtPayload('not-a-jwt')).toBeNull();
    expect(isIdentityId(IDENTITY_A)).toBe(true);
    expect(isIdentityId('ap-northeast-1:../../x')).toBe(false);
    expect(isIdentityId('raw/u1')).toBe(false);
    const t = idToken('s1');
    const req = (cookies: Record<string, string>, headers: Record<string, string>) => ({ cookies, get: (h: string) => headers[h.toLowerCase()] }) as never;
    expect(idTokenOf(req({ ca_it: t }, {}))).toBe(t);
    expect(idTokenOf(req({}, { 'x-cloudalbum-id-token': t }))).toBe(t);
    expect(idTokenOf(req({}, { 'x-cloudalbum-id-token': 'garbage value' }))).toBe('');
  });
});

describe('CognitoDirectUpload：会话与换取凭证', () => {
  it('openSession → sts（区域、暂存桶、分片大小、凭证接口；路径段 cognito:sts）；换取凭证后前缀带 identityId', async () => {
    const { drv, owner } = await setup();
    const a = await inCtx(owner, () => drv.openSession(cognitoPrincipal('sub-a')));
    expect(a.result).toEqual({
      mode: 'sts', region: 'ap-northeast-1', bucket: STAGING, prefix: 'private/', partSize: 8 * 1024 * 1024, credentialsUrl: '/api/uploads/credentials',
    });
    expect(a.ctx.path.get('identity-pool')).toBe('cognito:sts');

    mockExchange();
    const token = idToken('sub-a');
    const c = await inCtx(owner, () => drv.credentials(cognitoPrincipal('sub-a'), token));
    expect(c.result).toMatchObject({
      accessKeyId: 'ASIAEXAMPLEUPLOADER', secretAccessKey: 'sk', sessionToken: 'st', identityId: IDENTITY_A,
      region: 'ap-northeast-1', bucket: STAGING, prefix: `private/${IDENTITY_A}/`,
    });
    expect(c.ctx.path.get('identity-pool')).toBe('cognito:sts');
    // GetId 的 Logins 键是 User Pool 的提供方名；GetCredentialsForIdentity 带同一组 Logins
    expect(ci.commandCalls(GetIdCommand)[0]!.args[0].input).toEqual({ IdentityPoolId: POOL, Logins: { [PROVIDER]: token } });
    expect(Object.keys(ci.commandCalls(GetCredentialsForIdentityCommand)[0]!.args[0].input.Logins ?? {})).toEqual([PROVIDER]);
    expect((await findUserById((drv as unknown as { deps: AdapterDeps }).deps.db!, owner))?.identity_id).toBe(IDENTITY_A);
    expect(drv.lastIssued(owner)).toMatchObject({ identityId: IDENTITY_A, accessKeyPrefix: 'ASIA…', via: 'user-pool' });

    const b = await inCtx(owner, () => drv.openSession(cognitoPrincipal('sub-a')));
    expect(b.result).toMatchObject({ mode: 'sts', prefix: `private/${IDENTITY_A}/` });
    expect(drv.exchangeStats()).toMatchObject({ total: 1, ok: 1, failed: 0 });
  });

  it('ID 令牌的声明在本地核对：access token、别人的 sub、别的 User Pool / 客户端、过期都在调用 Cognito 之前被拒（401）', async () => {
    const { drv, owner } = await setup();
    mockExchange();
    const who = cognitoPrincipal('sub-a');
    const run = (t: string) => inCtx(owner, () => drv.credentials(who, t));
    await expect(run(jwt({ token_use: 'access', sub: 'sub-a' }))).rejects.toMatchObject({ status: 401, code: 'ID_TOKEN_INVALID' });
    await expect(run(idToken('sub-b'))).rejects.toMatchObject({ status: 401, code: 'ID_TOKEN_INVALID' });
    await expect(run(idToken('sub-a', { iss: 'https://cognito-idp.ap-northeast-1.amazonaws.com/ap-northeast-1_Other999' }))).rejects.toMatchObject({ status: 401 });
    await expect(run(idToken('sub-a', { aud: 'other-client' }))).rejects.toMatchObject({ status: 401 });
    await expect(run(idToken('sub-a', { exp: 1 }))).rejects.toMatchObject({ status: 401, code: 'ID_TOKEN_EXPIRED' });
    await expect(run('')).rejects.toMatchObject({ status: 401, code: 'ID_TOKEN_REQUIRED' });
    expect(ci.commandCalls(GetIdCommand)).toHaveLength(0);
    expect(drv.exchangeStats().total).toBe(0);
  });

  it('Cognito 拒绝已过期的令牌 → 401（不计入失败）；服务故障 → 503 并让 60 秒内的新会话退回前缀令牌（cognito:error-fallback）', async () => {
    const { drv, owner } = await setup();
    ci.on(GetIdCommand).rejectsOnce(awsError('NotAuthorizedException', 400, 'Invalid login token. Token expired: 1 >= 0'));
    await expect(inCtx(owner, () => drv.credentials(cognitoPrincipal('sub-a'), idToken('sub-a')))).rejects.toMatchObject({ status: 401, code: 'ID_TOKEN_EXPIRED' });
    expect(drv.fallbackReason()).toBeNull();

    ci.on(GetIdCommand).rejects(awsError('InternalErrorException', 500));
    const failed = inCtx(owner, () => drv.credentials(cognitoPrincipal('sub-a'), idToken('sub-a')));
    await expect(failed).rejects.toMatchObject({ status: 503, code: 'IDENTITY_POOL_UNAVAILABLE' });
    expect(drv.exchangeStats()).toMatchObject({ total: 1, failed: 1 });
    expect(drv.fallbackReason()).toContain('换取凭证失败');

    const s = await inCtx(owner, () => drv.openSession(cognitoPrincipal('sub-a')));
    expect(s.result).toMatchObject({ mode: 'token', fallback: true, prefix: `raw/${owner}/`, partUrl: '/api/uploads/parts:sign' });
    expect(s.ctx.path.get('identity-pool')).toBe('cognito:error-fallback');

    // 探针：失败率 > 1% → degraded，detail 说明已退回
    mockPool();
    const p = await drv.probe();
    expect(EXCHANGE_FAILURE_RATIO).toBe(0.01);
    expect(p.status).toBe('degraded');
    expect(p.detail).toContain('最近 5 分钟换取凭证失败 1/1');
    expect(p.data).toMatchObject({ fallbackActive: true, credentialExchanges: { failed: 1 } });
  });

  it('管理员旁路（X-Compare-Bypass: identity-pool）→ none 驱动的前缀令牌（cognito:bypass），令牌会话的分片授权照常', async () => {
    const { drv, owner, photoId, rawKey } = await setup();
    const s = await inCtx(owner, () => drv.openSession(localPrincipal(owner), { bypass: true }));
    expect(s.ctx.path.get('identity-pool')).toBe('cognito:bypass');
    if (s.result.mode !== 'token') throw new Error('expected token session');
    expect(s.result.fallback).toBeUndefined();
    const part = await inCtx(owner, () => drv.authorizePart((s.result as { token: string }).token, rawKey, photoId, 1));
    expect(part.result.url).toContain(`${RAW}`);
    expect(part.result.url).toContain('partNumber=1');
    await expect(drv.authorizePart((s.result as { token: string }).token, `raw/someone-else/${photoId}.jpg`, photoId, 1))
      .rejects.toMatchObject({ status: 403, code: 'UPLOAD_PREFIX_DENIED' });
  });

  it('开发者认证身份（auth=local + IDENTITY_DEV_PROVIDER）：GetOpenIdTokenForDeveloperIdentity → GetCredentialsForIdentity（Logins = cognito-identity.amazonaws.com）', async () => {
    const { drv, owner } = await setup({ AUTH_DRIVER: 'local', IDENTITY_DEV_PROVIDER: 'login.cloudalbum' });
    ci.on(GetOpenIdTokenForDeveloperIdentityCommand).resolves({ IdentityId: IDENTITY_A, Token: 'openid-token' });
    ci.on(GetCredentialsForIdentityCommand).resolves({
      IdentityId: IDENTITY_A, Credentials: { AccessKeyId: 'ASIADEV', SecretKey: 'sk', SessionToken: 'st', Expiration: new Date(Date.now() + 900_000) },
    });
    const r = await inCtx(owner, () => drv.credentials(localPrincipal(owner), ''));
    expect(r.result).toMatchObject({ accessKeyId: 'ASIADEV', identityId: IDENTITY_A, prefix: `private/${IDENTITY_A}/` });
    expect(ci.commandCalls(GetOpenIdTokenForDeveloperIdentityCommand)[0]!.args[0].input).toEqual({ IdentityPoolId: POOL, Logins: { 'login.cloudalbum': owner } });
    expect(ci.commandCalls(GetCredentialsForIdentityCommand)[0]!.args[0].input).toEqual({ IdentityId: IDENTITY_A, Logins: { 'cognito-identity.amazonaws.com': 'openid-token' } });
    expect(ci.commandCalls(GetIdCommand)).toHaveLength(0);
    // 第二次带上已保存的 IdentityId
    await inCtx(owner, () => drv.credentials(localPrincipal(owner), ''));
    expect(ci.commandCalls(GetOpenIdTokenForDeveloperIdentityCommand)[1]!.args[0].input.IdentityId).toBe(IDENTITY_A);
    expect(drv.lastIssued(owner)?.via).toBe('developer');
  });
});

describe('CognitoDirectUpload：complete（暂存 → 校验 → 服务端复制）', () => {
  async function withIdentity(s: Setup): Promise<string> {
    await s.db('users').where({ id: s.owner }).update({ identity_id: IDENTITY_A });
    return `private/${IDENTITY_A}/${s.photoId}.jpg`;
  }

  it('合规：CopyObject 到原图键，删除暂存对象，路径段 identity-pool=cognito:sts、storage=s3:import', async () => {
    const s = await setup();
    const key = await withIdentity(s);
    await stage(key, JPEG);
    const r = await inCtx(s.owner, () => s.drv.complete(s.photoId, cognitoPrincipal('sub-a')));
    expect(r.result).toEqual({ ok: true, rawKey: s.rawKey });
    expect(fake.buckets.get(RAW)!.get(s.rawKey)!.body.equals(JPEG)).toBe(true);
    expect(fake.buckets.get(STAGING)!.has(key)).toBe(false);
    expect(r.ctx.path.get('identity-pool')).toBe('cognito:sts');
    expect(r.ctx.path.get('storage')).toBe('s3:import');
  });

  it('文件头不是图片（扩展名伪装）→ 415，删除暂存对象并把照片标记为 FAILED，原图桶里没有对象', async () => {
    const s = await setup();
    const key = await withIdentity(s);
    await stage(key, Buffer.from('#!/bin/sh\necho not an image\n'), 'image/jpeg');
    await expect(inCtx(s.owner, () => s.drv.complete(s.photoId, cognitoPrincipal('sub-a')))).rejects.toMatchObject({ status: 415, code: 'UNSUPPORTED_MEDIA_TYPE' });
    expect(fake.buckets.get(STAGING)!.has(key)).toBe(false);
    expect(fake.buckets.get(RAW)!.has(s.rawKey)).toBe(false);
    expect((await getPhoto(s.db, s.photoId))?.status).toBe('FAILED');
  });

  it('超过运行时 maxUploadMb → 413；Content-Type 不在白名单 → 415；与声明类型不一致 → 415', async () => {
    const big = await setup({}, { maxUploadMb: 0.0001 });
    await stage(await withIdentity(big), JPEG);
    await expect(big.drv.complete(big.photoId, cognitoPrincipal('sub-a'))).rejects.toMatchObject({ status: 413, code: 'UPLOAD_TOO_LARGE' });

    const gif = await setup();
    await stage(await withIdentity(gif), JPEG, 'image/gif');
    await expect(gif.drv.complete(gif.photoId, cognitoPrincipal('sub-a'))).rejects.toMatchObject({ status: 415, code: 'UNSUPPORTED_MEDIA_TYPE' });

    const png = await setup();
    await stage(await withIdentity(png), Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(64)]), 'image/png');
    await expect(png.drv.complete(png.photoId, cognitoPrincipal('sub-a'))).rejects.toMatchObject({ status: 415, code: 'CONTENT_TYPE_MISMATCH' });
  });

  it('暂存桶里没有对象（令牌会话）→ 交给 none 驱动；它也没有分片时返回 ok:false 与原因', async () => {
    const s = await setup();
    await withIdentity(s);
    const r = await s.drv.complete(s.photoId, cognitoPrincipal('sub-a'));
    expect(r.ok).toBe(false);
    expect(r.reason).toContain('暂存桶中没有');
    const noIdentity = await setup();
    expect((await noIdentity.drv.complete(noIdentity.photoId, cognitoPrincipal('sub-a'))).reason).toContain('还没有换取过');
  });
});

describe('CognitoDirectUpload：探针、平台探测与服务端证据', () => {
  it('ok：DescribeIdentityPool + HeadBucket；deep 另列出暂存前缀', async () => {
    const { drv } = await setup();
    mockPool();
    const p = await drv.probe({ deep: true });
    expect(p.status).toBe('ok');
    expect(p.detail).toContain('不允许访客身份');
    expect(p.data).toMatchObject({ identityPoolId: POOL, stagingBucket: STAGING, allowUnauthenticated: false, stagingSample: { keyCount: 0 } });
  });

  it('degraded：允许未认证身份；身份提供方不是本站的 User Pool 客户端', async () => {
    const a = await setup();
    mockPool({ AllowUnauthenticatedIdentities: true });
    expect((await a.drv.probe()).detail).toContain('未认证');
    mockPool({ CognitoIdentityProviders: [{ ProviderName: PROVIDER, ClientId: 'stale-client' }] });
    const p = await a.drv.probe();
    expect(p.status).toBe('degraded');
    expect(p.detail).toContain('身份提供方');
  });

  it('error：身份池不存在 / 暂存桶不存在 / 无权限；error 之后的新会话退回前缀令牌', async () => {
    const { drv, owner } = await setup();
    ci.on(DescribeIdentityPoolCommand).rejects(awsError('ResourceNotFoundException', 400));
    const p = await drv.probe();
    expect(p).toMatchObject({ status: 'error', confidence: 'confirmed' });
    expect(p.detail).toContain('不存在');
    const s = await inCtx(owner, () => drv.openSession(cognitoPrincipal('sub-a')));
    expect(s.result).toMatchObject({ mode: 'token', fallback: true });

    mockPool();
    fake.buckets.delete(STAGING);
    expect((await drv.probe()).detail).toContain(`暂存桶 ${STAGING} 不存在`);

    fake.mock.on(HeadBucketCommand).rejects(awsError('AccessDenied', 403));
    expect((await drv.probe()).detail).toContain('PolicyArn');

    // 恢复后探针 ok，新会话重新走 STS
    fake.restore();
    fake = new FakeS3([RAW, MEDIA, STAGING]);
    expect((await drv.probe()).status).toBe('ok');
    expect((await drv.openSession(cognitoPrincipal('sub-a'))).mode).toBe('sts');
  });

  it('瞬时失败（重试后仍超时 / 限流）→ degraded + transient，不立即退回；连续 3 次后才退回', async () => {
    const { drv } = await setup();
    ci.on(DescribeIdentityPoolCommand).rejects(awsError('TooManyRequestsException', 429));
    const p = await drv.probe();
    expect(p).toMatchObject({ status: 'degraded', transient: true });
    expect(drv.fallbackReason()).toBeNull();
    await drv.probe();
    await drv.probe();
    expect(drv.fallbackReason()).toContain('连续 3 次探针失败');
  }, 20_000);

  it('平台探测 /api/lab/probe/identity-pool：cognito → cognito:probe；none → none:token（保留前缀 _probe/）', async () => {
    const { drv, deps } = await setup();
    mockPool();
    const r = await inCtx('admin', () => identityPoolLabProbe({ directUpload: drv }));
    expect(r.result).toMatchObject({ driver: 'cognito', identityPoolId: POOL, allowUnauthenticated: false, stagingBucket: STAGING });
    expect(r.ctx.path.get('identity-pool')).toBe('cognito:probe');

    const none = new PrefixTokenUpload(deps);
    const n = await inCtx('admin', () => identityPoolLabProbe({ directUpload: none }));
    expect(n.result).toMatchObject({ driver: 'none', prefix: '_probe/' });
    expect(n.ctx.path.get('identity-pool')).toBe('none:token');
  });

  it('stagingObject：只查暂存前缀之内的键（服务端证据：越权写入是否落地）', async () => {
    const { drv } = await setup();
    await stage(`private/${IDENTITY_A}/x.jpg`, JPEG);
    expect(await drv.stagingObject(`private/${IDENTITY_A}/x.jpg`)).toMatchObject({ exists: true, size: JPEG.length, contentType: 'image/jpeg' });
    expect(await drv.stagingObject('private/ap-northeast-1:bbbbbbbb-1111-4111-8111-bbbbbbbbbbbb/x.jpg')).toEqual({ key: 'private/ap-northeast-1:bbbbbbbb-1111-4111-8111-bbbbbbbbbbbb/x.jpg', exists: false });
    await expect(drv.stagingObject('raw/u1/x.jpg')).rejects.toMatchObject({ status: 400 });
    await expect(drv.stagingObject('private/../raw/x.jpg')).rejects.toMatchObject({ status: 400 });
  });
});
