/**
 * Platform preview scheme B (06 PM-21): `scripts/module tls-preview on|off --platform`.
 *   on : on the lab instance (SSM) infra/host/platform/tls-preview.sh on --ip <EIP> — Let's Encrypt IP certificate, tls local tier;
 *        a failed issuance never fails (exit 0, {"preview":"failed","reason":…}); state.platform.preview records the result
 *   off: only when tls.env carries TLS_PREVIEW=letsencrypt-ip (exit 2 otherwise); no AWS resource is involved
 * `enable autoscaling` / `enable tls` switch scheme B off first (ASG-014; rule 6).
 */
import type { Ctx } from '../context.js';
import { ensureBase } from '../context.js';
import { lastJsonLine, RemoteScript } from '../deliver.js';
import { CliError, EXIT } from '../printer.js';
import { recordHistory } from '../state.js';

function requirePlatform(ctx: Ctx, what: string): NonNullable<Ctx['platform']> {
  if (!ctx.platform) throw new CliError(`${what} only exists in platform mode (--platform or CLOUDALBUM_PLATFORM_MODE=1)`, EXIT.rules, 'PLATFORM_ONLY');
  return ctx.platform;
}

function json(o: unknown): void {
  process.stdout.write(`${JSON.stringify(o, null, 2)}\n`);
}


export async function tlsPreviewCommand(ctx: Ctx, mode: 'on' | 'off'): Promise<number> {
  const p = requirePlatform(ctx, 'tls-preview');
  await ensureBase(ctx);
  p.reporter.progress('preview', 'started', `tls-preview ${mode}`);
  const pf = ctx.state.platform!;
  if (mode === 'on') {
    const ip = ctx.state.base?.publicIp;
    if ((ctx.state.baseConfig.DEPLOY_MODE ?? 'single') !== 'single') throw new CliError('tls-preview needs DEPLOY_MODE=single (ASG-014)', EXIT.rules, 'PREVIEW_UNSUPPORTED');
    const s = new RemoteScript('tls-preview on');
    s.line(`bash /opt/cloudalbum/infra/host/platform/tls-preview.sh on --ip ${ctx.ph(ip, 'ec2:PublicIp')}`);
    const r = await ctx.deliverer().run(s, { capture: true, timeoutSec: 600 });
    const out = lastJsonLine(r.stdout) ?? {};
    const issued = !ctx.dryRun && r.code === 0 && out.preview === 'issued';
    pf.preview = { directHttps: 'on', status: ctx.dryRun ? 'pending' : issued ? 'issued' : 'failed', ...(issued || ctx.dryRun ? {} : { reason: String(out.reason ?? `exit ${r.code}`) }), ...(ip ? { ip } : {}) };
    // a failed issuance never fails the profile: the preview falls back to "open in a new tab" (03 §6.2)
    json({ preview: pf.preview.status, ...(pf.preview.reason ? { reason: pf.preview.reason } : {}) });
  } else {
    const s = new RemoteScript('tls-preview off');
    s.line('bash /opt/cloudalbum/infra/host/platform/tls-preview.sh off');
    const r = await ctx.deliverer().run(s, { capture: true, timeoutSec: 300 });
    if (r.code === 2) throw new CliError('tls-preview off: tls.env does not come from tls-preview (TLS_PREVIEW=letsencrypt-ip); nothing changed', EXIT.rules, 'NOT_PREVIEW');
    if (r.code !== 0) throw new CliError(`tls-preview off failed (exit ${r.code})`, EXIT.stack, 'PREVIEW_FAILED');
    pf.preview = { directHttps: 'off', status: 'off' };
    json({ preview: 'off' });
  }
  p.reporter.progress('preview', 'succeeded', `tls-preview ${mode}`);
  recordHistory(ctx.state, { op: `tls-preview ${mode}`, result: ctx.dryRun ? 'dry-run' : 'ok', exitCode: EXIT.ok, opId: p.opId, ...(p.identity ? { actor: p.identity.sessionName } : {}) });
  ctx.save();
  return EXIT.ok;
}

/** enable autoscaling / tls in platform mode: scheme B (TLS_MODE=letsencrypt) is switched off first (ASG-014, 06 PM-21 rule 6) */
export async function previewOffBefore(ctx: Ctx, id: string): Promise<void> {
  if (!ctx.platform || (id !== 'autoscaling' && id !== 'tls')) return;
  if (ctx.state.platform?.preview?.status !== 'issued') return;
  ctx.out.warn(`  ${id}: switching the platform preview scheme B off first (TLS_MODE=letsencrypt from tls-preview conflicts with ${id === 'autoscaling' ? 'ASG-014' : 'the tls module'})`);
  await tlsPreviewCommand(ctx, 'off');
}

