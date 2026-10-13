// backend/src/cli/platform/status.ts —— `cloudalbum platform-status --json`（06 PM-02）：平台模式自检（任何身份可执行、只读）
//
// 健康门 base.ready（04 §6.4）读取 platformEnv.valid、probeToken.present、services、dataVolumeMounted。
// 读不到的事实输出 null（例如开发机上没有 systemd、数据卷），而不是猜测。
import { execFile } from 'node:child_process';
import { readFileSync } from 'node:fs';
import http from 'node:http';
import type { Command, Option } from 'commander';
import type { PlatformStatus } from '@cloudalbum/contracts';
import { countAdmins } from '../../repositories/users.js';
import { checkBundleInfo, platformPaths, readLocalProbeSecret } from '../../platform/mode.js';
import { cloudalbumEnvOf } from './apply-env.js';
import { action, emit, envDirOf, loadConfig, platformFromDir, withDb } from './common.js';

function run(cmd: string, args: string[], timeoutMs = 4000): Promise<{ code: number | null; stdout: string; missing: boolean }> {
  return new Promise((resolve) => {
    execFile(cmd, args, { timeout: timeoutMs, windowsHide: true }, (err, stdout) => {
      const missing = Boolean(err && (err as NodeJS.ErrnoException).code === 'ENOENT');
      resolve({ code: err ? (typeof (err as { code?: unknown }).code === 'number' ? (err as { code: number }).code : 1) : 0, stdout: String(stdout ?? ''), missing });
    });
  });
}

function httpLive(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const req = http.get({ host: '127.0.0.1', port, path: '/api/health/live', timeout: 2000 }, (res) => {
      res.resume();
      resolve(res.statusCode === 200);
    });
    req.on('timeout', () => req.destroy());
    req.on('error', () => resolve(false));
  });
}

/** systemctl is-active <unit>；没有 systemd 时返回 null */
async function unitState(unit: string): Promise<string | null> {
  const r = await run('systemctl', ['is-active', unit]);
  if (r.missing) return null;
  return r.stdout.trim() || 'unknown';
}

/** 数据卷是否挂载在 CLOUDALBUM_DATA_DIR（Linux 读 /proc/self/mountinfo；其他平台 null） */
export function dataVolumeMounted(dataDir: string, mountinfo?: string): boolean | null {
  let text = mountinfo;
  if (text === undefined) {
    try {
      text = readFileSync('/proc/self/mountinfo', 'utf8');
    } catch {
      return null;
    }
  }
  return text.split('\n').some((l) => l.split(' ')[4] === dataDir);
}

/** SSM Agent 版本检查结果（引导脚本写 /opt/cloudalbum/.ssm-agent-check.json，PM-06） */
function ssmAgent(): PlatformStatus['ssmAgent'] {
  try {
    const j = JSON.parse(readFileSync(platformPaths().ssmAgentCheck, 'utf8')) as { version?: unknown; meetsMinimum?: unknown };
    return { version: typeof j.version === 'string' ? j.version : null, meetsMinimum: typeof j.meetsMinimum === 'boolean' ? j.meetsMinimum : null };
  } catch {
    return { version: null, meetsMinimum: null };
  }
}

export async function platformStatus(envDir: string): Promise<PlatformStatus> {
  const s = platformFromDir(envDir, cloudalbumEnvOf(envDir));
  const { cfg } = await loadConfig(envDir).catch(() => ({ cfg: undefined }));
  let admin: boolean | null = null;
  if (cfg) {
    admin = await withDb(envDir, async (db) => (await countAdmins(db)) > 0).catch(() => null);
  }
  const [api, worker, nginx] = await Promise.all(['cloudalbum-api', 'cloudalbum-worker', 'nginx'].map((u) => unitState(u)));
  let services: PlatformStatus['services'];
  if (api === null) {
    // 没有 systemd（开发机）：只能确认本机应用端口
    const live = cfg ? await httpLive(cfg.core.PORT) : false;
    services = { api: live ? 'active' : 'inactive', worker: 'unknown', nginx: 'unknown' };
  } else {
    services = { api, worker: worker ?? 'unknown', nginx: nginx ?? 'unknown' };
  }
  return {
    schema: 'cloudalbum.platform-status/v1',
    platformMode: s.mode,
    platformEnv: { present: s.present, valid: s.present ? s.valid : false, errors: s.present ? s.errors : ['platform.env is missing'] },
    probeToken: { present: readLocalProbeSecret(s) !== null },
    admin: { present: admin },
    checkBundle: checkBundleInfo(),
    ssmAgent: ssmAgent(),
    services,
    dataVolumeMounted: cfg ? dataVolumeMounted(cfg.core.CLOUDALBUM_DATA_DIR) : null,
    session: { sessionId: s.sessionId ?? null, labId: s.labId ?? null, envName: s.envName ?? null },
  };
}

export function registerStatus(program: Command, envDirOption: () => Option): void {
  program.command('platform-status')
    .description('平台模式自检（06 PM-02）：platform.env、探测密钥、检查包、SSM Agent、服务、数据卷')
    .addOption(envDirOption())
    .option('--json', 'JSON 输出（默认）')
    .action(action(async (opts: { envDir?: string }) => {
      emit(await platformStatus(envDirOf(opts)));
    }));
}
