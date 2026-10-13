// backend/src/cli/platform/capabilities.ts —— `cloudalbum capabilities`（06 PM-15）与 `module-state`
//
// capabilities：带本机令牌请求 http://127.0.0.1/api/capabilities（Host: 127.0.0.1）；连接被拒或 502/503 时退回应用端口
// http://127.0.0.1:<PORT>（01 §9.3“80 端口不可用时退回应用端口”）。输出 {"via":"nginx|direct","etag":"…","data":{…投影…}}。
// module-state：读取 /etc/cloudalbum/modules.state.json（scripts/module 写入）与 modules.d/*.env 的开关取值。
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import type { Command, Option } from 'commander';
import { PLATFORM_HEADERS, isModuleId, type ModuleId, type ModuleStateFile } from '@cloudalbum/contracts';
import { parseEnvFile } from '../../config/load-env.js';
import { REGISTRY } from '../../modules/registry.js';
import { readLocalProbeSecret } from '../../platform/mode.js';
import { cloudalbumEnvOf } from './apply-env.js';
import { action, emit, envDirOf, loadConfig, platformFromDir, unavailable, usage } from './common.js';

const FIELDS_RE = /^[A-Za-z0-9_.*[\],-]{1,2000}$/;
const MODULES_RE = /^[a-z0-9-]+(,[a-z0-9-]+)*$/;

interface HttpResult { status: number; etag: string | null; body: string }

function get(port: number, pathQuery: string, headers: Record<string, string>, timeoutMs = 5000): Promise<HttpResult> {
  return new Promise((resolve, reject) => {
    const req = http.get({ host: '127.0.0.1', port, path: pathQuery, headers: { Host: '127.0.0.1', Accept: 'application/json', ...headers }, timeout: timeoutMs }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (d: string) => { body += d; });
      res.on('end', () => resolve({ status: res.statusCode ?? 0, etag: (res.headers.etag as string | undefined) ?? null, body }));
    });
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.on('error', reject);
  });
}

export async function capabilitiesViaHttp(opts: { envDir: string; fields?: string; modules?: string; view: 'public' | 'admin'; nginxPort?: number; appPort?: number }): Promise<{ via: 'nginx' | 'direct'; etag: string | null; data: unknown }> {
  const s = platformFromDir(opts.envDir, cloudalbumEnvOf(opts.envDir));
  const qs = new URLSearchParams();
  if (opts.fields) qs.set('fields', opts.fields);
  if (opts.modules) qs.set('modules', opts.modules);
  if (opts.view === 'admin') qs.set('view', 'admin');
  const headers: Record<string, string> = {};
  if (opts.view === 'admin') {
    const token = readLocalProbeSecret(s);
    if (!token || s.mode !== 'on') throw unavailable('PROBE_UNAVAILABLE', 'view=admin needs platform mode and the local probe secret');
    headers[PLATFORM_HEADERS.probeToken] = token;
  }
  const q = `/api/capabilities${qs.toString() ? `?${qs.toString()}` : ''}`;
  const { cfg } = await loadConfig(opts.envDir);
  const appPort = opts.appPort ?? cfg?.core.PORT ?? 3000;
  let r: HttpResult | null = null;
  let via: 'nginx' | 'direct' = 'nginx';
  try {
    r = await get(opts.nginxPort ?? 80, q, headers, 3000);
    if (r.status === 502 || r.status === 503 || r.status === 504) r = null;
  } catch {
    r = null;
  }
  if (!r) {
    via = 'direct';
    try {
      r = await get(appPort, q, headers);
    } catch (e) {
      throw unavailable('APP_UNAVAILABLE', `CloudAlbum is not reachable on 127.0.0.1:80 or :${appPort} (${(e as Error).message})`);
    }
  }
  let data: unknown;
  try {
    data = JSON.parse(r.body);
  } catch {
    throw unavailable('APP_UNAVAILABLE', `unexpected response ${r.status}`);
  }
  if (r.status === 400) throw usage(String((data as { error?: { code?: string } }).error?.code ?? 'FIELDS_INVALID'), JSON.stringify(data));
  if (r.status !== 200) throw unavailable('APP_UNAVAILABLE', `capabilities returned ${r.status}`);
  return { via, etag: r.etag, data };
}

/** modules.state.json + modules.d/*.env（PM-15 的输出形状；兼容旧格式 {modules:{id:{status,at}}}） */
export function moduleState(envDir: string, only?: string): Record<string, unknown> {
  const file = path.join(envDir, 'modules.state.json');
  let raw: Partial<ModuleStateFile> & { modules?: Record<string, Record<string, unknown>> } = {};
  if (existsSync(file)) {
    try {
      raw = JSON.parse(readFileSync(file, 'utf8')) as typeof raw;
    } catch {
      raw = {};
    }
  }
  const envDirFiles = path.join(envDir, 'modules.d');
  const envFiles = new Map<string, Record<string, string>>();
  if (existsSync(envDirFiles)) {
    for (const f of readdirSync(envDirFiles).filter((x) => x.endsWith('.env'))) {
      envFiles.set(f.slice(0, -4), parseEnvFile(readFileSync(path.join(envDirFiles, f), 'utf8')));
    }
  }
  const modules: Record<string, unknown> = {};
  const ids = new Set<string>([...Object.keys(raw.modules ?? {}), ...envFiles.keys()]);
  for (const id of ids) {
    if (only && id !== only) continue;
    const rec = (raw.modules ?? {})[id] ?? {};
    const env = envFiles.get(id);
    const sw = isModuleId(id) ? REGISTRY[id as ModuleId]?.switch : undefined;
    const driver = typeof rec.driver === 'string' ? rec.driver : (sw && env?.[sw.var]) || null;
    const enabled = typeof rec.enabled === 'boolean' ? rec.enabled : rec.status === 'enabled' || (env?.[`MODULE_${id.toUpperCase().replace(/-/g, '_')}`] ?? '').toLowerCase() === 'on';
    modules[id] = {
      enabled, driver, version: typeof rec.version === 'number' ? rec.version : null,
      enabledAt: typeof rec.enabledAt === 'string' ? rec.enabledAt : (typeof rec.at === 'string' ? rec.at : null),
      envFile: Boolean(env),
    };
  }
  const history = Array.isArray(raw.history) ? raw.history.filter((h) => !only || h.module === only) : [];
  return { schema: 'cloudalbum.module-state/v1', modules, pending: raw.pending ?? null, history };
}

export function registerCapabilities(program: Command, envDirOption: () => Option): void {
  program.command('capabilities')
    .description('本机读取 capabilities 投影（06 PM-15）：先经 Nginx（80），不可用时退回应用端口')
    .addOption(envDirOption())
    .option('--fields <projection>', '逗号分隔的投影路径（06 PM-03）')
    .option('--modules <ids>', '只保留这些模块')
    .option('--view <view>', 'public | admin（admin 需要平台模式与本机探测密钥）', 'public')
    .option('--json', 'JSON 输出（默认）')
    .action(action(async (opts: { envDir?: string; fields?: string; modules?: string; view?: string }) => {
      if (opts.fields !== undefined && !FIELDS_RE.test(opts.fields)) throw usage('FIELDS_INVALID', '--fields contains invalid characters');
      if (opts.modules !== undefined && !MODULES_RE.test(opts.modules)) throw usage('MODULE_UNKNOWN', '--modules must be module ids');
      if (opts.view !== 'public' && opts.view !== 'admin') throw usage('ARG_INVALID', '--view must be public|admin');
      emit(await capabilitiesViaHttp({ envDir: envDirOf(opts), ...(opts.fields ? { fields: opts.fields } : {}), ...(opts.modules ? { modules: opts.modules } : {}), view: opts.view }));
    }));

  program.command('module-state')
    .description('已启用模块摘要（06 PM-15）：modules.state.json + modules.d/*.env')
    .addOption(envDirOption())
    .option('--module <id>', '只看一个模块')
    .option('--json', 'JSON 输出（默认）')
    .action(action((opts: { envDir?: string; module?: string }) => {
      if (opts.module !== undefined && !isModuleId(opts.module)) throw usage('MODULE_UNKNOWN', `unknown module ${opts.module}`);
      emit(moduleState(envDirOf(opts), opts.module));
    }));
}
