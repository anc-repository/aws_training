/**
 * database/failover —— 故障转移（03#database 第 5 节步骤 3；failover-probe）。
 *
 *   npm run exp -- database --label after  --scenario failover      # 第 30 秒 faults/rds-failover.sh（运维机，部署者凭证）
 *   npm run exp -- database --label before --scenario failover --fault-via ssh --ssh ec2-user@<EIP>
 *
 * 每 intervalMs（默认 200 ms）“写一行再读回”：建一个私有相册 → 读回 → 删除。三步都成功才算一次成功。
 * 连续失败合并为一个失败区间，输出最长中断时长、首次失败与恢复时刻（相对测量开始）。
 */
import { ROUTES } from '../_lib/app.js';
import { defineScenario, numParam } from '../_lib/scenario.js';
import { sleep } from '../_lib/util.js';

interface Attempt { at: number; ok: boolean; status: number; ms: number }

export function outageWindows(attempts: readonly Attempt[]): Array<{ startMs: number; endMs: number; durationMs: number; failures: number }> {
  const out: Array<{ startMs: number; endMs: number; durationMs: number; failures: number }> = [];
  let cur: { startMs: number; endMs: number; failures: number } | undefined;
  for (const a of attempts) {
    if (!a.ok) {
      if (!cur) cur = { startMs: a.at, endMs: a.at + a.ms, failures: 0 };
      cur.failures += 1;
      cur.endMs = a.at + a.ms;
    } else if (cur) {
      out.push({ ...cur, endMs: a.at, durationMs: Math.round(a.at - cur.startMs) });
      cur = undefined;
    }
  }
  if (cur) out.push({ ...cur, durationMs: Math.round(cur.endMs - cur.startMs) });
  return out;
}

export default defineScenario({
  warmupWithRun: false,
  async run(ctx) {
    const intervalMs = numParam(ctx, 'intervalMs', 200);
    const attempts: Attempt[] = [];
    let n = 0;
    while (ctx.remainingMs() > 0 && !ctx.signal.aborted) {
      const at = ctx.elapsedMs();
      n += 1;
      let ok = false;
      let status = 0;
      const created = await ctx.client.post(ROUTES.albums, { route: ROUTES.albums, json: { title: `failover-probe ${ctx.runId.slice(-6)} #${n}`, visibility: 'private' }, timeoutMs: 10_000 });
      status = created.status;
      if (created.ok) {
        const id = created.json<{ id?: string }>().id;
        if (id) {
          const read = await ctx.client.get(`/api/albums/${id}`, { route: ROUTES.album, timeoutMs: 10_000 });
          status = read.status;
          const del = await ctx.client.del(`/api/albums/${id}`, { route: ROUTES.album, timeoutMs: 10_000 });
          if (!del.ok) ctx.cleanupLater('DELETE', `/api/albums/${id}`);
          ok = read.ok;
        }
      }
      const ms = ctx.elapsedMs() - at;
      attempts.push({ at: Math.round(at), ok, status, ms: Math.round(ms) });
      await sleep(Math.max(0, intervalMs - ms), ctx.signal);
    }
    const windows = outageWindows(attempts);
    const failures = attempts.filter((a) => !a.ok).length;
    const longest = windows.reduce((m, w) => Math.max(m, w.durationMs), 0);
    ctx.finding('attempts', attempts.length);
    ctx.finding('failures', failures);
    ctx.finding('windows', windows);
    ctx.finding('longestOutageMs', longest);
    ctx.finding('firstFailureAtMs', windows[0]?.startMs);
    ctx.finding('recoveredAtMs', windows.length ? windows[windows.length - 1]!.endMs : undefined);
    const statuses: Record<string, number> = {};
    for (const a of attempts.filter((x) => !x.ok)) statuses[String(a.status)] = (statuses[String(a.status)] ?? 0) + 1;
    ctx.finding('failureStatuses', statuses);
    ctx.business('writeOutageMs', longest);
  },
});
