/**
 * iam/aws-ping —— 低速持续调用 `GET /api/lab/aws-ping`（02#iam 第 5 节步骤 4、6；long-run 与 revoke 两个实验共用）。
 *
 *   npm run exp -- iam --label after --scenario long-run --duration 6h
 *   npm run exp -- iam --label after --scenario revoke                  # 第 60 秒提示人工 Revoke sessions
 *
 * aws-ping 是 iam 模块的管理员接口：内部同时调用 GetCallerIdentity 与 iam:GetRole，分别报告两列结果
 * （响应约定 `{ sts: { ok, error? }, iam: { ok, error? } }`）。脚本按列记录首次失败、恢复时刻与失败区间。
 * 端点不存在（404 / 501）时记录并结束。
 */
import { runRate } from '../_lib/load.js';
import { defineScenario, numParam } from '../_lib/scenario.js';

const ENDPOINT = '/api/lab/aws-ping';

interface Column { ok: number; fail: number; firstFailAtMs?: number; recoveredAtMs?: number; lastError?: string; failing: boolean }

function newColumn(): Column {
  return { ok: 0, fail: 0, failing: false };
}

function track(c: Column, ok: boolean, atMs: number, error?: string): void {
  if (ok) {
    c.ok += 1;
    if (c.failing) {
      c.failing = false;
      c.recoveredAtMs = atMs;
    }
    return;
  }
  c.fail += 1;
  if (!c.failing) c.failing = true;
  c.firstFailAtMs ??= atMs;
  if (error) c.lastError = error.slice(0, 200);
}

export default defineScenario({
  warmupWithRun: false,
  async run(ctx) {
    const probe = await ctx.client.get(ENDPOINT, { record: false, expect: [200, 404, 501, 502, 503] });
    if (probe.status === 404 || probe.status === 501) {
      ctx.note(`${ENDPOINT} 不可用（${probe.status}）：iam 模块的 aws-ping 端点尚未实现`);
      ctx.finding('endpointAvailable', false);
      return;
    }
    const columns = { sts: newColumn(), iam: newColumn() };
    let requests = 0;
    let errors = 0;
    await runRate({ ratePerSec: numParam(ctx, 'rps', 1), durationMs: ctx.durationMs, signal: ctx.signal, maxInFlight: 4 }, async () => {
      const at = Math.round(ctx.elapsedMs());
      const res = await ctx.client.get(ENDPOINT, { route: ENDPOINT, expect: [200, 502, 503], timeoutMs: 15_000 });
      requests += 1;
      let body: { sts?: { ok?: boolean; error?: string }; iam?: { ok?: boolean; error?: string } } = {};
      try {
        body = res.json();
      } catch {
        /* 非 JSON */
      }
      const sts = body.sts?.ok ?? res.status === 200;
      const iam = body.iam?.ok ?? res.status === 200;
      if (!sts || !iam || res.status !== 200) errors += 1;
      track(columns.sts, sts, at, body.sts?.error);
      track(columns.iam, iam, at, body.iam?.error);
    });
    ctx.finding('endpointAvailable', true);
    ctx.finding('requests', requests);
    ctx.finding('errors', errors);
    for (const [k, c] of Object.entries(columns)) {
      const { failing, ...rest } = c;
      ctx.finding(k, { ...rest, failingAtEnd: failing });
    }
  },
});
