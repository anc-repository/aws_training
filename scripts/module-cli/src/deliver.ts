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

export class RemoteScript {
  private readonly lines: string[] = [];
  private readonly secrets: string[] = [];
  constructor(readonly title: string) {}

  get containsSecrets(): boolean { return this.secrets.length > 0; }

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
    const tag = `CA_EOF_${randomBytes(6).toString('hex')}`;
    this.lines.push(
      'ca_sf=$(readlink -f /etc/cloudalbum/secrets.env); ca_tmp=$(mktemp "$(dirname "$ca_sf")/.secrets.XXXXXX")',
      `grep -v -E '^(${keys.join('|')})=' "$ca_sf" > "$ca_tmp" || true`,
      `cat >> "$ca_tmp" <<'${tag}'`,
      ...keys.map((k) => `${k}=${values[k]}`),
      tag,
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

  render(): string {
    return ['#!/bin/bash', `# scripts/module: ${this.title}`, 'set -euo pipefail', 'umask 027', ...this.lines, ''].join('\n');
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

export class SsmDeliverer implements Deliverer {
  readonly channel = 'ssm';
  readonly dryRun: boolean;
  constructor(private readonly aws: AwsGateway, private readonly instanceId: string | undefined, private readonly out: Printer) {
    this.dryRun = aws.dryRun;
  }

  async run(script: RemoteScript, opts: { capture?: boolean; timeoutSec?: number } = {}): Promise<RemoteResult> {
    if (script.containsSecrets) {
      throw new CliError(`"${script.title}" carries secret values: SSM Run Command keeps command parameters in its history, `
        + 'so scripts/module only delivers secrets over ssh (or through the secrets module in a later round)', EXIT.rules);
    }
    const instanceId = this.instanceId ?? '<instance-id>';
    const sent = await this.aws.send<{ Command?: { CommandId?: string } }>({
      service: 'ssm', op: 'SendCommand',
      input: { InstanceIds: [instanceId], DocumentName: 'AWS-RunShellScript', Comment: script.title.slice(0, 100),
        Parameters: { commands: [script.render()], executionTimeout: [String(opts.timeoutSec ?? 900)] } },
      display: { InstanceIds: [instanceId], DocumentName: 'AWS-RunShellScript', script: script.title },
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

export function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
