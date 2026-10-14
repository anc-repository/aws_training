/**
 * `scripts/module status [id] [--refresh] [--repair]` (modular-design.md 9.2):
 *   no id : one line per module — type, local state (tier / value), stack status (--refresh), credentials, hourly
 *           billing, implemented in this round; then policy attachments vs quota.
 *   <id>  : stack, Info* outputs, modules.d env, attachments, injects (who injects me / whom I inject), reverse deps.
 *   --repair (CFG-004 half-enabled): rewrite modules.d/<id>.env from the stack Outputs (state.json is the record).
 */
import type { ModuleId } from '@cloudalbum/contracts';
import type { Ctx } from './context.js';
import { ensureBase } from './context.js';
import { reverseDependents } from './deps.js';
import { injectTargetsOf } from './injects.js';
import { principalOf, quotaFor } from './policy.js';
import { EXIT } from './printer.js';
import { IMPLEMENTED_MODULES, MODULE_IDS, REGISTRY, isHourlyBilled, moduleOf, stackName } from './registry.js';
import { describeStack } from './stack.js';
import { currentEnv } from './state.js';
import { RemoteScript } from './deliver.js';
import { renderEnvFile } from './env-file.js';

export async function statusCommand(ctx: Ctx, id: string | undefined, opts: { refresh?: boolean; repair?: boolean; json?: boolean }): Promise<number> {
  if (opts.refresh) await ensureBase(ctx, { refresh: true });
  if (opts.json) {
    ctx.out.info(JSON.stringify(id ? { module: id, record: ctx.state.modules[id as ModuleId] ?? null } : ctx.state, null, 2));
    return EXIT.ok;
  }
  if (!id) {
    ctx.out.section(`CloudAlbum env ${ctx.env} (${ctx.region}) — state ${ctx.stateFile}`);
    ctx.out.info(`  base: ${ctx.state.base?.stackName ?? '(not deployed)'} instance=${ctx.state.base?.instanceId ?? '-'} ip=${ctx.state.base?.publicIp ?? '-'} delivery=${ctx.state.delivery.channel}`);
    ctx.out.info(`  toolchain: ${ctx.state.toolchain?.bucket ?? '(not bootstrapped)'}   profile: ${ctx.state.profile ?? '-'}`);
    ctx.out.info(`  ${'module'.padEnd(17)} ${'type'.padEnd(7)} ${'state'.padEnd(22)} ${'stack'.padEnd(18)} ${'cred'.padEnd(9)} hourly impl`);
    for (const m of MODULE_IDS) {
      const r = REGISTRY[m];
      const rec = ctx.state.modules[m];
      let stack = rec?.tier === 'aws' ? (rec.stacks[0]?.status ?? '?') : '-';
      if (opts.refresh && rec?.tier === 'aws') {
        const st = rec.stacks[0];   // multi-stack modules (tls, waf): the first deployed stack, with its region
        stack = (await describeStack(ctx.aws, st?.stackName ?? stackName(ctx.env, m), st?.region))?.status ?? 'MISSING';
      }
      const state = m === 'ec2' ? 'base' : rec ? `${rec.tier} ${rec.value}` : 'off (local)';
      ctx.out.info(`  ${m.padEnd(17)} ${r.type.padEnd(7)} ${state.padEnd(22)} ${stack.padEnd(18)} ${r.credentials.padEnd(9)} ${isHourlyBilled(m) ? 'yes   ' : '      '} ${m === 'ec2' || IMPLEMENTED_MODULES.includes(m) ? 'yes' : 'no'}`);
    }
    const p = principalOf(ctx.state);
    if (p) ctx.out.info(`  policies: ${ctx.state.attachments.length} attached to ${p.type}/${p.name} (quota ${quotaFor(p)})`);
    return EXIT.ok;
  }
  const mid = id as ModuleId;
  const r = moduleOf(mid);
  const rec = ctx.state.modules[mid];
  ctx.out.section(`${mid}: ${r.function} <-> ${r.awsService} (${r.type}, credentials ${r.credentials})`);
  if (!rec) { ctx.out.info('  not enabled (local implementation)'); return EXIT.ok; }
  ctx.out.info(`  tier ${rec.tier}, value ${rec.value}, enabled ${rec.enabledAt}, updated ${rec.updatedAt}`);
  for (const s of rec.stacks) {
    const live = opts.refresh ? await describeStack(ctx.aws, s.stackName, s.region) : undefined;
    ctx.out.info(`  stack ${s.stackName} [${s.region}] ${live?.status ?? s.status ?? '?'}`);
  }
  for (const [k, v] of Object.entries(rec.outputs).filter(([k]) => k.startsWith('Info') || k === 'PolicyArn')) ctx.out.info(`  ${k} = ${v}`);
  ctx.out.info('  modules.d env:');
  for (const [k, v] of Object.entries(rec.env)) ctx.out.info(`    ${k}=${v}`);
  for (const a of ctx.state.attachments.filter((x) => x.module === mid)) ctx.out.info(`  attached ${a.policyArn} -> ${a.principal.type}/${a.principal.name}`);
  ctx.out.info(`  injects into: ${injectTargetsOf(mid, ctx.state).join(', ') || '-'}`);
  const from = MODULE_IDS.filter((p) => (REGISTRY[p]?.injects ?? []).some((i) => i.target === mid || i.target === '*') && ctx.state.modules[p]?.tier === 'aws');
  ctx.out.info(`  injected by: ${from.join(', ') || '-'}`);
  const rev = reverseDependents(currentEnv(ctx.state), mid, Object.keys(rec.env));
  ctx.out.info(`  reverse dependencies: ${rev.map((d) => `${d.module} (${d.rule})`).join(', ') || '-'}`);
  if (opts.repair) {
    const s = new RemoteScript(`repair ${mid}`);
    s.writeFile(`/etc/cloudalbum/modules.d/${mid}.env`, renderEnvFile(rec.env, { header: ['rewritten by scripts/module status --repair (CFG-004)'] }),
      { mode: '0640', owner: 'root:cloudalbum', backup: true });
    s.line('systemctl restart cloudalbum-api cloudalbum-worker');
    await ctx.deliverer().run(s);
  }
  return EXIT.ok;
}
