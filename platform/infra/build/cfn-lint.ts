/**
 * Run cfn-lint on the built platform template and the workstation template (01 §6.10). cfn-lint is a Python tool: set
 * ATL_CFN_LINT to its executable, or have `cfn-lint` on PATH (pip install cfn-lint). Fails only on errors
 * (`--non-zero-exit-code error`); warnings are printed.
 *   npm run cfn-lint -w @atl/infra
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { INFRA_ROOT, TEMPLATE_FILE_NAME } from './merge-template.js';
import { WORKSTATION_TEMPLATE } from './workstation-template.js';

export function cfnLintExecutable(): string | null {
  const candidates = [process.env.ATL_CFN_LINT, 'cfn-lint'].filter(Boolean) as string[];
  for (const c of candidates) {
    const r = spawnSync(c, ['--version'], { encoding: 'utf8' });
    if (r.status === 0) return c;
  }
  return null;
}

export function runCfnLint(files: string[], exe: string): { status: number; output: string } {
  const r = spawnSync(exe, ['--non-zero-exit-code', 'error', '--regions', 'ap-northeast-1', '--', ...files], {
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  });
  return { status: r.status ?? 1, output: `${r.stdout ?? ''}${r.stderr ?? ''}` };
}

function main(): void {
  const exe = cfnLintExecutable();
  if (!exe) {
    console.error('cfn-lint not found: pip install cfn-lint, or set ATL_CFN_LINT');
    process.exitCode = 2;
    return;
  }
  const template = path.join(INFRA_ROOT, 'dist', TEMPLATE_FILE_NAME);
  if (!fs.existsSync(template)) throw new Error('build the template first: npm run template -w @atl/infra');
  const r = runCfnLint([template, WORKSTATION_TEMPLATE], exe);
  process.stdout.write(r.output || 'cfn-lint: no findings\n');
  process.exitCode = r.status;
}

if (process.argv[1] && /cfn-lint\.(ts|js)$/.test(process.argv[1])) main();
