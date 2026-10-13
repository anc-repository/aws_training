/**
 * Module-specific parts of enable / disable for the 8 MVP modules (stack parameters, secretParams, extra env settings,
 * extra delivery steps). Everything else is generic (registry driven). Secrets (D5): values are generated here or read
 * back from the instance's secrets.env over ssh, passed to the stack as NoEcho parameters and written to secrets.env;
 * they never reach modules.d, state.json or the printed plan.
 */
import { randomBytes } from 'node:crypto';
import type { ModuleId } from '@cloudalbum/contracts';
import type { Ctx } from './context.js';
import { RemoteScript } from './deliver.js';
import type { ModuleTarget } from './deps.js';
import type { EnvMap } from './env-file.js';
import { CliError, EXIT } from './printer.js';
import { isEnabled, registryVersion } from './registry.js';
import { loadTemplate, mainTemplatePath } from './template.js';
import { currentEnv } from './state.js';

export interface Prepared {
  /** module-specific stack parameters (on top of base context + injects + --param) */
  params: Record<string, string>;
  secretParams: string[];
  /** secrets.env upserts (logical secret env names) */
  secrets: Record<string, string>;
  /** env settings written to modules.d/<id>.env besides the Env* outputs */
  settings: EnvMap;
  /** extra steps of the delivery script (before check-config) */
  remote: Array<(s: RemoteScript) => void>;
  notes: string[];
  code?: { workspace: string; dir: string; functionId: string; bucketParam: string; keyParam: string };
}

export function newToken(bytes = 32): string {
  return randomBytes(bytes).toString('base64url');
}

/** Read keys of /etc/cloudalbum/secrets.env from the instance (ssh). Dry-run: placeholders. */
export async function readRemoteSecrets(ctx: Ctx, keys: readonly string[]): Promise<Record<string, string | undefined>> {
  if (!keys.length) return {};
  // platform mode: the delivery channel is SSM and Run Command output stays in the command history, so secrets are never
  // read back (06 §1.5 rule 3): callers generate a new value and hand it off (SecureString parameter, deliver.ts)
  if (ctx.platform) return {};
  if (ctx.dryRun) return Object.fromEntries(keys.map((k) => [k, `<secrets.env:${k}>`]));
  const s = new RemoteScript(`read ${keys.join(', ')} from secrets.env`);
  s.secret('__marker__');   // the output carries secret values: never over SSM (SsmDeliverer refuses)
  s.line(...keys.map((k) => `sed -n 's/^${k}=//p' /etc/cloudalbum/secrets.env | tail -1 | sed 's/^/${k}=/'`));
  const r = await ctx.deliverer().run(s, { capture: true, timeoutSec: 60 });
  if (r.code !== 0) throw new CliError(`cannot read secrets.env on the instance: ${r.stderr.trim()}`, EXIT.rules);
  const out: Record<string, string | undefined> = {};
  for (const line of r.stdout.split(/\r?\n/)) {
    const eq = line.indexOf('=');
    if (eq > 0 && keys.includes(line.slice(0, eq))) out[line.slice(0, eq)] = line.slice(eq + 1) || undefined;
  }
  return out;
}

function directUrl(ctx: Ctx): string {
  return `http://${ctx.ph(ctx.state.base?.publicIp, 'ec2:PublicIp')}`;
}

/** Base-context values for template parameters (9.1): resolved from the ec2 base stack outputs. */
export function baseContextParams(ctx: Ctx, id: ModuleId, templateParams: readonly string[]): Record<string, string> {
  const b = ctx.state.base;
  const known: Record<string, () => string> = {
    Env: () => ctx.env,
    ModuleVersion: () => String(registryVersion(id)),
    VpcId: () => ctx.ph(b?.vpcId, 'ec2:VpcId'),
    SubnetIds: () => (b?.defaultSubnetIds?.length ? b.defaultSubnetIds.join(',') : ctx.ph(undefined, 'default-vpc:SubnetIds')),
    InstanceSecurityGroupId: () => ctx.ph(b?.securityGroupId, 'ec2:InstanceSecurityGroupId'),
    InstanceId: () => ctx.ph(b?.instanceId, 'ec2:InstanceId'),
    InstanceAz: () => ctx.ph(b?.availabilityZone, 'ec2:AvailabilityZone'),
    OriginBaseUrl: () => directUrl(ctx),
    // platform mode (06 PM-29): every new IAM role / user carries the workload boundary; standalone passes nothing (template default '')
    ...(ctx.platform ? { PermissionsBoundaryArn: () => ctx.platform!.env.boundaryArn } : {}),
  };
  const out: Record<string, string> = {};
  for (const p of templateParams) if (known[p]) out[p] = known[p]!();
  return out;
}

export async function prepareModule(ctx: Ctx, target: ModuleTarget, opts: { mode?: string; params: Record<string, string> }): Promise<Prepared> {
  const p: Prepared = { params: {}, secretParams: [], secrets: {}, settings: { ...target.settings }, remote: [], notes: [] };
  const env = currentEnv(ctx.state);
  switch (target.module) {
    case 'iam': {
      const keys = target.value === 'keys';
      if (ctx.platform && keys) {
        // learner boundary forbids IAM users and access keys: keys mode only through the platform action (06 PM-31)
        throw new CliError('platform mode: iam keys mode is a platform action (card platformOps iam-keys-on / registry keysModeOn)', EXIT.rules, 'PLATFORM_ACTION_REQUIRED');
      }
      p.params.CreateDemoUser = keys ? 'true' : 'false';
      // platform mode (06 PM-31, ATL-IAM-001): CloudAlbumAppRole and its instance profile belong to the platform stack
      p.params.AppRoleMode = ctx.platform ? 'existing' : 'create';
      if (keys) p.notes.push('keys mode is the anti-pattern (CRED-002): a long-term access key lands in secrets.env');
      break;
    }
    case 'cdn': {
      const s = target.settings;
      p.settings.CDN_DIRECT_ACCESS = s.CDN_DIRECT_ACCESS ?? 'open';
      if (p.settings.CDN_DIRECT_ACCESS === 'admin-ip' && !s.CDN_ADMIN_CIDR) {
        throw new CliError('CDN_DIRECT_ACCESS=admin-ip needs --set CDN_ADMIN_CIDR=<your-ip>/32', EXIT.rules);
      }
      const dns = ctx.ph(ctx.state.base?.publicDnsName, 'ec2:InfoPublicDnsName');
      p.settings.CDN_ORIGIN_DIRECT_URL = s.CDN_ORIGIN_DIRECT_URL ?? `http://${dns}`;
      const mediaOrigin = s.CDN_MEDIA_ORIGIN ?? 'ec2';
      if (mediaOrigin === 's3' && !isEnabled(env, 'storage')) throw new CliError('CDN_MEDIA_ORIGIN=s3 needs storage (s3) first (DEP-010)', EXIT.rules);
      p.params.MediaOrigin = mediaOrigin;
      p.params.OriginType = s.CDN_ORIGIN_TYPE ?? 'ec2';
      if (p.params.OriginType !== 'ec2') throw new CliError(`CDN_ORIGIN_TYPE=${p.params.OriginType} needs load-balancer / network(private), not part of this round`, EXIT.rules);
      // DEP-014 (deploy scope): the ec2 origin needs the EIP association (stable public DNS name)
      if ((ctx.state.base?.params.AssociateEip ?? 'true') !== 'true') {
        throw new CliError('DEP-014: CDN_ORIGIN_TYPE=ec2 needs AssociateEip=true on the base stack (scripts/module base set AssociateEip=true)', EXIT.rules);
      }
      p.params.OriginDomainName = dns;
      p.params.CloudFrontPrefixListId = await cloudFrontPrefixList(ctx);
      const existing = (await readRemoteSecrets(ctx, ['ORIGIN_VERIFY'])).ORIGIN_VERIFY;
      const value = existing && !existing.startsWith('<') ? existing : newToken(32);
      if (!existing || existing.startsWith('<')) p.secrets.ORIGIN_VERIFY = value;
      p.params.OriginVerifySecret = value;
      p.secretParams.push('OriginVerifySecret');
      if (s.CDN_SIGNED_MEDIA === 'on') throw new CliError('CDN_SIGNED_MEDIA=on (cloudfront-signing-key) is not part of this round', EXIT.rules);
      break;
    }
    case 'storage': {
      // MUTEX-004 (deploy scope, rules.ts deployCheck stub): the bucket notification configuration may only enable EventBridge
      const t = loadTemplate(ctx.repoRoot, mainTemplatePath('storage'));
      for (const b of ['RawBucket', 'MediaBucket']) {
        const nc = t.Resources[b]?.Properties?.NotificationConfiguration as Record<string, unknown> | undefined;
        if (nc && Object.keys(nc).some((k) => k !== 'EventBridgeConfiguration')) {
          throw new CliError(`MUTEX-004: ${b}.NotificationConfiguration contains ${Object.keys(nc).join(', ')}; only EventBridgeConfiguration is allowed`, EXIT.rules);
        }
      }
      break;
    }
    case 'auth': {
      if ((target.settings.AUTH_MIGRATION ?? 'bulk') === 'lazy') {
        throw new CliError('AUTH_MIGRATION=lazy (User Migration trigger in the VPC) is not part of this round; use the default bulk migration', EXIT.rules);
      }
      if ((target.settings.COGNITO_LOGIN_MODE ?? 'sdk') === 'managed') {
        throw new CliError('COGNITO_LOGIN_MODE=managed (hosted login, /api/auth/login + callback) is not part of this round; use LoginMode=sdk', EXIT.rules);
      }
      if ((target.settings.AUTH_DUAL_STACK ?? 'off') === 'on') {
        throw new CliError('AUTH_DUAL_STACK=on (local + Cognito during the migration window) is not part of this round', EXIT.rules);
      }
      p.settings.AUTH_MIGRATION = 'bulk';
      p.settings.AUTH_DUAL_STACK = target.settings.AUTH_DUAL_STACK ?? 'off';
      p.params.LoginMode = target.settings.COGNITO_LOGIN_MODE ?? 'sdk';
      p.params.EnableTriggers = (target.settings.COGNITO_TRIGGERS ?? 'off') === 'on' ? 'true' : 'false';
      break;
    }
    case 'image-processing': {
      if (target.tier !== 'aws') { p.settings.IMAGE_PROCESSOR = target.value; break; }
      if (!ctx.state.toolchain?.bucket && !ctx.dryRun) throw new CliError('prerequisite toolchain: run `scripts/module bootstrap` first', EXIT.rules);
      // platform mode default: queue (no inbound traffic, no secret read-back; cards C-8 / 06 platform mode of image-processing)
      const channel = target.settings.IMAGE_RESULT_CHANNEL ?? opts.params.ResultChannel
        ?? (ctx.platform || isEnabled(env, 'cdn') || ctx.state.modules.cdn ? 'queue' : 'callback');
      if (ctx.platform && channel === 'callback') {
        throw new CliError('platform mode: IMAGE_RESULT_CHANNEL=callback needs CALLBACK_HMAC_KEY read back from the instance; use ResultChannel=queue', EXIT.rules, 'PLATFORM_UNSUPPORTED');
      }
      if (!target.settings.IMAGE_RESULT_CHANNEL && channel === 'queue') {
        p.notes.push('IMAGE_RESULT_CHANNEL=queue chosen automatically: cdn is enabled, the callback must not go through CloudFront (DEP-020)');
      }
      p.params.ResultChannel = channel;
      p.params.Trigger = target.settings.IMAGE_TRIGGER ?? 'eventbridge';
      if (channel === 'callback') {
        const key = (await readRemoteSecrets(ctx, ['CALLBACK_HMAC_KEY'])).CALLBACK_HMAC_KEY;
        if (!key) throw new CliError('CALLBACK_HMAC_KEY missing in secrets.env (generated by l0-bootstrap.sh)', EXIT.rules);
        p.params.CallbackHmacKey = key;
        p.secretParams.push('CallbackHmacKey');
        p.notes.push('callback channel over http:// (DEP-021 warning): HMAC prevents forgery, not eavesdropping');
      }
      p.code = { workspace: '@cloudalbum/lambda-image-thumbnail', dir: 'lambdas/image-thumbnail', functionId: 'image-thumbnail',
        bucketParam: 'CodeS3Bucket', keyParam: 'CodeS3Key' };
      break;
    }
    case 'cache': {
      if (target.tier === 'self-hosted') {
        p.remote.push((s) => s.comment('cache local tier: self-hosted Valkey').line('bash /opt/cloudalbum/scripts/selfhost/valkey.sh apply'));
        break;
      }
      if (target.tier === 'local') break;
      if (opts.params.AuthToken === 'generate') {
        const token = newToken(32);
        p.params.AuthToken = token;
        p.secrets.REDIS_AUTH_TOKEN = token;
        p.secretParams.push('AuthToken');
      }
      break;
    }
    case 'database': {
      if (target.tier === 'self-hosted') {
        const existing = (await readRemoteSecrets(ctx, ['DB_PASSWORD'])).DB_PASSWORD;
        if (!existing || existing.startsWith('<')) p.secrets.DB_PASSWORD = newToken(24);
        p.remote.push((s) => s.comment('database local tier: PostgreSQL 16 on this instance').line('bash /opt/cloudalbum/scripts/selfhost/postgres.sh apply'));
        break;
      }
      const managed = env.SECRETS_DRIVER === 'secretsmanager';
      p.params.ManageMasterPassword = managed ? 'true' : 'false';
      if (!managed) {
        const existing = (await readRemoteSecrets(ctx, ['DB_PASSWORD'])).DB_PASSWORD;
        const pw = existing && !existing.startsWith('<') ? existing : newToken(24);
        if (!existing || existing.startsWith('<')) p.secrets.DB_PASSWORD = pw;
        p.params.MasterUserPassword = pw;
        p.secretParams.push('MasterUserPassword');
      }
      const r = ctx.region;
      p.remote.push((s) => s.comment('RDS CA bundle (public, not a secret) for DB_SSL_CA')
        .line(`ca_ca=$(mktemp); curl -fsSL https://truststore.pki.rds.amazonaws.com/${r}/${r}-bundle.pem -o "$ca_ca"`,
          'install -o root -g cloudalbum -m 0640 "$ca_ca" /etc/cloudalbum/rds-ca.pem; rm -f "$ca_ca"'));
      p.notes.push('RDS is billed per hour: disable it (or `profile apply l0-ec2`) when the lab is over');
      break;
    }
    default:
      break;
  }
  return p;
}

async function cloudFrontPrefixList(ctx: Ctx): Promise<string> {
  const r = await ctx.aws.send<{ PrefixLists?: Array<{ PrefixListId?: string }> }>({
    service: 'ec2', op: 'DescribeManagedPrefixLists',
    input: { Filters: [{ Name: 'prefix-list-name', Values: ['com.amazonaws.global.cloudfront.origin-facing'] }] },
  });
  return ctx.ph(r?.PrefixLists?.[0]?.PrefixListId, 'pl:cloudfront-origin-facing');
}

/** iam keys mode (anti-pattern): create the access key out of band and return the secrets.env lines. */
export async function createDemoAccessKey(ctx: Ctx, userName: string): Promise<Record<string, string>> {
  const r = await ctx.aws.send<{ AccessKey?: { AccessKeyId?: string; SecretAccessKey?: string } }>({
    service: 'iam', op: 'CreateAccessKey', input: { UserName: userName },
  });
  if (ctx.dryRun) return { IAM_KEYS_ACCESS_KEY_ID: '<AKIA…>', IAM_KEYS_SECRET_ACCESS_KEY: '<secret>' };
  const k = r?.AccessKey;
  if (!k?.AccessKeyId || !k.SecretAccessKey) throw new CliError('iam:CreateAccessKey returned no key', EXIT.stack);
  ctx.state.outOfBand.push({ module: 'iam', kind: 'access-key', id: k.AccessKeyId, at: new Date().toISOString() });
  return { IAM_KEYS_ACCESS_KEY_ID: k.AccessKeyId, IAM_KEYS_SECRET_ACCESS_KEY: k.SecretAccessKey };
}

export async function deleteDemoAccessKeys(ctx: Ctx, userName: string): Promise<void> {
  for (const k of ctx.state.outOfBand.filter((x) => x.module === 'iam' && x.kind === 'access-key')) {
    await ctx.aws.send({ service: 'iam', op: 'DeleteAccessKey', input: { UserName: userName, AccessKeyId: k.id } }).catch(() => undefined);
  }
  if (!ctx.dryRun) ctx.state.outOfBand = ctx.state.outOfBand.filter((x) => !(x.module === 'iam' && x.kind === 'access-key'));
}

/** HTTPS entry origins only (Cognito callback URLs must be https except localhost). */
export function httpsOnly(origins: string): string {
  return origins.split(',').map((s) => s.trim()).filter((s) => s.startsWith('https://')).join(',');
}
