/**
 * auth/accounts —— 测试账号与两种驱动的登录方式（auth 实验共用）。
 *
 * - local：`POST /api/auth/login`（令牌在 Set-Cookie `ca_at`）。
 * - cognito：总纲 4.2 规定 cognito 的 flows = null（浏览器经 Amplify 直连 User Pool），这里用 User Pool 的公开接口
 *   `InitiateAuth`（USER_PASSWORD_AUTH，不需要 AWS 凭证、不需要 SDK）模拟浏览器登录；App Client 必须允许该流程。
 *   只在学员运行实验时调用，测试中从不调用。
 */
import { readFileSync } from 'node:fs';
import { loginLocal, parseUsersCsv, ROUTES } from '../_lib/app.js';
import type { ExpResponse } from '../_lib/http.js';
import type { ScenarioContext } from '../_lib/scenario.js';
import { strParam } from '../_lib/scenario.js';

export interface Account { email: string; password: string }

export function authDriver(ctx: ScenarioContext): 'local' | 'cognito' {
  return ctx.capabilities.modules?.auth?.driver === 'cognito' ? 'cognito' : 'local';
}

/** `--param users=<csv>` > EXP_USERS_FILE > 管理员凭据。 */
export function loadAccounts(ctx: ScenarioContext): { accounts: Account[]; source: string } {
  const file = strParam(ctx, 'users', '') || process.env.EXP_USERS_FILE || '';
  if (file) {
    const accounts = parseUsersCsv(readFileSync(file, 'utf8'));
    if (!accounts.length) throw new Error(`${file} 中没有账号（每行 email,password）`);
    return { accounts, source: file };
  }
  if (ctx.credentials) return { accounts: [ctx.credentials], source: 'admin' };
  return { accounts: [], source: 'none' };
}

/** `email:password`（`--param user=`）。 */
export function parseAccount(spec: string): Account | undefined {
  const i = spec.indexOf(':');
  if (i <= 0) return undefined;
  return { email: spec.slice(0, i), password: spec.slice(i + 1) };
}

export interface LoginResult { res: ExpResponse; token?: string; idToken?: string; refreshToken?: string; error?: string }

export function cognitoConfig(ctx: ScenarioContext): { region: string; clientId: string; userPoolId?: string } | undefined {
  const pub = (ctx.capabilities.modules?.auth?.public ?? {}) as Record<string, unknown>;
  const clientId = typeof pub.userPoolClientId === 'string' ? pub.userPoolClientId : undefined;
  const userPoolId = typeof pub.userPoolId === 'string' ? pub.userPoolId : undefined;
  const region = typeof pub.region === 'string' ? pub.region : userPoolId?.split('_')[0];
  return clientId && region ? { region, clientId, ...(userPoolId ? { userPoolId } : {}) } : undefined;
}

/** 调用 Cognito User Pool 的公开 JSON API（InitiateAuth / GlobalSignOut 等，不签名）。 */
export async function cognitoCall(ctx: ScenarioContext, region: string, action: string, body: unknown, expect: number[] = [200]): Promise<ExpResponse> {
  const client = ctx.http(`https://cognito-idp.${region}.amazonaws.com`, { target: 'cognito', auth: false, experiment: false });
  return client.post('/', {
    route: `cognito:${action}`,
    headers: { 'content-type': 'application/x-amz-json-1.1', 'x-amz-target': `AWSCognitoIdentityProviderService.${action}` },
    body: JSON.stringify(body),
    expect,
  });
}

export async function login(ctx: ScenarioContext, account: Account, expect?: number[]): Promise<LoginResult> {
  if (authDriver(ctx) === 'local') {
    const r = await loginLocal(ctx.client, account.email, account.password, { route: ROUTES.login, ...(expect ? { expect } : {}) });
    return { res: r.res, ...(r.token ? { token: r.token } : {}), ...(r.mfa ? { error: 'mfa_required' } : {}) };
  }
  const cfg = cognitoConfig(ctx);
  if (!cfg) throw new Error('capabilities 中没有 auth 的 userPoolClientId / region');
  const res = await cognitoCall(ctx, cfg.region, 'InitiateAuth', {
    AuthFlow: 'USER_PASSWORD_AUTH', ClientId: cfg.clientId, AuthParameters: { USERNAME: account.email, PASSWORD: account.password },
  }, expect);
  if (!res.ok) {
    let type: string | undefined;
    try {
      type = res.json<{ __type?: string }>().__type;
    } catch {
      /* 非 JSON */
    }
    return { res, error: type ?? `HTTP ${res.status}` };
  }
  const ar = res.json<{ AuthenticationResult?: { AccessToken?: string; IdToken?: string; RefreshToken?: string }; ChallengeName?: string }>();
  if (!ar.AuthenticationResult) return { res, error: ar.ChallengeName ?? 'no AuthenticationResult' };
  return {
    res, ...(ar.AuthenticationResult.AccessToken ? { token: ar.AuthenticationResult.AccessToken } : {}),
    ...(ar.AuthenticationResult.IdToken ? { idToken: ar.AuthenticationResult.IdToken } : {}),
  };
}
