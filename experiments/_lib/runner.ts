/**
 * experiments/_lib/runner.ts —— 实验运行器（总纲 §8.2；Node 实现，不依赖 k6）
 *
 *   npm run exp -- <module> --label before|after|<变体> [--scenario <id>] [--target <url>] \
 *                  [--vus 10|10,50,200] [--duration 60s] [--warmup 10s] [--repeat 3] [--ab] [--upload] [--force] \
 *                  [--param k=v ...] [--fault-via auto|local|ssh|ssm|skip] [--ssh user@host] [--instance-id i-…] \
 *                  [--out <结果目录>] [--keep] [--list]
 *
 * 步骤：读取 <module>/experiment.json → 抓取管理员视图的 /api/capabilities 并校验 requires[label]（不匹配拒绝运行，
 * --force 时记 forced: true）→ 生成 runId（ULID）并 POST /api/lab/runs → 预热（不带实验头、不计入结果）→ 执行场景
 * （请求带 X-Experiment-Run / X-Experiment-Label；--ab 时交替带 X-Compare-Bypass，标签 <label>:A / <label>:B）→
 * 按 faults 注入故障 → 拉取 /api/lab/metrics?run= → 清理 → 写 _results/<module>/<UTC>__<label>__<runId>.json
 * （--upload 时 POST /api/lab/results）。
 *
 * 退出码：0 成功（含 manual 场景只打印指引）；1 场景或写结果失败；2 用法 / 清单错误；3 前置条件不满足（未 --force）；
 *         4 无法连接目标或没有管理员令牌。
 */
import { spawn } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { HEADERS, isModuleId, type BypassKey } from '@cloudalbum/contracts';
import { ulid } from 'ulid';
import {
  checkRequires, emptyServer, environmentOf, fetchCapabilities, fetchServerMetrics, finishRun, registerRun, uploadResult,
} from './collect.js';
import { defaultExecutor, FaultScheduler, type FaultExecutor } from './faults.js';
import { AbState, BypassLimiter, closeSharedDispatcher, ExpClient, type ClientOptions } from './http.js';
import { faultsFor, loadManifest, ManifestError, moduleDir, resolveParams, selectExperiment, validateLabel, variantOf } from './manifest.js';
import type { ParamValue, ScenarioContext, ScenarioModule } from './scenario.js';
import { validateResult } from './schema.js';
import { resolveAdminToken, resolveTarget } from './session.js';
import { Recorder } from './stats.js';
import type { Capabilities, ExperimentDef, FaultRecord, FaultVia, RepeatSummary, ResultDoc } from './types.js';
import {
  experimentsRoot, fileTimestamp, formatDuration, mapLimit, median, parseDuration, parseKeyValues, repoRoot, runningFromSource, truncate,
} from './util.js';

export const EXPERIMENT_HEADERS = {
  run: HEADERS.experimentRun,
  label: HEADERS.experimentLabel,
  bypass: HEADERS.compareBypass,
} as const;

export const RUNNER_VERSION = '0.1.0';

export const EXIT = { ok: 0, failed: 1, usage: 2, requires: 3, target: 4 } as const;

export interface RunnerArgs {
  module: string;
  label: string;
  scenario?: string;
  target?: string;
  vus?: number[];
  duration?: string;
  warmup?: string;
  repeat: number;
  ab: boolean;
  upload: boolean;
  force: boolean;
  params: Record<string, string>;
  token?: string;
  faultVia: FaultVia;
  ssh?: string;
  instanceId?: string;
  out?: string;
  keep: boolean;
  list: boolean;
  help: boolean;
}

export const USAGE = `用法：npm run exp -- <module> --label <标签> [--scenario <id>] [--target <url>] [--vus 10|10,50] [--duration 60s]
                  [--warmup 10s] [--repeat N] [--ab] [--upload] [--force] [--param k=v] [--fault-via auto|local|ssh|ssm|skip]
                  [--ssh user@host] [--instance-id i-…] [--out <目录>] [--keep] [--list]
环境变量：CLOUDALBUM_ADMIN_TOKEN | CLOUDALBUM_ADMIN_EMAIL + CLOUDALBUM_ADMIN_PASSWORD、EXP_TARGET、EXP_SSH、EXP_RESULTS_DIR`;

export function parseRunnerArgs(argv: string[]): RunnerArgs {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    strict: true,
    options: {
      label: { type: 'string', short: 'l' },
      scenario: { type: 'string', short: 's' },
      target: { type: 'string', short: 't' },
      vus: { type: 'string' },
      duration: { type: 'string', short: 'd' },
      warmup: { type: 'string' },
      repeat: { type: 'string' },
      ab: { type: 'boolean' },
      upload: { type: 'boolean' },
      force: { type: 'boolean' },
      param: { type: 'string', multiple: true, short: 'p' },
      token: { type: 'string' },
      'fault-via': { type: 'string' },
      ssh: { type: 'string' },
      'instance-id': { type: 'string' },
      out: { type: 'string' },
      keep: { type: 'boolean' },
      list: { type: 'boolean' },
      help: { type: 'boolean', short: 'h' },
    },
  });
  const vus = values.vus?.split(',').map((s) => Number(s.trim())).filter((n) => Number.isFinite(n));
  if (vus && (!vus.length || vus.some((n) => n < 1 || !Number.isInteger(n)))) throw new ManifestError(`--vus 需要正整数或逗号分隔的列表：${values.vus}`);
  const repeat = values.repeat === undefined ? 1 : Number(values.repeat);
  if (!Number.isInteger(repeat) || repeat < 1 || repeat > 20) throw new ManifestError(`--repeat 需要 1～20 的整数：${values.repeat}`);
  const via = (values['fault-via'] ?? 'auto') as FaultVia;
  if (!['auto', 'local', 'ssh', 'ssm', 'api', 'skip'].includes(via)) throw new ManifestError(`--fault-via 不合法：${via}`);
  if (values.duration) parseDuration(values.duration);
  if (values.warmup) parseDuration(values.warmup);
  return {
    module: positionals[0] ?? '',
    label: values.label ?? '',
    ...(values.scenario ? { scenario: values.scenario } : {}),
    ...(values.target ? { target: values.target } : {}),
    ...(vus ? { vus } : {}),
    ...(values.duration ? { duration: values.duration } : {}),
    ...(values.warmup ? { warmup: values.warmup } : {}),
    repeat,
    ab: values.ab ?? false,
    upload: values.upload ?? false,
    force: values.force ?? false,
    params: parseKeyValues(values.param),
    ...(values.token ? { token: values.token } : {}),
    faultVia: via,
    ...(values.ssh ? { ssh: values.ssh } : {}),
    ...(values['instance-id'] ? { instanceId: values['instance-id'] } : {}),
    ...(values.out ? { out: values.out } : {}),
    keep: values.keep ?? false,
    list: values.list ?? false,
    help: values.help ?? false,
  };
}

export interface RunnerDeps {
  env?: NodeJS.ProcessEnv;
  /** experiments 根目录（清单与场景脚本所在处）；测试可替换 */
  root?: string;
  /** 仓库根（.cloudalbum/state.json 与令牌缓存） */
  repo?: string;
  faultExecutor?: FaultExecutor;
  log?: (line: string) => void;
  signal?: AbortSignal;
}

export interface RunOutcome {
  code: number;
  result?: ResultDoc;
  file?: string;
  message?: string;
}

function scenarioPath(root: string, module: string, script: string): string {
  if (runningFromSource() || !script.endsWith('.ts')) return path.join(root, module, script);
  return path.join(root, 'dist', module, script.replace(/\.ts$/, '.js'));
}

async function loadScenario(file: string): Promise<ScenarioModule> {
  const mod = (await import(pathToFileURL(file).href)) as { default?: ScenarioModule; scenario?: ScenarioModule };
  const s = mod.default ?? mod.scenario;
  if (!s || typeof s.run !== 'function') throw new ManifestError(`${file} 没有默认导出 defineScenario({ run })`);
  return s;
}

/** shell 场景：bash 执行，stdout 最后一行 `EXP-RESULT:<json>` → findings。 */
function runShellScenario(file: string, env: Record<string, string>, log: (s: string) => void, signal: AbortSignal): Promise<{ code: number | null; findings: Record<string, unknown>; output: string }> {
  return new Promise((resolve) => {
    let out = '';
    const child = spawn('bash', [file], { env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    const onAbort = () => child.kill('SIGTERM');
    signal.addEventListener('abort', onAbort, { once: true });
    child.stdout.on('data', (d: Buffer) => {
      const s = d.toString();
      out += s;
      for (const line of s.split('\n')) if (line.trim() && !line.startsWith('EXP-RESULT:')) log(`  | ${line}`);
    });
    child.stderr.on('data', (d: Buffer) => log(`  | ${d.toString().trimEnd()}`));
    child.on('error', (e) => resolve({ code: null, findings: { error: e.message }, output: out }));
    child.on('close', (code) => {
      signal.removeEventListener('abort', onAbort);
      const last = out.split('\n').reverse().find((l) => l.startsWith('EXP-RESULT:'));
      let findings: Record<string, unknown> = {};
      if (last) {
        try {
          findings = JSON.parse(last.slice('EXP-RESULT:'.length)) as Record<string, unknown>;
        } catch (e) {
          findings = { parseError: (e as Error).message };
        }
      }
      resolve({ code, findings, output: out });
    });
  });
}

function offlineCapabilities(): Capabilities {
  return {
    schemaVersion: 2, generatedAt: new Date().toISOString(), view: 'public',
    app: { version: 'offline', profile: 'offline', deployMode: 'single', region: '', instance: { id: '', az: '', type: '', role: 'cli' },
      entry: { baseUrl: '', source: 'base' }, configHash: '', startedAt: '' },
    https: { trusted: false, via: 'none' }, validation: { errors: [], warnings: [], overridden: [] },
    modules: {} as Capabilities['modules'], features: {}, lab: { bypassEnabled: false, bypassKeys: [] },
  };
}

function printSummary(doc: ResultDoc, file: string | undefined, log: (s: string) => void): void {
  log('');
  log(`== ${doc.module}/${doc.experiment} · ${doc.label}${doc.forced ? ' · [FORCED]' : ''} · runId ${doc.runId}`);
  log(`   请求 ${doc.client.requests}，错误 ${doc.client.errors}${doc.client.rps !== undefined ? `，${doc.client.rps} rps` : ''}`);
  const rows = Object.entries(doc.client.latencyMs).sort((a, b) => b[1].count - a[1].count).slice(0, 12);
  for (const [k, s] of rows) {
    log(`   ${k.padEnd(44)} n=${String(s.count).padStart(5)}  p50=${String(s.p50 ?? '-').padStart(7)}  p95=${String(s.p95 ?? '-').padStart(7)}  err=${s.errors}`);
  }
  for (const [variant, slice] of Object.entries(doc.client.byVariant ?? {})) {
    const top = Object.entries(slice.latencyMs).sort((a, b) => b[1].count - a[1].count)[0];
    if (top) log(`   [${variant}] ${top[0]} n=${top[1].count} p50=${top[1].p50} p95=${top[1].p95}`);
  }
  const paths = Object.entries(doc.client.paths ?? {}).sort((a, b) => b[1] - a[1]).slice(0, 4);
  for (const [sig, n] of paths) log(`   路径 ${truncate(sig, 100)} ×${n}`);
  const timing = Object.entries(doc.client.serverTiming ?? {}).filter(([k]) => k !== 'total' && k !== 'app');
  if (timing.length) log(`   Server-Timing：${timing.map(([k, t]) => `${k} p95=${t.p95}ms ×${t.callsPerRequest ?? '?'}/req`).join('；')}`);
  if (!doc.server.available) log(`   服务端指标不可用：${doc.server.error ?? ''}`);
  else log(`   服务端：${Object.keys(doc.server.routes).length} 个路由，${Object.keys(doc.server.ports).length} 个端口，主机采样 ${doc.server.host.samples} 条`);
  const biz = Object.entries(doc.server.business);
  if (biz.length) log(`   业务：${biz.map(([k, v]) => `${k}=${v}`).join('，')}`);
  const findings = Object.entries(doc.scenario?.findings ?? {}).slice(0, 12);
  for (const [k, v] of findings) log(`   发现 ${k} = ${truncate(JSON.stringify(v) ?? String(v), 160)}`);
  for (const w of doc.warnings ?? []) log(`   警告：${w}`);
  if (file) log(`   结果：${file}`);
}

/** 运行一次实验（可编程调用；main() 是它的命令行包装）。 */
export async function runExperiment(args: RunnerArgs, deps: RunnerDeps = {}): Promise<RunOutcome> {
  const env = deps.env ?? process.env;
  const root = deps.root ?? experimentsRoot();
  const repo = deps.repo ?? repoRoot();
  const log = deps.log ?? ((s: string) => console.error(s));
  const signal = deps.signal ?? new AbortController().signal;

  if (args.help || !args.module) return { code: args.help ? EXIT.ok : EXIT.usage, message: USAGE };

  let exp: ExperimentDef;
  let params: Record<string, ParamValue>;
  try {
    const manifest = loadManifest(args.module, root);
    if (args.list) {
      for (const e of manifest.experiments) {
        log(`${e.id.padEnd(22)} ${e.kind.padEnd(13)} ${e.scenario.tool.padEnd(6)} 标签：${Object.keys(e.requires ?? {}).join('/') || '任意'}  ${e.title}`);
      }
      return { code: EXIT.ok };
    }
    exp = selectExperiment(manifest, args.scenario);
    if (!args.label) throw new ManifestError(`缺少 --label（可选：${Object.keys(exp.requires ?? {}).join(', ') || '任意'}）`);
    validateLabel(exp, args.label);
    if (args.ab && !exp.ab) throw new ManifestError(`实验 ${exp.id} 不支持 --ab（没有声明 ab.bypass）`);
    params = resolveParams(exp, args.params);
  } catch (e) {
    return { code: EXIT.usage, message: (e as Error).message };
  }

  const dir = moduleDir(exp.module, root);
  if (exp.scenario.tool === 'manual') {
    const readme = path.join(dir, 'README.md');
    return { code: EXIT.ok, message: `实验 ${exp.module}/${exp.id} 是手工实验：按 ${path.relative(repo, readme)} 的“${exp.id}”一节操作${exp.doc ? `（设计：${exp.doc}）` : ''}。` };
  }
  if (exp.scenario.tool === 'k6') {
    return { code: EXIT.usage, message: `实验 ${exp.id} 声明了 tool=k6：本实现不依赖 k6，请改写为 node 场景（<scenario>.ts）。` };
  }
  if (exp.scenario.tool === 'shell' && process.platform !== 'linux') {
    return { code: EXIT.usage, message: `实验 ${exp.id} 是 shell 场景（${exp.scenario.script}），需要在实例（Amazon Linux 2023）上运行。` };
  }

  const vusList = args.vus ?? [exp.scenario.vus ?? 1];
  const durationStr = args.duration ?? exp.scenario.duration ?? '30s';
  const durationMs = parseDuration(durationStr);
  const warmupStr = args.warmup ?? exp.scenario.warmup ?? '0s';
  const warmupMs = parseDuration(warmupStr);
  const offline = exp.scenario.offline === true;
  const warnings: string[] = [];
  const notes: string[] = [];

  // ---------------------------------------------------------------------------------- 1. 目标与令牌
  let target = 'offline:';
  let token: string | undefined;
  let credentials: { email: string; password: string } | undefined;
  if (!offline) {
    try {
      target = resolveTarget(args.target, env, repo);
    } catch (e) {
      return { code: EXIT.usage, message: (e as Error).message };
    }
    const t = await resolveAdminToken({ target, ...(args.token ? { token: args.token } : {}), env, root: repo });
    token = t.token;
    credentials = t.credentials;
    if (!token) return { code: EXIT.target, message: t.error ?? '没有管理员令牌' };
  }
  const admin = new ExpClient({ base: offline ? 'http://127.0.0.1' : target, ...(token ? { token } : {}), recording: false, signal });

  // ---------------------------------------------------------------------------------- 2. capabilities 与前置断言
  let caps: Capabilities;
  if (offline) {
    caps = offlineCapabilities();
    if (exp.requires?.[args.label] && Object.keys(exp.requires[args.label]!).length) warnings.push('离线场景：未校验 requires');
  } else {
    try {
      caps = await fetchCapabilities(admin);
    } catch (e) {
      return { code: EXIT.target, message: `${(e as Error).message}（目标 ${target}）` };
    }
    if (caps.view !== 'admin') {
      if (!args.force) return { code: EXIT.target, message: `/api/capabilities 返回的是 ${caps.view ?? '?'} 视图：令牌不是管理员（实验头只对管理员有效）` };
      warnings.push(`capabilities 不是管理员视图（${caps.view}）`);
    }
  }
  const req = offline ? { ok: true, mismatches: [] } : checkRequires(caps, exp.requires?.[args.label]);
  if (!req.ok) {
    const lines = req.mismatches.map((m) => `  ${m.key}: 期望 ${JSON.stringify(m.expected)}，实际 ${JSON.stringify(m.actual)}`).join('\n');
    if (!args.force) {
      return { code: EXIT.requires, message: `当前部署不满足 ${exp.id} 的 requires.${args.label}，拒绝运行（--force 可强制，结果会标记 forced）：\n${lines}` };
    }
    warnings.push(`强制运行：不满足 requires.${args.label}（${req.mismatches.map((m) => `${m.key}=${JSON.stringify(m.actual)}`).join('，')}）`);
    log(`警告：强制运行，前置条件不满足：\n${lines}`);
  }
  const forced = !req.ok;

  // ---------------------------------------------------------------------------------- 3. 登记运行
  const runId = ulid();
  let registered = false;
  if (!offline) {
    const reg = await registerRun(admin, {
      runId, module: exp.module, experiment: exp.id, label: args.label, variant: variantOf(exp, args.label), forced,
      params: { vus: vusList.length > 1 ? vusList : vusList[0], duration: durationStr, repeat: args.repeat, ab: args.ab, ...params },
    });
    registered = reg.registered;
    if (!registered) warnings.push(`未能登记运行（${reg.error}）；服务端仍按 X-Experiment-Run 归组`);
  }
  log(`== ${exp.module}/${exp.id} · ${args.label}${args.ab ? ' · A/B' : ''} · runId ${runId} · 目标 ${offline ? '（离线）' : target}`);
  log(`   ${exp.title}`);

  const recorder = new Recorder();
  const abState = args.ab && exp.ab ? new AbState(exp.ab.bypass) : undefined;
  const limiter = new BypassLimiter();
  const measureClient = admin.child({ recorder, experiment: { runId, label: args.label }, recording: true, ...(abState ? { ab: abState } : {}), limiter, target: 'direct' });
  const warmupClient = admin.child({ recording: false, limiter });
  if (abState) notes.push(`A/B：A = 带 X-Compare-Bypass: ${abState.bypass}（相当于“没有”），B = 不带（“有”）；旁路请求按服务端限额在客户端限流（≤110/分钟、≤4 在途）`);

  const findings: Record<string, unknown> = {};
  let business: Record<string, number> = {};
  const businessByRepeat: Array<Record<string, number>> = [];
  const cleanups: Array<{ method: string; path: string }> = [];
  let scenarioError: string | undefined;

  const makeCtx = (phase: 'warmup' | 'measure', vus: number, dur: number, repeat: number, stage: string | undefined): ScenarioContext => {
    const startedAt = performance.now();
    const client = phase === 'measure' ? measureClient : warmupClient;
    const sink = phase === 'measure';
    return {
      module: exp.module, experiment: exp, label: args.label, runId, target, phase, vus, durationMs: dur, repeat,
      ...(stage ? { stage } : {}),
      ab: phase === 'measure' && Boolean(abState),
      ...(exp.ab ? { abBypass: exp.ab.bypass as BypassKey } : {}),
      params, capabilities: caps, client,
      http(base, o = {}) {
        const overrides: Partial<ClientOptions> = { base };
        if (o.target) overrides.target = o.target;
        if (o.auth === false) overrides.token = undefined;
        else if (o.token) overrides.token = o.token;
        // 用户令牌不是管理员：不带实验头与旁路头（否则 403 EXPERIMENT_FORBIDDEN）
        if (o.experiment === false || o.token) {
          overrides.experiment = undefined;
          overrides.ab = undefined;
        }
        return client.child(overrides);
      },
      recorder, signal,
      log: (m) => log(`   ${m}`),
      finding: (k, v) => { if (sink && v !== undefined) findings[k] = v; },
      business: (k, v) => { if (sink && v !== undefined && Number.isFinite(v)) business[k] = v; },
      note: (t) => { if (sink) notes.push(t); },
      cleanupLater: (method, p) => { cleanups.push({ method, path: p }); },
      elapsedMs: () => performance.now() - startedAt,
      remainingMs: () => Math.max(0, dur - (performance.now() - startedAt)),
      ...(credentials ? { credentials } : {}),
    };
  };

  // 故障脚本参数中的 {参数名} 用本次运行的参数替换（例如 balloon.sh fill {fillPct}）
  const faultSpecs = faultsFor(exp, args.label).map((f) => (f.args
    ? { ...f, args: f.args.map((a) => a.replace(/\{(\w+)\}/g, (m, k: string) => (params[k] !== undefined ? String(params[k]) : m))) }
    : f));
  const faultRecords: FaultRecord[] = [];
  const repeats: RepeatSummary[] = [];
  const startedAt = new Date();
  const faultCtx = {
    moduleDir: dir, client: admin, via: args.faultVia, log: (m: string) => log(`   ${m}`),
    ...(args.ssh ?? env.EXP_SSH ? { ssh: (args.ssh ?? env.EXP_SSH)! } : {}),
    ...(args.instanceId ? { instanceId: args.instanceId } : {}),
    ...(caps.app?.region ? { region: caps.app.region } : {}),
  };

  try {
    if (exp.scenario.tool === 'shell') {
      const file = path.join(dir, exp.scenario.script!);
      const paramEnv = Object.fromEntries(Object.entries(params).map(([k, v]) => [`EXP_PARAM_${k.toUpperCase().replace(/-/g, '_')}`, String(v)]));
      const r = await runShellScenario(file, { EXP_RUN_ID: runId, EXP_LABEL: args.label, EXP_TARGET: target, ...paramEnv }, log, signal);
      Object.assign(findings, r.findings, { exitCode: r.code });
      if (r.code !== 0) scenarioError = `shell 场景退出码 ${r.code}`;
    } else {
      const scenario = await loadScenario(scenarioPath(root, exp.module, exp.scenario.script!));
      if (warmupMs > 0 && (scenario.warmup || scenario.warmupWithRun !== false)) {
        log(`   预热 ${formatDuration(warmupMs)}（不计入结果）`);
        const wctx = makeCtx('warmup', vusList[0]!, warmupMs, 0, undefined);
        try {
          await (scenario.warmup ? scenario.warmup(wctx) : scenario.run(wctx));
        } catch (e) {
          warnings.push(`预热出错：${(e as Error).message}`);
        }
      }
      for (let r = 1; r <= args.repeat && !signal.aborted; r += 1) {
        const repStart = new Date();
        recorder.repeat = r;
        business = {};
        for (const vus of vusList) {
          if (signal.aborted) break;
          const stage = vusList.length > 1 ? `vus=${vus}` : undefined;
          recorder.stage = stage;
          log(`   ${args.repeat > 1 ? `第 ${r}/${args.repeat} 轮 ` : ''}${stage ? `${stage} ` : ''}测量 ${formatDuration(durationMs)}，${vus} VU`);
          const faults = new FaultScheduler(faultSpecs, faultCtx, deps.faultExecutor ?? defaultExecutor);
          faults.start(durationMs);
          try {
            await scenario.run(makeCtx('measure', vus, durationMs, r, stage));
          } finally {
            await faults.runEnd();
            faultRecords.push(...(await faults.stop()));
          }
        }
        businessByRepeat.push({ ...business });
        repeats.push({ index: r, startedAt: repStart.toISOString(), finishedAt: new Date().toISOString(), client: recorder.sliceForRepeat(r), business: { ...business } });
      }
    }
  } catch (e) {
    scenarioError = (e as Error).stack ?? String(e);
    log(`场景出错：${(e as Error).message}`);
  }
  if (signal.aborted) warnings.push('运行被中止（Ctrl+C），结果不完整');
  const finishedAt = new Date();

  // ---------------------------------------------------------------------------------- 6. 服务端数据
  let server = emptyServer(offline ? '离线场景' : undefined);
  if (!offline) {
    if (registered) await finishRun(admin, runId, scenarioError ? `scenario error: ${scenarioError.slice(0, 500)}` : undefined);
    try {
      server = await fetchServerMetrics(admin, runId, {
        from: new Date(startedAt.getTime() - 60_000).toISOString(),
        to: new Date(finishedAt.getTime() + 60_000).toISOString(),
      });
    } catch (e) {
      server = emptyServer((e as Error).message);
    }
    if (!server.available) warnings.push(`服务端指标不可用：${server.error ?? ''}`);
  }
  // 业务指标：多轮时取各轮中位数
  const bizKeys = [...new Set(businessByRepeat.flatMap((b) => Object.keys(b)))];
  const mergedBusiness: Record<string, number> = businessByRepeat.length > 1
    ? Object.fromEntries(bizKeys.map((k) => [k, median(businessByRepeat.map((b) => b[k]).filter((v): v is number => v !== undefined))!]).filter(([, v]) => v !== undefined))
    : { ...business };
  server.business = { ...server.business, ...mergedBusiness };

  // ---------------------------------------------------------------------------------- 清理
  if (!offline && !args.keep) {
    let cleaned = false;
    if (exp.cleanup) {
      const [method, p] = exp.cleanup.split(' ', 2) as [string, string];
      const res = await admin.request(method, p.replace('{runId}', runId), { record: false });
      cleaned = res.ok;
      if (!cleaned && res.status !== 404 && res.status !== 501) warnings.push(`清理 ${exp.cleanup} → ${res.status || res.error}`);
    }
    if (!cleaned && cleanups.length) {
      const results = await mapLimit(cleanups, 4, (c) => admin.request(c.method, c.path, { record: false }));
      const failedN = results.filter((r) => !r.ok && r.status !== 404).length;
      notes.push(`清理：逐个删除 ${cleanups.length} 个资源${failedN ? `，${failedN} 个失败` : ''}`);
    }
  }

  // ---------------------------------------------------------------------------------- 7. 写结果
  if (scenarioError) warnings.push(`场景出错：${truncate(scenarioError.split('\n')[0] ?? scenarioError, 300)}`);
  const client = recorder.summary();
  const doc: ResultDoc = {
    schemaVersion: 1, runId, module: exp.module, experiment: exp.id, label: args.label, variant: variantOf(exp, args.label), forced,
    startedAt: startedAt.toISOString(), finishedAt: finishedAt.toISOString(), target,
    params: {
      vus: vusList.length > 1 ? vusList : vusList[0]!, duration: durationStr, ...(warmupMs ? { warmup: warmupStr } : {}), repeat: args.repeat, ab: args.ab,
      ...(Object.keys(params).length ? { extra: params } : {}),
    },
    environment: offline ? { drivers: {}, capabilitiesHash: 'none' } : environmentOf(caps),
    requiresCheck: { label: args.label, ok: req.ok, mismatches: req.mismatches },
    spec: { title: exp.title, kind: exp.kind, ...(exp.metrics ? { metrics: exp.metrics } : {}), ...(exp.expect ? { expect: exp.expect } : {}), ...(exp.ab ? { ab: exp.ab } : {}) },
    client, server,
    scenario: { findings },
    ...(repeats.length > 1 ? { repeats } : {}),
    faults: faultRecords, notes: notes.join('\n'),
    ...(warnings.length ? { warnings } : {}),
    runner: { version: RUNNER_VERSION, node: process.version, platform: `${process.platform}-${process.arch}` },
  };
  const check = validateResult(doc);
  if (!check.ok) doc.warnings = [...(doc.warnings ?? []), `结果不符合 result.schema.json：${check.errors.slice(0, 5).join('；')}`];

  const outRoot = args.out ?? env.EXP_RESULTS_DIR ?? path.join(root, '_results');
  const outDir = path.join(outRoot, exp.module);
  const file = path.join(outDir, `${fileTimestamp(startedAt)}__${args.label}__${runId}.json`);
  try {
    mkdirSync(outDir, { recursive: true });
    writeFileSync(file, `${JSON.stringify(doc, null, 2)}\n`);
  } catch (e) {
    return { code: EXIT.failed, result: doc, message: `写结果失败：${(e as Error).message}` };
  }
  if (args.upload && !offline) {
    const up = await uploadResult(admin, doc);
    if (!up.ok) log(`警告：POST /api/lab/results 失败（${up.status} ${up.error ?? ''}）；结果已保存在本地`);
    else log('   已上传到 /api/lab/results');
  }
  printSummary(doc, file, log);
  return { code: scenarioError ? EXIT.failed : EXIT.ok, result: doc, file };
}

export async function main(argv: string[] = process.argv.slice(2)): Promise<number> {
  let args: RunnerArgs;
  try {
    args = parseRunnerArgs(argv);
  } catch (e) {
    console.error((e as Error).message);
    console.error(USAGE);
    return EXIT.usage;
  }
  if (args.module && !isModuleId(args.module) && !args.help) {
    console.error(`未知的模块 id：${args.module}`);
    return EXIT.usage;
  }
  const ac = new AbortController();
  let interrupts = 0;
  const onSigint = () => {
    interrupts += 1;
    if (interrupts > 1) process.exit(130);
    console.error('\n收到 Ctrl+C：停止负载并写出已有结果（再按一次立即退出）');
    ac.abort();
  };
  process.on('SIGINT', onSigint);
  try {
    const outcome = await runExperiment(args, { signal: ac.signal });
    if (outcome.message) console.error(outcome.message);
    return outcome.code;
  } finally {
    process.off('SIGINT', onSigint);
    await closeSharedDispatcher();
  }
}

const invokedDirectly = process.argv[1] !== undefined && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) {
  void main().then((code) => process.exit(code));
}
