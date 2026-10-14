/**
 * identity-pool/cross-prefix —— 越权测试（02#identity-pool 第 5 节步骤 1）。
 *
 *   npm run exp -- identity-pool --label before --scenario cross-prefix --param users=<测试用户文件>   # none：应用自签前缀令牌
 *   scripts/module enable identity-pool
 *   npm run exp -- identity-pool --label after  --scenario cross-prefix --param users=<测试用户文件> --upload
 *
 * 用户 A 依次尝试：写自己的前缀（应允许）、写 B 的前缀、列出（B 的分片 / 整个桶）、删除 B 的对象（都应拒绝），记录每次由谁拒绝：
 *   token 模式：应用返回 403 UPLOAD_PREFIX_DENIED（拒绝逻辑在 adapters/identity-pool/none.ts）；
 *   sts 模式：S3 返回 AccessDenied（拒绝逻辑在 Uploader 角色的 IAM 策略里，${cognito-identity.amazonaws.com:sub}）。
 * 服务端证据（管理员）：暂存桶中对象是否存在（sts）、B 的照片在服务端的状态（token）。
 */
import { testJpeg } from '../_lib/images.js';
import type { ExpResponse } from '../_lib/http.js';
import { defineScenario, type ScenarioContext } from '../_lib/scenario.js';
import {
  createPhoto, errorCode, getCredentials, loadAccounts, loginUser, modeOf, openSession, ROUTES, serverPhotoStatus, stagingExists, StsS3,
  tokenPart, type Mode, type TokenSession, type UserSession,
} from './lib.js';
import { s3ErrorCode } from './s3.js';

export interface Attempt {
  action: 'write-own' | 'list-own' | 'write-other' | 'list-root' | 'list-other' | 'delete-other';
  expected: 'allowed' | 'denied';
  status: number;
  code?: string;
  /** 实际结果：allowed / denied（不适用时 n/a） */
  outcome: 'allowed' | 'denied' | 'n/a';
  deniedBy: 'application' | 's3' | null;
  matches: boolean;
  note?: string;
}

export function classify(mode: Mode, action: Attempt['action'], expected: Attempt['expected'], r: { status: number; code?: string } | null, note?: string): Attempt {
  if (!r) return { action, expected, status: 0, outcome: 'n/a', deniedBy: null, matches: true, ...(note ? { note } : {}) };
  const allowed = r.status >= 200 && r.status < 300;
  const outcome = allowed ? 'allowed' : 'denied';
  const deniedBy = allowed ? null : mode === 'sts' ? 's3' : 'application';
  return {
    action, expected, status: r.status, ...(r.code ? { code: r.code } : {}), outcome, deniedBy,
    // 拒绝必须是授权类（403 / 404），不能是 5xx 之类的偶然失败
    matches: expected === 'allowed' ? allowed : !allowed && (r.status === 403 || r.status === 404),
    ...(note ? { note } : {}),
  };
}

export function summarize(attempts: readonly Attempt[]): { deniedByApplication: number; deniedByS3: number; unexpected: number; allowedOwn: number } {
  return {
    deniedByApplication: attempts.filter((a) => a.deniedBy === 'application').length,
    deniedByS3: attempts.filter((a) => a.deniedBy === 's3').length,
    unexpected: attempts.filter((a) => !a.matches).length,
    allowedOwn: attempts.filter((a) => a.action.endsWith('-own') && a.outcome === 'allowed').length,
  };
}

const s3r = (r: ExpResponse) => ({ status: r.status, ...(s3ErrorCode(r) ? { code: s3ErrorCode(r)! } : {}) });

async function tokenMode(ctx: ScenarioContext, A: UserSession, B: UserSession, jpeg: Buffer): Promise<{ attempts: Attempt[]; evidence: Record<string, unknown> }> {
  const { session } = await openSession(A);
  if (session.mode !== 'token') {
    throw new Error('当前驱动发放的是 STS 会话：普通用户拿不到前缀令牌（只有管理员可以旁路），改用 --param mode=sts');
  }
  const s = session as TokenSession;
  const title = `experiment identity-pool/cross-prefix ${ctx.label}`;
  const pA = await createPhoto(A, jpeg.length, title);
  const pB = await createPhoto(B, jpeg.length, title);
  for (const id of [pA.photoId, pB.photoId]) ctx.cleanupLater('DELETE', `/api/photos/${id}`);
  const attempts: Attempt[] = [];
  const own = await tokenPart(ctx, A, s, pA, 1, jpeg);
  attempts.push(classify('token', 'write-own', 'allowed', own));
  const other = await tokenPart(ctx, A, s, pB, 1, jpeg);
  attempts.push(classify('token', 'write-other', 'denied', other));
  if (s.partUrl === ROUTES.upload) {
    const list = await A.client.get(`${ROUTES.parts}?${new URLSearchParams({ uploadId: pB.uploadId, key: pB.rawKey })}`, {
      route: ROUTES.parts, headers: { authorization: `CA-Upload ${s.token}` }, expect: [200],
    });
    attempts.push(classify('token', 'list-other', 'denied', { status: list.status, ...(errorCode(list) ? { code: errorCode(list)! } : {}) }));
  } else {
    attempts.push(classify('token', 'list-other', 'denied', null, 'storage=s3：前缀令牌没有列出能力（分片状态由 S3 维护，后端只为本人的照片签名）'));
  }
  const del = await A.client.del(ROUTES.photo.replace(':id', encodeURIComponent(pB.photoId)), { route: ROUTES.photo, expect: [200, 204] });
  attempts.push(classify('token', 'delete-other', 'denied', { status: del.status, ...(errorCode(del) ? { code: errorCode(del)! } : {}) }, '应用的删除接口按照片主人校验'));
  return {
    attempts,
    evidence: {
      otherPhotoStatus: await serverPhotoStatus(ctx, pB.photoId),
      prefix: s.prefix,
      tokenTtlHint: '令牌本身只有本应用认识；撤销靠应用（jti 黑名单）',
    },
  };
}

async function stsMode(ctx: ScenarioContext, A: UserSession, B: UserSession, jpeg: Buffer): Promise<{ attempts: Attempt[]; evidence: Record<string, unknown> }> {
  const ca = await getCredentials(A);
  const cb = await getCredentials(B);
  if (!ca.creds || !cb.creds) throw new Error(`GET /api/uploads/credentials 失败：A HTTP ${ca.res.status} / B HTTP ${cb.res.status}（identity-pool 未启用，或缺少 ID 令牌）`);
  const s3A = new StsS3(ctx, ca.creds);
  const s3B = new StsS3(ctx, cb.creds);
  const tag = ctx.runId.slice(-8).toLowerCase();
  const ownKey = `${ca.creds.prefix}cross-prefix-${tag}.jpg`;
  const otherKey = `${cb.creds.prefix}cross-prefix-from-a-${tag}.jpg`;
  const targetKey = `${cb.creds.prefix}cross-prefix-target-${tag}.jpg`;
  const attempts: Attempt[] = [];
  attempts.push(classify('sts', 'write-own', 'allowed', s3r(await s3A.putObject(ownKey, jpeg))));
  attempts.push(classify('sts', 'list-own', 'allowed', s3r(await s3A.listBucket(ca.creds.prefix))));
  const target = await s3B.putObject(targetKey, jpeg);   // B 在自己的前缀里放一个对象，作为“删除别人的对象”的目标
  attempts.push(classify('sts', 'write-other', 'denied', s3r(await s3A.putObject(otherKey, jpeg))));
  attempts.push(classify('sts', 'list-root', 'denied', s3r(await s3A.listBucket())));
  attempts.push(classify('sts', 'delete-other', 'denied', s3r(await s3A.deleteObject(targetKey)), target.ok ? undefined : `B 没能放置目标对象（HTTP ${target.status}）`));
  return {
    attempts,
    evidence: {
      identityA: ca.creds.identityId,
      identityB: cb.creds.identityId,
      accessKeyPrefix: `${ca.creds.accessKeyId.slice(0, 4)}…`,
      credentialsExpireAt: ca.creds.expiration,
      // 服务端确认：A 自己的对象落地了；写到 B 前缀的对象不存在；B 的对象没有被 A 删掉
      ownObjectExists: await stagingExists(ctx, ownKey),
      crossObjectExists: await stagingExists(ctx, otherKey),
      targetStillExists: await stagingExists(ctx, targetKey),
      cleanup: '暂存桶的生命周期规则 1 天后删除这些对象（Uploader 角色没有 DeleteObject 权限）',
    },
  };
}

export default defineScenario({
  warmupWithRun: false,
  async run(ctx) {
    const mode = modeOf(ctx);
    const { accounts, source } = loadAccounts(ctx);
    ctx.finding('mode', mode);
    ctx.finding('usersSource', source);
    if (accounts.length < 2) {
      ctx.note('需要两个测试用户：--param users=<文件>（[{email,password}] 或 email,password），或在平台工作台设置 CLOUDALBUM_TEST_USERS_PARAM');
      ctx.finding('error', 'need-two-users');
      return;
    }
    const A = await loginUser(ctx, accounts[0]!);
    const B = await loginUser(ctx, accounts[1]!);
    const jpeg = (await testJpeg({ width: 64, height: 48 })).buffer;
    const r = mode === 'sts' ? await stsMode(ctx, A, B, jpeg) : await tokenMode(ctx, A, B, jpeg);
    const sum = summarize(r.attempts);
    ctx.finding('attempts', r.attempts);
    ctx.finding('deniedByApplication', sum.deniedByApplication);
    ctx.finding('deniedByS3', sum.deniedByS3);
    ctx.finding('unexpected', sum.unexpected);
    ctx.finding('allowedOwn', sum.allowedOwn);
    ctx.finding('serverEvidence', r.evidence);
    ctx.business('denied_by_app', sum.deniedByApplication);
    ctx.business('denied_by_s3', sum.deniedByS3);
    ctx.business('unexpected', sum.unexpected);
    if (sum.unexpected) ctx.note(`有 ${sum.unexpected} 次尝试与预期不符：检查 Uploader 角色的策略（策略变量）或应用的前缀校验`);
  },
});
