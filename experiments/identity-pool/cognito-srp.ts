/**
 * identity-pool/cognito-srp —— 以 USER_SRP_AUTH 登录 Cognito User Pool（只用公开的 InitiateAuth / RespondToAuthChallenge，
 * 不需要 AWS 凭证、不需要 SDK）。
 *
 * 为什么不用 USER_PASSWORD_AUTH：auth 模块的 SPA 客户端只允许 SRP（infra/modules/auth.yaml 的 ExplicitAuthFlows），
 * 浏览器里的 Amplify 也是走 SRP。这里按 amazon-cognito-identity-js 的 AuthenticationHelper 实现同一套计算：
 *   N = RFC 3526 的 3072 位 MODP 素数，g = 2，k = H(PAD(N) | PAD(g))
 *   A = g^a mod N；u = H(PAD(A) | PAD(B))；x = H(PAD(salt) | H(poolName | userIdForSrp | ":" | password))
 *   S = (B − k·g^x)^(a + u·x) mod N；K = HKDF(ikm = PAD(S), salt = PAD(u), info = "Caldera Derived Key" | 0x01)[0..16)
 *   PASSWORD_CLAIM_SIGNATURE = Base64(HMAC-SHA256(K, poolName | userIdForSrp | SECRET_BLOCK | TIMESTAMP))
 * 只在学员运行实验时调用；单元测试用一个按同样公式实现的假服务端核对（experiments/test/identity-pool.test.ts）。
 */
import { createHash, createHmac, randomBytes } from 'node:crypto';

export const N_HEX = 'FFFFFFFFFFFFFFFFC90FDAA22168C234C4C6628B80DC1CD129024E088A67CC74020BBEA63B139B22514A08798E3404DD'
  + 'EF9519B3CD3A431B302B0A6DF25F14374FE1356D6D51C245E485B576625E7EC6F44C42E9A637ED6B0BFF5CB6F406B7ED'
  + 'EE386BFB5A899FA5AE9F24117C4B1FE649286651ECE45B3DC2007CB8A163BF0598DA48361C55D39A69163FA8FD24CF5F'
  + '83655D23DCA3AD961C62F356208552BB9ED529077096966D670C354E4ABC9804F1746C08CA18217C32905E462E36CE3B'
  + 'E39E772C180E86039B2783A2EC07A28FB5C55DF06F4C52C9DE2BCBF6955817183995497CEA956AE515D2261898FA0510'
  + '15728E5A8AAAC42DAD33170D04507A33A85521ABDF1CBA64ECFB850458DBEF0A8AEA71575D060C7DB3970F85A6E1E4C7'
  + 'ABF5AE8CDB0933D71E8C94E04A25619DCEE3D2261AD2EE6BF12FFA06D98A0864D87602733EC86A64521F2B18177B200C'
  + 'BBE117577A615D6C770988C0BAD946E208E24FA074E5AB3143DB5BFCE0FD108E4B82D120A93AD2CAFFFFFFFFFFFFFFFF';
export const N = BigInt(`0x${N_HEX}`);
export const G = 2n;

export function modPow(base: bigint, exp: bigint, mod: bigint): bigint {
  let result = 1n;
  let b = ((base % mod) + mod) % mod;
  let e = exp;
  while (e > 0n) {
    if (e & 1n) result = (result * b) % mod;
    b = (b * b) % mod;
    e >>= 1n;
  }
  return result;
}

/** amazon-cognito-identity-js 的 padHex：偶数长度；最高位为 1 时前补 00（按正数解释） */
export function padHex(v: bigint | string): string {
  let h = typeof v === 'string' ? v.toLowerCase().replace(/^0+(?=.)/, '') : v.toString(16);
  if (h.length % 2) h = `0${h}`;
  if (/^[89a-f]/.test(h)) h = `00${h}`;
  return h;
}

export function hexHash(hex: string): string {
  return createHash('sha256').update(Buffer.from(hex, 'hex')).digest('hex').padStart(64, '0');
}

export function hashUtf8(s: string): string {
  return createHash('sha256').update(s, 'utf8').digest('hex').padStart(64, '0');
}

export const K = BigInt(`0x${hexHash(`${padHex(N)}${padHex(G)}`)}`);

export function hkdf(ikm: Buffer, salt: Buffer): Buffer {
  const prk = createHmac('sha256', salt).update(ikm).digest();
  return createHmac('sha256', prk).update(Buffer.concat([Buffer.from('Caldera Derived Key', 'utf8'), Buffer.from([1])])).digest().subarray(0, 16);
}

/** "Tue Oct 14 5:03:09 UTC 2026"：日不补零，时分秒补零（与 amazon-cognito-identity-js 的 getNowString 一致） */
export function cognitoTimestamp(d: Date = new Date()): string {
  const days = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const p = (n: number) => String(n).padStart(2, '0');
  return `${days[d.getUTCDay()]} ${months[d.getUTCMonth()]} ${d.getUTCDate()} ${p(d.getUTCHours())}:${p(d.getUTCMinutes())}:${p(d.getUTCSeconds())} UTC ${d.getUTCFullYear()}`;
}

export interface SrpClientState { a: bigint; A: bigint }

export function srpStart(random: (n: number) => Buffer = randomBytes): SrpClientState {
  for (;;) {
    const a = BigInt(`0x${random(128).toString('hex')}`) % N;
    const A = modPow(G, a, N);
    if (a !== 0n && A % N !== 0n) return { a, A };
  }
}

export interface PasswordVerifierChallenge { SALT: string; SRP_B: string; SECRET_BLOCK: string; USER_ID_FOR_SRP: string }

/** PASSWORD_VERIFIER 的应答（ChallengeResponses） */
export function passwordVerifier(state: SrpClientState, challenge: PasswordVerifierChallenge, opts: { userPoolId: string; password: string; now?: Date }):
  { USERNAME: string; PASSWORD_CLAIM_SECRET_BLOCK: string; TIMESTAMP: string; PASSWORD_CLAIM_SIGNATURE: string } {
  const poolName = opts.userPoolId.split('_')[1] ?? '';
  const B = BigInt(`0x${challenge.SRP_B}`);
  if (B % N === 0n) throw new Error('SRP：服务端的 B 非法');
  const u = BigInt(`0x${hexHash(`${padHex(state.A)}${padHex(B)}`)}`);
  if (u === 0n) throw new Error('SRP：u = 0');
  const userId = challenge.USER_ID_FOR_SRP;
  const x = BigInt(`0x${hexHash(`${padHex(challenge.SALT)}${hashUtf8(`${poolName}${userId}:${opts.password}`)}`)}`);
  const base = (((B - K * modPow(G, x, N)) % N) + N) % N;
  const S = modPow(base, state.a + u * x, N);
  const key = hkdf(Buffer.from(padHex(S), 'hex'), Buffer.from(padHex(u), 'hex'));
  const timestamp = cognitoTimestamp(opts.now);
  const message = Buffer.concat([Buffer.from(poolName, 'utf8'), Buffer.from(userId, 'utf8'), Buffer.from(challenge.SECRET_BLOCK, 'base64'), Buffer.from(timestamp, 'utf8')]);
  return {
    USERNAME: userId, PASSWORD_CLAIM_SECRET_BLOCK: challenge.SECRET_BLOCK, TIMESTAMP: timestamp,
    PASSWORD_CLAIM_SIGNATURE: createHmac('sha256', key).update(message).digest('base64'),
  };
}

export interface CognitoTokens { accessToken: string; idToken: string; refreshToken?: string }

/** 发送一个 Cognito User Pool 的公开 JSON API 调用；返回 HTTP 状态与 JSON */
export type CognitoCall = (action: string, body: Record<string, unknown>) => Promise<{ status: number; json: Record<string, unknown> }>;

/** InitiateAuth(USER_SRP_AUTH) → RespondToAuthChallenge(PASSWORD_VERIFIER) → 令牌 */
export async function srpLogin(call: CognitoCall, opts: { userPoolId: string; clientId: string; username: string; password: string }): Promise<CognitoTokens> {
  const st = srpStart();
  const init = await call('InitiateAuth', { AuthFlow: 'USER_SRP_AUTH', ClientId: opts.clientId, AuthParameters: { USERNAME: opts.username, SRP_A: st.A.toString(16) } });
  if (init.status !== 200) throw new Error(`InitiateAuth 失败：HTTP ${init.status} ${String(init.json.__type ?? '')} ${String(init.json.message ?? '')}`.trim());
  if (init.json.ChallengeName !== 'PASSWORD_VERIFIER') throw new Error(`InitiateAuth 返回了不支持的挑战 ${String(init.json.ChallengeName)}`);
  const params = init.json.ChallengeParameters as PasswordVerifierChallenge;
  const responses = passwordVerifier(st, params, { userPoolId: opts.userPoolId, password: opts.password });
  const r = await call('RespondToAuthChallenge', { ChallengeName: 'PASSWORD_VERIFIER', ClientId: opts.clientId, ChallengeResponses: responses });
  if (r.status !== 200) throw new Error(`RespondToAuthChallenge 失败：HTTP ${r.status} ${String(r.json.__type ?? '')} ${String(r.json.message ?? '')}`.trim());
  const ar = r.json.AuthenticationResult as { AccessToken?: string; IdToken?: string; RefreshToken?: string } | undefined;
  if (!ar?.AccessToken || !ar.IdToken) {
    throw new Error(`登录需要额外的挑战 ${String(r.json.ChallengeName ?? '')}（例如 MFA / NEW_PASSWORD_REQUIRED）：实验用的测试用户不应开启 MFA`);
  }
  return { accessToken: ar.AccessToken, idToken: ar.IdToken, ...(ar.RefreshToken ? { refreshToken: ar.RefreshToken } : {}) };
}
