/**
 * Health probes after a switch (modular-design.md 9.2 steps 10 / 11): poll /api/health/ready (max 60 s), then the
 * module's capabilities status with a deep probe (max 120 s) until ok or degraded. Executed ON the instance through the
 * delivery channel (no admin token needed): `node dist/cli.js probe <id> --deep --json` (same probe as the admin view of
 * /api/capabilities?deep=1). error / timeout -> the caller restores the .bak files and restarts (exit 5).
 */
import type { ModuleId } from '@cloudalbum/contracts';
import type { Ctx } from './context.js';
import { RemoteScript, sleep } from './deliver.js';

export interface ProbeOutcome { ok: boolean; status: string; detail: string; raw?: unknown }

export async function waitReady(ctx: Ctx, timeoutSec = 60): Promise<boolean> {
  const s = new RemoteScript('wait for /api/health/ready');
  s.line(`for _ in $(seq 1 ${Math.ceil(timeoutSec / 2)}); do`,
    '  if curl -fsS -m 3 -o /dev/null http://127.0.0.1/api/health/ready; then echo ready; exit 0; fi',
    '  sleep 2',
    'done',
    'curl -sS -m 3 http://127.0.0.1/api/health/ready || true',
    'journalctl -u cloudalbum-api -n 30 --no-pager || true',
    'exit 1');
  const r = await ctx.deliverer().run(s, { capture: true, timeoutSec: timeoutSec + 60 });
  if (ctx.dryRun) return true;
  if (r.code !== 0) ctx.out.error(r.stdout.trim().split('\n').slice(-15).join('\n'));
  return r.code === 0;
}

export function parseProbe(stdout: string): ProbeOutcome {
  const start = stdout.indexOf('{');
  if (start === -1) return { ok: false, status: 'unknown', detail: stdout.trim().slice(0, 300) };
  try {
    const m = JSON.parse(stdout.slice(start)) as { status?: string; detail?: string; localHealth?: string };
    const status = m.status ?? 'unknown';
    return { ok: status === 'ok' || status === 'degraded', status, detail: m.detail ?? '', raw: m };
  } catch {
    return { ok: false, status: 'unknown', detail: stdout.trim().slice(0, 300) };
  }
}

/** expectOff: after disable the module must be `off` with localHealth ok. */
export async function waitModule(ctx: Ctx, id: ModuleId, opts: { timeoutSec?: number; expectOff?: boolean } = {}): Promise<ProbeOutcome> {
  const deadline = Date.now() + (opts.timeoutSec ?? 120) * 1000;
  let last: ProbeOutcome = { ok: false, status: 'unknown', detail: '' };
  for (;;) {
    const s = new RemoteScript(`probe ${id}`);
    s.cli(`probe ${id} --deep --json`);
    const r = await ctx.deliverer().run(s, { capture: true, timeoutSec: 120 });
    if (ctx.dryRun) return { ok: true, status: 'dry-run', detail: '' };
    last = parseProbe(r.stdout);
    if (opts.expectOff) {
      const m = last.raw as { status?: string; localHealth?: string } | undefined;
      last = { ...last, ok: m?.status === 'off' && (m.localHealth ?? 'ok') === 'ok' };
    }
    if (last.ok) return last;
    if (Date.now() > deadline) return last;
    await sleep(10_000);
  }
}
