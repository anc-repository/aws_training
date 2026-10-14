/**
 * tls/handshake —— TLS 握手耗时（01#tls 第 5 节步骤 3）。
 *
 *   npm run exp -- tls --label after --scenario handshake --param samples=20 --upload    # 在 4 个区域的 CloudShell 各跑一次（选做）
 *
 * 每个入口新建连接 samples 次，记录 TCP 连接耗时与 TLS 握手耗时（= curl 的 time_appconnect - time_connect），取中位数。
 * 远端区域经 CloudFront 时握手在附近边缘完成，数量级上从数百毫秒降到数十毫秒；从东京访问差别不大；ALB 不减少往返次数。
 */
import { defineScenario, numParam } from '../_lib/scenario.js';
import { median, round1 } from '../_lib/util.js';
import { inspectEntry, serverEvidence, tlsEntries } from './lib.js';

export default defineScenario({
  warmupWithRun: false,
  async run(ctx) {
    const samples = numParam(ctx, 'samples', 20);
    const entries = tlsEntries(ctx);
    const out: Record<string, unknown> = {};
    for (const e of entries) {
      const hs: number[] = [];
      const conn: number[] = [];
      let errors = 0;
      for (let i = 0; i < samples && !ctx.signal.aborted; i += 1) {
        const c = await inspectEntry(e, 8000);
        if (!c.ok || c.handshakeMs === undefined) { errors += 1; continue; }
        hs.push(c.handshakeMs);
        if (c.connectMs !== undefined) conn.push(c.connectMs);
      }
      out[e.entry] = { host: e.host, samples: hs.length, errors, handshakeP50: round1(median(hs)), connectP50: round1(median(conn)) };
    }
    ctx.finding('entries', out);
    const d = out.direct as { handshakeP50?: number } | undefined;
    const cdn = out.cdn as { handshakeP50?: number } | undefined;
    if (d?.handshakeP50 && cdn?.handshakeP50) ctx.finding('cdnVsDirectHandshakeRatio', Math.round((cdn.handshakeP50 / d.handshakeP50) * 1000) / 1000);
    ctx.finding('clientRegion', process.env.AWS_REGION ?? process.env.AWS_DEFAULT_REGION ?? 'local');
    ctx.finding('server', await serverEvidence(ctx));
  },
});
