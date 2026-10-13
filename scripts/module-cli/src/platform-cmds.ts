/**
 * Platform-mode subcommands of scripts/module (06 PM-21, PM-31～PM-36, PM-43～PM-44):
 *   plan --start-of / --profile, profile gen-atl, hooks run --pending, seed <id>, tls-preview on|off,
 *   env destroy --fast --ledger-out, env suspend | resume, wait-stable, iam revoke-older-sessions | refresh-instance-credentials,
 *   status --json (cloudalbum.status/v1).
 * Every AWS call goes through the gateway (printed in --dry-run).
 */
import { randomBytes, randomInt } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { isSeedId, SEED_TEST_USERS, type ModuleId } from '@cloudalbum/contracts';
import type { Ctx } from './context.js';
import { ensureBase } from './context.js';
import { applyTarget, orderSteps, planEnable, resolveTarget, type PlanStep } from './deps.js';
import { lastJsonLine, RemoteScript, sleep } from './deliver.js';
import { previewEnv } from './enable.js';
import { buildModuleEnv } from './outputs.js';
import { registryEdges } from './meta.js';
import { runLocalCheck, type StagedEnv } from './plan.js';
import {
  digestObject, listCards, loadLab, normalizeProfileName, parseAtlProfile, planStartOf, renderAtlProfile, specDigest, toolkitRegistryVersion,
  toolkitVersion, variantsOf, PLAN_SCHEMA, type PlanResult, type StartEntry,
} from './plan-start.js';
import { readLock } from './platform/lock.js';
import { registerHook, ssmParam } from './platform/hooks.js';
export { hooksRun, registerHook, ADMIN_EMAIL } from './platform/hooks.js';
export { tlsPreviewCommand, previewOffBefore } from './platform/tls-preview.js';
import { CliError, EXIT } from './printer.js';
import { isPlatformPolicy } from './policy.js';
import { profilePath } from './profiles.js';
import { MODULE_IDS, isModuleId, moduleOf, stackName } from './registry.js';
import { describeStack, waitForStack } from './stack.js';
import { nowIso, recordHistory } from './state.js';

function requirePlatform(ctx: Ctx, what: string): NonNullable<Ctx['platform']> {
  if (!ctx.platform) throw new CliError(`${what} only exists in platform mode (--platform or CLOUDALBUM_PLATFORM_MODE=1)`, EXIT.rules, 'PLATFORM_ONLY');
  return ctx.platform;
}

function json(o: unknown): void {
  process.stdout.write(`${JSON.stringify(o, null, 2)}\n`);
}

// ================================================================================================ plan

/** rule engine on a start state: staged env (outputs as placeholders) + backend check-config --plan */
export function startStateCheck(repoRoot: string) {
  return (start: StartEntry[]) => {
    const staged: StagedEnv = {
      base: { AWS_REGION: 'ap-northeast-1', CLOUDALBUM_ENV: 'eplan000', APP_BASE_URL: 'http://203.0.113.10', DEPLOY_MODE: 'single' }, modules: {}, secrets: {},
    };
    for (const e of start) {
      if (e.id === 'ec2' || e.kind === 'runtime' || !isModuleId(e.id)) continue;
      const id = e.id as ModuleId;
      const sw = moduleOf(id).switch;
      const settings = Object.fromEntries(Object.entries(e.set ?? {}).filter(([k]) => k !== sw?.var));
      if (e.kind === 'local') {
        staged.modules[id] = { ...(staged.modules[id] ?? {}), ...buildModuleEnv({ module: id, awsTier: false, settings: e.set ?? {} }) };
        continue;
      }
      const t = sw && 'ownedValues' in sw ? resolveTarget(id, { driver: e.set?.[sw.var] ?? sw.ownedValues[0]!, settings }) : resolveTarget(id, { settings });
      const step: PlanStep = { ...t, reason: 'start state', isTarget: false };
      staged.modules[id] = previewEnv(repoRoot, step);
    }
    if (Object.values(staged.modules).some((m) => m?.IAM_CREDENTIALS === 'keys')) staged.secrets = { IAM_KEYS_ACCESS_KEY_ID: 'AKIAPLACEHOLDER', IAM_KEYS_SECRET_ACCESS_KEY: 'placeholder' };
    const r = runLocalCheck(repoRoot, staged);
    return { ran: r.ran, ok: r.ok, errors: r.errors.map((e) => ({ rule: e.rule, message: e.message })), warnings: r.warnings.map((w) => ({ rule: w.rule })), ...(r.reason ? { reason: r.reason } : {}) };
  };
}

export function planStartOfCommand(ctx: Pick<Ctx, 'repoRoot' | 'opts'>, card: string, o: { variant?: string; labFile?: string; noRules?: boolean }): PlanResult {
  const lab = loadLab(ctx.repoRoot, card, o.labFile);
  return planStartOf(lab, { repoRoot: ctx.repoRoot, ...(o.variant ? { variant: o.variant } : {}),
    ...(o.noRules || ctx.opts.skipLocalCheck ? {} : { check: startStateCheck(ctx.repoRoot) }) });
}

/** the profile file of an atl profile name: the working directory first (the runner downloads it there), then the repository */
export function atlProfileFile(repoRoot: string, name: string): string {
  const n = normalizeProfileName(name);
  const rel = path.join('profiles', ...`${n}.env`.split('/'));
  const cwd = path.resolve(rel);
  return existsSync(cwd) ? cwd : profilePath(repoRoot, n);
}

/** `plan --profile atl/<card>/<variant> [--then <module[:K=V,…]>,…]` (06 PM-32): same digest algorithm as --start-of */
export function planProfileCommand(ctx: Pick<Ctx, 'repoRoot'>, name: string, o: { then?: string } = {}): Record<string, unknown> {
  const file = atlProfileFile(ctx.repoRoot, name);
  if (!existsSync(file)) throw new CliError(`profile ${name} not found (${file})`, EXIT.rules, 'PROFILE_NOT_FOUND');
  const spec = parseAtlProfile(readFileSync(file, 'utf8'));
  const digest = specDigest(spec);
  const then: Array<{ module: string; issues: Array<{ rule: string; message: string }> }> = [];
  if (o.then) {
    // simulate enabling the targets one after another on top of the start state (04 DRV-6)
    let env: Record<string, string> = {};
    for (const m of spec.modules) if (m.kind !== 'runtime') env = { ...env, ...m.set };
    for (const item of o.then.split(/,(?=[a-z][a-z0-9-]*(?::|,|$))/)) {
      const [mod, kv] = item.split(':') as [string, string | undefined];
      if (!isModuleId(mod)) throw new CliError(`--then: unknown module ${mod}`, EXIT.rules, 'MODULE_UNKNOWN');
      const settings = Object.fromEntries((kv ?? '').split(',').filter(Boolean).map((x) => { const i = x.indexOf('='); return [x.slice(0, i), x.slice(i + 1)]; }));
      const sw = moduleOf(mod as ModuleId).switch;
      const driver = sw && 'ownedValues' in sw ? settings[sw.var] : undefined;
      const t = resolveTarget(mod as ModuleId, { ...(driver ? { driver } : {}), settings: Object.fromEntries(Object.entries(settings).filter(([k]) => k !== sw?.var)) });
      const p = planEnable(env, t, {});
      then.push({ module: mod, issues: p.issues.map((i) => ({ rule: i.rule, message: i.message })) });
      env = applyTarget(env, t);
    }
  }
  return {
    schema: PLAN_SCHEMA, registryVersion: toolkitRegistryVersion(), toolkitVersion: toolkitVersion(), profileName: spec.name,
    card: spec.card, variant: spec.variant, file, modules: spec.modules, platform: spec.platform, baseParams: spec.baseParams,
    extraStacks: spec.extraStacks, seeds: spec.seeds, placeholders: spec.placeholders,
    recordedDigest: spec.recordedDigest, recordedRegistryVersion: spec.recordedRegistryVersion,
    digest, digestMatches: spec.recordedDigest === digest, ...(then.length ? { then } : {}),
    digestObject: digestObject(spec),
  };
}

/** `profile gen-atl [--card <id>] --out profiles/atl/` (labs:build calls it) */
export function genAtlProfiles(ctx: Pick<Ctx, 'repoRoot' | 'opts'>, o: { card?: string; out?: string; noRules?: boolean }, log: (l: string) => void): string[] {
  const outDir = path.resolve(o.out ?? path.join(ctx.repoRoot, 'profiles', 'atl'));
  const cards = o.card ? [o.card] : listCards(ctx.repoRoot);
  const written: string[] = [];
  for (const card of cards) {
    const lab = loadLab(ctx.repoRoot, card);
    for (const variant of variantsOf(lab)) {
      const plan = planStartOf(lab, { repoRoot: ctx.repoRoot, variant, ...(o.noRules || ctx.opts.skipLocalCheck ? {} : { check: startStateCheck(ctx.repoRoot) }) });
      const file = path.join(outDir, card, `${variant}.env`);
      mkdirSync(path.dirname(file), { recursive: true });
      writeFileSync(file, renderAtlProfile(plan));
      written.push(file);
      log(`wrote ${path.relative(ctx.repoRoot, file)} (${plan.digest})`);
    }
  }
  return written;
}

// ================================================================================================ seeds (PM-43～PM-45)

const SYMBOLS = '!#$%&*+-=?@^_';

/** 24 characters with at least one upper, lower, digit and symbol (Cognito default password policy) */
export function seedPassword(): string {
  const sets = ['ABCDEFGHJKLMNPQRSTUVWXYZ', 'abcdefghijkmnopqrstuvwxyz', '23456789', SYMBOLS];
  const all = sets.join('');
  const chars = sets.map((s) => s[randomInt(s.length)]!);
  while (chars.length < 24) chars.push(all[randomInt(all.length)]!);
  for (let i = chars.length - 1; i > 0; i -= 1) { const j = randomInt(i + 1); [chars[i], chars[j]] = [chars[j]!, chars[i]!]; }
  return chars.join('');
}

async function argon2idHash(password: string): Promise<string> {
  const argon2 = (await import('@node-rs/argon2' as string)) as { hash?: (p: string, o: Record<string, number>) => Promise<string>; default?: { hash: (p: string, o: Record<string, number>) => Promise<string> } };
  const hash = argon2.hash ?? argon2.default?.hash;
  if (!hash) throw new CliError('argon2id is not available (@node-rs/argon2)', EXIT.rules, 'ARGON2_UNAVAILABLE');
  return hash(password, { memoryCost: 19456, timeCost: 2, parallelism: 1 });
}

export async function seedCommand(ctx: Ctx, id: string, o: { owner?: string } = {}): Promise<number> {
  const p = requirePlatform(ctx, 'seed');
  if (!isSeedId(id)) throw new CliError(`unknown seed ${id} (06 §11: cognito-test-users, gps-sample-photos)`, EXIT.rules, 'SEED_UNKNOWN');
  await ensureBase(ctx);
  p.reporter.progress('seed', 'started', id, { module: null });
  const seeds = ctx.state.platform!.seeds;
  try {
    if (id === 'cognito-test-users') {
      if (!p.env.testUsersParam) throw new CliError('CLOUDALBUM_TEST_USERS_PARAM is required for cognito-test-users', EXIT.rules, 'PLATFORM_ENV_INCOMPLETE');
      let users: Array<{ username: string; email: string; password: string }>;
      const existing = await ssmParam(ctx, p.env.testUsersParam);
      if (existing) users = JSON.parse(existing) as typeof users;                   // idempotent: keep the passwords
      else {
        users = SEED_TEST_USERS.map((u) => ({ username: u, email: `${u}@example.com`, password: seedPassword() }));
        const tags = Object.entries({ ...(ctx.state.platform?.platformTags ?? {}), ...p.env.tags }).map(([Key, Value]) => ({ Key, Value }));
        await ctx.aws.send({ service: 'ssm', op: 'PutParameter', input: { Name: p.env.testUsersParam, Type: 'SecureString', Value: JSON.stringify(users), Tags: tags },
          display: { Name: p.env.testUsersParam, Type: 'SecureString', Value: '***' } });
      }
      const hashed = ctx.dryRun ? users.map((u) => ({ username: u.username, email: u.email, passwordHash: '<argon2id>' }))
        : await Promise.all(users.map(async (u) => ({ username: u.username, email: u.email, passwordHash: await argon2idHash(u.password) })));
      const b64 = Buffer.from(JSON.stringify(hashed)).toString('base64url');
      const s = new RemoteScript('seed cognito-test-users');
      s.line(`/opt/cloudalbum/bin/cloudalbum seed cognito-test-users --users-b64 ${b64} --json`);
      const r = await ctx.deliverer().run(s, { capture: true, timeoutSec: 300 });
      if (r.code !== 0) throw new CliError(`seed cognito-test-users failed on the instance (exit ${r.code}): ${(lastJsonLine(r.stdout) ?? {}).error ? JSON.stringify(lastJsonLine(r.stdout)) : r.stderr.trim().slice(-300)}`, EXIT.stack, 'SEED_FAILED');
      const cognito = ctx.state.modules.auth?.tier === 'aws';
      seeds[id] = { instance: 'done', ...(cognito ? { cognito: 'pending' as const } : {}), at: nowIso() };
      if (cognito) await registerHook(ctx, 'cognito-passwords', `seed cognito-test-users with auth=cognito (${p.identity?.sessionName ?? '?'})`);
    } else {
      const s = new RemoteScript('seed gps-sample-photos');
      if (o.owner && !/^[a-z0-9][a-z0-9._-]{0,63}$/.test(o.owner)) throw new CliError('--owner must be a user name', EXIT.rules, 'USAGE');
      s.line(`/opt/cloudalbum/bin/cloudalbum seed gps-sample-photos${o.owner ? ` --owner ${o.owner}` : ''} --json`);
      const r = await ctx.deliverer().run(s, { capture: true, timeoutSec: 600 });
      if (r.code !== 0) throw new CliError(`seed gps-sample-photos failed on the instance (exit ${r.code})`, EXIT.stack, 'SEED_FAILED');
      seeds[id] = { instance: 'done', at: nowIso() };
      if (!ctx.dryRun) ctx.out.info(`  ${JSON.stringify(lastJsonLine(r.stdout))}`);
    }
  } catch (e) {
    seeds[id] = { ...(seeds[id] ?? {}), instance: 'failed', at: nowIso() };
    p.reporter.progress('seed', 'failed', (e as Error).message);
    recordHistory(ctx.state, { op: `seed ${id}`, result: 'failed', exitCode: EXIT.stack, opId: p.opId, ...(p.identity ? { actor: p.identity.sessionName } : {}) });
    ctx.save();
    if (e instanceof CliError && e.exitCode === EXIT.rules) throw e;
    throw new CliError((e as Error).message, EXIT.stack, 'SEED_FAILED');          // seeds fail with exit 3 (PM-43)
  }
  p.reporter.progress('seed', 'succeeded', id);
  recordHistory(ctx.state, { op: `seed ${id}`, result: ctx.dryRun ? 'dry-run' : 'ok', exitCode: EXIT.ok, opId: p.opId, ...(p.identity ? { actor: p.identity.sessionName } : {}) });
  ctx.save();
  json({ seed: id, ...seeds[id] });
  return EXIT.ok;
}

// ================================================================================================ env destroy / suspend / resume, wait-stable

interface LedgerStack { name: string; region: string; result: 'DELETED' | 'DELETED_WITH_RETAINED' | 'DELETE_FAILED' | 'NOT_FOUND'; resources: Array<{ logicalId: string; physicalId: string; type: string; retained: boolean }> }

async function listEnvStacks(ctx: Ctx, region?: string): Promise<Array<{ name: string; status: string }>> {
  const out: Array<{ name: string; status: string }> = [];
  let token: string | undefined;
  for (let i = 0; i < 20; i += 1) {
    const r = await ctx.aws.send<{ StackSummaries?: Array<{ StackName?: string; StackStatus?: string }>; NextToken?: string }>({
      service: 'cloudformation', op: 'ListStacks', ...(region ? { region } : {}),
      input: { ...(token ? { NextToken: token } : {}), StackStatusFilter: ['CREATE_IN_PROGRESS', 'CREATE_FAILED', 'CREATE_COMPLETE', 'ROLLBACK_IN_PROGRESS', 'ROLLBACK_FAILED',
        'ROLLBACK_COMPLETE', 'DELETE_IN_PROGRESS', 'DELETE_FAILED', 'UPDATE_IN_PROGRESS', 'UPDATE_COMPLETE_CLEANUP_IN_PROGRESS', 'UPDATE_COMPLETE',
        'UPDATE_FAILED', 'UPDATE_ROLLBACK_IN_PROGRESS', 'UPDATE_ROLLBACK_FAILED', 'UPDATE_ROLLBACK_COMPLETE_CLEANUP_IN_PROGRESS', 'UPDATE_ROLLBACK_COMPLETE',
        'REVIEW_IN_PROGRESS', 'IMPORT_IN_PROGRESS', 'IMPORT_COMPLETE', 'IMPORT_ROLLBACK_IN_PROGRESS', 'IMPORT_ROLLBACK_FAILED', 'IMPORT_ROLLBACK_COMPLETE'] },
    });
    for (const s of r?.StackSummaries ?? []) if (s.StackName?.startsWith(`cloudalbum-${ctx.env}-`)) out.push({ name: s.StackName, status: s.StackStatus ?? '?' });
    token = r?.NextToken;
    if (!token) break;
  }
  return out;
}

/** deletion order: card stacks (x-*) → modules (reverse topological) → ec2 → toolchain */
export function destroyOrder(env: string, names: string[]): string[] {
  const prefix = `cloudalbum-${env}-`;
  const extra = names.filter((n) => n.startsWith(`${prefix}x-`));
  const mods = MODULE_IDS.filter((id) => id !== 'ec2' && names.some((n) => n === `${prefix}${id}` || n.startsWith(`${prefix}${id}-`)));
  const ordered = orderSteps(mods.map((module) => ({ module })), registryEdges()).map((s) => s.module).reverse();
  const out: string[] = [...extra];
  for (const id of ordered) out.push(...names.filter((n) => (n === `${prefix}${id}` || n.startsWith(`${prefix}${id}-`)) && !out.includes(n)));
  for (const n of [`${prefix}ec2`, `${prefix}toolchain`]) if (names.includes(n)) out.push(n);
  for (const n of names) if (!out.includes(n)) out.push(n);
  return out;
}

export async function envDestroy(ctx: Ctx, o: { fast?: boolean; ledgerOut?: string }): Promise<number> {
  const p = requirePlatform(ctx, 'env destroy');
  if (!o.fast) throw new CliError('env destroy needs --fast (stack-level teardown with a ledger, 02 §6.5)', EXIT.rules, 'USAGE');
  ctx.out.section(`env destroy --fast ${ctx.env}${ctx.dryRun ? ' [dry-run]' : ''}`);
  p.reporter.progress('destroy', 'started', `env ${ctx.env}`);
  const regions = [ctx.region, ...new Set(Object.values(ctx.state.modules).flatMap((m) => m?.stacks.map((s) => s.region) ?? []).filter((r) => r !== ctx.region))];
  const stacks: Array<{ name: string; region: string }> = [];
  for (const r of regions) for (const s of await listEnvStacks(ctx, r === ctx.region ? undefined : r)) stacks.push({ name: s.name, region: r });
  for (const rec of Object.values(ctx.state.modules)) for (const s of rec?.stacks ?? []) if (!stacks.some((x) => x.name === s.stackName)) stacks.push({ name: s.stackName, region: s.region });
  if (ctx.dryRun && !stacks.length) {
    for (const id of Object.keys(ctx.state.modules)) stacks.push({ name: stackName(ctx.env, id as ModuleId), region: ctx.region });
    stacks.push({ name: stackName(ctx.env, 'ec2'), region: ctx.region }, { name: stackName(ctx.env, 'toolchain'), region: ctx.region });
  }
  const order = destroyOrder(ctx.env, stacks.map((s) => s.name));
  // policies first: detach every recorded attachment (platform policies are never touched)
  const detached: Array<{ policyArn: string; principal: string; detached: boolean }> = [];
  for (const a of [...ctx.state.attachments]) {
    if (isPlatformPolicy(a.policyArn)) continue;
    let ok = true;
    try {
      await ctx.aws.send(a.principal.type === 'role'
        ? { service: 'iam', op: 'DetachRolePolicy', input: { RoleName: a.principal.name, PolicyArn: a.policyArn } }
        : { service: 'iam', op: 'DetachUserPolicy', input: { UserName: a.principal.name, PolicyArn: a.policyArn } });
    } catch (e) {
      ok = /NoSuchEntity/.test(String((e as Error).message));
    }
    detached.push({ policyArn: a.policyArn, principal: `${a.principal.type}/${a.principal.name}`, detached: ok });
    if (ok && !ctx.dryRun) ctx.state.attachments = ctx.state.attachments.filter((x) => x !== a);
  }
  const ledger: LedgerStack[] = [];
  for (const name of order) {
    const region = stacks.find((s) => s.name === name)?.region ?? ctx.region;
    const reg = region === ctx.region ? undefined : region;
    const res = await ctx.aws.send<{ StackResourceSummaries?: Array<{ LogicalResourceId?: string; PhysicalResourceId?: string; ResourceType?: string; ResourceStatus?: string }> }>({
      service: 'cloudformation', op: 'ListStackResources', input: { StackName: name }, ...(reg ? { region: reg } : {}) }).catch(() => undefined);
    const resources = (res?.StackResourceSummaries ?? []).map((r) => ({ logicalId: r.LogicalResourceId ?? '?', physicalId: r.PhysicalResourceId ?? '', type: r.ResourceType ?? '?', retained: false }));
    const existing = await describeStack(ctx.aws, name, reg);
    if (existing === null) { ledger.push({ name, region, result: 'NOT_FOUND', resources }); continue; }
    ctx.out.info(`  delete ${name} [${region}]`);
    await ctx.aws.send({ service: 'cloudformation', op: 'DeleteStack', input: { StackName: name }, ...(reg ? { region: reg } : {}) });
    if (ctx.dryRun) { ledger.push({ name, region, result: 'DELETED', resources }); continue; }
    let done = await waitForStack(ctx.aws, ctx.out, name, reg);
    let result: LedgerStack['result'] = done.status === 'DELETE_COMPLETE' ? 'DELETED' : 'DELETE_FAILED';
    if (result === 'DELETE_FAILED') {
      // retain what could not be deleted (non-empty buckets, …) and record it: the reclaimer removes it later (02 §7)
      const ev = await ctx.aws.send<{ StackEvents?: Array<{ LogicalResourceId?: string; ResourceStatus?: string }> }>({
        service: 'cloudformation', op: 'DescribeStackEvents', input: { StackName: name }, ...(reg ? { region: reg } : {}) }).catch(() => undefined);
      const failed = [...new Set((ev?.StackEvents ?? []).filter((x) => x.ResourceStatus === 'DELETE_FAILED').map((x) => x.LogicalResourceId ?? ''))].filter(Boolean);
      await ctx.aws.send({ service: 'cloudformation', op: 'DeleteStack', input: { StackName: name, RetainResources: failed }, ...(reg ? { region: reg } : {}) });
      done = await waitForStack(ctx.aws, ctx.out, name, reg);
      if (done.status === 'DELETE_COMPLETE') {
        result = 'DELETED_WITH_RETAINED';
        for (const r of resources) if (failed.includes(r.logicalId)) r.retained = true;
      }
    }
    ledger.push({ name, region, result, resources });
  }
  const doc = {
    schema: 'cloudalbum.ledger/v1', env: ctx.env, envId: p.env.envId, generatedAt: nowIso(),
    stacks: ledger, outOfBand: ctx.state.outOfBand.map((x) => ({ type: x.kind, id: x.id, region: ctx.region, createdBy: x.module })),
    policyAttachments: detached, backups: ctx.state.backups.map((b) => b.key),
  };
  if (o.ledgerOut) {
    mkdirSync(path.dirname(path.resolve(o.ledgerOut)), { recursive: true });
    writeFileSync(o.ledgerOut, `${JSON.stringify(doc, null, 2)}\n`);
  }
  const partial = ledger.some((s) => s.result === 'DELETE_FAILED');
  if (!ctx.dryRun && !partial) {
    ctx.state.modules = {};
    delete ctx.state.base;
    delete ctx.state.toolchain;
  }
  p.reporter.progress('destroy', partial ? 'failed' : 'succeeded', `${ledger.length} stack(s)`);
  recordHistory(ctx.state, { op: 'env destroy', result: ctx.dryRun ? 'dry-run' : partial ? 'failed' : 'ok', exitCode: partial ? EXIT.destroyPartial : EXIT.ok,
    opId: p.opId, ...(p.identity ? { actor: p.identity.sessionName } : {}), runId: p.env.runId ?? null });
  ctx.save();
  json({ ledger: o.ledgerOut ?? null, stacks: ledger.map((s) => ({ name: s.name, result: s.result })) });
  return partial ? EXIT.destroyPartial : EXIT.ok;
}

export async function envSuspendResume(ctx: Ctx, mode: 'suspend' | 'resume'): Promise<number> {
  const p = requirePlatform(ctx, `env ${mode}`);
  await ensureBase(ctx);
  const instance = ctx.ph(ctx.state.base?.instanceId, 'ec2:InstanceId');
  const db = ctx.state.modules.database?.tier === 'aws' ? ctx.state.modules.database.outputs.InfoDbInstanceId : undefined;
  const skipped: Array<{ id: string; reason: string }> = [];
  for (const id of ['autoscaling', 'cache', 'network', 'cdn'] as const) if (ctx.state.modules[id]) skipped.push({ id, reason: `${id} is not stopped by env ${mode} (02 §8.2)` });
  if (mode === 'suspend') {
    await ctx.aws.send({ service: 'ec2', op: 'StopInstances', input: { InstanceIds: [instance] } });
    if (db) {
      try { await ctx.aws.send({ service: 'rds', op: 'StopDBInstance', input: { DBInstanceIdentifier: db } }); }
      catch (e) { skipped.push({ id: db, reason: (e as Error).message.slice(0, 200) }); }
    }
    ctx.state.suspended = { at: nowIso(), stopped: [instance, ...(db ? [db] : [])], skipped };
  } else {
    await ctx.aws.send({ service: 'ec2', op: 'StartInstances', input: { InstanceIds: [instance] } });
    if (db) await ctx.aws.send({ service: 'rds', op: 'StartDBInstance', input: { DBInstanceIdentifier: db } }).catch((e: Error) => skipped.push({ id: db, reason: e.message.slice(0, 200) }));
    if (!ctx.dryRun) {
      const deadline = Date.now() + 15 * 60_000;
      for (;;) {
        const r = await ctx.aws.send<{ Reservations?: Array<{ Instances?: Array<{ State?: { Name?: string } }> }> }>({ service: 'ec2', op: 'DescribeInstances', input: { InstanceIds: [instance] } });
        if (r?.Reservations?.[0]?.Instances?.[0]?.State?.Name === 'running') break;
        if (Date.now() > deadline) throw new CliError(`${instance} did not reach running`, EXIT.health, 'RESUME_TIMEOUT');
        await sleep(10_000);
      }
    }
    const s = new RemoteScript('env resume: platform-status');
    s.line('/opt/cloudalbum/bin/cloudalbum platform-status --json');
    const r = await ctx.deliverer().run(s, { capture: true, timeoutSec: 300 });
    if (!ctx.dryRun) ctx.out.info(`  ${JSON.stringify(lastJsonLine(r.stdout))}`);
    ctx.state.suspended = null;
  }
  recordHistory(ctx.state, { op: `env ${mode}`, result: ctx.dryRun ? 'dry-run' : 'ok', exitCode: EXIT.ok, opId: p.opId, ...(p.identity ? { actor: p.identity.sessionName } : {}) });
  ctx.save();
  json({ [mode === 'suspend' ? 'suspended' : 'resumed']: true, skipped });
  return EXIT.ok;
}

/** wait until no cloudalbum-<env>-* stack is *_IN_PROGRESS; UPDATE_ROLLBACK_FAILED → continue-update-rollback */
export async function waitStable(ctx: Ctx, o: { timeout?: string; skipFailed?: boolean }): Promise<number> {
  const timeoutSec = o.timeout ? Number(o.timeout) : 1800;
  if (!Number.isInteger(timeoutSec) || timeoutSec < 1 || timeoutSec > 86_400) throw new CliError('--timeout must be 1..86400 seconds', EXIT.rules, 'USAGE');
  const deadline = Date.now() + timeoutSec * 1000;
  for (;;) {
    const stacks = await listEnvStacks(ctx);
    for (const s of stacks.filter((x) => x.status === 'UPDATE_ROLLBACK_FAILED')) {
      let skip: string[] = [];
      if (o.skipFailed) {
        const ev = await ctx.aws.send<{ StackEvents?: Array<{ LogicalResourceId?: string; ResourceStatus?: string }> }>({ service: 'cloudformation', op: 'DescribeStackEvents', input: { StackName: s.name } });
        skip = [...new Set((ev?.StackEvents ?? []).filter((x) => x.ResourceStatus === 'UPDATE_FAILED').map((x) => x.LogicalResourceId ?? ''))].filter(Boolean);
      }
      await ctx.aws.send({ service: 'cloudformation', op: 'ContinueUpdateRollback', input: { StackName: s.name, ...(skip.length ? { ResourcesToSkip: skip } : {}) } });
    }
    const busy = stacks.filter((x) => /_IN_PROGRESS$/.test(x.status) || x.status === 'UPDATE_ROLLBACK_FAILED');
    if (!busy.length || ctx.dryRun) {
      json({ stable: true, stacks: stacks.map((x) => ({ name: x.name, status: x.status })) });
      return EXIT.ok;
    }
    if (Date.now() > deadline) throw new CliError(`wait-stable: still in progress after ${timeoutSec}s: ${busy.map((b) => `${b.name}=${b.status}`).join(', ')}`, EXIT.stack, 'WAIT_STABLE_TIMEOUT');
    await sleep(15_000);
  }
}

// ================================================================================================ iam platform actions (PM-31)

export async function iamPlatformAction(ctx: Ctx, action: 'revoke-older-sessions' | 'refresh-instance-credentials'): Promise<number> {
  const p = requirePlatform(ctx, `iam ${action}`);
  if (p.identity?.kind !== 'provisioner' && !ctx.dryRun) {
    throw new CliError(`iam ${action} is a platform action: only the runner (ATL_OP=module-op) may run it`, EXIT.rules, 'PLATFORM_ACTION_REQUIRED');
  }
  if (action === 'revoke-older-sessions') {
    const now = nowIso();
    const doc = { Version: '2012-10-17', Statement: [{ Effect: 'Deny', Action: ['*'], Resource: ['*'], Condition: { DateLessThan: { 'aws:TokenIssueTime': now } } }] };
    await ctx.aws.send({ service: 'iam', op: 'PutRolePolicy', input: { RoleName: 'CloudAlbumAppRole', PolicyName: 'AWSRevokeOlderSessions', PolicyDocument: JSON.stringify(doc) } });
    json({ revoked: true, before: now, interruptsManagementChannel: true });
  } else {
    await ensureBase(ctx);
    const instance = ctx.ph(ctx.state.base?.instanceId, 'ec2:InstanceId');
    const r = await ctx.aws.send<{ IamInstanceProfileAssociations?: Array<{ AssociationId?: string }> }>({ service: 'ec2', op: 'DescribeIamInstanceProfileAssociations',
      input: { Filters: [{ Name: 'instance-id', Values: [instance] }, { Name: 'state', Values: ['associated'] }] } });
    const assoc = r?.IamInstanceProfileAssociations?.[0]?.AssociationId;
    try {
      await ctx.aws.send({ service: 'ec2', op: 'ReplaceIamInstanceProfileAssociation', input: { AssociationId: ctx.ph(assoc, 'association-id'), IamInstanceProfile: { Name: 'CloudAlbumAppRole' } } });
    } catch {
      await ctx.aws.send({ service: 'ec2', op: 'RebootInstances', input: { InstanceIds: [instance] } });
    }
    const d = ctx.deliverer();
    if ('waitOnline' in d && typeof d.waitOnline === 'function') await (d as unknown as { waitOnline(ids: string[]): Promise<void> }).waitOnline([instance]);
    json({ refreshed: true, instanceId: instance });
  }
  recordHistory(ctx.state, { op: `iam ${action}`, result: ctx.dryRun ? 'dry-run' : 'ok', exitCode: EXIT.ok, opId: p.opId, ...(p.identity ? { actor: p.identity.sessionName } : {}), runId: p.env.runId ?? null });
  ctx.save();
  return EXIT.ok;
}

// ================================================================================================ status --json (platform)

export async function statusJson(ctx: Ctx, o: { refresh?: boolean } = {}): Promise<Record<string, unknown>> {
  const modules: Record<string, unknown> = {};
  for (const [id, rec] of Object.entries(ctx.state.modules)) {
    if (!rec) continue;
    const st = rec.stacks[0];
    const live = o.refresh && st ? await describeStack(ctx.aws, st.stackName, st.region === ctx.region ? undefined : st.region) : undefined;
    const sw = moduleOf(id as ModuleId).switch;
    modules[id] = {
      enabled: true, driver: sw && 'ownedValues' in sw ? rec.value : (rec.tier === 'aws' ? 'aws' : rec.value), tier: rec.tier,
      stack: st ? { name: st.stackName, status: live?.status ?? st.status ?? null } : null,
      envFile: Object.keys(rec.env).length > 0,
      policyAttached: ctx.state.attachments.some((a) => a.module === id),
    };
  }
  const lock = ctx.platform ? await readLock(ctx.aws, ctx.platform.env.lockTable, ctx.env) : null;
  return {
    schema: 'cloudalbum.status/v1', env: ctx.env, mode: ctx.state.mode, stateEtag: ctx.platform?.store.etag ?? null,
    lock: lock ? { held: true, ...lock } : { held: false },
    modules, pendingHooks: ctx.state.platform?.pendingHooks ?? [], preview: ctx.state.platform?.preview ?? null,
    ...(ctx.state.suspended ? { suspended: ctx.state.suspended } : {}),
  };
}

/** random suffix for one-shot names */
export function shortId(): string {
  return randomBytes(4).toString('hex');
}
