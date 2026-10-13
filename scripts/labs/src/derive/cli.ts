/**
 * `scripts/module plan --start-of <card> [--variant <v>] --lab-file <path> --platform --json` (06 PM-32/33) as the
 * authoritative plan source of `labs:derive`. When the installed toolkit does not know `--start-of` yet, the caller
 * falls back to the reference derivation (`reference.ts`) and says so.
 *
 * The command is run as `node scripts/module-cli/dist/index.js …` when built, otherwise through tsx on the sources
 * (same resolution as the `scripts/module` wrapper). `ATL_LABS_PLAN_CMD` (JSON array: argv prefix) overrides it.
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import type { LabsPaths } from '../paths.js';
import { PLAN_SCHEMA, planDigest, str, type PlanEntry, type PlanOutput } from './plan.js';

export type CliPlanResult =
  | { status: 'ok'; plan: PlanOutput; raw: unknown }
  | { status: 'unavailable'; reason: string }
  | { status: 'failed'; exitCode: number; message: string; raw?: unknown };

export function planCommand(p: LabsPaths): string[] {
  const override = process.env.ATL_LABS_PLAN_CMD;
  if (override) return JSON.parse(override) as string[];
  const dist = path.join(p.moduleCli, 'dist', 'index.js');
  if (fs.existsSync(dist)) return [process.execPath, dist];
  const require = createRequire(import.meta.url);
  const tsxCli = require.resolve('tsx/cli');
  return [process.execPath, tsxCli, path.join(p.moduleCli, 'src', 'index.ts')];
}

function run(p: LabsPaths, args: string[], cwd?: string): { code: number; stdout: string; stderr: string } {
  const [cmd, ...prefix] = planCommand(p);
  const r = spawnSync(cmd!, [...prefix, ...args], {
    cwd: cwd ?? p.repo,
    encoding: 'utf8',
    env: { ...process.env, CLOUDALBUM_REPO_ROOT: p.repo, NO_COLOR: '1' },
    timeout: 120_000,
    maxBuffer: 16 * 1024 * 1024,
  });
  return { code: r.status ?? 1, stdout: r.stdout ?? '', stderr: `${r.stderr ?? ''}${r.error ? String(r.error) : ''}` };
}

function firstJson(text: string): unknown {
  const i = text.indexOf('{');
  if (i < 0) return undefined;
  try {
    return JSON.parse(text.slice(i));
  } catch {
    return undefined;
  }
}

/** Normalizes the PM-33 output (`start[]`; an earlier draft used `provisions[]` with `item`). */
export function normalizeCliPlan(raw: Record<string, unknown>, card: string, variant: string): PlanOutput {
  const entries = ((raw.start ?? raw.provisions ?? []) as Record<string, unknown>[]).map(
    (e): PlanEntry => ({
      id: String(e.id ?? e.item),
      kind: (e.kind as PlanEntry['kind']) ?? 'module',
      basis: (e.basis as PlanEntry['basis']) ?? 'closure',
      ...(e.set ? { set: Object.fromEntries(Object.entries(e.set as Record<string, unknown>).map(([k, v]) => [k, str(v as string)])) } : {}),
      ...(e.params ? { params: Object.fromEntries(Object.entries(e.params as Record<string, unknown>).map(([k, v]) => [k, str(v as string)])) } : {}),
      ...(e.value !== undefined ? { value: str(e.value as string) } : {}),
      ...(Array.isArray(e.because) ? { because: (e.because as unknown[]).map(String) } : {}),
    }),
  );
  const platform = (raw.platform ?? {}) as Record<string, string>;
  const out: PlanOutput = {
    schema: PLAN_SCHEMA,
    deriver: 'scripts/module',
    registryVersion: String(raw.registryVersion ?? ''),
    toolkitVersion: String(raw.toolkitVersion ?? ''),
    card: String(raw.card ?? card),
    variant: String(raw.variant ?? variant),
    profileName: String(raw.profileName ?? `atl/${card}/${variant}`),
    start: entries,
    targets: (raw.targets as PlanOutput['targets']) ?? [],
    branches: (raw.branches as PlanOutput['branches']) ?? {},
    platform: { 'preview.directHttps': platform['preview.directHttps'] === 'off' ? 'off' : 'on' },
    baseParams: (raw.baseParams as Record<string, string>) ?? {},
    warnings: ((raw.warnings ?? raw.warningsAfterTargets ?? []) as unknown[]).map((w) => (typeof w === 'string' ? w : String((w as { rule?: string }).rule))),
    errors: ((raw.errors ?? []) as unknown[]).map((e) => (typeof e === 'string' ? e : JSON.stringify(e))),
    order: (raw.order as string[]) ?? [],
    seeds: (raw.seeds as string[]) ?? [],
    extraStacks: (raw.extraStacks as PlanOutput['extraStacks']) ?? [],
    targetDeps: {},
    digest: String(raw.digest ?? ''),
  };
  if (!out.digest) {
    out.digest = planDigest({ card, variant, registryVersion: out.registryVersion, start: out.start, platform: out.platform, baseParams: out.baseParams, extraStacks: out.extraStacks });
  }
  return out;
}

export function cliPlan(p: LabsPaths, card: string, variant: string, labFile: string): CliPlanResult {
  const r = run(p, ['plan', '--start-of', card, ...(variant !== 'default' ? ['--variant', variant] : []), '--lab-file', labFile, '--platform', '--json']);
  if (/unknown option ['"]?--start-of|unknown option '--lab-file'|missing required argument/i.test(r.stderr)) {
    return { status: 'unavailable', reason: 'scripts/module plan does not support --start-of yet (06 PM-33)' };
  }
  const raw = firstJson(r.stdout);
  if (raw && typeof raw === 'object' && (raw as { schema?: string }).schema === PLAN_SCHEMA) {
    const plan = normalizeCliPlan(raw as Record<string, unknown>, card, variant);
    if (r.code === 0) return { status: 'ok', plan, raw };
    return { status: 'failed', exitCode: r.code, message: (r.stderr || r.stdout).trim().slice(0, 2000), raw };
  }
  if (r.code !== 0) return { status: 'failed', exitCode: r.code, message: (r.stderr || r.stdout).trim().slice(0, 2000) };
  return { status: 'unavailable', reason: `unexpected output of scripts/module plan --start-of: ${r.stdout.slice(0, 200)}` };
}

/**
 * `plan --profile atl/<card>/<variant> --platform --json` on a generated profile file (DRV-10 run-time entry point).
 * The file is placed at `profiles/atl/<card>/<variant>.env` under a scratch working directory (06 PM-32: the runner puts
 * the downloaded file at this relative path).
 */
export function cliProfileDigest(p: LabsPaths, card: string, variant: string, profileText: string, then: string[] = []): { status: 'ok'; digest: string; warnings: string[] } | { status: 'unavailable' | 'failed'; reason: string } {
  const tmpRoot = path.join(p.repo, '.atl-dev', 'tmp');
  fs.mkdirSync(tmpRoot, { recursive: true });
  const dir = fs.mkdtempSync(path.join(tmpRoot ?? os.tmpdir(), 'labs-profile-'));
  try {
    const file = path.join(dir, 'profiles', 'atl', card, `${variant}.env`);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, profileText);
    const r = run(p, ['plan', '--profile', `atl/${card}/${variant}`, ...(then.length ? ['--then', then.join(',')] : []), '--platform', '--json'], dir);
    if (/unknown option|missing required argument/i.test(r.stderr)) return { status: 'unavailable', reason: 'scripts/module plan does not support --profile yet (06 PM-32)' };
    const raw = firstJson(r.stdout) as { digest?: string; warnings?: unknown[] } | undefined;
    if (!raw?.digest) return { status: r.code === 0 ? 'unavailable' : 'failed', reason: (r.stderr || r.stdout).trim().slice(0, 500) };
    return { status: 'ok', digest: raw.digest, warnings: (raw.warnings ?? []).map((w) => (typeof w === 'string' ? w : String((w as { rule?: string }).rule))) };
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}
