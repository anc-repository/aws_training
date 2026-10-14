/**
 * scripts/module hook of shell-access (wave1-logs-ssm). Contract: ./types.ts.
 * Design: docs/modules/05-ops-observability.md#shell-access (section 6 "切换、数据迁移与回滚", section 0, section 12 platform mode;
 * 06 PM-M28 / PM-27).
 *
 * enable (generic steps in brackets):
 *   plan        SHELL_ACCESS_KEEP_SSH=false|true is always written (registry baseParams SshIngressCidr '' applies only when it is
 *               false); `--param KeepSsh=true` (or `--set SHELL_ACCESS_KEEP_SSH=true`) keeps port 22 for a side-by-side period.
 *   prepare     preflight policy-quota (managed policies on CloudAlbumAppRole) and ssm-session-preferences (read the region
 *               singleton SSM-SessionManagerRunShell); a retained session log group is reused (CreateLogGroup=false).
 *   [3 deploy]
 *   afterDeploy before anything touches port 22 (anti lock-out, section 4 "启用校验"):
 *               1. attach PolicyArn now (the agent needs ssm:UpdateInstanceInformation to register; generic step 5 then finds it
 *                  attached) and, with `--param ManagedCore=true`, the AWS managed AmazonSSMManagedInstanceCore (comparison option);
 *               2. standalone: restart amazon-ssm-agent over the current ssh channel to speed up the registration;
 *               3. wait for PingStatus=Online (5 minutes) and smoke-test Run Command (`id; systemctl is-active cloudalbum-api`);
 *                  on failure the attachment is rolled back and enable stops with exit 5: port 22 is unchanged;
 *               4. back up and write the session preferences (state.json backups + outOfBand; platform: the state bucket
 *                  <envName>/backups/, PM-27), then make the new version the default.
 *   [4b baseParams SshIngressCidr '' closes port 22; 5 PolicyArn already attached; 7 delivery through SSM (hostSetup creates
 *    cloudalbum-ops + sudoers); 10 probe]
 * disable:
 *   beforeDisable  standalone: refuse without --reopen-ssh while port 22 is closed (the SSM policy is about to be detached: no
 *               channel would be left). With --reopen-ssh: reopen SshIngressCidr (recorded original, or --param
 *               SshIngressCidr=<ip>/32 when the operator IP changed), verify ssh, and only then continue; on failure port 22 is
 *               closed again and the module stays enabled. Platform mode: SSM stays the channel, port 22 stays closed unless
 *               --reopen-ssh. Then the session preferences are restored from the backup (default version, or deleted when the
 *               document did not exist before).
 *   afterDisable   detach AmazonSSMManagedInstanceCore if this module attached it; delivery channel back to ssh; reminders.
 * Platform mode: the instance is an SSM managed node from L0 (platform management channel) — no agent restart, Online is
 * expected immediately; the platform session documents ATL-SessionShell* are never modified.
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type { Ctx } from '../context.js';
import { RemoteScript, SshDeliverer, SsmDeliverer, sleep, type Deliverer } from '../deliver.js';
import type { PlanStep } from '../deps.js';
import type { Prepared } from '../hooks.js';
import { injectedParams, mergedEnv } from '../ops.js';
import { isPlatformPolicy, principalOf, quotaFor } from '../policy.js';
import { CliError, EXIT } from '../printer.js';
import { registryVersion, stackName } from '../registry.js';
import { deployStack, stackTags } from '../stack.js';
import { nowIso, type ModuleRecord } from '../state.js';
import { existingLogGroups } from './logging.js';
import type { DeployedStacks, HookArgs, HookDisableResult, HookPlanResult, ModuleHook } from './types.js';

export const SESSION_DOCUMENT = 'SSM-SessionManagerRunShell';
export const MANAGED_CORE_ARN = 'arn:aws:iam::aws:policy/AmazonSSMManagedInstanceCore';
const OOB_PREFS = 'ssm-session-preferences';
const OOB_CORE = 'managed-core-attachment';
const OPERATOR_POLICY = 'infra/modules/shell-access/operator-policy.json';
/** prepare() -> afterDeploy(): CreateLogGroup of this run ('false' = a retained group is reused) */
const logGroupDecision = new WeakMap<Ctx, string>();
export const ONLINE_TIMEOUT_SEC = 300;
const CIDR_RE = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})\/(\d{1,2})$/;

/** Test seam: delivery channels used before the switch, the clock and the pause between polls. */
export const shellAccessDeps = {
  /** the ssh channel of standalone mode (never cached in ctx: the cached deliverer of this run must become SSM) */
  ssh(ctx: Ctx): Deliverer {
    const s = ctx.state;
    const host = ctx.opts.host ?? s.delivery.host ?? s.base?.publicIp;
    return new SshDeliverer(host ? { host, user: ctx.opts.sshUser ?? s.delivery.sshUser, ...((ctx.opts.sshKey ?? s.delivery.sshKeyPath) ? { keyPath: ctx.opts.sshKey ?? s.delivery.sshKeyPath } : {}) } : undefined,
      ctx.dryRun, ctx.out);
  },
  /** Run Command to one instance (platform mode: the context's own SSM deliverer) */
  ssm(ctx: Ctx, instanceId: string): Deliverer {
    return ctx.platform ? ctx.deliverer() : new SsmDeliverer(ctx.aws, instanceId, ctx.out);
  },
  sleep: (ms: number) => sleep(ms),
  now: () => Date.now(),
};

export function keepSshOf(step: Pick<PlanStep, 'settings'>, args: Pick<HookArgs, 'params'>): 'true' | 'false' {
  const v = String(args.params.KeepSsh ?? step.settings.SHELL_ACCESS_KEEP_SSH ?? 'false').toLowerCase();
  if (!['true', 'false'].includes(v)) throw new CliError(`shell-access: KeepSsh must be true or false (got "${v}")`, EXIT.rules, 'USAGE');
  return v as 'true' | 'false';
}

/** Session preferences content (infra/modules/shell-access/session-preferences.json with the module's values). */
export function renderSessionPreferences(repoRoot: string, v: { logGroup: string; runAs: string; kmsKeyArn?: string; logGroupEncrypted?: boolean }): string {
  const doc = JSON.parse(readFileSync(path.join(repoRoot, 'infra/modules/shell-access/session-preferences.json'), 'utf8')) as { inputs: Record<string, unknown> };
  doc.inputs.cloudWatchLogGroupName = v.logGroup;
  doc.inputs.runAsDefaultUser = v.runAs;
  if (v.kmsKeyArn) {
    // kmsKeyId encrypts the session data stream (the operator who starts a session needs kms:GenerateDataKey on it:
    // optional statement SessionDataKms of operator-policy.json). cloudWatchEncryptionEnabled additionally requires the log
    // group itself to be KMS-encrypted — true for a group created by the stack with KmsKeyArn, not necessarily for a
    // retained group that is reused (CreateLogGroup=false): session log writes would fail (wave1-fix).
    doc.inputs.kmsKeyId = v.kmsKeyArn;
    doc.inputs.cloudWatchEncryptionEnabled = v.logGroupEncrypted ?? true;
  }
  return JSON.stringify(doc, null, 2);
}

/**
 * Is the session log group KMS-encrypted? A group created by this stack is encrypted exactly when KmsKeyArn is injected;
 * a reused group (CreateLogGroup=false) is checked with logs:DescribeLogGroups (kmsKeyId). Dry-run: undefined.
 */
export async function sessionLogGroupEncrypted(ctx: Ctx, logGroup: string, createdByStack: boolean, kmsKeyArn: string): Promise<boolean | undefined> {
  if (!kmsKeyArn) return false;
  if (createdByStack) return true;
  const r = await ctx.aws.send<{ logGroups?: Array<{ logGroupName?: string; kmsKeyId?: string }> }>({
    service: 'logs', op: 'DescribeLogGroups', input: { logGroupNamePrefix: logGroup, limit: 5 },
  });
  if (r === undefined) return undefined;
  return Boolean((r.logGroups ?? []).find((g) => g.logGroupName === logGroup)?.kmsKeyId);
}

function instanceOf(ctx: Ctx): string {
  return ctx.ph(ctx.state.base?.instanceId, 'ec2:InstanceId');
}

function roleOf(ctx: Ctx): string {
  const p = principalOf(ctx.state);
  if (!p || p.type !== 'role') throw new CliError('shell-access: DEP-001 needs IAM_CREDENTIALS=role (CloudAlbumAppRole on the instance): scripts/module enable iam --mode role', EXIT.rules, 'DEP-001');
  return p.name;
}

async function attachRole(ctx: Ctx, role: string, arn: string): Promise<void> {
  await ctx.aws.send({ service: 'iam', op: 'AttachRolePolicy', input: { RoleName: role, PolicyArn: arn } });
}

async function detachRole(ctx: Ctx, role: string, arn: string): Promise<void> {
  try {
    await ctx.aws.send({ service: 'iam', op: 'DetachRolePolicy', input: { RoleName: role, PolicyArn: arn } });
  } catch (e) {
    if (!/NoSuchEntity/.test(String((e as Error)?.message))) throw e;
  }
}

/** Poll ssm:DescribeInstanceInformation until the instance is Online. Returns the last PingStatus (dry-run: 'Online'). */
export async function waitOnline(ctx: Ctx, instanceId: string, timeoutSec = ONLINE_TIMEOUT_SEC): Promise<{ online: boolean; ping: string; agentVersion?: string }> {
  const deadline = shellAccessDeps.now() + timeoutSec * 1000;
  let ping = 'NotRegistered';
  for (;;) {
    const r = await ctx.aws.send<{ InstanceInformationList?: Array<{ PingStatus?: string; AgentVersion?: string }> }>({
      service: 'ssm', op: 'DescribeInstanceInformation', input: { Filters: [{ Key: 'InstanceIds', Values: [instanceId] }] },
    });
    if (r === undefined) return { online: true, ping: 'Online' };          // dry-run
    const i = r.InstanceInformationList?.[0];
    ping = i?.PingStatus ?? 'NotRegistered';
    if (ping === 'Online') return { online: true, ping, ...(i?.AgentVersion ? { agentVersion: i.AgentVersion } : {}) };
    if (shellAccessDeps.now() >= deadline) return { online: false, ping };
    await shellAccessDeps.sleep(10_000);
  }
}

/** Back up SSM-SessionManagerRunShell (PM-27 format) and write the module's preferences; returns the out-of-band detail. */
async function writeSessionPreferences(ctx: Ctx, content: string): Promise<Record<string, string>> {
  const cur = await ctx.aws.send<{ Content?: string; DocumentVersion?: string }>({
    service: 'ssm', op: 'GetDocument', input: { Name: SESSION_DOCUMENT, DocumentFormat: 'JSON' },
  }).catch((e: unknown) => {
    if (/InvalidDocument|not found|does not exist/i.test(String((e as Error)?.message))) return null;
    throw e;
  });
  const existed = cur !== null;
  const dry = cur === undefined;
  let defaultVersion = '';
  if (cur) {
    const d = await ctx.aws.send<{ Document?: { DefaultVersion?: string } }>({ service: 'ssm', op: 'DescribeDocument', input: { Name: SESSION_DOCUMENT } });
    defaultVersion = d?.Document?.DefaultVersion ?? cur.DocumentVersion ?? '';
  }
  const stamp = new Date(shellAccessDeps.now()).toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z');
  const backup = existed && cur ? { existed: true, defaultVersion, content: safeJson(cur.Content) } : { existed: false };
  let key: string;
  if (ctx.platform) {
    key = `${ctx.platform.env.env}/backups/ssm-document-${SESSION_DOCUMENT}-${stamp}.json`;
    await ctx.aws.send({ service: 's3', op: 'PutObject', input: { Bucket: ctx.platform.env.stateBucket, Key: key, Body: JSON.stringify(backup), ContentType: 'application/json' },
      display: { Bucket: ctx.platform.env.stateBucket, Key: key, Body: '<previous session preferences>' } });
  } else {
    // next to state.json (.cloudalbum/backup/ by default; section 2 "会话首选项")
    const dir = path.join(path.dirname(ctx.stateFile), 'backup');
    key = path.join(dir, `${SESSION_DOCUMENT}-${stamp}.json`);
    if (!ctx.dryRun) {
      mkdirSync(dir, { recursive: true });
      writeFileSync(key, `${JSON.stringify(backup, null, 2)}\n`, { mode: 0o600 });
    } else {
      ctx.out.dry(`write ${key} (backup of ${SESSION_DOCUMENT})`);
    }
  }
  if (!dry) ctx.state.backups.push({ type: 'ssm-document', id: SESSION_DOCUMENT, key, at: nowIso() });

  let version = '1';
  if (existed && !dry) {
    try {
      const u = await ctx.aws.send<{ DocumentDescription?: { DocumentVersion?: string } }>({
        service: 'ssm', op: 'UpdateDocument', input: { Name: SESSION_DOCUMENT, Content: content, DocumentVersion: '$LATEST', DocumentFormat: 'JSON' },
      });
      version = u?.DocumentDescription?.DocumentVersion ?? version;
      await ctx.aws.send({ service: 'ssm', op: 'UpdateDocumentDefaultVersion', input: { Name: SESSION_DOCUMENT, DocumentVersion: version } });
    } catch (e) {
      if (!/DuplicateDocumentContent/.test(String((e as Error)?.message))) throw e;
      ctx.out.info(`      ${SESSION_DOCUMENT} already has this content (unchanged)`);
    }
  } else if (dry) {
    await ctx.aws.send({ service: 'ssm', op: 'UpdateDocument', input: { Name: SESSION_DOCUMENT, Content: content, DocumentVersion: '$LATEST', DocumentFormat: 'JSON' } });
    await ctx.aws.send({ service: 'ssm', op: 'UpdateDocumentDefaultVersion', input: { Name: SESSION_DOCUMENT, DocumentVersion: '<new version>' } });
  } else {
    await ctx.aws.send({ service: 'ssm', op: 'CreateDocument', input: { Name: SESSION_DOCUMENT, Content: content, DocumentType: 'Session', DocumentFormat: 'JSON' } });
  }
  return { backup: key, existed: dry ? 'unknown' : String(existed), ...(defaultVersion ? { previousDefaultVersion: defaultVersion } : {}), version };
}

function safeJson(s: string | undefined): unknown {
  try {
    return JSON.parse(s ?? 'null');
  } catch {
    return s ?? null;
  }
}

/** Restore the session preferences recorded by enable (outOfBand ssm-session-preferences). */
async function restoreSessionPreferences(ctx: Ctx): Promise<void> {
  const recs = ctx.state.outOfBand.filter((o) => o.module === 'shell-access' && o.kind === OOB_PREFS);
  const rec = recs[0];                         // the first record holds the state before the module ever touched the document
  if (!rec) {
    ctx.out.warn(`      shell-access: no backup of ${SESSION_DOCUMENT} in state.json; leaving the document as it is`);
    return;
  }
  const d = rec.detail ?? {};
  if (d.existed === 'false') {
    await ctx.aws.send({ service: 'ssm', op: 'DeleteDocument', input: { Name: SESSION_DOCUMENT } });
    ctx.out.info(`      ${SESSION_DOCUMENT}: did not exist before enable -> deleted`);
  } else if (d.previousDefaultVersion) {
    await ctx.aws.send({ service: 'ssm', op: 'UpdateDocumentDefaultVersion', input: { Name: SESSION_DOCUMENT, DocumentVersion: d.previousDefaultVersion } });
    ctx.out.info(`      ${SESSION_DOCUMENT}: default version restored to ${d.previousDefaultVersion} (backup ${d.backup ?? '?'})`);
  } else {
    ctx.out.warn(`      shell-access: the backup of ${SESSION_DOCUMENT} has no previous default version; restore it from ${d.backup ?? 'the backup'} by hand`);
  }
  if (!ctx.dryRun) ctx.state.outOfBand = ctx.state.outOfBand.filter((o) => !(o.module === 'shell-access' && o.kind === OOB_PREFS));
}

function sshCidrCheck(cidr: string): string | undefined {
  const m = CIDR_RE.exec(cidr);
  if (!m || m.slice(1, 5).some((x) => Number(x) > 255) || Number(m[5]) > 32) return `SshIngressCidr "${cidr}" is not an IPv4 CIDR (x.x.x.x/32)`;
  if (cidr === '0.0.0.0/0') return 'SshIngressCidr 0.0.0.0/0 is never restored by shell-access (00 6.4): pass your own IP as --param SshIngressCidr=<ip>/32';
  return undefined;
}

async function setSshIngress(ctx: Ctx, cidr: string): Promise<void> {
  await deployStack(ctx.aws, ctx.out, ctx.repoRoot, {
    stackName: stackName(ctx.env, 'ec2'), template: 'infra/modules/ec2.yaml', params: { SshIngressCidr: cidr }, tags: stackTags(ctx.env, 'ec2', registryVersion('ec2')),
  });
  if (ctx.state.base) ctx.state.base.params.SshIngressCidr = cidr;
}

export const shellAccessHook: ModuleHook = {
  id: 'shell-access',

  plan(ctx, step, args): HookPlanResult {
    const keep = keepSshOf(step, args);
    const notes: string[] = [];
    if (ctx.platform) {
      notes.push('platform mode: the instance is already an SSM managed node (platform management channel); this module closes port 22 '
        + `and writes the region-level session preferences ${SESSION_DOCUMENT} (backed up to the state bucket, restored on disable)`);
    } else {
      notes.push('the delivery channel of scripts/module switches from ssh to SSM Run Command; port 22 closes only after the agent is Online and a Run Command smoke test passed');
      notes.push('over SSM, secrets.env is only written (SecureString hand-off under /cloudalbum/<env>/handoff/, readable by the instance through this '
        + 'module policy) and never read back: later steps that must reuse an existing secret (cdn ORIGIN_VERIFY, database DB_PASSWORD, '
        + 'image-processing CALLBACK_HMAC_KEY) stop with SECRETS_READBACK_OVER_SSM — enable those modules first, or keep port 22 '
        + '(--param KeepSsh=true) and run them with `--delivery ssh`');
      notes.push(`operators attach ${OPERATOR_POLICY} to their own identity (replace \${Region} / \${AccountId}); its statement SessionDataKms `
        + 'is needed only when kms is enabled (replace ${KmsKeyArn}: session data is encrypted with that key), otherwise delete that statement');
    }
    notes.push(keep === 'true'
      ? 'KeepSsh=true: port 22 stays open for a side-by-side period (status degraded, SEC-003 is an expected warning)'
      : 'base stack parameter SshIngressCidr -> \'\' (port 22 closed); `scripts/module disable shell-access --reopen-ssh` restores it');
    if ((args.params.ManagedCore ?? 'false') === 'true') notes.push('ManagedCore=true: AmazonSSMManagedInstanceCore is attached instead of the least-privilege agent statement (comparison option)');
    return { settings: { SHELL_ACCESS_KEEP_SSH: keep }, notes };
  },

  async prepare(ctx, step, args, p: Prepared) {
    if (step.tier !== 'aws') return;
    p.settings.SHELL_ACCESS_KEEP_SSH = keepSshOf(step, args);
    // preflight policy-quota: this module adds 1 managed policy (+1 with ManagedCore outside platform mode)
    const principal = principalOf(ctx.state);
    if (principal?.type === 'role') {
      const r = await ctx.aws.send<{ AttachedPolicies?: Array<{ PolicyArn?: string }> }>({
        service: 'iam', op: 'ListAttachedRolePolicies', input: { RoleName: principal.name, MaxItems: 100 },
      });
      if (r) {
        const attached = (r.AttachedPolicies ?? []).filter((x) => !isPlatformPolicy(x.PolicyArn ?? ''));
        const adding = 1 + ((args.params.ManagedCore ?? 'false') === 'true' && !ctx.platform ? 1 : 0)
          - (attached.some((x) => x.PolicyArn?.endsWith(`/cloudalbum-${ctx.env}-shell-access`)) ? 1 : 0);
        if (attached.length + adding > quotaFor(principal)) {
          throw new CliError(`policy-quota: ${principal.name} already has ${attached.length} managed policies; +${adding} exceeds ${quotaFor(principal)}`, EXIT.rules, 'POLICY_QUOTA');
        }
      }
    }
    // preflight ssm-session-preferences: read only here (the backup is taken right before the change, afterDeploy)
    await ctx.aws.send({ service: 'ssm', op: 'GetDocument', input: { Name: SESSION_DOCUMENT, DocumentFormat: 'JSON' } }).catch(() => undefined);
    // a session log group retained by an earlier disable is reused
    const prev = ctx.state.modules['shell-access'];
    if (prev?.tier === 'aws' && prev.params.CreateLogGroup) {
      p.params.CreateLogGroup = prev.params.CreateLogGroup;
    } else {
      const name = `/cloudalbum/${ctx.env}/ssm-sessions`;
      const found = await existingLogGroups(ctx, name, [name]);
      if (found?.has(name)) {
        p.params.CreateLogGroup = 'false';
        p.notes.push(`shell-access: reusing the session log group ${name} retained by an earlier disable`);
      }
    }
    logGroupDecision.set(ctx, p.params.CreateLogGroup ?? 'true');
  },

  async afterDeploy(ctx, step, args, deployed: DeployedStacks) {
    const instanceId = instanceOf(ctx);
    const role = roleOf(ctx);
    const policyArn = ctx.ph(deployed.outputs.PolicyArn, 'shell-access:PolicyArn');
    const managedCore = (args.params.ManagedCore ?? deployed.outputs.InfoManagedCore ?? 'false') === 'true' && !ctx.platform;
    // 1. permissions first: the agent registers with ssm:UpdateInstanceInformation from this policy
    ctx.out.info(`      attach ${policyArn} -> role/${role} (before the SSM check; step 5 finds it attached)`);
    await attachRole(ctx, role, policyArn);
    const principal = { type: 'role' as const, name: role };
    const already = ctx.state.attachments.some((a) => a.policyArn === policyArn && a.principal.name === role);
    if (!already) ctx.state.attachments.push({ module: 'shell-access', policyArn, principal, at: nowIso() });
    if (managedCore) {
      await attachRole(ctx, role, MANAGED_CORE_ARN);
      if (!ctx.state.outOfBand.some((o) => o.module === 'shell-access' && o.kind === OOB_CORE)) {
        ctx.state.outOfBand.push({ module: 'shell-access', kind: OOB_CORE, id: MANAGED_CORE_ARN, at: nowIso(), detail: { role } });
      }
    }
    const rollback = async (why: string): Promise<never> => {
      await detachRole(ctx, role, policyArn).catch(() => undefined);
      ctx.state.attachments = ctx.state.attachments.filter((a) => !(a.policyArn === policyArn && a.principal.name === role));
      if (managedCore) {
        await detachRole(ctx, role, MANAGED_CORE_ARN).catch(() => undefined);
        ctx.state.outOfBand = ctx.state.outOfBand.filter((o) => !(o.module === 'shell-access' && o.kind === OOB_CORE));
      }
      throw new CliError(`shell-access: ${why}. Port 22 is unchanged (SshIngressCidr not touched); the stack is kept — fix the cause and run enable again`, EXIT.health, 'SSM_NOT_READY');
    };
    // 2. standalone: the agent picks up the new permissions faster after a restart (over the still-open ssh channel)
    if (!ctx.platform && (ctx.opts.delivery ?? ctx.state.delivery.channel) === 'ssh') {
      const s = new RemoteScript('restart amazon-ssm-agent (shell-access)');
      s.line('systemctl enable amazon-ssm-agent >/dev/null 2>&1 || true', 'systemctl restart amazon-ssm-agent');
      const r = await shellAccessDeps.ssh(ctx).run(s, { capture: true, timeoutSec: 120 }).catch((e: unknown) => ({ code: 1, stdout: '', stderr: (e as Error).message }));
      if (r.code !== 0) ctx.out.warn(`      shell-access: could not restart amazon-ssm-agent over ssh (${r.stderr.trim() || `exit ${r.code}`}); waiting for the agent anyway`);
    }
    // 3. Online + Run Command smoke test before port 22 can close
    ctx.out.info(`      waiting for ${instanceId} to be Online in Systems Manager (up to ${ONLINE_TIMEOUT_SEC / 60} minutes)`);
    const on = await waitOnline(ctx, instanceId);
    if (!on.online) {
      await rollback(`the SSM Agent of ${instanceId} is ${on.ping} after ${ONLINE_TIMEOUT_SEC / 60} minutes (instance profile role, amazon-ssm-agent running, outbound 443 to ssm / ssmmessages / ec2messages)`);
    }
    ctx.out.info(`      ${instanceId}: PingStatus Online${on.agentVersion ? ` (agent ${on.agentVersion})` : ''}; Run Command smoke test`);
    const smoke = new RemoteScript('shell-access smoke test');
    smoke.line('id', 'systemctl is-active cloudalbum-api');
    const res = await shellAccessDeps.ssm(ctx, instanceId).run(smoke, { capture: true, timeoutSec: 120 })
      .catch((e: unknown) => ({ code: 1, stdout: '', stderr: (e as Error).message }));
    if (res.code !== 0) await rollback(`the Run Command smoke test failed (exit ${res.code}: ${(res.stderr || res.stdout).trim().slice(0, 300)})`);
    // 4. session preferences (region singleton): backup, write, new default version
    const env = mergedEnv(ctx.state, ctx.state.modules);
    const kmsRaw = injectedParams(ctx, 'shell-access', ctx.state.modules, env).KmsKeyArn ?? '';
    const kms = kmsRaw && !kmsRaw.startsWith('<') ? kmsRaw : '';
    const logGroup = ctx.ph(deployed.outputs.EnvSsmSessionLogGroup, 'shell-access:EnvSsmSessionLogGroup');
    const created = (logGroupDecision.get(ctx) ?? ctx.state.modules['shell-access']?.params.CreateLogGroup ?? 'true') !== 'false';
    const encrypted = await sessionLogGroupEncrypted(ctx, logGroup, created, kms);
    if (kms && encrypted === false) {
      ctx.out.warn(`      shell-access: the reused session log group ${logGroup} is not KMS-encrypted — cloudWatchEncryptionEnabled stays false `
        + `(session logs would fail to write). Encrypt it (aws logs associate-kms-key --log-group-name ${logGroup} --kms-key-id ${kms}) and run enable again`);
    }
    const content = renderSessionPreferences(ctx.repoRoot, {
      logGroup, runAs: deployed.outputs.EnvSsmSessionRunAs || 'cloudalbum-ops',
      ...(kms ? { kmsKeyArn: kms, logGroupEncrypted: encrypted !== false } : {}),
    });
    if (kms) {
      ctx.out.warn(`      shell-access: session data is encrypted with ${kms}: operators need kms:GenerateDataKey on it — add the optional statement `
        + `SessionDataKms of ${OPERATOR_POLICY} (replace \${KmsKeyArn}) to the identity that runs aws ssm start-session, otherwise StartSession is denied`);
    }
    const hadRecord = ctx.state.outOfBand.some((o) => o.module === 'shell-access' && o.kind === OOB_PREFS);
    const detail = await writeSessionPreferences(ctx, content);
    // keep the first record (the state before this module ever touched the document); later enables only refresh the content
    if (!hadRecord && !ctx.dryRun) {
      ctx.state.outOfBand.push({ module: 'shell-access', kind: OOB_PREFS, id: SESSION_DOCUMENT, at: nowIso(), region: ctx.region, detail });
    }
    ctx.out.info(`      ${SESSION_DOCUMENT}: runAs ${deployed.outputs.EnvSsmSessionRunAs || 'cloudalbum-ops'}, logs -> ${deployed.outputs.EnvSsmSessionLogGroup ?? '<log group>'} (backup ${detail.backup})`);
    if (step.settings.SHELL_ACCESS_KEEP_SSH === 'true') ctx.out.warn('      KeepSsh=true: port 22 stays open (SEC-003 expected, shell-access degraded)');
  },

  async beforeDisable(ctx, rec: ModuleRecord, args): Promise<HookDisableResult> {
    const notes: string[] = [];
    const closed = rec.env.SHELL_ACCESS_KEEP_SSH !== 'true' && (ctx.state.base?.params.SshIngressCidr ?? '') === '';
    let keep: string[] = [];
    if (!args.reopenSsh) {
      if (closed && !ctx.platform) {
        throw new CliError('shell-access: port 22 is closed and disabling detaches the SSM policy — no management channel would be left. '
          + 'Run `scripts/module disable shell-access --reopen-ssh` (add --param SshIngressCidr=<your-ip>/32 if your IP changed)', EXIT.rules, 'REOPEN_SSH_REQUIRED');
      }
      keep = ['SshIngressCidr'];
      if (closed) notes.push('platform mode: port 22 stays closed (the platform SSM channel remains); --reopen-ssh restores the recorded SshIngressCidr');
    } else if (closed) {
      const recorded = ctx.state.baseParams.SshIngressCidr?.original ?? '';
      const cidr = args.params.SshIngressCidr ?? recorded;
      if (!cidr) {
        throw new CliError('shell-access --reopen-ssh: no SshIngressCidr was recorded before port 22 closed; pass --param SshIngressCidr=<your-ip>/32', EXIT.rules, 'REOPEN_SSH_CIDR');
      }
      const bad = sshCidrCheck(cidr);
      if (bad) throw new CliError(`shell-access --reopen-ssh: ${bad}`, EXIT.rules, 'REOPEN_SSH_CIDR');
      if (!cidr.endsWith('/32')) ctx.out.warn(`      shell-access: ${cidr} is wider than /32 (00 6.4 preflight ec2-ssh-cidr)`);
      ctx.out.info(`      reopen port 22 for ${cidr} before anything else, then verify ssh (the SSM channel stays until this succeeds)`);
      await setSshIngress(ctx, cidr);
      if (!ctx.platform) {
        const probe = new RemoteScript('ssh check (shell-access disable)');
        probe.line('true');
        const r = await shellAccessDeps.ssh(ctx).run(probe, { capture: true, timeoutSec: 60 }).catch((e: unknown) => ({ code: 255, stdout: '', stderr: (e as Error).message }));
        if (r.code !== 0) {
          await setSshIngress(ctx, '');
          throw new CliError(`shell-access --reopen-ssh: ssh to the instance failed after opening ${cidr} (${r.stderr.trim().slice(0, 200) || `exit ${r.code}`}); `
            + 'port 22 is closed again and shell-access stays enabled (SSM channel kept). Check your current public IP and the key pair', EXIT.health, 'REOPEN_SSH_FAILED');
        }
      }
      // the generic restore (disable step 5) finds the base parameter already at this value; keep fail2ban from banning the operator
      if (ctx.state.baseParams.SshIngressCidr) ctx.state.baseParams.SshIngressCidr.original = cidr;
      notes.push(`port 22 reopened for ${cidr}`);
    }
    await restoreSessionPreferences(ctx);
    notes.push(`the session log group /cloudalbum/${ctx.env}/ssm-sessions is kept (DeletionPolicy Retain); delete it with `
      + `aws logs delete-log-group --log-group-name /cloudalbum/${ctx.env}/ssm-sessions`);
    return { ...(keep.length ? { keepBaseParams: keep } : {}), notes };
  },

  async afterDisable(ctx, rec, args) {
    for (const o of ctx.state.outOfBand.filter((x) => x.module === 'shell-access' && x.kind === OOB_CORE)) {
      await detachRole(ctx, o.detail?.role ?? 'CloudAlbumAppRole', o.id);
      ctx.out.info(`      detach ${o.id} <- role/${o.detail?.role ?? 'CloudAlbumAppRole'} (attached by shell-access --param ManagedCore=true)`);
    }
    if (!ctx.dryRun) ctx.state.outOfBand = ctx.state.outOfBand.filter((x) => !(x.module === 'shell-access' && x.kind === OOB_CORE));
    // the base parameter is back to its original value: drop the contribution record when shell-access was its only writer
    const bp = ctx.state.baseParams.SshIngressCidr;
    if (bp && bp.by.every((m) => m === 'shell-access')) delete ctx.state.baseParams.SshIngressCidr;
    if (!ctx.platform) {
      ctx.state.delivery.channel = 'ssh';
      if (args.reopenSsh || rec.env.SHELL_ACCESS_KEEP_SSH === 'true') {
        ctx.out.info('      delivery channel: ssh again (fail2ban ignoreip: /etc/cloudalbum/fail2ban-ignoreip comes from `scripts/module base deploy`; update it there if the operator IP changed)');
      }
    }
  },
};
