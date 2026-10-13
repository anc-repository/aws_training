import { describe, expect, it, vi } from 'vitest';
import { createMemoryBroadcast } from '../lib/broadcast';
import { fakeFetch, json } from '../test/helpers';
import { AuthService, devToken, safeNext } from './authService';
import { authorizeUrl, logoutUrl, pkceChallenge } from './cognito';
import { authModeOf, isLocalDevHost, loadConfig } from './config';
import { principalFromToken, roleOf } from './jwt';

function b64url(o: unknown): string {
  return btoa(JSON.stringify(o)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
function jwt(payload: Record<string, unknown>): string {
  return `${b64url({ alg: 'RS256' })}.${b64url(payload)}.sig`;
}

const COGNITO = { apiBase: '/api/v1', clientId: 'client123', domain: 'atl-1a2b3c4d.auth.ap-northeast-1.amazoncognito.com', redirectUri: 'https://lab.example.test/auth/callback', logoutUri: 'https://lab.example.test/' };

function loc(hostname = 'lab.example.test') {
  return { origin: `https://${hostname}`, hostname, assign: vi.fn() };
}

describe('config.json and auth mode (01 §10.6)', () => {
  it('dev tokens only on local development hosts', () => {
    expect(isLocalDevHost('localhost')).toBe(true);
    expect(isLocalDevHost('[::1]')).toBe(true);
    expect(isLocalDevHost('atl.localhost')).toBe(true);
    expect(isLocalDevHost('d111.cloudfront.net')).toBe(false);
    expect(authModeOf({ apiBase: '/api/v1', auth: 'dev' }, '127.0.0.1')).toBe('dev');
    expect(authModeOf({ apiBase: '/api/v1', auth: 'dev' }, 'd111.cloudfront.net')).toBeNull();
    expect(authModeOf(COGNITO, 'd111.cloudfront.net')).toBe('cognito');
  });

  it('loads /config.json without caching and defaults apiBase', async () => {
    const f = fakeFetch({ 'GET /config.json': json(200, { domain: 'x', clientId: 'y' }) });
    expect((await loadConfig(f.impl)).apiBase).toBe('/api/v1');
  });
});

describe('access token claims (01 §5.2, §5.3)', () => {
  it('Cognito JWT → groups, role precedence, auth_time, exp', () => {
    const p = principalFromToken(jwt({ sub: 'u1', 'cognito:groups': ['observer', 'assistant'], auth_time: 1_700_000_000, exp: 1_700_003_600, username: 'zhang' }))!;
    expect([p.sub, p.role, p.authTime, p.expiresAt, p.username]).toEqual(['u1', 'A', 1_700_000_000, 1_700_003_600_000, 'zhang']);
    expect(principalFromToken(jwt({ sub: 'u2' }))!.role).toBeNull();
    expect(roleOf(['assistant', 'learner'])).toBe('L');
    expect(principalFromToken('garbage')).toBeNull();
  });

  it('dev tokens follow the dev-server format dev.<group>.<sub>[.<authTime>]', () => {
    expect(devToken('learner', 'u1')).toBe('dev.learner.u1');
    const p = principalFromToken('dev.observer.ta1.1700000000')!;
    expect([p.role, p.sub, p.authTime, p.expiresAt]).toEqual(['O', 'ta1', 1_700_000_000, null]);
  });
});

describe('Cognito hosted login (P01, PKCE)', () => {
  it('authorize / logout URLs carry client, redirect, state and the S256 challenge', async () => {
    const challenge = await pkceChallenge('dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk');
    expect(challenge).toBe('E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM'); // RFC 7636 附录 B
    const u = new URL(authorizeUrl(COGNITO, { state: 'st', challenge }));
    expect(u.origin + u.pathname).toBe('https://atl-1a2b3c4d.auth.ap-northeast-1.amazoncognito.com/oauth2/authorize');
    expect(Object.fromEntries(u.searchParams)).toMatchObject({ response_type: 'code', client_id: 'client123', redirect_uri: COGNITO.redirectUri, state: 'st', code_challenge_method: 'S256' });
    expect(new URL(logoutUrl(COGNITO)).searchParams.get('logout_uri')).toBe('https://lab.example.test/');
  });

  it('beginLogin stores the request; completeLogin checks state, exchanges the code and only allows on-site next', async () => {
    const access = jwt({ sub: 'u1', 'cognito:groups': ['learner'], auth_time: 1, exp: 9_999_999_999 });
    const f = fakeFetch({ 'POST https://atl-1a2b3c4d.auth.ap-northeast-1.amazoncognito.com/oauth2/token': json(200, { access_token: access, refresh_token: 'r1', expires_in: 3600 }) });
    const l = loc();
    const auth = new AuthService({ config: COGNITO, fetchImpl: f.impl, location: l, channel: null });
    await auth.beginLogin('/labs/svc-cdn?start=1');
    const url = new URL(l.assign.mock.calls[0]![0] as string);
    const state = url.searchParams.get('state')!;
    expect((await auth.completeLogin(new URLSearchParams({ code: 'c', state: 'other' }))).result).toBe('stale');
    await auth.beginLogin('//evil.example/');
    const state2 = new URL(l.assign.mock.calls[1]![0] as string).searchParams.get('state')!;
    expect(state2).not.toBe(state);
    const r = await auth.completeLogin(new URLSearchParams({ code: 'c', state: state2 }));
    expect(r).toEqual({ result: 'ok', next: '/' });
    expect(f.calls[0]!.body).toContain('grant_type=authorization_code');
    expect(f.calls[0]!.body).toContain('code_verifier=');
    expect(auth.getSnapshot()).toMatchObject({ status: 'authenticated', principal: { role: 'L' } });
    expect(sessionStorage.getItem('atl.auth.refresh.v1')).toBe('"r1"');
    expect(await auth.getAccessToken()).toBe(access);
    expect((await auth.completeLogin(new URLSearchParams({ error: 'access_denied', error_description: '用户取消' })))).toEqual({ result: 'error', error: '用户取消' });
  });

  it('safeNext rejects open redirects and auth pages', () => {
    expect(safeNext('/labs?view=map')).toBe('/labs?view=map');
    for (const bad of ['https://evil', '//evil', '/\\evil', '/login?next=/x', '/auth/callback', null]) expect(safeNext(bad, '/')).toBe('/');
  });
});

describe('AuthService session lifecycle', () => {
  it('init(): silent refresh with the stored refresh token; failure → anonymous with hadSession', async () => {
    sessionStorage.setItem('atl.auth.refresh.v1', JSON.stringify('r-old'));
    const f = fakeFetch({ 'POST https://atl-1a2b3c4d.auth.ap-northeast-1.amazoncognito.com/oauth2/token': json(400, { error: 'invalid_grant' }) });
    const auth = new AuthService({ config: COGNITO, fetchImpl: f.impl, location: loc(), channel: null });
    const s = await auth.init();
    expect(s).toMatchObject({ status: 'anonymous', hadSession: true, expired: false });
    expect(sessionStorage.getItem('atl.auth.refresh.v1')).toBeNull();
  });

  it('dev mode: devLogin, refresh keeps the identity, stale auth_time simulates REAUTH, sign-out broadcasts to other tabs', async () => {
    const factory = createMemoryBroadcast();
    const l1 = loc('127.0.0.1');
    const a1 = new AuthService({ config: { apiBase: '/api/v1', auth: 'dev' }, location: l1, channel: factory('atl-auth'), nowMs: () => 1_800_000_000_000 });
    const a2 = new AuthService({ config: { apiBase: '/api/v1', auth: 'dev' }, location: loc('127.0.0.1'), channel: factory('atl-auth') });
    expect(a1.mode).toBe('dev');
    a1.devLogin('learner', 'u1', { staleAuth: true });
    expect(await a1.getAccessToken()).toBe(`dev.learner.u1.${1_800_000_000 - 61 * 60}`);
    expect(await a1.refresh()).toBe(true);
    expect(await a1.getAccessToken()).toMatch(/^dev\.learner\.u1\.\d+$/);
    a2.devLogin('assistant', 'ta1');
    await a1.signOut();
    await new Promise((r) => setTimeout(r, 0));
    expect(l1.assign).toHaveBeenCalledWith('/auth/signed-out');
    expect(a1.getSnapshot().status).toBe('anonymous');
    expect(a2.getSnapshot()).toMatchObject({ status: 'anonymous', signedOutElsewhere: true });
  });

  it('dev login is refused outside dev mode', () => {
    const auth = new AuthService({ config: COGNITO, location: loc(), channel: null });
    expect(() => auth.devLogin('learner', 'u1')).toThrow(/dev mode/);
  });

  it('a failed refresh while signed in marks the session expired instead of dropping the page (P13 #5)', async () => {
    const f = fakeFetch({ 'POST https://atl-1a2b3c4d.auth.ap-northeast-1.amazoncognito.com/oauth2/token': json(400, { error: 'invalid_grant' }) });
    const auth = new AuthService({ config: COGNITO, fetchImpl: f.impl, location: loc(), channel: null });
    // 模拟已登录
    const access = jwt({ sub: 'u1', 'cognito:groups': ['learner'], exp: 1 });
    (auth as unknown as { accept(t: string): boolean }).accept(access);
    sessionStorage.setItem('atl.auth.refresh.v1', JSON.stringify('r1'));
    expect(await auth.refresh()).toBe(false);
    expect(auth.getSnapshot()).toMatchObject({ status: 'authenticated', expired: true });
    expect(await auth.getAccessToken()).toBeNull();
  });
});
