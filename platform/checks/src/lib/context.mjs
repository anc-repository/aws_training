// Host context for check modules: fixed paths, execFile with fixed argv (never a shell), the CloudAlbum CLI (06 PM-12),
// IMDSv2, the local probe token and the loopback base URL. In ATL_DEV_MODE=1 (dev LocalRunCommand) the same API maps to
// the local CloudAlbum started by the dev runner (ATL_DEV_APP_BASE_URL / ATL_DEV_APP_ROOT) and to fake host facts.
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';

export class CheckError extends Error {
  constructor(code, message, observed) {
    super(message);
    this.name = 'CheckError';
    this.code = code;
    if (observed !== undefined) this.observed = observed;
  }
}

export const PATHS = {
  cloudalbumCli: '/opt/cloudalbum/bin/cloudalbum',
  etc: '/etc/cloudalbum',
  modulesDir: '/etc/cloudalbum/modules.d',
  modulesState: '/etc/cloudalbum/modules.state.json',
  platformEnv: '/etc/cloudalbum/platform.env',
  probeTokenFile: '/etc/cloudalbum/atl/probe.token',
  nginxLog: '/var/lib/cloudalbum/logs/nginx-access.json',
  wsReady: '/var/lib/atl/ready.json',
  wsPrepared: '/var/lib/atl/prepared.json',
  terminalHelper: '/opt/atl/bin/atl-lab-proxy',
  repoDir: '/home/labuser/cloudalbum',
};

/** Parse a KEY=value env file (no shell semantics; quotes stripped). */
export function parseEnvFile(text) {
  const out = {};
  for (const line of text.split(/\r?\n/)) {
    const m = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/.exec(line);
    if (!m || line.trimStart().startsWith('#')) continue;
    let v = m[2];
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
    out[m[1]] = v;
  }
  return out;
}

export function readJsonFile(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function run(cmd, args, { timeoutMs = 10_000, env } = {}) {
  return new Promise((resolve) => {
    execFile(cmd, args, { timeout: timeoutMs, maxBuffer: 4 * 1024 * 1024, env: env ?? { PATH: process.env.PATH ?? '/usr/sbin:/usr/bin:/sbin:/bin', LANG: 'C' }, windowsHide: true }, (err, stdout, stderr) => {
      const code = err ? (typeof err.code === 'number' ? err.code : err.killed ? 124 : 127) : 0;
      resolve({ code, stdout: String(stdout ?? ''), stderr: String(stderr ?? ''), error: err && typeof err.code !== 'number' ? String(err.message) : null });
    });
  });
}

export function createContext({ env = process.env, bundleDir }) {
  const dev = env.ATL_DEV_MODE === '1';
  const devRoot = dev ? env.ATL_DEV_APP_ROOT || null : null;
  const devEtc = devRoot ? path.join(devRoot, 'etc') : null;
  const hostRole = dev ? (String(env.ATL_DEV_INSTANCE_ID ?? '').endsWith('-ws') ? 'workstation' : 'lab') : fs.existsSync(PATHS.etc) ? 'lab' : 'workstation';
  let imdsToken = null;

  const ctx = {
    dev,
    hostRole,
    bundleDir,
    appBaseUrl: dev ? env.ATL_DEV_APP_BASE_URL || null : 'http://127.0.0.1',
    paths: {
      ...PATHS,
      ...(devEtc
        ? {
            etc: devEtc,
            modulesDir: path.join(devEtc, 'modules.d'),
            modulesState: path.join(devEtc, 'modules.state.json'),
            platformEnv: path.join(devEtc, 'platform.env'),
            probeTokenFile: path.join(devEtc, 'atl', 'probe.token'),
            nginxLog: path.join(devRoot, 'data', 'logs', 'nginx-access.json'),
          }
        : {}),
    },
    exec: (cmd, args, opts) => run(cmd, args, opts),

    /** `cloudalbum <sub> … --json` (06 PM-12): stdout is one JSON object; exit 3 = unavailable, 4 = not found. */
    async cli(args, { timeoutMs = 15_000 } = {}) {
      let r;
      if (dev) {
        const cliJs = path.join(process.cwd(), 'backend', 'dist', 'cli.js');
        if (!devEtc || !fs.existsSync(cliJs)) throw new CheckError('RUNNER_UNAVAILABLE', 'dev: CloudAlbum CLI not available (needs local-l0 runner mode and npm run build)');
        r = await run(process.execPath, [cliJs, ...args], {
          timeoutMs,
          env: { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot, CLOUDALBUM_ENV_DIR: devEtc, CLOUDALBUM_ROLE: 'cli', NODE_ENV: 'development' },
        });
      } else {
        // the wrapper drops to the cloudalbum user itself for non-root subcommands (06 PM-12)
        r = await run(PATHS.cloudalbumCli, args, { timeoutMs });
      }
      if (r.code === 127 && !dev) throw new CheckError('RUNNER_UNAVAILABLE', 'cloudalbum CLI not installed');
      let parsed = null;
      try {
        parsed = r.stdout.trim() ? JSON.parse(r.stdout.trim().split(/\r?\n/).pop()) : null;
      } catch {
        parsed = null;
      }
      if (r.code === 0 && parsed !== null) return parsed;
      const msg = parsed?.error?.message ?? (r.stderr.trim().split(/\r?\n/).pop() || `exit ${r.code}`);
      if (r.code === 3) throw new CheckError('RUNNER_UNAVAILABLE', `cloudalbum ${args[0]}: unavailable: ${msg}`);
      if (r.code === 4) throw new CheckError('PRECONDITION', `cloudalbum ${args[0]}: not found: ${msg}`);
      if (r.code === 124) throw new CheckError('TIMEOUT', `cloudalbum ${args[0]} timed out`);
      throw new CheckError('INTERNAL', `cloudalbum ${args[0]} failed (${r.code}): ${msg}`);
    },

    async instanceId() {
      if (dev) return env.ATL_DEV_INSTANCE_ID || 'i-dev-local';
      return (await ctx.imds('instance-id')).value;
    },

    /** IMDSv2 GET; `{ value, status }`. Never called for credential paths (the check enforces the allowlist). */
    async imds(p, { v1 = false } = {}) {
      if (dev) {
        const fake = {
          'instance-id': env.ATL_DEV_INSTANCE_ID || 'i-dev-local',
          'ami-id': 'ami-0dev0000000000000',
          'placement/availability-zone': 'ap-northeast-1a',
          'public-ipv4': '127.0.0.1',
          'iam/info': JSON.stringify({ Code: 'Success', InstanceProfileArn: 'arn:aws:iam::000000000000:instance-profile/cloudalbum-dev' }),
          'iam/security-credentials/': 'CloudAlbumAppRole',
          'local-ipv4': '127.0.0.1',
        };
        if (v1) return { status: 401, value: null };
        return p in fake ? { status: 200, value: fake[p] } : { status: 404, value: null };
      }
      const req = (method, url, headers) =>
        new Promise((resolve, reject) => {
          const r = http.request({ host: '169.254.169.254', port: 80, path: url, method, headers, timeout: 2000 }, (res) => {
            let body = '';
            res.setEncoding('utf8');
            res.on('data', (d) => (body += d));
            res.on('end', () => resolve({ status: res.statusCode ?? 0, body }));
          });
          r.on('timeout', () => r.destroy(new Error('IMDS timeout')));
          r.on('error', reject);
          r.end();
        });
      if (v1) {
        const r = await req('GET', `/latest/meta-data/${p}`, {});
        return { status: r.status, value: r.status === 200 ? r.body : null };
      }
      if (!imdsToken) {
        const t = await req('PUT', '/latest/api/token', { 'X-aws-ec2-metadata-token-ttl-seconds': '60' });
        if (t.status !== 200) throw new CheckError('RUNNER_UNAVAILABLE', `IMDSv2 token request failed (${t.status})`);
        imdsToken = t.body;
      }
      const r = await req('GET', `/latest/meta-data/${p}`, { 'X-aws-ec2-metadata-token': imdsToken });
      return { status: r.status, value: r.status === 200 ? r.body : null };
    },

    /** Local probe token (06 PM-09): only used on loopback requests; never printed. */
    localProbeToken() {
      let file = ctx.paths.probeTokenFile;
      try {
        const pe = parseEnvFile(fs.readFileSync(ctx.paths.platformEnv, 'utf8'));
        if (pe.ATL_PROBE_TOKEN_FILE && (dev || pe.ATL_PROBE_TOKEN_FILE.startsWith('/etc/cloudalbum/atl/'))) file = pe.ATL_PROBE_TOKEN_FILE;
      } catch {
        /* platform.env missing → default path */
      }
      try {
        const v = fs.readFileSync(file, 'utf8').trim();
        return v.length > 0 ? v : null;
      } catch {
        return null;
      }
    },

    /** One-time probe tokens via `cloudalbum probe-token --ttl N --count M` (06 PM-13). */
    async oneTimeProbeTokens(count = 1, ttlSec = 60) {
      const r = await ctx.cli(['probe-token', '--ttl', String(ttlSec), '--count', String(count), '--json']);
      if (!Array.isArray(r.tokens) || r.tokens.length < count) throw new CheckError('RUNNER_UNAVAILABLE', 'probe-token returned no tokens');
      return r;
    },

    /** Read `modules.d/<module>.env` (non-secret keys only are returned with values). */
    moduleEnv(module) {
      try {
        return parseEnvFile(fs.readFileSync(path.join(ctx.paths.modulesDir, `${module}.env`), 'utf8'));
      } catch {
        return null;
      }
    },

    networkAddresses() {
      const out = [];
      for (const list of Object.values(os.networkInterfaces())) for (const a of list ?? []) if (!a.internal) out.push(a.address);
      return out;
    },
  };
  return ctx;
}

/** Secret-like env keys never return values (04 §4.4 rule 3). */
export const SECRET_KEY_RE = /(SECRET|PASSWORD|TOKEN|PRIVATE|_KEY|KEYS)$/i;
