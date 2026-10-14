#!/usr/bin/env node
/**
 * `npm run e2e:platform` — browser end-to-end test of the ATL platform in ATL_DEV_MODE=1 (docs/implementation-notes.md
 * “platform-web-integration”). Everything runs on this machine and no AWS API is called (every AWS_* variable is removed
 * from the child processes):
 *
 *   DynamoDB Local (docker-compose.platform.yml, per-run tables atl-main-e2e-<t>) → the API dev server
 *   (platform/api/src/dev-server.ts: the full dev runtime, runner `local-l0` = a local CloudAlbum per environment, the dev
 *   check engine against it, the @atl/ssm-client mock for the terminals, the federation stub, ×5 clock) → Vite (the SPA,
 *   proxying /api, /content, /__dev and the public files) → scripts/e2e/platform_e2e.py (Python Playwright, the system
 *   Chrome in headless mode) drives the screens. The production build (vite preview) is served as well, with the CSP
 *   header of 70-web.yaml, to catch CSP violations of the built SPA — including a live workbench with an open terminal
 *   (connect-src also lists the local SSM mock, see withMockSsm).
 *
 *   npm run e2e:platform [-- --keep] [--serve-only] [--headed] [--time-scale 5] [--only <step,...>]
 *
 *   --keep        keep the tables, the data directory and the local L0 directories (default: removed after a green run)
 *   --serve-only  start everything and print the URLs; Ctrl+C stops (for exploring the UI by hand)
 *   --headed      show the browser window
 *   --no-build    reuse dist/content, platform/web/dist and public-pages/dist (default: rebuilt from the current sources)
 *
 * Languages (09-i18n-and-visual.md): the flow runs in zh-CN; phase 11 checks ja (default) / en / zh-CN and writes Japanese
 * screenshots of the main screens to .atl-dev/screens-ja/.
 *
 * Output: .atl-dev/e2e/run-<t>/ (dev-server.log, vite.log, screenshots/, results.json) and .atl-dev/e2e/last.json.
 */
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const TSX = path.join(REPO, 'node_modules', 'tsx', 'dist', 'cli.mjs');
const VITE = path.join(REPO, 'node_modules', 'vite', 'bin', 'vite.js');
const WEB = path.join(REPO, 'platform', 'web');

const argv = process.argv.slice(2);
const flag = (n) => argv.includes(n);
const opt = (n, d) => {
  const i = argv.indexOf(n);
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : d;
};

const KEEP = flag('--keep');
const SERVE_ONLY = flag('--serve-only');
const TIME_SCALE = opt('--time-scale', '5');
const STAMP = new Date().toISOString().replace(/[-:]/g, '').replace(/\..+$/, '').toLowerCase();
const RUN_DIR = path.join(REPO, '.atl-dev', 'e2e', `run-${STAMP}`);
const DDB = process.env.ATL_DEV_DDB_ENDPOINT ?? 'http://127.0.0.1:58000';
const TABLES = { main: `atl-main-e2e-${STAMP.slice(-6)}`, locks: `cloudalbum-lab-locks-e2e-${STAMP.slice(-6)}` };
const T0 = Date.now();

function log(s) {
  console.log(`${((Date.now() - T0) / 1000).toFixed(1).padStart(6)}s  [e2e:platform] ${s}`);
}

/** Child processes never see AWS credentials or the repository's own config variables. */
function childEnv(extra = {}) {
  const env = {};
  for (const [k, v] of Object.entries(process.env)) if (!/^AWS_/i.test(k) && !/^CLOUDALBUM_/i.test(k) && k !== 'NODE_ENV') env[k] = v;
  return { ...env, ...extra };
}

function run(cmd, args, o = {}) {
  const r = spawnSync(cmd, args, { cwd: o.cwd ?? REPO, env: o.env ?? childEnv(), encoding: 'utf8', timeout: o.timeoutMs ?? 600_000, windowsHide: true, shell: false });
  return { status: r.status ?? 1, out: `${r.stdout ?? ''}${r.stderr ?? ''}${r.error ? String(r.error) : ''}` };
}

function freePort() {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.unref();
    s.on('error', reject);
    s.listen(0, '127.0.0.1', () => {
      const a = s.address();
      s.close(() => resolve(a.port));
    });
  });
}

async function reachable(url) {
  try {
    await fetch(url, { signal: AbortSignal.timeout(2000) });
    return true;
  } catch {
    return false;
  }
}

async function waitFor(url, child, timeoutMs) {
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    if (child && child.exitCode !== null) return false;
    try {
      const r = await fetch(url, { signal: AbortSignal.timeout(2000) });
      if (r.status < 500) return true;
    } catch {
      /* not yet */
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  return false;
}

/** The SPA's Content-Security-Policy as the atl-web-spa response-headers policy sends it (70-web.yaml, dev placeholders). */
function spaCsp() {
  const yaml = fs.readFileSync(path.join(REPO, 'platform', 'infra', 'src', '70-web.yaml'), 'utf8');
  const at = yaml.indexOf('Name: atl-web-spa');
  const m = /- "(default-src[^"]+)"/.exec(yaml.slice(at));
  if (at < 0 || !m) throw new Error('70-web.yaml: the atl-web-spa CSP was not found');
  return m[1].replaceAll('${AWS::Region}', 'ap-northeast-1').replaceAll('${CognitoDomain}', 'atl-e2e00000');
}

/**
 * e2e only: the dev SSM mock (ws://127.0.0.1:<port>) stands in for `wss://ssmmessages.<region>` in `connect-src`, so the
 * CSP run can open a terminal (xterm.js runtime styles under `style-src 'self'`, 03 §3.7.6). Every other directive —
 * `script-src` and `style-src` included — stays exactly as 70-web.yaml sends it.
 */
function withMockSsm(csp, origin) {
  if (!/(^|;\s*)connect-src /.test(csp)) throw new Error('the atl-web-spa CSP has no connect-src');
  return csp.replace(/(^|;\s*)connect-src ([^;]*)/, (_m, lead, v) => `${lead}connect-src ${v.trim()} ${origin}`);
}

const children = [];

function start(name, args, env, cwd = REPO) {
  const out = fs.openSync(path.join(RUN_DIR, `${name}.log`), 'a');
  const child = spawn(process.execPath, args, { cwd, env, stdio: ['ignore', out, out], windowsHide: true });
  children.push({ name, child });
  return child;
}

/** Stop a child and its process tree (the dev server starts one local CloudAlbum per environment). */
function stopTree(child) {
  if (!child || child.exitCode !== null) return;
  if (process.platform === 'win32') spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
  else child.kill('SIGTERM');
}

function prebuild() {
  if (!fs.existsSync(path.join(REPO, 'backend', 'dist', 'server.js'))) throw new Error('backend/dist is missing: run npm run build first (the local L0 runs the built CloudAlbum)');
  const cb = run(process.execPath, [path.join(REPO, 'platform', 'checks', 'build.mjs')]);
  if (cb.status !== 0) throw new Error(`node platform/checks/build.mjs failed:\n${cb.out.slice(-2000)}`);
  const bundle = JSON.parse(fs.readFileSync(path.join(REPO, 'platform', 'checks', 'dist', 'bundle.json'), 'utf8'));
  const contentRoot = path.join(REPO, 'dist', 'content');
  const hasContent = fs.existsSync(contentRoot) && fs.readdirSync(contentRoot).some((d) => fs.existsSync(path.join(contentRoot, d, 'manifest.json')));
  // rebuilt from labs/ unless --no-build (the language checks need the current ja / en content, 09 §2.4)
  if (!hasContent || !flag('--no-build')) {
    log('labs:build (dist/content) …');
    const b = run(process.execPath, [TSX, path.join(REPO, 'scripts', 'labs', 'src', 'cli.ts'), 'build']);
    if (b.status !== 0) throw new Error(`labs:build failed:\n${b.out.slice(-2000)}`);
  }
  // the production SPA build (served by `vite preview` with the CloudFront CSP for the CSP check) and P09-V (published by
  // atl-certs) are rebuilt from the current sources unless --no-build
  if (!flag('--no-build') || !fs.existsSync(path.join(WEB, 'dist', 'index.html'))) {
    log('vite build (platform/web/dist) …');
    const b = run(process.execPath, [VITE, 'build', '--config', path.join(WEB, 'vite.config.ts'), '--logLevel', 'warn'], { cwd: WEB });
    if (b.status !== 0) throw new Error(`vite build failed:\n${b.out.slice(-2000)}`);
  }
  if (!flag('--no-build') || !fs.existsSync(path.join(WEB, 'public-pages', 'dist', 'verify', 'verify.js'))) {
    log('build the public pages (P09-V verify page) …');
    const p = run(process.execPath, [path.join(WEB, 'public-pages', 'build.mjs')], { cwd: WEB });
    if (p.status !== 0) throw new Error(`public-pages/build.mjs failed:\n${p.out.slice(-2000)}`);
  }
  const py = run(process.platform === 'win32' ? 'python' : 'python3', ['-c', 'import playwright; print("ok")']);
  if (!py.out.includes('ok')) throw new Error('Python Playwright is not installed (pip install playwright); the test uses the system Chrome (channel chrome)');
  return { checksBundleDigest: bundle.bundleDigest, checkRunner: path.join(REPO, 'platform', 'checks', 'dist', 'atl', 'bin', 'atl-check.mjs') };
}

async function main() {
  fs.mkdirSync(path.join(RUN_DIR, 'screenshots'), { recursive: true });
  log(`run directory ${path.relative(REPO, RUN_DIR)}`);
  const builds = prebuild();
  if (!(await reachable(DDB))) {
    log('starting DynamoDB Local (docker compose -f docker-compose.platform.yml up -d --wait)');
    const r = run('docker', ['compose', '-f', 'docker-compose.platform.yml', 'up', '-d', '--wait'], { timeoutMs: 300_000 });
    if (r.status !== 0) throw new Error(`docker compose failed: ${r.out.slice(-1000)}`);
  }
  const [apiPort, webPort, ssmPort] = [await freePort(), await freePort(), await freePort()];
  const apiUrl = `http://127.0.0.1:${apiPort}`;
  const webUrl = `http://127.0.0.1:${webPort}`;
  const devEnv = childEnv({
    ATL_DEV_MODE: '1',
    ATL_DEV_DDB_ENDPOINT: DDB,
    ATL_DEV_PORT: String(apiPort),
    ATL_DEV_DATA_DIR: path.join(RUN_DIR, 'data'),
    ATL_DEV_RUNNER_MODE: 'local-l0',
    ATL_DEV_TIME_SCALE: TIME_SCALE,
    ATL_DEV_RUNNER_NOOP_SECONDS: '30',
    ATL_DEV_CHECK_RUNNER: builds.checkRunner,
    ATL_CHECK_BUNDLE_DIGEST: builds.checksBundleDigest,
    ATL_DEV_TABLE_MAIN: TABLES.main,
    ATL_DEV_TABLE_LOCKS: TABLES.locks,
    ATL_DEV_PLATFORM_URL: webUrl,
    ATL_DEV_SSM_MOCK_URL: `http://127.0.0.1:${ssmPort}`,
  });
  const t = run(process.execPath, [TSX, path.join(REPO, 'platform', 'api', 'src', 'dev', 'create-tables.ts')], { env: devEnv });
  if (t.status !== 0) throw new Error(`create-tables failed: ${t.out.slice(-1000)}`);
  log(`tables ${TABLES.main}, ${TABLES.locks}`);
  const api = start('dev-server', [TSX, path.join(REPO, 'platform', 'api', 'src', 'dev-server.ts'), '--dev-mode', '--seed-catalog', '--port', String(apiPort)], devEnv);
  if (!(await waitFor(`${apiUrl}/api/v1/public/health`, api, 180_000))) throw new Error(`the API dev server did not start (see ${path.join(RUN_DIR, 'dev-server.log')})`);
  log(`API dev server ${apiUrl} (runner local-l0, time ×${TIME_SCALE})`);
  const vite = start('vite', [VITE, '--config', path.join(WEB, 'vite.config.ts')], childEnv({ ATL_API_URL: apiUrl, ATL_WEB_PORT: String(webPort) }), WEB);
  if (!(await waitFor(`${webUrl}/`, vite, 120_000))) throw new Error(`Vite did not start (see ${path.join(RUN_DIR, 'vite.log')})`);
  log(`SPA ${webUrl}/ (dev login: learner / e2e-learner)`);
  // the production build under the CSP header of the atl-web-spa response-headers policy (70-web.yaml)
  const cspPort = await freePort();
  const cspUrl = `http://127.0.0.1:${cspPort}`;
  const csp = withMockSsm(spaCsp(), `ws://127.0.0.1:${ssmPort}`);
  const preview = start('vite-preview', [VITE, 'preview', '--config', path.join(WEB, 'vite.config.ts')], childEnv({ ATL_API_URL: apiUrl, ATL_WEB_PORT: String(cspPort), ATL_WEB_CSP: csp }), WEB);
  if (!(await waitFor(`${cspUrl}/`, preview, 60_000))) throw new Error(`vite preview did not start (see ${path.join(RUN_DIR, 'vite-preview.log')})`);
  log(`production build with the CloudFront CSP ${cspUrl}/`);

  if (SERVE_ONLY) {
    log('--serve-only: Ctrl+C stops everything');
    await new Promise((resolve) => {
      process.on('SIGINT', resolve);
      process.on('SIGTERM', resolve);
    });
    return 0;
  }
  const py = process.platform === 'win32' ? 'python' : 'python3';
  const args = [path.join(REPO, 'scripts', 'e2e', 'platform_e2e.py'), '--web', webUrl, '--api', apiUrl, '--csp-web', cspUrl, '--out', RUN_DIR, '--ja-shots', path.join(REPO, '.atl-dev', 'screens-ja')];
  if (flag('--headed')) args.push('--headed');
  const only = opt('--only', '');
  if (only) args.push('--only', only);
  log(`python ${path.relative(REPO, args[0])} …`);
  const code = await new Promise((resolve) => {
    const c = spawn(py, args, { cwd: REPO, env: childEnv({ PYTHONUNBUFFERED: '1', PYTHONIOENCODING: 'utf-8' }), stdio: 'inherit', windowsHide: true });
    c.on('exit', (x) => resolve(x ?? 1));
  });
  return code;
}

async function cleanup(ok) {
  for (const { child } of children.reverse()) stopTree(child);
  const roots = [];
  const envDir = path.join(RUN_DIR, 'data', 'envs');
  if (fs.existsSync(envDir)) {
    for (const f of fs.readdirSync(envDir)) {
      try {
        const rec = JSON.parse(fs.readFileSync(path.join(envDir, f), 'utf8'));
        if (rec.root) roots.push(rec.root);
      } catch {
        /* ignore */
      }
    }
  }
  if (!KEEP) {
    run(process.execPath, [TSX, path.join(REPO, 'platform', 'api', 'src', 'dev', 'create-tables.ts'), '--drop'], {
      env: childEnv({ ATL_DEV_DDB_ENDPOINT: DDB, ATL_DEV_TABLE_MAIN: TABLES.main, ATL_DEV_TABLE_LOCKS: TABLES.locks }),
    });
    if (ok) {
      await new Promise((r) => setTimeout(r, 1000));
      for (const r of roots) fs.rmSync(r, { recursive: true, force: true });
      fs.rmSync(path.join(RUN_DIR, 'data'), { recursive: true, force: true });
    }
  }
}

let code = 1;
try {
  code = await main();
} catch (e) {
  console.error(`[e2e:platform] ${e instanceof Error ? e.message : String(e)}`);
  code = 1;
} finally {
  await cleanup(code === 0);
  const resFile = path.join(RUN_DIR, 'results.json');
  const results = fs.existsSync(resFile) ? JSON.parse(fs.readFileSync(resFile, 'utf8')) : null;
  fs.mkdirSync(path.join(REPO, '.atl-dev', 'e2e'), { recursive: true });
  fs.writeFileSync(
    path.join(REPO, '.atl-dev', 'e2e', 'last.json'),
    JSON.stringify({ schema: 'atl.e2e-platform/v1', startedAt: new Date(T0).toISOString(), seconds: Math.round((Date.now() - T0) / 1000), exitCode: code, runDir: RUN_DIR, tables: TABLES, results }, null, 2),
  );
  log(`done in ${Math.round((Date.now() - T0) / 1000)}s, exit ${code}; results ${path.relative(REPO, resFile)}`);
}
process.exit(code);
