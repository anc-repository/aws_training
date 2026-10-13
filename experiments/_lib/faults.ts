/**
 * experiments/_lib/faults.ts —— 故障注入（总纲 §8.2 运行器第 5 步、§8.4）。
 *
 * 投递方式（`--fault-via`，或 faults[].via）：
 * - `api`   —— `POST /api/lab/faults`（共享故障注入接口：延迟 / 5xx / 内存），只要 faults[].api 存在就走它；
 * - `ssh`   —— `ssh <host> sudo bash -s -- <args> < 脚本`（L0 的投递通道，`--ssh user@host` 或 `EXP_SSH`）；
 * - `ssm`   —— `aws ssm send-command`（AWS-RunShellScript，shell-access=ssm 时；用运维机的部署者凭证，由学员执行，测试中从不调用）；
 * - `local` —— 在运行器所在机器上 `bash <脚本>`（运行器就在实例上、或脚本本身调用 AWS CLI 操作云资源时）；
 * - `skip`  —— 只记录、不执行（Windows 开发机默认）。
 * `manual` 型故障到点时打印提示，由学员手工操作（例如控制台 Revoke sessions）。
 */
import { spawn } from 'node:child_process';
import { createReadStream, existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import type { ExpClient } from './http.js';
import type { FaultRecord, FaultSpec, FaultVia } from './types.js';
import { parseDuration, truncate } from './util.js';

export interface FaultContext {
  moduleDir: string;
  client: ExpClient;
  via: FaultVia;
  ssh?: string;
  /** shell-access=ssm 时的实例 ID */
  instanceId?: string;
  region?: string;
  log(message: string): void;
}

export type FaultExecutor = (spec: FaultSpec, ctx: FaultContext) => Promise<Omit<FaultRecord, 'at'>>;

/** 未指定投递方式时的推断。 */
export function resolveVia(spec: FaultSpec, ctx: Pick<FaultContext, 'via' | 'ssh' | 'instanceId'>, platform: NodeJS.Platform = process.platform): FaultVia {
  if (spec.api) return 'api';
  if (spec.manual && !spec.script) return 'skip';
  const v = spec.via && spec.via !== 'auto' ? spec.via : ctx.via;
  if (v && v !== 'auto') return v;
  if (ctx.ssh) return 'ssh';
  if (ctx.instanceId) return 'ssm';
  return platform === 'linux' ? 'local' : 'skip';
}

/** `aws ssm send-command` 的参数（脚本以 base64 内联，避免引号转义）。导出供测试检查，不在测试中执行。 */
export function ssmSendCommandArgs(script: string, args: readonly string[], instanceId: string, region?: string): string[] {
  const b64 = Buffer.from(script, 'utf8').toString('base64');
  const quoted = args.map((a) => `'${a.replace(/'/g, `'\\''`)}'`).join(' ');
  const command = `echo ${b64} | base64 -d > /tmp/cloudalbum-fault.sh && sudo bash /tmp/cloudalbum-fault.sh ${quoted}; rc=$?; rm -f /tmp/cloudalbum-fault.sh; exit $rc`;
  return [
    'ssm', 'send-command', '--instance-ids', instanceId, '--document-name', 'AWS-RunShellScript',
    '--comment', 'cloudalbum experiment fault', '--parameters', JSON.stringify({ commands: [command] }),
    '--query', 'Command.CommandId', '--output', 'text', ...(region ? ['--region', region] : []),
  ];
}

function run(cmd: string, args: string[], stdinFile?: string, timeoutMs = 300_000): Promise<{ code: number | null; output: string; error?: string }> {
  return new Promise((resolve) => {
    let output = '';
    let settled = false;
    const child = spawn(cmd, args, { stdio: [stdinFile ? 'pipe' : 'ignore', 'pipe', 'pipe'], windowsHide: true });
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
    }, timeoutMs);
    child.stdout?.on('data', (d: Buffer) => { output += d.toString(); });
    child.stderr?.on('data', (d: Buffer) => { output += d.toString(); });
    if (stdinFile && child.stdin) createReadStream(stdinFile).pipe(child.stdin);
    child.on('error', (e) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ code: null, output, error: e.message });
    });
    child.on('close', (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ code, output });
    });
  });
}

async function pollSsm(commandId: string, instanceId: string, region: string | undefined): Promise<{ code: number | null; output: string }> {
  const deadline = Date.now() + 300_000;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 3000));
    const r = await run('aws', ['ssm', 'get-command-invocation', '--command-id', commandId, '--instance-id', instanceId,
      '--output', 'json', ...(region ? ['--region', region] : [])]);
    if (r.code !== 0) continue;
    try {
      const inv = JSON.parse(r.output) as { Status?: string; ResponseCode?: number; StandardOutputContent?: string; StandardErrorContent?: string };
      if (inv.Status && !['Pending', 'InProgress', 'Delayed'].includes(inv.Status)) {
        return { code: inv.ResponseCode ?? (inv.Status === 'Success' ? 0 : 1), output: `${inv.StandardOutputContent ?? ''}${inv.StandardErrorContent ?? ''}` };
      }
    } catch {
      /* 继续轮询 */
    }
  }
  return { code: null, output: 'SSM 命令超时' };
}

/** 默认执行器。 */
export const defaultExecutor: FaultExecutor = async (spec, ctx) => {
  const via = resolveVia(spec, ctx);
  const started = Date.now();
  const base = { via, startedAt: new Date(started).toISOString() };
  if (spec.manual) ctx.log(`【需要人工操作】${spec.manual}`);
  if (via === 'api') {
    const res = await ctx.client.post('/api/lab/faults', { json: spec.api, record: false });
    return { ...base, api: spec.api, exitCode: res.ok ? 0 : 1, durationMs: Date.now() - started,
      output: truncate(res.text() || res.error || '', 500), ...(res.ok ? {} : { error: `POST /api/lab/faults → ${res.status || res.error}` }) };
  }
  if (!spec.script) return { ...base, via: spec.manual ? 'manual' : via, exitCode: null, skipped: !spec.manual, ...(spec.manual ? { manual: spec.manual } : {}) };
  const file = path.resolve(ctx.moduleDir, spec.script);
  if (!existsSync(file)) return { ...base, script: spec.script, exitCode: null, error: `脚本不存在：${file}` };
  const args = spec.args ?? [];
  if (via === 'skip') {
    ctx.log(`跳过故障 ${spec.script} ${args.join(' ')}（投递方式 skip；可用 --fault-via ssh|ssm|local）`);
    return { ...base, script: spec.script, exitCode: null, skipped: true };
  }
  let r: { code: number | null; output: string; error?: string };
  if (via === 'local') {
    r = await run('bash', [file, ...args]);
  } else if (via === 'ssh') {
    if (!ctx.ssh) return { ...base, script: spec.script, exitCode: null, error: '--fault-via ssh 需要 --ssh <user@host> 或 EXP_SSH' };
    r = await run('ssh', ['-o', 'BatchMode=yes', ctx.ssh, 'sudo', 'bash', '-s', '--', ...args], file);
  } else {
    if (!ctx.instanceId) return { ...base, script: spec.script, exitCode: null, error: '--fault-via ssm 需要实例 ID（--instance-id 或 state.json）' };
    const send = await run('aws', ssmSendCommandArgs(readFileSync(file, 'utf8'), args, ctx.instanceId, ctx.region));
    r = send.code === 0 ? await pollSsm(send.output.trim(), ctx.instanceId, ctx.region) : send;
  }
  return { ...base, script: spec.script, exitCode: r.code, durationMs: Date.now() - started, output: truncate(r.output.trim(), 2000), ...(r.error ? { error: r.error } : {}) };
};

/**
 * 按时刻调度故障。`start(durationMs)` 在测量阶段开始时调用；`end` 型故障由 `runEnd()` 在场景结束后执行；
 * `stop()` 取消尚未触发的定时器并等待已触发的执行完成。
 */
export class FaultScheduler {
  private readonly timers: NodeJS.Timeout[] = [];
  private readonly running: Array<Promise<void>> = [];
  private readonly unfired = new Set<FaultSpec>();
  readonly records: FaultRecord[] = [];

  constructor(private readonly specs: readonly FaultSpec[], private readonly ctx: FaultContext, private readonly executor: FaultExecutor = defaultExecutor) {}

  private fire(spec: FaultSpec): void {
    this.unfired.delete(spec);
    this.ctx.log(`故障注入 @${spec.at}：${spec.script ?? (spec.api ? `POST /api/lab/faults ${JSON.stringify(spec.api)}` : spec.manual ?? '')}`);
    const p = this.executor(spec, this.ctx)
      .then((r) => { this.records.push({ at: spec.at, ...r }); })
      .catch((e: unknown) => { this.records.push({ at: spec.at, via: 'error', exitCode: null, error: (e as Error).message }); });
    this.running.push(p);
  }

  start(durationMs: number): void {
    for (const spec of this.specs) {
      if (spec.at === 'end') continue;
      const at = spec.at === 'start' ? 0 : parseDuration(spec.at);
      if (at > durationMs) this.ctx.log(`注意：故障 ${spec.script ?? spec.at} 的时刻 ${spec.at} 超过测量时长，场景可能先结束`);
      this.unfired.add(spec);
      this.timers.push(setTimeout(() => this.fire(spec), at));
    }
  }

  async runEnd(): Promise<void> {
    for (const spec of this.specs) if (spec.at === 'end') this.fire(spec);
    await Promise.all(this.running);
  }

  async stop(): Promise<FaultRecord[]> {
    for (const t of this.timers) clearTimeout(t);
    for (const spec of this.unfired) {
      this.records.push({ at: spec.at, ...(spec.script ? { script: spec.script } : {}), via: 'none', exitCode: null, skipped: true, error: '场景在该时刻之前已结束' });
    }
    this.unfired.clear();
    await Promise.all(this.running);
    return this.records;
  }
}
