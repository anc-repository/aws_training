/**
 * auth/login-storm —— 登录压力（02#auth 第 5 节步骤 3、8）。
 *
 *   npm run exp -- auth --label before --scenario login-storm --param users=experiments/auth/users.csv
 *   npm run exp -- auth --label after  --scenario login-storm --param users=experiments/auth/users.csv
 *
 * VU 轮流用测试账号登录（local：POST /api/auth/login；cognito：InitiateAuth），成功后用拿到的 access token 请求一次
 * `GET /api/me`，从 Server-Timing 的 auth 项看令牌校验耗时（cognito 首次需要拉取 JWKS）。限速（429）、锁定（423）单独计数。
 * 登录请求不带管理员令牌，因此也不带实验头（服务端只对管理员接受 X-Experiment-*）；它们只出现在客户端统计里。
 */
import { ROUTES } from '../_lib/app.js';
import { runVus } from '../_lib/load.js';
import { boolParam, defineScenario } from '../_lib/scenario.js';
import { authDriver, loadAccounts, login } from './accounts.js';

export default defineScenario({
  warmupWithRun: false,
  async run(ctx) {
    const driver = authDriver(ctx);
    const { accounts, source } = loadAccounts(ctx);
    if (!accounts.length) {
      ctx.note('没有测试账号：用 --param users=<csv> 或 EXP_USERS_FILE（每行 email,password），或设置 CLOUDALBUM_ADMIN_EMAIL / PASSWORD');
      return;
    }
    if (source === 'admin') ctx.note('只有管理员一个账号：登录接口按“IP + 邮箱”限速，很快会出现 429；建议用 scripts/admin seed-users 生成的测试账号');
    const verify = boolParam(ctx, 'verify', true);
    const statuses: Record<string, number> = {};
    let ok = 0;
    let failures = 0;
    let rateLimited = 0;
    let locked = 0;
    await runVus({ vus: ctx.vus, durationMs: ctx.durationMs, signal: ctx.signal }, async (_vu, it) => {
      const account = accounts[(it - 1) % accounts.length]!;
      const r = await login(ctx, account, [200, 400, 401, 403, 423, 429]);
      statuses[String(r.res.status)] = (statuses[String(r.res.status)] ?? 0) + 1;
      if (r.res.status === 429) rateLimited += 1;
      if (r.res.status === 423) locked += 1;
      if (!r.token) {
        failures += 1;
        return;
      }
      ok += 1;
      if (verify) {
        const user = ctx.http(ctx.target, { token: r.token });
        await user.get(ROUTES.me, { route: ROUTES.me });
      }
    });
    ctx.finding('driver', driver);
    ctx.finding('accounts', { count: accounts.length, source: source === 'admin' ? 'admin' : 'csv' });
    ctx.finding('loginStatuses', statuses);
    ctx.finding('loginOk', ok);
    ctx.finding('loginFailures', failures);
    ctx.finding('rateLimited', rateLimited);
    ctx.finding('locked', locked);
  },
});
