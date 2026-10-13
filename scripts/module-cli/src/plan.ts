/**
 * Plan validation (modular-design.md 9.2 step 1): stage "the env set after the operation" (values that only exist after
 * deployment become syntactically valid placeholders) and run the backend rule engine on it:
 *   node backend/dist/cli.js check-config --env-dir <staging> --plan --json      (78 = rejected)
 * The engine is the same code that runs on the instance, so the operator sees exactly the startup verdict (errors,
 * warnings, fixes) before anything is deployed. Deployment-scope rules (DEP-014/016/037, MUTEX-004) are checked by
 * scripts/module itself (hooks.ts / preflight) because they need cloud state.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { ModuleId } from '@cloudalbum/contracts';
import { renderEnvFile, type EnvMap } from './env-file.js';
import type { Printer } from './printer.js';

/** Replace `<placeholder>` values by values that pass the zod schema (URLs, ARNs, pool IDs). */
export function stagedValue(key: string, value: string): string {
  if (!value.includes('<')) return value;
  if (key === 'REDIS_URL') return 'rediss://placeholder.invalid:6379';
  if (key === 'CDN_BASE_URL') return 'https://placeholder.cloudfront.net';
  if (key === 'COGNITO_USER_POOL_ID') return 'ap-northeast-1_Placeholder';
  if (key === 'IMAGE_LAMBDA_FUNCTION') return 'arn:aws:lambda:ap-northeast-1:000000000000:function:placeholder';
  if (/_URL$/.test(key)) return `https://placeholder.invalid/${key.toLowerCase()}`;
  if (/_ARN$/.test(key)) return 'arn:aws:secretsmanager:ap-northeast-1:000000000000:secret:placeholder';
  if (/_PORT$/.test(key)) return '5432';
  if (/_ID$/.test(key)) return 'placeholder-id';
  return 'placeholder';
}

export interface StagedEnv {
  base: EnvMap;
  modules: Partial<Record<ModuleId, EnvMap>>;
  secrets: EnvMap;
}

export function writeStagedEnv(dir: string, staged: StagedEnv): void {
  mkdirSync(path.join(dir, 'modules.d'), { recursive: true });
  writeFileSync(path.join(dir, 'cloudalbum.env'), renderEnvFile(staged.base));
  for (const [id, env] of Object.entries(staged.modules)) {
    if (!env) continue;
    const vals = Object.fromEntries(Object.entries(env).map(([k, v]) => [k, stagedValue(k, v)]));
    writeFileSync(path.join(dir, 'modules.d', `${id}.env`), renderEnvFile(vals));
  }
  if (Object.keys(staged.secrets).length) {
    writeFileSync(path.join(dir, 'secrets.env'), renderEnvFile(Object.fromEntries(Object.entries(staged.secrets).map(([k, v]) => [k, v.includes('<') ? 'placeholder-secret' : v]))));
  }
}

export interface CheckIssue { rule: string; severity: string; message: string; fix?: string; modules?: string[] }
export interface LocalCheckResult { ran: boolean; ok: boolean; errors: CheckIssue[]; warnings: CheckIssue[]; parseErrors: unknown[]; reason?: string }

/** Run the backend check-config on a staged env directory (operator machine). */
export function runLocalCheck(repoRoot: string, staged: StagedEnv): LocalCheckResult {
  const cli = path.join(repoRoot, 'backend', 'dist', 'cli.js');
  if (!existsSync(cli)) return { ran: false, ok: true, errors: [], warnings: [], parseErrors: [], reason: 'backend/dist/cli.js missing (npm run build)' };
  const dir = mkdtempSync(path.join(os.tmpdir(), 'cloudalbum-plan-'));
  try {
    writeStagedEnv(dir, staged);
    let stdout = '';
    try {
      stdout = execFileSync(process.execPath, [cli, 'check-config', '--env-dir', dir, '--plan', '--json'], {
        cwd: path.join(repoRoot, 'backend'), encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
        env: { ...process.env, CLOUDALBUM_ENV_DIR: dir, NODE_ENV: 'production' },
      });
    } catch (e) {
      stdout = String((e as { stdout?: string }).stdout ?? '');
    }
    const start = stdout.indexOf('{');
    if (start === -1) return { ran: false, ok: true, errors: [], warnings: [], parseErrors: [], reason: `unexpected check-config output: ${stdout.slice(0, 200)}` };
    const r = JSON.parse(stdout.slice(start)) as { ok: boolean; errors?: CheckIssue[]; warnings?: CheckIssue[]; parseErrors?: unknown[] };
    return { ran: true, ok: r.ok, errors: r.errors ?? [], warnings: r.warnings ?? [], parseErrors: r.parseErrors ?? [] };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

export function printCheck(out: Printer, r: LocalCheckResult): void {
  if (!r.ran) { out.warn(`plan check skipped: ${r.reason}`); return; }
  out.info(`      check-config --plan (staged env): ${r.ok ? 'OK' : 'REJECTED (78 on the instance)'}; ${r.errors.length} error(s), ${r.warnings.length} warning(s)`);
  for (const e of r.parseErrors) out.error(`      parse: ${JSON.stringify(e)}`);
  for (const e of r.errors) out.error(`      ${e.rule}: ${e.message}${e.fix ? `\n            fix: ${e.fix}` : ''}`);
  for (const w of r.warnings) out.warn(`      ${w.rule}: ${w.message}`);
}
