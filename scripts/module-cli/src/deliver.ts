/**
 * Delivery channel to the instance (modular-design.md 9.2): L0 uses ssh; once shell-access is enabled
 * (SHELL_ACCESS_MODE=ssm) scripts/module switches to SSM Run Command. The channel itself is part of the comparison.
 * Scripts run as root (`sudo bash -s` / AWS-RunShellScript). Secret values are only ever sent over ssh stdin
 * (never on a command line); SSM keeps command parameters in its history, so secret-bearing scripts are refused there.
 */
import { randomBytes } from 'node:crypto';
import { spawn } from 'node:child_process';
import type { AwsGateway } from './aws.js';
import type { Printer } from './printer.js';
import { CliError, EXIT } from './printer.js';

/** marker line replaced at render time by the secrets.env upsert (inline heredoc, or the SSM parameter hand-off) */
const HANDOFF_MARKER = '__CA_SECRETS_HANDOFF__';

export class RemoteScript {
  private readonly lines: string[] = [];
  private readonly secrets: string[] = [];
  /** secrets.env values (upsertSecrets): delivered inline over ssh, or through a SecureString parameter over SSM (platform mode) */
  readonly handoff: Record<string, string> = {};
  constructor(readonly title: string) {}

  get containsSecrets(): boolean { return this.secrets.length > 0; }

  /** secret values outside the secrets.env upsert: they can never be delivered over SSM */
  get containsInlineSecrets(): boolean {
    const handed = new Set(Object.values(this.handoff));
    return this.secrets.some((v) => !handed.has(v));
  }

  line(...l: string[]): this { this.lines.push(...l); return this; }
  comment(c: string): this { this.lines.push(`# ${c}`); return this; }

  /** Register a value that must never be printed (dry-run output, logs). */
  secret(value: string): string {
    if (value) this.secrets.push(value);
    return value;
  }

  /** Atomic write: temporary file in the same directory + rename (resolves the /etc/cloudalbum symlink). */
  writeFile(dest: string, content: string, opts: { mode: string; owner: string; backup?: boolean }): this {
    const tag = `CA_EOF_${randomBytes(6).toString('hex')}`;
    const q = shq(dest);
    this.lines.push(
      `ca_dest=$(readlink -f ${q} 2>/dev/null || echo ${q}); ca_dir=$(dirname "$ca_dest")`,
      'install -d -m 0750 -o root -g cloudalbum "$ca_dir" 2>/dev/null || install -d "$ca_dir"',
      ...(opts.backup ? [`if [ -f "$ca_dest" ]; then cp -p "$ca_dest" "$ca_dest.bak"; else rm -f "$ca_dest.bak"; fi`] : []),
      'ca_tmp=$(mktemp "$ca_dir/.ca.XXXXXX")',
      `cat > "$ca_tmp" <<'${tag}'`,
      content.endsWith('\n') ? content.slice(0, -1) : content,
      tag,
      `chown ${opts.owner} "$ca_tmp"; chmod ${opts.mode} "$ca_tmp"; mv -f "$ca_tmp" "$ca_dest"`,
    );
    return this;
  }

  /** Upsert keys of /etc/cloudalbum/secrets.env (root:cloudalbum 0640), atomically. Values are redacted in displays. */
  upsertSecrets(values: Readonly<Record<string, string>>): this {
    const keys = Object.keys(values);
    if (!keys.length) return this;
    for (const v of Object.values(values)) this.secret(v);
    Object.assign(this.handoff, values);
    this.lines.push(
      'ca_sf=$(readlink -f /etc/cloudalbum/secrets.env); ca_tmp=$(mktemp "$(dirname "$ca_sf")/.secrets.XXXXXX")',
      `grep -v -E '^(${keys.join('|')})=' "$ca_sf" > "$ca_tmp" || true`,
      `${HANDOFF_MARKER} ${keys.join(',')}`,
      'chown root:cloudalbum "$ca_tmp"; chmod 0640 "$ca_tmp"; mv -f "$ca_tmp" "$ca_sf"',
    );
    return this;
  }

  removeSecrets(keys: readonly string[]): this {
    if (!keys.length) return this;
    this.lines.push(
      'ca_sf=$(readlink -f /etc/cloudalbum/secrets.env); ca_tmp=$(mktemp "$(dirname "$ca_sf")/.secrets.XXXXXX")',
      `grep -v -E '^(${keys.join('|')})=' "$ca_sf" > "$ca_tmp" || true`,
      'chown root:cloudalbum "$ca_tmp"; chmod 0640 "$ca_tmp"; mv -f "$ca_tmp" "$ca_sf"',
    );
    return this;
  }

  /** Run the instance CLI as the cloudalbum user (node dist/cli.js). */
  cli(args: string): this {
    this.lines.push(`runuser -u cloudalbum -- env CLOUDALBUM_ENV_DIR=/etc/cloudalbum CLOUDALBUM_ROLE=cli /usr/bin/node /opt/cloudalbum/backend/dist/cli.js ${args}`);
    return this;
  }

  /**
   * inline (default): the secrets.env values are part of the script (ssh stdin only).
   * hand-off: platform mode over SSM (06 §1.5 rule 3: secrets never travel in Run Command parameters) — the values were written to
   *   a SecureString parameter beforehand; the instance reads it with its instance profile (AmazonSSMManagedInstanceCore allows
   *   ssm:GetParameter) and scripts/module deletes the parameter afterwards (the same hand-off as the PM-31 keys mode).
   */
  render(handoff: { param: string; region: string } | null = null): string {
    const out: string[] = [];
    for (const l of this.lines) {
      if (!l.startsWith(HANDOFF_MARKER)) { out.push(l); continue; }
      const keys = l.slice(HANDOFF_MARKER.length + 1).split(',');
      if (handoff) {
        out.push(
          `ca_ho=$(aws ssm get-parameter --region ${handoff.region} --name ${shq(handoff.param)} --with-decryption --query Parameter.Value --output text)`,
          `printf '%s' "$ca_ho" | jq -r --arg keys ${shq(keys.join(','))} '($keys | split(",")) as $k | to_entries[] | select(.key as $x | $k | index($x)) | "\\(.key)=\\(.value)"' >> "$ca_tmp"`,
          'unset ca_ho',
        );
      } else {
        const tag = `CA_EOF_${randomBytes(6).toString('hex')}`;
        out.push(`cat >> "$ca_tmp" <<'${tag}'`, ...keys.map((k) => `${k}=${this.handoff[k] ?? ''}`), tag);
      }
    }
    return ['#!/bin/bash', `# scripts/module: ${this.title}`, 'set -euo pipefail', 'umask 027', ...out, ''].join('\n');
  }

  get hasHandoff(): boolean {
    return Object.keys(this.handoff).length > 0;
  }

  display(): string {
    let s = this.render();
    for (const v of this.secrets) s = s.split(v).join('***');
    return s;
  }
}

export function shq(s: string): string {
  return /^[A-Za-z0-9_./:@%+=,-]+$/.test(s) ? s : `'${s.replace(/'/g, `'\\''`)}'`;
}

export interface RemoteResult { code: number; stdout: string; stderr: string }

export interface Deliverer {
  readonly channel: 'ssh' | 'ssm';
  readonly dryRun: boolean;
  run(script: RemoteScript, opts?: { capture?: boolean; timeoutSec?: number }): Promise<RemoteResult>;
}

export interface SshTarget { host: string; user: string; keyPath?: string }

export class SshDeliverer implements Deliverer {
  readonly channel = 'ssh';
  constructor(private readonly target: SshTarget | undefined, readonly dryRun: boolean, private readonly out: Printer) {}

  async run(script: RemoteScript, opts: { capture?: boolean; timeoutSec?: number } = {}): Promise<RemoteResult> {
    const host = this.target?.host ?? '<instance-public-ip>';
    const args = ['-o', 'BatchMode=yes', '-o', 'StrictHostKeyChecking=accept-new', '-o', 'ConnectTimeout=15',
      ...(this.target?.keyPath ? ['-i', this.target.keyPath] : []), `${this.target?.user ?? 'ec2-user'}@${host}`, 'sudo', 'bash', '-s'];
    if (this.dryRun) {
      this.out.dry(`ssh ${args.join(' ')}  <<< ${script.title}`);
      for (const l of script.display().split('\n')) this.out.dry(`  | ${l}`);
      return { code: 0, stdout: '', stderr: '' };
    }
    if (!this.target?.host) throw new CliError('no instance address in state.json (run `scripts/module base deploy` or `status --refresh` first)', EXIT.rules);
    return new Promise((resolve, reject) => {
      const child = spawn('ssh', args, { stdio: ['pipe', 'pipe', 'pipe'] });
      let stdout = ''; let stderr = '';
      const timer = setTimeout(() => child.kill('SIGTERM'), (opts.timeoutSec ?? 900) * 1000);
      child.stdout.on('data', (d: Buffer) => { stdout += d.toString(); if (!opts.capture) process.stdout.write(d); });
      child.stderr.on('data', (d: Buffer) => { stderr += d.toString(); if (!opts.capture) process.stderr.write(d); });
      child.on('error', (e) => { clearTimeout(timer); reject(e); });
      child.on('close', (code) => { clearTimeout(timer); resolve({ code: code ?? 1, stdout, stderr }); });
      child.stdin.end(script.render());
    });
  }
}

/** platform mode (06 PM-30): target discovery by tags, comment, secret hand-off parameter */
export interface SsmPlatformOptions {
  envName: string;
  envId: string;
  region: string;
  /** `cloudalbum <command> <runId|opId>` */
  commentSuffix: string;
  /** SecureString parameter prefix of the secret hand-off: /cloudalbum/<envName>/handoff/<opId> */
  handoffPrefix: string;
  /** wait for PingStatus=Online (s); default 600 */
  pingTimeoutSec?: number;
}

type Ec2Instance = { InstanceId?: string; Tags?: Array<{ Key?: string; Value?: string }> };

/**
 * Lab instances of the environment (06 PM-30, 01 §9.8): tag:atl:env-id + tag:atl:role=lab-app + running, then the AWS reserved
 * tag aws:cloudformation:stack-name=cloudalbum-<envName>-ec2 (ASG instances: aws:autoscaling:groupName of this environment).
 * Learner-created instances with copied tags and stopped L0 instances are excluded; instance IDs are never cached.
 */
export async function discoverLabInstances(aws: AwsGateway, envName: string, envId: string): Promise<string[]> {
  const r = await aws.send<{ Reservations?: Array<{ Instances?: Ec2Instance[] }> }>({
    service: 'ec2', op: 'DescribeInstances',
    input: { Filters: [{ Name: 'tag:atl:env-id', Values: [envId] }, { Name: 'tag:atl:role', Values: ['lab-app'] }, { Name: 'instance-state-name', Values: ['running'] }] },
  });
  if (r === undefined) return ['<lab-instance-id>'];
  const out: string[] = [];
  for (const res of r.Reservations ?? []) {
    for (const i of res.Instances ?? []) {
      const tag = (k: string) => i.Tags?.find((t) => t.Key === k)?.Value;
      const stack = tag('aws:cloudformation:stack-name');
      const asg = tag('aws:autoscaling:groupName');
      if (stack === `cloudalbum-${envName}-ec2` || (asg && asg.startsWith(`cloudalbum-${envName}-`))) {
        if (i.InstanceId) out.push(i.InstanceId);
      }
    }
  }
  return out;
}

export class SsmDeliverer implements Deliverer {
  readonly channel = 'ssm';
  readonly dryRun: boolean;
  private counter = 0;
  constructor(private readonly aws: AwsGateway, private readonly instanceId: string | undefined, private readonly out: Printer,
    private readonly platform?: SsmPlatformOptions) {
    this.dryRun = aws.dryRun;
  }

  private async targets(): Promise<string[]> {
    if (!this.platform) return [this.instanceId ?? '<instance-id>'];
    const ids = await discoverLabInstances(this.aws, this.platform.envName, this.platform.envId);
    if (!ids.length) throw new CliError(`no running lab instance tagged atl:env-id=${this.platform.envId}, atl:role=lab-app`, EXIT.rules, 'LAB_INSTANCE_NOT_FOUND');
    return ids;
  }

  /** new instances: wait for the management channel (PingStatus=Online, up to 10 minutes) before sending */
  async waitOnline(ids: readonly string[], timeoutSec = this.platform?.pingTimeoutSec ?? 600): Promise<void> {
    if (this.dryRun) return;
    const deadline = Date.now() + timeoutSec * 1000;
    for (;;) {
      const r = await this.aws.send<{ InstanceInformationList?: Array<{ InstanceId?: string; PingStatus?: string }> }>({
        service: 'ssm', op: 'DescribeInstanceInformation', input: { Filters: [{ Key: 'InstanceIds', Values: [...ids] }] },
      });
      const online = new Set((r?.InstanceInformationList ?? []).filter((x) => x.PingStatus === 'Online').map((x) => x.InstanceId));
      if (ids.every((id) => online.has(id))) return;
      if (Date.now() > deadline) {
        throw new CliError(`the management channel did not come back within ${timeoutSec}s (PingStatus≠Online): check the NAT or the ssm / ssmmessages / ec2messages interface endpoints (ATL-NET-001)`, EXIT.health, 'MGMT_CHANNEL_OFFLINE');
      }
      await sleep(10_000);
    }
  }

  async run(script: RemoteScript, opts: { capture?: boolean; timeoutSec?: number } = {}): Promise<RemoteResult> {
    if (this.platform ? script.containsInlineSecrets : script.containsSecrets) {
      throw new CliError(`"${script.title}" carries secret values: SSM Run Command keeps command parameters in its history, `
        + 'so scripts/module only delivers secrets over ssh (or, in platform mode, the secrets.env upsert through a SecureString hand-off parameter)', EXIT.rules);
    }
    const ids = await this.targets();
    if (this.platform && !this.dryRun) await this.waitOnline(ids);
    let handoff: { param: string; region: string } | null = null;
    if (this.platform && script.hasHandoff) {
      this.counter += 1;
      handoff = { param: `${this.platform.handoffPrefix}-${this.counter}`, region: this.platform.region };
      await this.aws.send({ service: 'ssm', op: 'PutParameter',
        input: { Name: handoff.param, Type: 'SecureString', Value: JSON.stringify(script.handoff), Overwrite: true,
          Description: `scripts/module secret hand-off (${script.title.slice(0, 60)}); deleted after delivery` },
        display: { Name: handoff.param, Type: 'SecureString', Value: '***' } });
    }
    try {
      const results: RemoteResult[] = [];
      for (const instanceId of ids) results.push(await this.runOn(instanceId, script, handoff, opts));
      const failed = results.find((r) => r.code !== 0);
      return failed ?? results[0] ?? { code: 0, stdout: '', stderr: '' };
    } finally {
      if (handoff) await this.aws.send({ service: 'ssm', op: 'DeleteParameter', input: { Name: handoff.param } }).catch(() => undefined);
    }
  }

  private async runOn(instanceId: string, script: RemoteScript, handoff: { param: string; region: string } | null,
    opts: { capture?: boolean; timeoutSec?: number }): Promise<RemoteResult> {
    const comment = this.platform ? `cloudalbum ${script.title} ${this.platform.commentSuffix}` : script.title;
    const sent = await this.aws.send<{ Command?: { CommandId?: string } }>({
      service: 'ssm', op: 'SendCommand',
      input: { InstanceIds: [instanceId], DocumentName: 'AWS-RunShellScript', Comment: comment.replace(/[^\x20-\x7e]/g, '').slice(0, 100),
        Parameters: { commands: [script.render(handoff)], executionTimeout: [String(opts.timeoutSec ?? 900)] } },
      display: { InstanceIds: [instanceId], DocumentName: 'AWS-RunShellScript', script: script.title, ...(handoff ? { handoff: handoff.param } : {}) },
    });
    if (this.dryRun) {
      for (const l of script.display().split('\n')) this.out.dry(`  | ${l}`);
      return { code: 0, stdout: '', stderr: '' };
    }
    const commandId = sent?.Command?.CommandId;
    if (!commandId) throw new CliError('SSM SendCommand returned no CommandId', EXIT.rules);
    const deadline = Date.now() + (opts.timeoutSec ?? 900) * 1000;
    for (;;) {
      await sleep(3000);
      try {
        const inv = await this.aws.send<{ Status?: string; ResponseCode?: number; StandardOutputContent?: string; StandardErrorContent?: string }>({
          service: 'ssm', op: 'GetCommandInvocation', input: { CommandId: commandId, InstanceId: instanceId },
        });
        const st = inv?.Status ?? 'Pending';
        if (!['Pending', 'InProgress', 'Delayed'].includes(st)) {
          const r = { code: inv?.ResponseCode ?? (st === 'Success' ? 0 : 1), stdout: inv?.StandardOutputContent ?? '', stderr: inv?.StandardErrorContent ?? '' };
          if (!opts.capture) { process.stdout.write(r.stdout); process.stderr.write(r.stderr); }
          return r;
        }
      } catch (e) {
        if (!(e instanceof Error && e.message.includes('InvocationDoesNotExist'))) throw e;
      }
      if (Date.now() > deadline) throw new CliError(`SSM command ${commandId} timed out`, EXIT.health);
    }
  }
}

/** the last JSON line of a remote command (Run Command output may be truncated: only the final line is relied on, PM-30) */
export function lastJsonLine(stdout: string): Record<string, unknown> | null {
  const lines = stdout.trim().split(/\r?\n/).reverse();
  for (const l of lines) {
    const t = l.trim();
    if (!t.startsWith('{')) continue;
    try {
      return JSON.parse(t) as Record<string, unknown>;
    } catch {
      return null;
    }
  }
  return null;
}

export function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
