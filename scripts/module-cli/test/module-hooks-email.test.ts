// wave1-sns-ses: module hook of email (module-hooks/email.ts) — manual prerequisite ses-identity, identity parameters, adopting an
// existing identity (06 PM-M24), the sandbox notice, waiting for verification, disable notes. No AWS call is executed: dry-run
// gateway, or a scripted fake gateway for the read-only SES calls.
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AwsCallError, type AwsCall, type AwsGateway } from '../src/aws.js';
import { createContext } from '../src/context.js';
import { disableCommand } from '../src/disable.js';
import { enableCommand } from '../src/enable.js';
import type { Prepared } from '../src/hooks.js';
import { emailHook, identityOf } from '../src/module-hooks/email.js';
import type { PlanStep } from '../src/deps.js';
import type { HookArgs } from '../src/module-hooks/index.js';
import { CapturePrinter, CliError } from '../src/printer.js';
import type { ModuleRecord } from '../src/state.js';
import { REPO_ROOT, RecordingDeliverer, deployedState, dryContext } from './helpers.js';

class ScriptedGateway implements AwsGateway {
  readonly dryRun = false;
  readonly calls: AwsCall[] = [];
  constructor(private readonly reply: (c: AwsCall) => unknown) {}
  async send<T>(call: AwsCall): Promise<T | undefined> {
    this.calls.push(call);
    const r = this.reply(call);
    if (r instanceof Error) throw new AwsCallError(call, r);
    return r as T;
  }
}

function liveContext(reply: (c: AwsCall) => unknown) {
  const out = new CapturePrinter();
  const aws = new ScriptedGateway(reply);
  const ctx = createContext({ yes: true, skipLocalCheck: true, state: path.join(REPO_ROOT, '.cloudalbum', 'never-written.json') },
    { aws, out, deliverer: new RecordingDeliverer(false), repoRoot: REPO_ROOT, state: deployedState() });
  return { ctx, out, aws };
}

const step: PlanStep = { module: 'email', value: 'ses', tier: 'aws', settings: {}, reason: 'requested', isTarget: true };
const args = (params: Record<string, string> = {}, extra: Partial<HookArgs> = {}): HookArgs => ({ params, planOnly: false, isTarget: true, ...extra });
const prepared = (): Prepared => ({ params: {}, secretParams: [], secrets: {}, settings: {}, remote: [], notes: [] });
const notFound = () => Object.assign(new Error('Email identity <x> does not exist.'), { name: 'NotFoundException' });

afterEach(() => vi.restoreAllMocks());

describe('email hook: manual prerequisite ses-identity', () => {
  it('without --param Email / Domain: enable exits 2 with the hint; plan prints it and skips (exit 0); no stack is touched', async () => {
    const a = dryContext();
    expect(await enableCommand(a.ctx, 'email', { withDeps: true })).toBe(2);
    expect(a.out.text()).toContain('manual prerequisite "ses-identity" is not met');
    expect(a.out.text()).toContain('scripts/module enable email --param Email=<your address>');
    expect(a.aws.calls.filter((c) => /Stack$/.test(c.op))).toEqual([]);
    const b = dryContext();
    expect(await enableCommand(b.ctx, 'email', { withDeps: true, planOnly: true })).toBe(0);
    expect(b.out.text()).toContain('plan skipped: email');
  });

  it('a reserved name can never be verified: missing prerequisite; Email and Domain together are refused', async () => {
    const { ctx } = dryContext();
    const r = await emailHook.plan!(ctx, step, args({ Email: 'me@example.com' }));
    expect(r.missing?.[0]).toMatchObject({ prerequisite: 'ses-identity', message: expect.stringContaining('reserved') });
    expect(() => identityOf({ Email: 'a@b.dev', Domain: 'b.dev' }, undefined)).toThrow(CliError);
    expect(() => emailHook.plan!(ctx, step, args({ Email: 'not-an-address' }))).toThrow(/not an e-mail address/);
  });

  it('identityOf: --param Email > --param Domain / --domain > the last deployment', () => {
    expect(identityOf({ Email: 'Me@Mail.dev' }, undefined)).toEqual({ kind: 'Email', value: 'me@mail.dev' });
    expect(identityOf({}, 'mail.example.org')).toEqual({ kind: 'Domain', value: 'mail.example.org' });
    expect(identityOf({}, undefined, { Email: '', Domain: 'mail.corp.dev' })).toEqual({ kind: 'Domain', value: 'mail.corp.dev' });
    expect(identityOf({}, undefined)).toBeUndefined();
  });

  it('enable --param Email (dry-run): identity parameters on the stack, SES_IDENTITY / EMAIL_SANDBOX_POLICY / rate in the env, sandbox note', async () => {
    const { ctx, out, aws } = dryContext();
    expect(await enableCommand(ctx, 'email', { withDeps: true, param: ['Email=you@mail.dev'], set: ['EMAIL_SANDBOX_POLICY=outbox'] })).toBe(0);
    const deploy = aws.calls.find((c) => c.op === 'CreateOrUpdateStack' && c.input.StackName === 'cloudalbum-lab-email')!;
    const params = Object.fromEntries((deploy.input.Parameters as Array<{ ParameterKey: string; ParameterValue: string }>).map((p) => [p.ParameterKey, p.ParameterValue]));
    expect(params).toMatchObject({ Email: 'you@mail.dev', Domain: '', AdoptExistingIdentity: 'false' });
    expect(aws.calls.filter((c) => c.service === 'sesv2').map((c) => c.op)).toEqual(['GetEmailIdentity', 'GetAccount']);
    expect(ctx.state.modules.email?.env).toMatchObject({ SES_IDENTITY: 'you@mail.dev', EMAIL_SANDBOX_POLICY: 'outbox', EMAIL_SEND_RATE_PER_SEC: '1', EMAIL_DRIVER: 'ses', EMAIL_FOR_COGNITO: 'off' });
    expect(out.text()).toContain('SES sandbox (per region)');
    expect(out.text()).toContain('poll sesv2:GetEmailIdentity until VerifiedForSendingStatus=true');
  });

  it('--domain with dns enabled: DKIM records come from the HostedZoneId inject (note)', async () => {
    const { ctx } = dryContext();
    ctx.state.modules.dns = { tier: 'aws', value: 'route53', env: { MODULE_DNS: 'on', DNS_PROVIDER: 'route53' } } as unknown as ModuleRecord;
    const r = await emailHook.plan!(ctx, step, args({}, { domain: 'mail.corp.dev' }));
    expect(r.notes?.[0]).toContain('the dns module zone gets the 3 DKIM CNAMEs');
    const p = prepared();
    await emailHook.prepare!(ctx, step, args({}, { domain: 'mail.corp.dev' }), p);
    expect(p.params).toMatchObject({ Email: '', Domain: 'mail.corp.dev' });
  });
});

describe('email hook: preflight (prepare)', () => {
  it('an identity that already exists is adopted read-only (AdoptExistingIdentity=true); NotFound -> the stack creates it', async () => {
    const found = liveContext((c) => (c.op === 'GetEmailIdentity' ? { VerifiedForSendingStatus: true } : { ProductionAccessEnabled: false, SendQuota: { Max24HourSend: 200 } }));
    const p = prepared();
    await emailHook.prepare!(found.ctx, step, args({ Email: 'you@mail.dev' }), p);
    expect(p.params.AdoptExistingIdentity).toBe('true');
    expect(p.notes.join('\n')).toContain('adopted read-only');
    expect(p.notes.join('\n')).toContain('SES is in the sandbox in ap-northeast-1 (max 200 per 24 h)');
    const missing = liveContext((c) => (c.op === 'GetEmailIdentity' ? notFound() : { ProductionAccessEnabled: true }));
    const q = prepared();
    await emailHook.prepare!(missing.ctx, step, args({ Email: 'you@mail.dev' }), q);
    expect(q.params.AdoptExistingIdentity).toBe('false');
    expect(q.notes).toEqual([]);
  });

  it('an update of an existing stack never flips AdoptExistingIdentity (no GetEmailIdentity); ForCognito is carried over', async () => {
    const { ctx, aws } = liveContext(() => ({ ProductionAccessEnabled: true }));
    ctx.state.modules.email = { params: { Email: 'you@mail.dev', Domain: '', AdoptExistingIdentity: 'false', ForCognito: 'true' } } as unknown as ModuleRecord;
    const p = prepared();
    await emailHook.prepare!(ctx, step, args({}), p);
    expect(p.params).toMatchObject({ Email: 'you@mail.dev', AdoptExistingIdentity: 'false', ForCognito: 'true' });
    expect(aws.calls.map((c) => c.op)).toEqual(['GetAccount']);
  });
});

describe('email hook: waiting for verification (afterDeploy)', () => {
  const deployed = { outputs: { EnvSesIdentity: 'you@mail.dev', InfoDkimRecords: 'n/a' }, byStack: {}, stacks: [] };

  it('returns as soon as GetEmailIdentity reports VerifiedForSendingStatus=true', async () => {
    const { ctx, out, aws } = liveContext(() => ({ VerifiedForSendingStatus: true, DkimAttributes: { Status: 'NOT_STARTED' } }));
    await emailHook.afterDeploy!(ctx, step, args(), deployed, prepared());
    expect(aws.calls).toHaveLength(1);
    expect(out.text()).toContain('you@mail.dev verified');
  });

  it('still unverified after VerifyTimeoutSec -> exit 5 (SES_IDENTITY_UNVERIFIED) before the env is written', async () => {
    const { ctx } = liveContext(() => ({ VerifiedForSendingStatus: false, VerificationStatus: 'PENDING' }));
    const t0 = Date.now();
    vi.spyOn(Date, 'now').mockReturnValueOnce(t0).mockReturnValue(t0 + 3_600_000);
    await expect(emailHook.afterDeploy!(ctx, step, args({ VerifyTimeoutSec: '60' }), deployed, prepared()))
      .rejects.toMatchObject({ exitCode: 5, code: 'SES_IDENTITY_UNVERIFIED' });
  });

  it('a domain identity whose DKIM records were not written by the stack prints them', async () => {
    const { ctx, out } = dryContext();
    await emailHook.afterDeploy!(ctx, step, args(), {
      outputs: { EnvSesIdentity: 'mail.corp.dev', InfoDkimRecords: 'a._domainkey.mail.corp.dev CNAME a.dkim.amazonses.com', InfoDkimWrittenBy: 'you (external DNS provider) or not applicable' },
      byStack: {}, stacks: [],
    }, prepared());
    expect(out.text()).toContain('add these DKIM records at your DNS provider: a._domainkey.mail.corp.dev CNAME a.dkim.amazonses.com');
  });
});

describe('email hook: disable and hints', () => {
  it('disable --dry-run: notes for EMAIL_FOR_COGNITO=on and an adopted identity; the stack is deleted', async () => {
    const { ctx, out, aws } = dryContext();
    expect(await enableCommand(ctx, 'email', { withDeps: true, param: ['Email=you@mail.dev'] })).toBe(0);
    ctx.state.modules.email!.env.EMAIL_FOR_COGNITO = 'on';
    ctx.state.modules.email!.params.AdoptExistingIdentity = 'true';
    expect(await disableCommand(ctx, 'email', {})).toBe(0);
    expect(out.text()).toContain('EMAIL_FOR_COGNITO=on: the auth stack gets SesIdentityArn=\'\' first');
    expect(out.text()).toContain('sender identity you@mail.dev was adopted: it is not deleted');
    expect(aws.calls.some((c) => c.op === 'DeleteStack' && c.input.StackName === 'cloudalbum-lab-email')).toBe(true);
  });

  it('planHints (plan --start-of / --single) name the manual prerequisite; local tier has none', () => {
    expect(emailHook.planHints!(step).join(' ')).toContain('manual prerequisite "ses-identity"');
    expect(emailHook.planHints!({ ...step, tier: 'local', value: 'outbox' })).toEqual([]);
  });
});
