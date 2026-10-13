/**
 * auth/brute-force —— 暴力破解（02#auth 第 5 节步骤 4）。
 *
 *   npm run exp -- auth --label before --scenario brute-force --param email=victim@example.test
 *   npm run exp -- auth --label after  --scenario brute-force --param email=victim@example.test
 *
 * 对测试账号连续提交 attempts 次错误密码（间隔 intervalMs），记录响应码序列（local：401 → 423 锁定 / 429 限速；
 * cognito：400 NotAuthorizedException → “Password attempts exceeded”）。不要对管理员账号运行。
 */
import { defineScenario, numParam, strParam } from '../_lib/scenario.js';
import { sleep } from '../_lib/util.js';
import { authDriver, login } from './accounts.js';

/** 响应码序列压缩：[401,401,401,423] → "401×3, 423×1" */
export function runLength(codes: readonly string[]): string {
  const out: string[] = [];
  let prev: string | undefined;
  let n = 0;
  for (const c of [...codes, '\u0000']) {
    if (c === prev) {
      n += 1;
      continue;
    }
    if (prev !== undefined) out.push(`${prev}×${n}`);
    prev = c;
    n = 1;
  }
  return out.join(', ');
}

export default defineScenario({
  warmupWithRun: false,
  async run(ctx) {
    const email = strParam(ctx, 'email', 'victim@example.test');
    if (ctx.credentials && email.toLowerCase() === ctx.credentials.email.toLowerCase()) {
      throw new Error('不要对运行器自己的管理员账号做暴力破解实验（会被锁定）：用 --param email=<测试账号>');
    }
    const attempts = numParam(ctx, 'attempts', 30);
    const intervalMs = numParam(ctx, 'intervalMs', 200);
    const codes: string[] = [];
    let firstReject: number | undefined;
    let accepted = 0;
    for (let i = 1; i <= attempts && !ctx.signal.aborted && ctx.remainingMs() > 0; i += 1) {
      const r = await login(ctx, { email, password: `wrong-${ctx.runId.slice(-6)}-${i}` }, [200, 400, 401, 403, 423, 429]);
      const code = r.error && r.res.status === 400 ? `400:${r.error.split('#').pop()}` : String(r.res.status);
      codes.push(code);
      if (r.token) accepted += 1;
      if (firstReject === undefined && (r.res.status === 423 || r.res.status === 429 || /LimitExceeded|attempts exceeded/i.test(r.error ?? ''))) firstReject = i;
      await sleep(intervalMs, ctx.signal);
    }
    ctx.finding('driver', authDriver(ctx));
    ctx.finding('sequence', runLength(codes));
    ctx.finding('firstRejectAttempt', firstReject);
    ctx.finding('accepted', accepted);
    ctx.finding('attempts', codes.length);
  },
});
