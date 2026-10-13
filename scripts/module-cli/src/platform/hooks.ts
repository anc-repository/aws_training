/**
 * Platform hooks of scripts/module (06 PM-36): steps that need the learner identity although the runner triggered them.
 * Only hook today: cognito-passwords (the admin and the seeded test users get their known passwords in the User Pool).
 *   registered : after `enable auth` (cognito) or `seed cognito-test-users` with auth=cognito — the runner only registers it
 *   run        : `scripts/module hooks run --pending --platform` (learner): ATL-WorkstationSetup runs it once; idempotent
 */
import type { Ctx } from '../context.js';
import { CliError, EXIT } from '../printer.js';
import { stackName } from '../registry.js';
import { describeStack } from '../stack.js';
import { nowIso, recordHistory } from '../state.js';

function requirePlatform(ctx: Ctx, what: string): NonNullable<Ctx['platform']> {
  if (!ctx.platform) throw new CliError(`${what} only exists in platform mode (--platform or CLOUDALBUM_PLATFORM_MODE=1)`, EXIT.rules, 'PLATFORM_ONLY');
  return ctx.platform;
}

function json(o: unknown): void {
  process.stdout.write(`${JSON.stringify(o, null, 2)}\n`);
}


export const ADMIN_EMAIL = 'atl-admin@example.com';

export async function ssmParam(ctx: Ctx, name: string): Promise<string | undefined> {
  try {
    const r = await ctx.aws.send<{ Parameter?: { Value?: string } }>({ service: 'ssm', op: 'GetParameter', input: { Name: name, WithDecryption: true } });
    return r?.Parameter?.Value;
  } catch (e) {
    if (/ParameterNotFound/.test(String((e as Error).message))) return undefined;
    throw e;
  }
}

async function userPoolId(ctx: Ctx): Promise<string | undefined> {
  const rec = ctx.state.modules.auth;
  if (rec?.outputs?.InfoUserPoolId) return rec.outputs.InfoUserPoolId;
  const info = await describeStack(ctx.aws, stackName(ctx.env, 'auth'));
  return info?.outputs.InfoUserPoolId;
}

/** cognito-passwords: admin + test users get their known passwords in the User Pool (learner identity; idempotent) */
async function cognitoPasswordsHook(ctx: Ctx): Promise<{ users: number }> {
  const p = requirePlatform(ctx, 'hooks');
  const pool = await userPoolId(ctx);
  if (!pool && !ctx.dryRun) throw new CliError('cognito-passwords: the auth User Pool does not exist', EXIT.stack, 'USER_POOL_MISSING');
  const users: Array<{ email: string; password: string }> = [];
  const admin = await ssmParam(ctx, p.env.adminPasswordParam);
  if (admin) users.push({ email: ADMIN_EMAIL, password: admin });
  if (p.env.testUsersParam) {
    const raw = await ssmParam(ctx, p.env.testUsersParam);
    if (raw) for (const u of JSON.parse(raw) as Array<{ email: string; password: string }>) users.push({ email: u.email, password: u.password });
  }
  for (const u of users) {
    try {
      await ctx.aws.send({ service: 'cognito-idp', op: 'AdminGetUser', input: { UserPoolId: pool, Username: u.email } });
    } catch (e) {
      if (!/UserNotFound/.test(String((e as Error).message))) throw e;
      await ctx.aws.send({ service: 'cognito-idp', op: 'AdminCreateUser', input: { UserPoolId: pool, Username: u.email, MessageAction: 'SUPPRESS',
        UserAttributes: [{ Name: 'email', Value: u.email }, { Name: 'email_verified', Value: 'true' }] } });
    }
    await ctx.aws.send({ service: 'cognito-idp', op: 'AdminSetUserPassword', input: { UserPoolId: pool, Username: u.email, Password: u.password, Permanent: true },
      display: { UserPoolId: pool, Username: u.email, Password: '***', Permanent: true } });
  }
  return { users: users.length };
}

/** register a hook; a learner caller runs it right away (06 PM-36) */
export async function registerHook(ctx: Ctx, id: 'cognito-passwords', reason: string): Promise<void> {
  if (!ctx.platform || !ctx.state.platform) return;
  if (!ctx.state.platform.pendingHooks.some((h) => h.id === id)) {
    ctx.state.platform.pendingHooks.push({ id, reason, createdAt: nowIso(), requires: 'learner' });
  }
  if (ctx.platform.identity?.kind === 'learner' || ctx.platform.identity?.kind === 'console') await hooksRun(ctx, { pending: true });
}

export async function hooksRun(ctx: Ctx, o: { pending?: boolean }): Promise<number> {
  const p = requirePlatform(ctx, 'hooks run');
  if (!o.pending) throw new CliError('hooks run needs --pending', EXIT.rules, 'USAGE');
  const hooks = [...(ctx.state.platform?.pendingHooks ?? [])];
  if (p.identity?.kind === 'provisioner') {
    ctx.out.info(`hooks: ${hooks.length} pending hook(s) need the learner identity (registered only)`);
    json({ ran: [], pending: hooks.map((h) => h.id) });
    return EXIT.ok;
  }
  const ran: string[] = [];
  for (const h of hooks) {
    p.reporter.progress('finalize', 'started', `hook ${h.id}`);
    if (h.id === 'cognito-passwords') {
      const r = await cognitoPasswordsHook(ctx);
      ctx.out.info(`hook cognito-passwords: ${r.users} user(s) synchronized`);
      for (const s of Object.values(ctx.state.platform?.seeds ?? {})) if (s.cognito === 'pending') s.cognito = 'done';
    }
    if (!ctx.dryRun && ctx.state.platform) ctx.state.platform.pendingHooks = ctx.state.platform.pendingHooks.filter((x) => x.id !== h.id);
    ran.push(h.id);
  }
  recordHistory(ctx.state, { op: 'hooks run', result: ctx.dryRun ? 'dry-run' : 'ok', exitCode: EXIT.ok, detail: ran.join(',') || 'none', opId: p.opId,
    ...(p.identity ? { actor: p.identity.sessionName } : {}) });
  ctx.save();
  json({ ran, pending: ctx.state.platform?.pendingHooks.map((h) => h.id) ?? [] });
  return EXIT.ok;
}

