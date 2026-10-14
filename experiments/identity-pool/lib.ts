/**
 * identity-pool 实验共用（02#identity-pool 第 5 节）：测试用户、按用户登录、F14 的两种上传路径与服务端证据。
 *
 * 测试用户（越权实验需要 A、B 两个）按优先级取：
 *   --param users=<文件>：JSON（平台种子 cognito-test-users 的格式 [{username,email,password}]）或 CSV（每行 email,password）；
 *   环境变量 CLOUDALBUM_TEST_USERS_PARAM（平台工作台）：用 AWS CLI 读取 SecureString（aws ssm get-parameter --with-decryption）；
 *   环境变量 EXP_USERS_FILE。密码只在本进程内存中使用，不写入结果。
 * 登录：auth=local → POST /api/auth/login；auth=cognito → USER_SRP_AUTH（cognito-srp.ts，与浏览器的 Amplify 相同）。
 * 用户请求不带实验头（服务端只接受管理员的 X-Experiment-*），因此这些实验在卡片中用 validity: functional，佐证来自
 * 服务端的 path-seen 检查；场景另以管理员身份读取服务端证据（照片状态、暂存桶中对象是否存在）。
 */
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { cookieValue, type ExpClient, type ExpResponse } from '../_lib/http.js';
import { parseUsersCsv } from '../_lib/app.js';
import type { ScenarioContext } from '../_lib/scenario.js';
import { strParam } from '../_lib/scenario.js';
import { srpLogin, type CognitoCall } from './cognito-srp.js';
import { StsS3, type StsCredentials } from './s3.js';

export const ROUTES = {
  login: '/api/auth/login',
  session: '/api/uploads/session',
  partsSign: '/api/uploads/parts:sign',
  credentials: '/api/uploads/credentials',
  upload: '/api/storage/upload',
  parts: '/api/storage/upload/parts',
  photos: '/api/photos',
  complete: '/api/photos/:id/complete',
  photo: '/api/photos/:id',
  staging: '/api/lab/identity-pool/staging-object',
  whoami: '/api/lab/identity-pool/whoami',
} as const;

export const ID_TOKEN_HEADER = 'x-cloudalbum-id-token';

export interface Account { email: string; password: string }

export type Mode = 'token' | 'sts';

/** 当前驱动决定默认模式：cognito → sts，其余 → token（--param mode= 覆盖；token 模式在 cognito 驱动下用管理员旁路会话） */
export function modeOf(ctx: Pick<ScenarioContext, 'params' | 'capabilities'>): Mode {
  const p = strParam(ctx, 'mode', 'auto');
  if (p === 'token' || p === 'sts') return p;
  return ctx.capabilities.modules?.['identity-pool']?.driver === 'cognito' ? 'sts' : 'token';
}

/** 解析测试用户文件：平台种子的 JSON 数组、{users:[…]}，或 CSV */
export function parseAccounts(text: string): Account[] {
  const t = text.trim();
  if (t.startsWith('[') || t.startsWith('{')) {
    const doc = JSON.parse(t) as unknown;
    const list = Array.isArray(doc) ? doc : (doc as { users?: unknown[] }).users ?? [];
    return (list as Array<Record<string, unknown>>)
      .map((u) => ({ email: String(u.email ?? ''), password: String(u.password ?? '') }))
      .filter((u) => u.email && u.password);
  }
  return parseUsersCsv(t);
}

export interface AccountSource { accounts: Account[]; source: string }

export function loadAccounts(ctx: Pick<ScenarioContext, 'params'>, env: NodeJS.ProcessEnv = process.env,
  readParam: (name: string) => string = (name) => execFileSync('aws', ['ssm', 'get-parameter', '--with-decryption', '--name', name, '--query', 'Parameter.Value', '--output', 'text'], { encoding: 'utf8' })): AccountSource {
  const file = strParam(ctx, 'users', '') || '';
  if (file) return { accounts: parseAccounts(readFileSync(file, 'utf8')), source: file };
  if (env.CLOUDALBUM_TEST_USERS_PARAM) return { accounts: parseAccounts(readParam(env.CLOUDALBUM_TEST_USERS_PARAM)), source: `ssm:${env.CLOUDALBUM_TEST_USERS_PARAM}` };
  if (env.EXP_USERS_FILE) return { accounts: parseAccounts(readFileSync(env.EXP_USERS_FILE, 'utf8')), source: env.EXP_USERS_FILE };
  return { accounts: [], source: 'none' };
}

export interface UserSession {
  email: string;
  /** CloudAlbum 的 access token（local：ca_at；cognito：User Pool access token），作为 Bearer */
  token: string;
  /** auth=cognito：User Pool 的 ID 令牌（换取 Identity Pool 凭证用） */
  idToken?: string;
  client: ExpClient;
}

function cognitoPublic(ctx: Pick<ScenarioContext, 'capabilities'>): { region: string; clientId: string; userPoolId: string } {
  const pub = (ctx.capabilities.modules?.auth?.public ?? {}) as Record<string, unknown>;
  const clientId = String(pub.publicClientId ?? pub.userPoolClientId ?? '');
  const userPoolId = String(pub.userPoolId ?? '');
  const region = String(pub.region ?? userPoolId.split('_')[0] ?? '');
  if (!clientId || !userPoolId || !region) throw new Error('capabilities 中没有 auth 的 userPoolId / userPoolClientId（auth 不是 cognito？）');
  return { region, clientId, userPoolId };
}

export async function loginUser(ctx: ScenarioContext, a: Account): Promise<UserSession> {
  const anon = ctx.http(ctx.target, { target: 'direct', auth: false, experiment: false });
  if (ctx.capabilities.modules?.auth?.driver !== 'cognito') {
    const r = await anon.post(ROUTES.login, { route: ROUTES.login, json: { email: a.email, password: a.password }, auth: false, expect: [200] });
    const token = r.ok ? cookieValue(r.setCookie, 'ca_at') ?? (r.json<{ accessToken?: string }>().accessToken) : undefined;
    if (!token) throw new Error(`${a.email} 登录失败：HTTP ${r.status || r.error}`);
    return { email: a.email, token, client: ctx.http(ctx.target, { target: 'direct', token, experiment: false }) };
  }
  const cfg = cognitoPublic(ctx);
  const cognito = ctx.http(`https://cognito-idp.${cfg.region}.amazonaws.com`, { target: 'cognito', auth: false, experiment: false });
  const call: CognitoCall = async (action, body) => {
    const r = await cognito.post('/', {
      route: `cognito:${action}`, auth: false, body: JSON.stringify(body), expect: [200],
      headers: { 'content-type': 'application/x-amz-json-1.1', 'x-amz-target': `AWSCognitoIdentityProviderService.${action}` },
    });
    let json: Record<string, unknown> = {};
    try {
      json = r.json<Record<string, unknown>>();
    } catch {
      /* 非 JSON */
    }
    return { status: r.status, json };
  };
  const t = await srpLogin(call, { userPoolId: cfg.userPoolId, clientId: cfg.clientId, username: a.email, password: a.password });
  return { email: a.email, token: t.accessToken, idToken: t.idToken, client: ctx.http(ctx.target, { target: 'direct', token: t.accessToken, experiment: false }) };
}

export interface TokenSession { mode: 'token'; token: string; prefix: string; partSize: number; partUrl: string; fallback?: boolean }
export interface StsSessionDoc { mode: 'sts'; region: string; bucket: string; prefix: string; partSize: number; credentialsUrl: string }
export type SessionDoc = TokenSession | StsSessionDoc;

/** POST /api/uploads/session（mode=token 且驱动是 cognito 时：这个接口只接受管理员的旁路头，普通用户直接用 sts） */
export async function openSession(u: UserSession): Promise<{ session: SessionDoc; res: ExpResponse }> {
  const res = await u.client.post(ROUTES.session, { route: ROUTES.session, expect: [201, 200] });
  if (!res.ok) throw new Error(`POST /api/uploads/session 失败：HTTP ${res.status || res.error}`);
  return { session: res.json<SessionDoc>(), res };
}

export interface CreatedPhoto { photoId: string; rawKey: string; uploadId: string }

export async function createPhoto(u: UserSession, size: number, title: string): Promise<CreatedPhoto> {
  const r = await u.client.post(ROUTES.photos, {
    route: ROUTES.photos, expect: [201],
    json: { contentType: 'image/jpeg', size, filename: 'exp-identity-pool.jpg', visibility: 'private', title, transfer: 'multipart' },
  });
  if (!r.ok) throw new Error(`POST /api/photos 失败：HTTP ${r.status || r.error}`);
  const b = r.json<{ photoId?: string; rawKey?: string; uploadId?: string; photo?: { id?: string } }>();
  const photoId = b.photoId ?? b.photo?.id ?? '';
  return { photoId, rawKey: b.rawKey ?? '', uploadId: b.uploadId ?? photoId };
}

/** 令牌模式的一片：storage=local 直接 PUT 到 EC2；storage=s3 先 parts:sign 再 PUT 预签名 URL。返回发往 EC2 的请求数 */
export async function tokenPart(ctx: ScenarioContext, u: UserSession, s: TokenSession, p: CreatedPhoto, part: number, body: Buffer):
  Promise<{ ok: boolean; status: number; code?: string; etag?: string; backend: number }> {
  const auth = { authorization: `CA-Upload ${s.token}` };
  if (s.partUrl === ROUTES.upload) {
    const r = await u.client.put(`${ROUTES.upload}?${new URLSearchParams({ key: p.rawKey, uploadId: p.uploadId, part: String(part) })}`, {
      route: `PUT ${ROUTES.upload}`, headers: { ...auth, 'content-type': 'application/octet-stream' }, body, expect: [200],
    });
    return { ok: r.ok, status: r.status, ...(errorCode(r) ? { code: errorCode(r)! } : {}), ...(r.headers.etag ? { etag: r.headers.etag } : {}), backend: 1 };
  }
  const signed = await u.client.post(ROUTES.partsSign, { route: ROUTES.partsSign, headers: auth, json: { key: p.rawKey, uploadId: p.uploadId, part }, expect: [200] });
  if (!signed.ok) return { ok: false, status: signed.status, ...(errorCode(signed) ? { code: errorCode(signed)! } : {}), backend: 1 };
  const url = signed.json<{ url: string }>().url;
  const target = url.startsWith('/') ? ctx.target : new URL(url).origin;
  const put = await ctx.http(target, { target: url.startsWith('/') ? 'direct' : 's3', auth: false, experiment: false })
    .put(url.startsWith('/') ? url : url, { route: 'PUT s3:UploadPart(presigned)', body, auth: false, expect: [200] });
  return { ok: put.ok, status: put.status, ...(put.headers.etag ? { etag: put.headers.etag } : {}), backend: url.startsWith('/') ? 2 : 1 };
}

export function errorCode(r: ExpResponse): string | undefined {
  try {
    const b = r.json<{ error?: string | { code?: string }; code?: string }>();
    return typeof b.error === 'string' ? b.error : b.error?.code ?? b.code;
  } catch {
    return undefined;
  }
}

export async function completePhoto(u: UserSession, photoId: string, body: Record<string, unknown> = {}): Promise<ExpResponse> {
  return u.client.post(ROUTES.complete.replace(':id', encodeURIComponent(photoId)), { route: ROUTES.complete, json: body, expect: [200, 202] });
}

/** GET /api/uploads/credentials：ID 令牌放在 Cookie ca_it 与请求头 X-CloudAlbum-Id-Token 里（脚本不是浏览器，两种都能带） */
export async function getCredentials(u: UserSession): Promise<{ creds?: StsCredentials; res: ExpResponse }> {
  const headers: Record<string, string> = u.idToken ? { cookie: `ca_it=${u.idToken}`, [ID_TOKEN_HEADER]: u.idToken } : {};
  const res = await u.client.get(ROUTES.credentials, { route: ROUTES.credentials, headers, expect: [200] });
  return res.ok ? { creds: res.json<StsCredentials>(), res } : { res };
}

/** 暂存键 private/<identityId>/<photoId>.<原图键的扩展名>（与后端 complete 的规则相同） */
export function stagingKeyOf(creds: StsCredentials, photoId: string, rawKey: string): string {
  const ext = (/\.([A-Za-z0-9]{1,8})$/.exec(rawKey)?.[1] ?? 'jpg').toLowerCase();
  return `${creds.prefix.replace(/\/?$/, '/')}${photoId}.${ext}`;
}

/** 服务端证据（管理员）：暂存桶中对象是否存在；接口未登记（404）或 none 驱动时返回 null */
export async function stagingExists(ctx: ScenarioContext, key: string): Promise<boolean | null> {
  const r = await ctx.client.get(`${ROUTES.staging}?${new URLSearchParams({ key })}`, { route: ROUTES.staging, expect: [200] });
  if (!r.ok) return null;
  return Boolean(r.json<{ exists?: boolean }>().exists);
}

/** 服务端证据（管理员）：照片在服务端的状态 */
export async function serverPhotoStatus(ctx: ScenarioContext, photoId: string): Promise<string | null> {
  const r = await ctx.client.get(ROUTES.photo.replace(':id', encodeURIComponent(photoId)), { route: ROUTES.photo, expect: [200] });
  return r.ok ? r.json<{ status?: string }>().status ?? null : null;
}

/** 路径头里的 identity-pool 段（客户端看到的；服务端证据另见 stagingExists / path-seen 检查） */
export function identityPoolSegment(r: ExpResponse): string | undefined {
  return /(?:^|;)identity-pool=([^;]+)/.exec(r.headers['x-cloudalbum-path'] ?? '')?.[1];
}

export { StsS3 };
export type { StsCredentials };

/** 一个文件的 STS 分片直传：CreateMultipartUpload → UploadPart × n → Complete；返回 S3 请求数与每片结果 */
export async function stsMultipart(s3: StsS3, key: string, body: Buffer, partSize: number, opts: { skip?: Map<number, string>; failAt?: number } = {}):
  Promise<{ uploadId: string; parts: Map<number, string>; s3Requests: number; partsSent: number[] }> {
  const uploadId = await s3.createMultipart(key, 'image/jpeg');
  return continueMultipart(s3, key, uploadId, body, partSize, opts, 1);
}

export async function continueMultipart(s3: StsS3, key: string, uploadId: string, body: Buffer, partSize: number,
  opts: { skip?: Map<number, string>; failAt?: number } = {}, initialRequests = 0):
  Promise<{ uploadId: string; parts: Map<number, string>; s3Requests: number; partsSent: number[] }> {
  const parts = new Map(opts.skip ?? []);
  const total = Math.max(1, Math.ceil(body.length / partSize));
  let s3Requests = initialRequests;
  const partsSent: number[] = [];
  for (let n = 1; n <= total; n += 1) {
    if (parts.has(n)) continue;
    if (opts.failAt === n) throw Object.assign(new Error(`模拟断网：第 ${n} 片之前中断`), { name: 'SimulatedDisconnect', parts, uploadId, partsSent, s3Requests });
    const r = await s3.uploadPart(key, uploadId, n, body.subarray((n - 1) * partSize, n * partSize));
    s3Requests += 1;
    if (!r.etag) throw new Error(`UploadPart ${n} 失败：HTTP ${r.res.status}（读不到 ETag？）`);
    parts.set(n, r.etag);
    partsSent.push(n);
  }
  const c = await s3.completeMultipart(key, uploadId, parts);
  s3Requests += 1;
  if (!c.ok || /<Error>/.test(c.text())) throw new Error(`CompleteMultipartUpload 失败：HTTP ${c.status}`);
  return { uploadId, parts, s3Requests, partsSent };
}
