/**
 * auth/token-claims —— Token 声明对照（02#auth 第 5 节步骤 7；也是 /lab/auth 卡片 Token 查看器的命令行版）。
 *
 *   npm run exp -- auth --label before --scenario token-claims
 *   npm run exp -- auth --label after  --scenario token-claims --param user=alice@example.test:****
 *
 * 不校验签名地解码 access token：local 为 alg=ES256、iss=https://<host>；cognito 为 alg=RS256、iss=https://cognito-idp…，
 * 带 token_use、client_id、cognito:groups。再取 JWKS（local：/.well-known/jwks.json；cognito：<iss>/.well-known/jwks.json）
 * 统计密钥数量与算法。只输出声明的名称与非敏感值，不输出令牌本身，主体（sub）只保留前 8 位。
 */
import { decodeJwt } from '../_lib/app.js';
import { defineScenario, strParam } from '../_lib/scenario.js';
import { authDriver, login, parseAccount } from './accounts.js';

export default defineScenario({
  warmupWithRun: false,
  async run(ctx) {
    const driver = authDriver(ctx);
    let token = ctx.client.token;
    let source = 'runner-admin-token';
    const spec = strParam(ctx, 'user', '');
    if (spec) {
      const account = parseAccount(spec);
      if (!account) throw new Error('--param user 需要 email:password');
      const r = await login(ctx, account);
      if (!r.token) {
        ctx.note(`登录失败：${r.error ?? r.res.status}`);
        return;
      }
      token = r.token;
      source = 'login';
    }
    if (!token) {
      ctx.note('没有可检查的令牌');
      return;
    }
    const jwt = decodeJwt(token);
    if (!jwt) {
      ctx.note('令牌不是 JWT（无法解码）');
      return;
    }
    const { header, payload } = jwt;
    const groups = payload['cognito:groups'] ?? payload.groups ?? payload.roles;
    const iat = typeof payload.iat === 'number' ? payload.iat : undefined;
    const exp = typeof payload.exp === 'number' ? payload.exp : undefined;
    ctx.finding('driver', driver);
    ctx.finding('source', source);
    ctx.finding('header', { alg: header.alg, kid: typeof header.kid === 'string' ? `${header.kid.slice(0, 12)}…` : header.kid, typ: header.typ });
    ctx.finding('claims', {
      iss: payload.iss, aud: payload.aud, token_use: payload.token_use, client_id: payload.client_id, scope: payload.scope,
      groups, plan: payload.plan ?? payload['custom:plan'], tv: payload.tv,
      sub: typeof payload.sub === 'string' ? `${payload.sub.slice(0, 8)}…` : undefined,
      names: Object.keys(payload).sort(),
    });
    ctx.finding('lifetimeSec', iat !== undefined && exp !== undefined ? exp - iat : undefined);
    const iss = typeof payload.iss === 'string' ? payload.iss : '';
    const jwksUrl = /cognito-idp\./.test(iss) ? `${iss}/.well-known/jwks.json` : `${ctx.target}/.well-known/jwks.json`;
    const jwksClient = ctx.http(new URL(jwksUrl).origin, { target: /cognito-idp\./.test(jwksUrl) ? 'cognito' : 'direct', auth: false, experiment: false });
    const jwks = await jwksClient.get(jwksUrl, { route: '/.well-known/jwks.json' });
    if (jwks.ok) {
      const keys = jwks.json<{ keys?: Array<{ kid?: string; alg?: string; kty?: string }> }>().keys ?? [];
      ctx.finding('jwks', {
        url: jwksUrl, keys: keys.length, algs: [...new Set(keys.map((k) => k.alg ?? k.kty))],
        matchesKid: keys.some((k) => k.kid === header.kid), cacheControl: jwks.headers['cache-control'] ?? null,
      });
    } else {
      ctx.finding('jwks', { url: jwksUrl, status: jwks.status });
    }
  },
});
