/**
 * scripts/module hook of email (wave1-sns-ses). Contract: ./types.ts.
 * Design: docs/modules/04-compute-async.md#email (section 6 "切换、数据迁移与回滚", section 0 registry entry, section 12 platform mode).
 *
 * What this module needs beyond the generic flow:
 *   - prerequisite ses-identity (manual): --param Email=<address> (e-mail identity, no own domain needed) or --param Domain=<domain>
 *     (also --domain <domain>; Easy DKIM, 3 CNAMEs). Without either, `enable` exits 2 with the hint and `plan` skips the module.
 *     Re-enabling (e.g. `enable email --param ForCognito=true`) keeps the identity parameters of the last deployment.
 *   - preflight (prepare): sesv2:GetEmailIdentity. An identity that already exists in this account and region is adopted read-only
 *     (AdoptExistingIdentity=true, 06 PM-M24): the stack does not create it and disable does not delete it. The value is never
 *     flipped on an update of an existing stack (flipping would delete or re-create a verified identity). sesv2:GetAccount prints
 *     the sandbox notice (sandbox status is per region; production access is a manual request).
 *   - afterDeploy: poll sesv2:GetEmailIdentity until VerifiedForSendingStatus=true (the learner clicks the AWS verification e-mail,
 *     or the DKIM CNAMEs propagate). Timeout (--param VerifyTimeoutSec, default 900) -> exit 5 before the env is written; the stack
 *     stays, re-run `scripts/module enable email` later (section 6 step 2).
 *   - --param ForCognito=true -> EnvEmailForCognito=on (template output) -> the registry injects InfoIdentityArn into auth
 *     (SesIdentityArn); with dns enabled the HostedZoneId inject lets the stack write the DKIM / MAIL FROM records.
 *   - settings: EMAIL_SANDBOX_POLICY (fail | outbox, default fail) and EMAIL_SEND_RATE_PER_SEC (default 1) via --set.
 * Platform mode: the GetEmailIdentity / GetAccount preflight is read-only (no out-of-band resources).
 */
import type { ModuleHook } from './types.js';
import { isAwsError } from '../aws.js';
import { CliError, EXIT } from '../printer.js';
import { currentEnv } from '../state.js';
import { isEnabled } from '../registry.js';

const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;
const DOMAIN_RE = /^([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;
const RESERVED = /(^|[@.])(example\.(com|net|org))$|\.(example|invalid|test|localhost)$/i;

interface Identity { kind: 'Email' | 'Domain'; value: string }

/** the identity of this operation: --param Email / --param Domain / --domain, else the last deployment */
export function identityOf(params: Readonly<Record<string, string>>, domainArg: string | undefined, prev?: Readonly<Record<string, string>>): Identity | undefined {
  const email = (params.Email ?? '').trim().toLowerCase();
  const domain = (params.Domain ?? domainArg ?? '').trim().toLowerCase();
  if (email && domain) throw new CliError('email: --param Email and --param Domain (--domain) are mutually exclusive', EXIT.rules, 'BAD_PARAM');
  if (email) return { kind: 'Email', value: email };
  if (domain) return { kind: 'Domain', value: domain };
  if (prev?.Email) return { kind: 'Email', value: prev.Email };
  if (prev?.Domain) return { kind: 'Domain', value: prev.Domain };
  return undefined;
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export const emailHook: ModuleHook = {
  id: 'email',

  planHints(target) {
    if (target.tier !== 'aws') return [];
    return [
      'manual prerequisite "ses-identity": a verified SES sender identity (--param Email=<an address you can read> and click the AWS '
      + 'verification e-mail, or --param Domain=<your own domain> with 3 DKIM CNAMEs); in the SES sandbox recipients must be verified too',
    ];
  },

  plan(ctx, step, args) {
    if (step.tier !== 'aws' || !args.isTarget) return {};
    const prev = ctx.state.modules.email?.params;
    const id = identityOf(args.params, args.domain, prev);
    if (!id) {
      return {
        missing: [{
          prerequisite: 'ses-identity',
          message: 'no SES sender identity given (an e-mail address you can read, or your own domain)',
          hint: 'scripts/module enable email --param Email=<your address>   (or --param Domain=<your domain>; then click the AWS verification e-mail / add the DKIM CNAMEs)',
        }],
      };
    }
    if (id.kind === 'Email' && !EMAIL_RE.test(id.value)) throw new CliError(`email: Email=${id.value} is not an e-mail address`, EXIT.rules, 'BAD_PARAM');
    if (id.kind === 'Domain' && !DOMAIN_RE.test(id.value)) throw new CliError(`email: Domain=${id.value} is not a domain name`, EXIT.rules, 'BAD_PARAM');
    if (RESERVED.test(id.value)) {
      return {
        missing: [{
          prerequisite: 'ses-identity',
          message: `${id.value} is a reserved name (example.com, .test, ...): it can never be verified`,
          hint: 'use an address or a domain you control: scripts/module enable email --param Email=<your address>',
        }],
      };
    }
    const settings: Record<string, string> = {
      // same value as the EnvSesIdentity output; known before the deployment, so the staged check-config --plan sees it too
      SES_IDENTITY: id.value,
      EMAIL_SANDBOX_POLICY: step.settings.EMAIL_SANDBOX_POLICY ?? 'fail',
      EMAIL_SEND_RATE_PER_SEC: step.settings.EMAIL_SEND_RATE_PER_SEC ?? '1',
    };
    if (!['fail', 'outbox'].includes(settings.EMAIL_SANDBOX_POLICY!)) {
      throw new CliError('email: EMAIL_SANDBOX_POLICY must be fail or outbox', EXIT.rules, 'BAD_SETTING');
    }
    const notes = [
      `sender identity ${id.kind === 'Email' ? 'e-mail address' : 'domain'} ${id.value} (manual prerequisite ses-identity)`
      + (id.kind === 'Email' ? ': click the link in the "Amazon Web Services – Email Address Verification Request" e-mail after the deployment'
        : isEnabled(currentEnv(ctx.state), 'dns') ? ': the dns module zone gets the 3 DKIM CNAMEs (HostedZoneId inject)'
          : ': add the 3 DKIM CNAMEs (Info output InfoDkimRecords) at your DNS provider'),
      'SES sandbox (per region): only verified addresses and the SES mailbox simulator receive mail until production access is granted',
    ];
    if (args.params.ForCognito === 'true') {
      notes.push(isEnabled(currentEnv(ctx.state), 'auth')
        ? 'ForCognito=true: the auth stack gets SesIdentityArn (User Pool EmailConfiguration DEVELOPER)'
        : 'ForCognito=true: auth is not enabled; the SesIdentityArn inject is applied when auth (cognito) is enabled');
    }
    return { settings, notes };
  },

  async prepare(ctx, step, args, p) {
    if (step.tier !== 'aws' || !args.isTarget) return;
    const prev = ctx.state.modules.email?.params;
    const id = identityOf(args.params, args.domain, prev);
    if (!id) return;   // plan() already reported the missing prerequisite
    p.params.Email = id.kind === 'Email' ? id.value : '';
    p.params.Domain = id.kind === 'Domain' ? id.value : '';
    if (prev?.ForCognito && args.params.ForCognito === undefined) p.params.ForCognito = prev.ForCognito;
    const sameIdentity = prev && (prev.Email ?? '') === p.params.Email && (prev.Domain ?? '') === p.params.Domain;
    if (prev?.AdoptExistingIdentity && sameIdentity) {
      p.params.AdoptExistingIdentity = prev.AdoptExistingIdentity;   // never flip on an update
    } else {
      let found: { VerifiedForSendingStatus?: boolean; VerificationStatus?: string } | null | undefined;
      try {
        found = await ctx.aws.send({ service: 'sesv2', op: 'GetEmailIdentity', input: { EmailIdentity: id.value } });
      } catch (e) {
        if (!isAwsError(e, 'NotFoundException')) throw e;
        found = null;
      }
      if (found === undefined) {
        p.params.AdoptExistingIdentity = 'false';
        p.notes.push(`email: (dry-run) GetEmailIdentity ${id.value} not executed: assuming the stack creates the identity (AdoptExistingIdentity=false)`);
      } else if (found) {
        p.params.AdoptExistingIdentity = 'true';
        p.notes.push(`email: identity ${id.value} already exists (${found.VerifiedForSendingStatus ? 'verified' : found.VerificationStatus ?? 'pending'}): adopted read-only, disable will not delete it`);
      } else {
        p.params.AdoptExistingIdentity = 'false';
      }
    }
    const account = await ctx.aws.send<{ ProductionAccessEnabled?: boolean; SendQuota?: { Max24HourSend?: number } }>({ service: 'sesv2', op: 'GetAccount', input: {} });
    if (account && !account.ProductionAccessEnabled) {
      p.notes.push(`email: SES is in the sandbox in ${ctx.region} (max ${account.SendQuota?.Max24HourSend ?? '?'} per 24 h): recipients must be verified addresses or the mailbox simulator`);
    }
  },

  async afterDeploy(ctx, _step, args, deployed) {
    const identity = deployed.outputs.EnvSesIdentity;
    if (deployed.outputs.InfoDkimRecords && !deployed.outputs.InfoDkimRecords.startsWith('n/a') && !deployed.outputs.InfoDkimWrittenBy?.startsWith('this stack')) {
      ctx.out.warn(`      email: add these DKIM records at your DNS provider: ${deployed.outputs.InfoDkimRecords}`);
    }
    if (ctx.dryRun || !identity) {
      ctx.out.dry('poll sesv2:GetEmailIdentity until VerifiedForSendingStatus=true (the env is written only after that)');
      return;
    }
    const timeoutSec = Math.max(30, Number(args.params.VerifyTimeoutSec ?? 900) || 900);
    const deadline = Date.now() + timeoutSec * 1000;
    let last = '';
    for (;;) {
      const r = await ctx.aws.send<{ VerifiedForSendingStatus?: boolean; VerificationStatus?: string; DkimAttributes?: { Status?: string } }>(
        { service: 'sesv2', op: 'GetEmailIdentity', input: { EmailIdentity: identity } });
      if (r?.VerifiedForSendingStatus) {
        ctx.out.info(`      email: ${identity} verified (DKIM ${r.DkimAttributes?.Status ?? 'n/a'})`);
        return;
      }
      const status = `${r?.VerificationStatus ?? 'PENDING'} / DKIM ${r?.DkimAttributes?.Status ?? 'n/a'}`;
      if (status !== last) ctx.out.info(`      email: waiting for ${identity} to be verified (${status}); click the AWS verification e-mail / check the DKIM CNAMEs`);
      last = status;
      if (Date.now() > deadline) {
        throw new CliError(`email: ${identity} is still not verified after ${timeoutSec} s (${status}); the stack is kept and the env is not written. `
          + 'Verify the identity, then run `scripts/module enable email` again', EXIT.health, 'SES_IDENTITY_UNVERIFIED');
      }
      await sleep(15_000);
    }
  },

  beforeDisable(_ctx, rec) {
    const notes = ['outbox_emails history stays in place; the feedback queue is deleted with the stack (pending SES events are dropped)'];
    if (rec.env.EMAIL_FOR_COGNITO === 'on') {
      notes.push('EMAIL_FOR_COGNITO=on: the auth stack gets SesIdentityArn=\'\' first (User Pool back to COGNITO_DEFAULT, whose daily e-mail quota is low)');
    }
    if (rec.params.AdoptExistingIdentity === 'true') notes.push(`sender identity ${rec.params.Email || rec.params.Domain} was adopted: it is not deleted`);
    return { notes };
  },

  afterDisable(ctx, rec) {
    if (rec.params.Domain && !rec.outputs.InfoDkimWrittenBy?.startsWith('this stack')) {
      ctx.out.warn(`      email: remove the DKIM CNAMEs of ${rec.params.Domain} you added at your DNS provider`);
    }
  },
};
