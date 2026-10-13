#!/usr/bin/env node
/**
 * `npm run platform:dev`：一键启动 ATL 的本地联调环境（ATL_DEV_MODE=1，不连接任何 AWS）。
 *
 *   1. DynamoDB Local：127.0.0.1:58000 不可达时执行 `docker compose -f docker-compose.platform.yml up -d --wait`
 *   2. 建表（atl-main、cloudalbum-lab-locks；幂等，不覆盖已有的 PlatformConfig）
 *   3. platform/api 的 dev-server（--dev-mode --seed-catalog，默认 127.0.0.1:8787），等 /api/v1/public/health 就绪
 *   4. platform/web 的 Vite dev server（默认 http://127.0.0.1:5174），把 /api、/content、/__dev 代理到 dev-server
 *
 * 选项：--no-db（不碰 Docker）、--api-only、--web-only、--api-port <n>、--web-port <n>、--no-seed-catalog
 * 环境变量照常传给 dev-server（ATL_DEV_RUNNER_MODE、ATL_DEV_TIME_SCALE、ATL_DEV_DDB_ENDPOINT …，见 platform/api/src/dev/config.ts）。
 * Ctrl+C 结束全部子进程；DynamoDB Local 容器保留（npm run platform:db:down 删除）。
 */
import { spawn, spawnSync } from 'node:child_process';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const WEB = path.resolve(HERE, '..');
const REPO = path.resolve(WEB, '../..');
const TSX = path.join(REPO, 'node_modules', 'tsx', 'dist', 'cli.mjs');
const VITE = path.join(REPO, 'node_modules', 'vite', 'bin', 'vite.js');

const argv = process.argv.slice(2);
/** @param {string} name */
const flag = (name) => argv.includes(name);
/** @param {string} name @param {string} fallback */
const opt = (name, fallback) => {
  const i = argv.indexOf(name);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : fallback;
};

const apiPort = Number(opt('--api-port', process.env.ATL_DEV_PORT ?? '8787'));
const webPort = Number(opt('--web-port', process.env.ATL_WEB_PORT ?? '5174'));
const ddbEndpoint = process.env.ATL_DEV_DDB_ENDPOINT ?? 'http://127.0.0.1:58000';
const apiUrl = `http://127.0.0.1:${apiPort}`;

/** @type {import('node:child_process').ChildProcess[]} */
const children = [];
let stopping = false;

/** @param {string} msg */
function log(msg) {
  console.log(`[platform:dev] ${msg}`);
}

function stopAll(code = 0) {
  if (stopping) return;
  stopping = true;
  for (const c of children) if (c.exitCode === null) c.kill();
  setTimeout(() => process.exit(code), 500).unref();
}

process.on('SIGINT', () => stopAll(0));
process.on('SIGTERM', () => stopAll(0));

/** @param {string} url */
async function reachable(url) {
  try {
    await fetch(url, { signal: AbortSignal.timeout(1500) });
    return true;
  } catch {
    return false;
  }
}

/** @param {string} url @param {import('node:child_process').ChildProcess} child @param {number} timeoutMs */
async function waitFor(url, child, timeoutMs) {
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    if (child.exitCode !== null) return false;
    try {
      const r = await fetch(url, { signal: AbortSignal.timeout(1500) });
      if (r.ok) return true;
    } catch {
      /* 还没起来 */
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  return false;
}

/** @param {string} name @param {string[]} args @param {{ cwd?: string; env?: NodeJS.ProcessEnv }} [o] */
function start(name, args, o = {}) {
  const child = spawn(process.execPath, args, { cwd: o.cwd ?? REPO, env: { ...process.env, ...o.env }, stdio: 'inherit' });
  child.on('exit', (code, signal) => {
    if (stopping) return;
    log(`${name} exited (${signal ?? code}); stopping the others`);
    stopAll(typeof code === 'number' && code !== 0 ? code : 1);
  });
  children.push(child);
  return child;
}

async function ensureDynamoDb() {
  if (await reachable(ddbEndpoint)) {
    log(`DynamoDB Local is up at ${ddbEndpoint}`);
    return;
  }
  if (flag('--no-db')) throw new Error(`DynamoDB Local is not reachable at ${ddbEndpoint} (started with --no-db)`);
  log('starting DynamoDB Local (docker compose -f docker-compose.platform.yml up -d --wait)');
  const r = spawnSync('docker', ['compose', '-f', 'docker-compose.platform.yml', 'up', '-d', '--wait'], { cwd: REPO, stdio: 'inherit', shell: process.platform === 'win32' });
  if (r.status !== 0) throw new Error('docker compose failed: is Docker running? (or start DynamoDB Local yourself and pass --no-db)');
}

function createTables() {
  log('creating tables (idempotent)');
  const r = spawnSync(process.execPath, [TSX, 'platform/api/src/dev/create-tables.ts'], { cwd: REPO, stdio: 'inherit', env: { ...process.env, ATL_DEV_DDB_ENDPOINT: ddbEndpoint } });
  if (r.status !== 0) throw new Error('create-tables failed');
}

async function main() {
  const webOnly = flag('--web-only');
  const apiOnly = flag('--api-only');
  if (!webOnly) {
    await ensureDynamoDb();
    createTables();
    const args = [TSX, 'platform/api/src/dev-server.ts', '--dev-mode', '--port', String(apiPort)];
    if (!flag('--no-seed-catalog')) args.push('--seed-catalog');
    log(`starting the API dev server on ${apiUrl}`);
    const api = start('dev-server', args, { env: { ATL_DEV_MODE: '1', ATL_DEV_DDB_ENDPOINT: ddbEndpoint } });
    if (!(await waitFor(`${apiUrl}/api/v1/public/health`, api, 180_000))) throw new Error(`the API dev server did not become ready on ${apiUrl}`);
    log(`API ready: ${apiUrl}/api/v1 (Authorization: Bearer dev.learner.u1)`);
  }
  if (!apiOnly) {
    start('vite', [VITE, '--config', path.join(WEB, 'vite.config.ts')], { cwd: WEB, env: { ATL_API_URL: apiUrl, ATL_WEB_PORT: String(webPort) } });
    log(`SPA: http://127.0.0.1:${webPort}/  (dev login: learner / u1; /api, /content, /__dev → ${apiUrl})`);
  }
}

main().catch((e) => {
  console.error(`[platform:dev] ${e instanceof Error ? e.message : String(e)}`);
  stopAll(1);
});
