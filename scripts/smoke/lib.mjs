// scripts/smoke/lib.mjs —— 本机端到端自测的公共部分（npm run smoke:l0 / smoke:selfhost / smoke:localstack）
//
// - makeEnvDir()：在 .cloudalbum/smoke/<名称>-<时间> 下生成一套完整的配置目录（cloudalbum.env、modules.d/*.env、secrets.env、
//   ES256 密钥、runtime.json）与数据目录，和 EC2 上的 /etc/cloudalbum、/var/lib/cloudalbum 同构；
// - startProcess()：用构建产物启动 api / worker（node backend/dist/server.js、worker.js），日志写到该目录；
// - Client：带 Cookie 罐的 fetch 包装（本地认证用 HttpOnly Cookie）；
// - Reporter：逐步记录通过 / 失败，最后打印汇总并给出退出码。
// 只访问本机进程与本机 Docker 容器；不调用任何真实 AWS API（进程环境中的 AWS_* 变量在启动子进程前一律去掉）。
import { spawn, spawnSync } from 'node:child_process';
import { generateKeyPairSync, randomBytes } from 'node:crypto';
import { createWriteStream, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
export const BACKEND_DIST = path.join(ROOT, 'backend', 'dist');
export const CLI = path.join(BACKEND_DIST, 'cli.js');

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const posix = (p) => p.replace(/\\/g, '/');

/** 构建产物必须存在（npm run build） */
export function requireBuild() {
  for (const f of ['server.js', 'worker.js', 'cli.js']) {
    if (!existsSync(path.join(BACKEND_DIST, f))) {
      console.error(`缺少 backend/dist/${f}：请先运行 npm run build`);
      process.exit(2);
    }
  }
}

export function freePort() {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.unref();
    s.on('error', reject);
    s.listen(0, '127.0.0.1', () => {
      const { port } = s.address();
      s.close(() => resolve(port));
    });
  });
}

function envFile(obj) {
  return `${Object.entries(obj).filter(([, v]) => v !== undefined && v !== null).map(([k, v]) => `${k}=${v}`).join('\n')}\n`;
}

/** 子进程环境：去掉 AWS_*（不让 SDK 默认链拾取任何真实凭证）与本仓库的配置变量 */
export function childEnv(extra = {}) {
  const env = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (/^AWS_/i.test(k) || /^CLOUDALBUM_/i.test(k) || k === 'NODE_ENV' || k === 'VITEST') continue;
    env[k] = v;
  }
  return { ...env, ...extra };
}

/**
 * 生成配置目录。modules：{ <模块 id>: { KEY: value } } → modules.d/<id>.env；secrets：额外的 secrets.env 键。
 */
export function makeEnvDir({ name, port, base = {}, modules = {}, secrets = {}, runtime = {} }) {
  const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\..+$/, '');
  const root = path.join(ROOT, '.cloudalbum', 'smoke', `${name}-${stamp}`);
  const etc = path.join(root, 'etc');
  const data = path.join(root, 'data');
  for (const d of [path.join(etc, 'keys'), path.join(etc, 'modules.d'), path.join(root, 'run'), data]) mkdirSync(d, { recursive: true });
  const baseUrl = `http://127.0.0.1:${port}`;
  writeFileSync(path.join(etc, 'cloudalbum.env'), envFile({
    AWS_REGION: 'ap-northeast-1', CLOUDALBUM_ENV: 'lab', APP_BASE_URL: baseUrl, DEPLOY_MODE: 'single',
    CLOUDALBUM_DATA_DIR: posix(data), LOCK_FILE_DIR: posix(path.join(root, 'run')), PORT: String(port), HOST: '127.0.0.1',
    ...base,
  }));
  const key = () => randomBytes(32).toString('base64');
  const pem = generateKeyPairSync('ec', { namedCurve: 'P-256', privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
    publicKeyEncoding: { type: 'spki', format: 'pem' } }).privateKey;
  writeFileSync(path.join(etc, 'keys', 'jwt-es256.pem'), pem);
  writeFileSync(path.join(etc, 'secrets.env'), envFile({
    SECRETS_ORIGIN: 'instance', UPLOAD_HMAC_KEY: key(), MEDIA_HMAC_KEY: key(), CALLBACK_HMAC_KEY: key(), INTERNAL_HMAC_KEY: key(),
    COOKIE_SECRET: key(), LOCAL_MASTER_KEY: key(), JWT_SIGNING_KEY_FILE: posix(path.join(etc, 'keys', 'jwt-es256.pem')), ...secrets,
  }));
  for (const [id, kv] of Object.entries(modules)) writeFileSync(path.join(etc, 'modules.d', `${id}.env`), envFile(kv));
  writeFileSync(path.join(etc, 'runtime.json'), `${JSON.stringify({
    maintenanceMode: false, readOnly: false, maxUploadMb: 25, allowedEmailDomains: [], feedCacheTtlSec: 30, labBypassEnabled: true,
    logLevel: 'info', featureFlags: {}, ...runtime,
  }, null, 2)}\n`);
  return { root, etc: posix(etc), data: posix(data), baseUrl, port };
}

/** node backend/dist/cli.js <args>（同步；返回 { status, stdout, stderr }） */
export function cli(etc, args, extraEnv = {}) {
  const r = spawnSync(process.execPath, [CLI, ...args], {
    cwd: ROOT, encoding: 'utf8', env: childEnv({ CLOUDALBUM_ENV_DIR: etc, NODE_ENV: 'development', ...extraEnv }), timeout: 120_000,
  });
  return { status: r.status, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
}

/** 启动 api 或 worker；返回 { child, log, stop(), exited } */
export function startProcess(kind, env, { root, extraEnv = {} } = {}) {
  const script = path.join(BACKEND_DIST, kind === 'api' ? 'server.js' : 'worker.js');
  const log = path.join(root ?? ROOT, `${kind}.log`);
  const out = createWriteStream(log);
  const child = spawn(process.execPath, ['--enable-source-maps', script], {
    cwd: ROOT, env: childEnv({ CLOUDALBUM_ENV_DIR: env.etc, NODE_ENV: 'development', ...extraEnv }), stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout.pipe(out);
  child.stderr.pipe(out);
  const exited = new Promise((resolve) => child.on('exit', (code, signal) => resolve({ code, signal })));
  return {
    child, log, exited,
    async stop() {
      if (child.exitCode !== null || child.signalCode !== null) return;
      child.kill('SIGTERM');
      const t = setTimeout(() => child.kill('SIGKILL'), 8000);
      await exited;
      clearTimeout(t);
    },
  };
}

export async function waitHealthy(baseUrl, proc, timeoutMs = 60_000) {
  const t0 = Date.now();
  for (;;) {
    if (proc && proc.child.exitCode !== null) {
      throw new Error(`进程已退出（exit ${proc.child.exitCode}）：\n${tail(proc.log)}`);
    }
    try {
      const r = await fetch(`${baseUrl}/api/health/ready`, { signal: AbortSignal.timeout(2000) });
      if (r.status === 200) return;
    } catch {
      /* 还没监听 */
    }
    if (Date.now() - t0 > timeoutMs) throw new Error(`等待 ${baseUrl}/api/health/ready 超时：\n${proc ? tail(proc.log) : ''}`);
    await sleep(300);
  }
}

export function tail(file, n = 40) {
  try {
    return readFileSync(file, 'utf8').trimEnd().split('\n').slice(-n).join('\n');
  } catch {
    return '';
  }
}

// ------------------------------------------------------------------------------------------------
// HTTP 客户端（Cookie 罐）
// ------------------------------------------------------------------------------------------------
export class Client {
  constructor(baseUrl, name = 'anon') {
    this.baseUrl = baseUrl;
    this.name = name;
    this.jar = new Map();
    this.bearer = null;
  }

  cookieHeader() {
    return [...this.jar.entries()].map(([k, v]) => `${k}=${v}`).join('; ');
  }

  absorb(res) {
    const list = typeof res.headers.getSetCookie === 'function' ? res.headers.getSetCookie() : [];
    for (const sc of list) {
      const [pair, ...attrs] = sc.split(';');
      const i = pair.indexOf('=');
      const k = pair.slice(0, i).trim();
      const v = pair.slice(i + 1).trim();
      const expired = attrs.some((a) => /^\s*max-age=0\s*$/i.test(a) || (/^\s*expires=/i.test(a) && Date.parse(a.split('=')[1]) < Date.now()));
      if (!v || expired) this.jar.delete(k);
      else this.jar.set(k, v);
    }
  }

  async req(method, p, { json, body, headers = {}, raw = false, redirect = 'manual' } = {}) {
    const url = /^https?:\/\//.test(p) ? p : `${this.baseUrl}${p}`;
    const h = { ...headers };
    const sameOrigin = url.startsWith(this.baseUrl);
    if (sameOrigin && this.jar.size) h.cookie = this.cookieHeader();
    if (sameOrigin && this.bearer && !h.authorization) h.authorization = `Bearer ${this.bearer}`;
    let payload = body;
    if (json !== undefined) {
      h['content-type'] = 'application/json';
      payload = JSON.stringify(json);
    }
    const res = await fetch(url, { method, headers: h, body: payload, redirect });
    if (sameOrigin) this.absorb(res);
    const ct = res.headers.get('content-type') ?? '';
    let data;
    if (raw) data = Buffer.from(await res.arrayBuffer());
    else if (ct.includes('application/json')) data = await res.json().catch(() => null);
    else data = await res.text();
    return { status: res.status, headers: res.headers, body: data, url };
  }

  get(p, o) { return this.req('GET', p, o); }
  post(p, json, o = {}) { return this.req('POST', p, { ...o, json }); }
  put(p, o) { return this.req('PUT', p, o); }
  patch(p, json, o = {}) { return this.req('PATCH', p, { ...o, json }); }
  del(p, o) { return this.req('DELETE', p, o); }
}

// ------------------------------------------------------------------------------------------------
// 结果记录
// ------------------------------------------------------------------------------------------------
export class AssertionFailed extends Error {}

export function check(cond, message) {
  if (!cond) throw new AssertionFailed(message);
}

export function expectStatus(res, ...codes) {
  if (!codes.includes(res.status)) {
    const b = typeof res.body === 'string' ? res.body.slice(0, 300) : JSON.stringify(res.body)?.slice(0, 300);
    throw new AssertionFailed(`${res.url} 期望 ${codes.join('/')}，实际 ${res.status}：${b}`);
  }
  return res;
}

export class Reporter {
  constructor(title) {
    this.title = title;
    this.sections = [];
    this.current = null;
  }

  section(name) {
    this.current = { name, steps: [] };
    this.sections.push(this.current);
    console.log(`\n== ${name}`);
  }

  async step(name, fn) {
    const t0 = Date.now();
    try {
      const detail = await fn();
      const ms = Date.now() - t0;
      this.current.steps.push({ name, ok: true, ms, detail });
      console.log(`  PASS ${name}${detail ? ` — ${detail}` : ''} (${ms}ms)`);
      return true;
    } catch (e) {
      const ms = Date.now() - t0;
      const msg = e instanceof AssertionFailed ? e.message : (e?.stack ?? String(e));
      this.current.steps.push({ name, ok: false, ms, detail: msg });
      console.log(`  FAIL ${name} (${ms}ms)\n       ${String(msg).split('\n').join('\n       ')}`);
      return false;
    }
  }

  skip(name, why) {
    this.current.steps.push({ name, ok: null, ms: 0, detail: why });
    console.log(`  SKIP ${name} — ${why}`);
  }

  totals() {
    const all = this.sections.flatMap((s) => s.steps);
    return { passed: all.filter((s) => s.ok === true).length, failed: all.filter((s) => s.ok === false).length, skipped: all.filter((s) => s.ok === null).length };
  }

  finish(jsonFile) {
    const t = this.totals();
    console.log(`\n${this.title}：${t.passed} 通过，${t.failed} 失败，${t.skipped} 跳过`);
    for (const s of this.sections) {
      const p = s.steps.filter((x) => x.ok === true).length;
      const f = s.steps.filter((x) => x.ok === false).length;
      console.log(`  ${f ? 'FAIL' : 'PASS'} ${s.name}：${p} 通过${f ? `，${f} 失败` : ''}`);
    }
    if (jsonFile) {
      mkdirSync(path.dirname(jsonFile), { recursive: true });
      writeFileSync(jsonFile, `${JSON.stringify({ title: this.title, at: new Date().toISOString(), totals: t, sections: this.sections }, null, 2)}\n`);
    }
    return t.failed ? 1 : 0;
  }
}

/** 删除本次运行的目录（--keep 时保留，便于查看日志） */
export function cleanup(root, keep) {
  if (keep) {
    console.log(`保留运行目录：${root}`);
    return;
  }
  try {
    rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  } catch {
    /* Windows 上偶尔有文件仍被占用 */
  }
}

export function argFlag(name) {
  return process.argv.includes(`--${name}`);
}

export function argValue(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

// ------------------------------------------------------------------------------------------------
// Docker（只用本机已有的镜像；不拉取）
// ------------------------------------------------------------------------------------------------
export function docker(args, opts = {}) {
  const r = spawnSync('docker', args, { encoding: 'utf8', timeout: opts.timeout ?? 120_000 });
  return { status: r.status, stdout: (r.stdout ?? '').trim(), stderr: (r.stderr ?? '').trim(), error: r.error };
}

export function dockerAvailable() {
  const r = docker(['version', '--format', '{{.Server.Version}}'], { timeout: 20_000 });
  return r.status === 0 ? r.stdout : null;
}

export function imagePresent(image) {
  return docker(['image', 'inspect', image, '--format', '{{.Id}}'], { timeout: 20_000 }).status === 0;
}

export async function waitTcp(host, port, timeoutMs = 60_000) {
  const t0 = Date.now();
  for (;;) {
    const ok = await new Promise((resolve) => {
      const s = net.connect({ host, port });
      s.setTimeout(1000, () => { s.destroy(); resolve(false); });
      s.once('connect', () => { s.destroy(); resolve(true); });
      s.once('error', () => resolve(false));
    });
    if (ok) return;
    if (Date.now() - t0 > timeoutMs) throw new Error(`等待 ${host}:${port} 超时`);
    await sleep(500);
  }
}
