/**
 * auth/revoke —— 登出后旧 access token 还能用多久（02#auth 第 5 节步骤 5）。
 *
 *   npm run exp -- auth --label before --scenario revoke --param user=alice@example.test:****
 *   npm run exp -- auth --label after  --scenario revoke --param user=alice@example.test:**** --duration 16m
 *
 * 登录 → 用令牌请求 GET /api/me（应 200）→ 登出（local：POST /api/auth/logout；cognito：GlobalSignOut）→ 每 intervalSec
 * 用旧令牌请求一次 GET /api/me，直到被拒绝（401）或时长用尽（cognito 的 access token 在过期前一直有效）。
 * 必须用测试账号：登出会让该账号的所有令牌失效。
 */
import { ROUTES } from '../_lib/app.js';
import { defineScenario, numParam, strParam } from '../_lib/scenario.js';
import { sleep } from '../_lib/util.js';
import { authDriver, cognitoCall, cognitoConfig, login, parseAccount } from './accounts.js';

export default defineScenario({
  warmupWithRun: false,
  async run(ctx) {
    const account = parseAccount(strParam(ctx, 'user', ''));
    if (!account) throw new Error('需要 --param user=<email:password>（测试账号，不能是运行器的管理员账号）');
    if (ctx.credentials && account.email.toLowerCase() === ctx.credentials.email.toLowerCase()) {
      throw new Error('revoke 会让该账号的全部令牌失效：请用测试账号，不要用运行器自己的管理员账号');
    }
    const driver = authDriver(ctx);
    const r = await login(ctx, account);
    if (!r.token) {
      ctx.note(`登录失败：${r.error ?? r.res.status}`);
      return;
    }
    const user = ctx.http(ctx.target, { token: r.token });
    const before = await user.get(ROUTES.me, { route: ROUTES.me });
    if (driver === 'local') {
      await user.post(ROUTES.logout, { route: ROUTES.logout, json: {}, expect: [200, 204] });
    } else {
      const cfg = cognitoConfig(ctx);
      if (cfg) await cognitoCall(ctx, cfg.region, 'GlobalSignOut', { AccessToken: r.token });
    }
    const loggedOutAt = Date.now();
    const intervalMs = numParam(ctx, 'intervalSec', 30) * 1000;
    const checks: Array<{ afterMs: number; status: number }> = [];
    let rejectedAfterMs: number | undefined;
    while (!ctx.signal.aborted) {
      const res = await user.get(ROUTES.me, { route: `${ROUTES.me} (revoked)`, expect: [200, 401] });
      const afterMs = Date.now() - loggedOutAt;
      checks.push({ afterMs, status: res.status });
      if (res.status === 401) {
        rejectedAfterMs = afterMs;
        break;
      }
      if (ctx.remainingMs() < intervalMs) break;
      await sleep(intervalMs, ctx.signal);
    }
    ctx.finding('driver', driver);
    ctx.finding('beforeLogoutStatus', before.status);
    ctx.finding('checks', checks);
    ctx.finding('rejected', rejectedAfterMs !== undefined ? 1 : 0);
    ctx.finding('rejectedAfterMs', rejectedAfterMs);
    ctx.finding('stillValidMs', rejectedAfterMs ?? checks[checks.length - 1]?.afterMs ?? 0);
  },
});
