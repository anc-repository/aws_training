/**
 * Cognito 托管登录（01 §5.1：授权码 + PKCE，公共客户端 `atl-web`；08 P01）。SPA 不接触密码。
 * 端点不属于 /api/v1：`https://<domain>/oauth2/authorize`、`/oauth2/token`、`/oauth2/revoke`、`/logout`（以官方文档为准）。
 * 01 §10.6 的 CSP 已为托管登录域名放开 connect-src 与 form-action。
 */
import type { PlatformConfigJson } from './config';

export interface TokenSet {
  accessToken: string;
  idToken?: string;
  refreshToken?: string;
  expiresIn?: number;
}

const SCOPES = 'openid email profile';

function origin(cfg: PlatformConfigJson): string {
  const d = cfg.domain ?? '';
  return d.startsWith('https://') ? d.replace(/\/+$/, '') : `https://${d}`;
}

export function redirectUriOf(cfg: PlatformConfigJson, loc: Pick<Location, 'origin'> = globalThis.location): string {
  return cfg.redirectUri ?? `${loc.origin}/auth/callback`;
}

export function logoutUriOf(cfg: PlatformConfigJson, loc: Pick<Location, 'origin'> = globalThis.location): string {
  return cfg.logoutUri ?? `${loc.origin}/auth/signed-out`;
}

function base64Url(bytes: Uint8Array): string {
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function randomUrlSafe(byteLength = 32): string {
  const b = new Uint8Array(byteLength);
  globalThis.crypto.getRandomValues(b);
  return base64Url(b);
}

/** PKCE S256：code_challenge = base64url(SHA-256(code_verifier))。 */
export async function pkceChallenge(verifier: string): Promise<string> {
  const digest = await globalThis.crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier));
  return base64Url(new Uint8Array(digest));
}

export function authorizeUrl(cfg: PlatformConfigJson, p: { state: string; challenge: string }, loc?: Pick<Location, 'origin'>): string {
  const q = new URLSearchParams({
    response_type: 'code',
    client_id: cfg.clientId ?? '',
    redirect_uri: redirectUriOf(cfg, loc),
    scope: SCOPES,
    state: p.state,
    code_challenge_method: 'S256',
    code_challenge: p.challenge,
  });
  return `${origin(cfg)}/oauth2/authorize?${q.toString()}`;
}

export function logoutUrl(cfg: PlatformConfigJson, loc?: Pick<Location, 'origin'>): string {
  const q = new URLSearchParams({ client_id: cfg.clientId ?? '', logout_uri: logoutUriOf(cfg, loc) });
  return `${origin(cfg)}/logout?${q.toString()}`;
}

async function tokenRequest(cfg: PlatformConfigJson, form: Record<string, string>, fetchImpl: typeof fetch): Promise<TokenSet> {
  const res = await fetchImpl(`${origin(cfg)}/oauth2/token`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(form).toString(),
    credentials: 'omit',
  });
  if (!res.ok) throw new Error(`token endpoint: HTTP ${res.status}`);
  const j = (await res.json()) as { access_token?: string; id_token?: string; refresh_token?: string; expires_in?: number };
  if (!j.access_token) throw new Error('token endpoint: no access_token');
  return { accessToken: j.access_token, idToken: j.id_token, refreshToken: j.refresh_token, expiresIn: j.expires_in };
}

export function exchangeCode(cfg: PlatformConfigJson, code: string, verifier: string, fetchImpl: typeof fetch, loc?: Pick<Location, 'origin'>): Promise<TokenSet> {
  return tokenRequest(
    cfg,
    { grant_type: 'authorization_code', client_id: cfg.clientId ?? '', code, redirect_uri: redirectUriOf(cfg, loc), code_verifier: verifier },
    fetchImpl,
  );
}

export function refreshTokens(cfg: PlatformConfigJson, refreshToken: string, fetchImpl: typeof fetch): Promise<TokenSet> {
  return tokenRequest(cfg, { grant_type: 'refresh_token', client_id: cfg.clientId ?? '', refresh_token: refreshToken }, fetchImpl);
}

/** 退出时撤销刷新令牌（客户端启用了令牌撤销，01 §5.1）；失败不影响退出。 */
export async function revokeRefreshToken(cfg: PlatformConfigJson, refreshToken: string, fetchImpl: typeof fetch): Promise<void> {
  try {
    await fetchImpl(`${origin(cfg)}/oauth2/revoke`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ token: refreshToken, client_id: cfg.clientId ?? '' }).toString(),
      credentials: 'omit',
    });
  } catch {
    /* 忽略 */
  }
}
