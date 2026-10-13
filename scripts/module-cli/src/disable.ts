/**
 * `scripts/module disable <id>` (modular-design.md 9.2):
 *   1 reverse dependencies (refuse, or --cascade in reverse topological order)   2 plan check of the env after removal
 *   3 migrate data back (`migrate-module <id> down` + verify; --abandon-data keeps it in the cloud)
 *   4 switch back to local: remove modules.d/<id>.env (+ .bak), host artifacts revert, check, restart, probe off/ok
 *   5 undo injects (targets get ''), detach PolicyArn, restore baseParams, remove the module's secrets.env keys
 *   6 delete the stack (Retain resources are listed and kept; data deletion only with --purge, not part of this round)
 *   7 state.json + history
 */
import type { ModuleId } from '@cloudalbum/contracts';
import type { Ctx } from './context.js';
import { ensureBase } from './context.js';
import { orderSteps, reverseDependents } from './deps.js';
import { RemoteScript } from './deliver.js';
import { waitModule, waitReady } from './health.js';
import { deleteDemoAccessKeys } from './hooks.js';
import { applyBaseParams, stagedEnv, updateInjectedTargets } from './ops.js';
import { printCheck, runLocalCheck } from './plan.js';
import { syncAttachments } from './policy.js';
import { CliError, EXIT } from './printer.js';
import { REGISTRY, moduleOf, stackName } from './registry.js';
import { deleteStack } from './stack.js';
import { currentEnv, recordHistory } from './state.js';
import { confirm, instanceStateUpdate } from './enable.js';
import { loadTemplate, mainTemplatePath } from './template.js';

export interface DisableOptions { cascade?: boolean; abandonData?: boolean; migrate?: boolean; purge?: boolean; skipHealth?: boolean }

export async function disableCommand(ctx: Ctx, idArg: string, opts: DisableOptions): Promise<number> {
  const id = idArg as ModuleId;
  if (id === 'ec2') throw new CliError('ec2 cannot be disabled (use scripts/teardown)', EXIT.rules);
  const rec = ctx.state.modules[id];
  if (!rec) { ctx.out.info(`${id} is not enabled (state.json); nothing to do`); return EXIT.ok; }
  await ensureBase(ctx);

  ctx.out.section(`plan: disable ${id}${ctx.dryRun ? ' [dry-run]' : ''}`);
  const env = currentEnv(ctx.state);
  const dependents = reverseDependents(env, id, Object.keys(rec.env));
  ctx.out.step(1, 'reverse dependencies');
  if (dependents.length) {
    for (const d of dependents) ctx.out.info(`      ${d.module} needs ${d.need} (${d.rule})`);
    if (!opts.cascade) {
      ctx.out.error(`      refusing: disable them first or use --cascade`);
      return EXIT.rules;
    }
    const order = orderSteps(dependents.map((d) => ({ module: d.module })), dependents.map((d) => [id, d.module] as [ModuleId, ModuleId])).reverse();
    for (const d of order) {
      const code = await disableCommand(ctx, d.module, { ...opts, cascade: true });
      if (code !== EXIT.ok) return code;
    }
  } else {
    ctx.out.info('      none');
  }

  ctx.out.step(2, 'plan check of the env after disabling');
  const after = { ...ctx.state.modules };
  delete after[id];
  if (!ctx.opts.skipLocalCheck) {
    const check = runLocalCheck(ctx.repoRoot, stagedEnv(ctx, after));
    printCheck(ctx.out, check);
    if (check.ran && !check.ok) return EXIT.rules;
  }
  if (!ctx.dryRun && !ctx.yes && !(await confirm(`disable ${id}?`))) { ctx.out.info('aborted'); return EXIT.rules; }

  // 3. data back to local
  const migration = moduleOf(id).migration;
  if (rec.tier === 'aws' && typeof migration === 'string' && migration.startsWith('scripts/migrate') && !opts.abandonData && opts.migrate !== false) {
    ctx.out.step(3, `migrate data back (${migration} down, read-only window)`);
    const s = new RemoteScript(`migrate ${id} down`);
    s.line('/usr/local/sbin/cloudalbum-runtime set readOnly true', 'systemctl stop cloudalbum-worker || true',
      'trap \'/usr/local/sbin/cloudalbum-runtime set readOnly false; systemctl start cloudalbum-worker\' EXIT');
    s.cli(`migrate-module ${id} down`).cli(`migrate-module ${id} verify`);
    const r = await ctx.deliverer().run(s);
    if (r.code !== 0) {
      ctx.out.error('migration back failed: nothing changed (use --abandon-data to leave the data in the cloud)');
      recordHistory(ctx.state, { op: 'disable', module: id, result: 'failed', exitCode: EXIT.migration });
      ctx.save();
      return EXIT.migration;
    }
  } else {
    ctx.out.step(3, opts.abandonData ? 'data left in the cloud (--abandon-data; Retain resources keep it)' : 'no data to migrate back');
  }

  // 4. local implementation again
  ctx.out.step(4, 'remove modules.d env and host artifacts, check, restart');
  const m = REGISTRY[id];
  const hasHost = Boolean(m.nginxFragments?.length || m.systemdDropIns?.length || (m.hostSetup && m.hostSetup !== 'infra/userdata/l0-bootstrap.sh'));
  const f = `/etc/cloudalbum/modules.d/${id}.env`;
  const s = new RemoteScript(`disable ${id}`);
  s.line(`ca_f=$(readlink -f ${f} 2>/dev/null || echo ${f})`,
    'if [ -f "$ca_f" ]; then cp -p "$ca_f" "$ca_f.bak"; fi',
    ...(hasHost ? [`/usr/local/lib/cloudalbum/run-hostsetup.sh ${id} revert`] : []),
    ...(rec.tier === 'self-hosted' && m.selfHosted ? [`bash /opt/cloudalbum/${m.selfHosted.installer} revert || true`] : []),
    'rm -f "$ca_f"',
    '/usr/local/lib/cloudalbum/render-fail2ban.sh || true',
    'if ! runuser -u cloudalbum -- env CLOUDALBUM_ENV_DIR=/etc/cloudalbum CLOUDALBUM_ROLE=cli /usr/bin/node /opt/cloudalbum/backend/dist/cli.js check-config; then',
    '  mv -f "$ca_f.bak" "$ca_f"' + (hasHost ? `; /usr/local/lib/cloudalbum/run-hostsetup.sh ${id} apply || true` : ''), '  exit 2', 'fi',
    'systemctl restart cloudalbum-api cloudalbum-worker',
    ...instanceStateUpdate(id, 'disabled'));
  const r = await ctx.deliverer().run(s, { timeoutSec: 600 });
  if (r.code !== 0) { ctx.out.error('the instance rejected the configuration without the module: restored'); return EXIT.rules; }
  if (!opts.skipHealth) {
    const ready = await waitReady(ctx, 60);
    const probe = ready ? await waitModule(ctx, id, { timeoutSec: 120, expectOff: true }) : { ok: false, status: 'not-ready', detail: '' };
    if (!ready || !probe.ok) {
      ctx.out.error(`health after disable failed (${probe.status}); restoring ${id}.env`);
      const back = new RemoteScript(`restore ${id}`);
      back.line(`ca_f=$(readlink -f ${f} 2>/dev/null || echo ${f})`, '[ -f "$ca_f.bak" ] && mv -f "$ca_f.bak" "$ca_f"',
        ...(hasHost ? [`/usr/local/lib/cloudalbum/run-hostsetup.sh ${id} apply || true`] : []), 'systemctl restart cloudalbum-api cloudalbum-worker');
      await ctx.deliverer().run(back);
      return EXIT.health;
    }
  }

  // 5. injects, policies, baseParams, secrets
  ctx.out.step(5, 'undo injects, detach PolicyArn, restore baseParams, remove secrets');
  await updateInjectedTargets(ctx, id, after);
  if (id === 'iam' && rec.value === 'keys' && ctx.state.iam?.userName) await deleteDemoAccessKeys(ctx, ctx.state.iam.userName);
  delete ctx.state.modules[id];   // in --dry-run only in memory (state.json is never written)
  if (id === 'iam') delete ctx.state.iam;
  const diff = await syncAttachments(ctx.aws, ctx.out, ctx.state);
  for (const d of diff.detach) ctx.out.info(`      detach ${d.policyArn} <- ${d.principal.type}/${d.principal.name}`);
  await applyBaseParams(ctx, after, id);
  const secretKeys = [...rec.secretKeys, ...(id === 'iam' && rec.value === 'keys' ? ['IAM_KEYS_ACCESS_KEY_ID', 'IAM_KEYS_SECRET_ACCESS_KEY'] : [])];
  if (secretKeys.length) {
    const rm = new RemoteScript(`remove ${id} secrets`);
    rm.removeSecrets(secretKeys).line('systemctl restart nginx');
    await ctx.deliverer().run(rm);
  }

  // 6. stacks
  if (rec.tier === 'aws') {
    ctx.out.step(6, `delete ${stackName(ctx.env, id)}`);
    const t = loadTemplate(ctx.repoRoot, mainTemplatePath(id));
    const retained = Object.entries(t.Resources).filter(([, r]) => r.DeletionPolicy === 'Retain' || r.DeletionPolicy === 'Snapshot');
    for (const [name, r] of retained) ctx.out.warn(`      kept by DeletionPolicy ${String(r.DeletionPolicy)}: ${name} (${r.Type})`);
    if (opts.purge) ctx.out.warn('      --purge (empty buckets, final snapshot, key deletion) is not implemented in this round: delete retained resources manually');
    for (const st of rec.stacks.length ? rec.stacks : [{ stackName: stackName(ctx.env, id), region: ctx.region, name: 'main' }]) {
      await deleteStack(ctx.aws, ctx.out, st.stackName, st.region);
    }
  }

  // 7. state
  recordHistory(ctx.state, { op: 'disable', module: id, result: ctx.dryRun ? 'dry-run' : 'ok', exitCode: EXIT.ok });
  ctx.save();
  ctx.out.step(7, `${id} disabled: back to the local implementation`);
  return EXIT.ok;
}
