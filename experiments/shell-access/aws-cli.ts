/**
 * experiments/shell-access/aws-cli.ts —— 在工作台上以学员身份调用 AWS CLI v2（只读：DescribeSessions、DescribeLogStreams、
 * LookupEvents、DescribeInstances、DescribeSecurityGroupRules）。实验依赖包不含 AWS SDK，所以经 CLI 取控制面证据；
 * 测试中用 setAwsRunner() 替换。
 */
import { spawn } from 'node:child_process';

export type AwsRunner = (args: readonly string[]) => Promise<{ code: number | null; stdout: string; stderr: string }>;

const defaultRunner: AwsRunner = (args) => new Promise((resolve) => {
  let stdout = '';
  let stderr = '';
  const child = spawn('aws', [...args], { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
  const timer = setTimeout(() => child.kill('SIGKILL'), 60_000);
  child.stdout.on('data', (d: Buffer) => { stdout += d.toString(); });
  child.stderr.on('data', (d: Buffer) => { stderr += d.toString(); });
  child.on('error', (e) => { clearTimeout(timer); resolve({ code: null, stdout, stderr: e.message }); });
  child.on('close', (code) => { clearTimeout(timer); resolve({ code, stdout, stderr }); });
});

let runner: AwsRunner = defaultRunner;

/** 测试：替换 AWS CLI；返回恢复函数 */
export function setAwsRunner(r: AwsRunner): () => void {
  const prev = runner;
  runner = r;
  return () => { runner = prev; };
}

export class AwsCliError extends Error {
  constructor(readonly args: readonly string[], readonly code: number | null, readonly stderr: string) {
    super(`aws ${args.slice(0, 2).join(' ')} 失败（${code ?? 'spawn'}）：${stderr.trim().slice(0, 300)}`);
    this.name = 'AwsCliError';
  }
}

/** `aws <args> --output json [--region r]` → JSON */
export async function awsJson<T = Record<string, unknown>>(args: readonly string[], region?: string): Promise<T> {
  const full = [...args, '--output', 'json', ...(region ? ['--region', region] : [])];
  const r = await runner(full);
  if (r.code !== 0) throw new AwsCliError(full, r.code, r.stderr);
  return (r.stdout.trim() ? JSON.parse(r.stdout) : {}) as T;
}
