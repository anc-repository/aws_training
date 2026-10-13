// backend/src/cli/platform/common.ts —— 平台模式本机 CLI 的通用约定（06 PM-12、§1.5 第 5 条）
//
// - stdout 只有一个 JSON 对象（成功时为结果，失败时为 {"error":{"code","message"}}）；人读的信息写 stderr；
// - 退出码：0 成功；2 用法或参数错误；3 不可用（平台模式关闭、应用未就绪、数据库不可达）；4 对象不存在；5 内部错误；
// - 所有参数先按正则校验再使用。
import type { Knex } from 'knex';
import { DEFAULT_ENV_DIR, validateConfig } from '../../config/validate.js';
import type { AppConfig } from '../../config/schema.js';
import { createKnex } from '../../db/knex.js';
import { initPlatform, readPlatformEnvFile, type PlatformState } from '../../platform/mode.js';

export const EXIT = { ok: 0, usage: 2, unavailable: 3, notFound: 4, internal: 5 } as const;

export class CliExit extends Error {
  constructor(readonly exitCode: number, readonly code: string, message: string) {
    super(message);
  }
}

export const usage = (code: string, message: string) => new CliExit(EXIT.usage, code, message);
export const unavailable = (code: string, message: string) => new CliExit(EXIT.unavailable, code, message);
export const notFound = (code: string, message: string) => new CliExit(EXIT.notFound, code, message);

/** stdout：一个 JSON 对象（单行，便于检查包取最后一行解析） */
export function emit(obj: unknown): void {
  process.stdout.write(`${JSON.stringify(obj)}\n`);
}

export function note(line: string): void {
  process.stderr.write(`${line}\n`);
}

/** 包装 action：CliExit → {"error":…} + 退出码；其他异常 → INTERNAL（5） */
export function action<A extends unknown[]>(fn: (...args: A) => Promise<void> | void): (...args: A) => Promise<void> {
  return async (...args: A) => {
    try {
      await fn(...args);
    } catch (e) {
      if (e instanceof CliExit) {
        emit({ error: { code: e.code, message: e.message } });
        process.exitCode = e.exitCode;
        return;
      }
      note((e as Error)?.stack ?? String(e));
      emit({ error: { code: 'INTERNAL', message: (e as Error)?.message ?? String(e) } });
      process.exitCode = EXIT.internal;
    }
  };
}

export function envDirOf(opts: { envDir?: string }): string {
  return opts.envDir ?? process.env.CLOUDALBUM_ENV_DIR ?? DEFAULT_ENV_DIR;
}

/** 由配置目录建立平台状态（不经 container；platform-status、probe-token 等只读命令使用） */
export function platformFromDir(envDir: string, cloudalbumEnv?: string): PlatformState {
  const f = readPlatformEnvFile(envDir);
  return initPlatform({ env: f.values, envDir, ...(cloudalbumEnv !== undefined ? { cloudalbumEnv } : {}), present: f.present, fileKeys: f.keys });
}

/** 启动配置（结构校验通过即可；规则错误不影响只读命令） */
export async function loadConfig(envDir: string): Promise<{ cfg: AppConfig | undefined; errors: string[] }> {
  const v = await validateConfig({ role: 'cli', envDir, checkImplemented: false });
  return { cfg: v.parsed.config, errors: [...v.parsed.errors.map((e) => `${e.section}.${e.path}: ${e.message}`), ...v.verdict.errors.map((f) => `${f.rule}: ${f.message}`)] };
}

/** 打开主库；配置无效或数据库不可达 → 不可用（3） */
export async function withDb<T>(envDir: string, fn: (db: Knex, cfg: AppConfig) => Promise<T>): Promise<T> {
  const { cfg } = await loadConfig(envDir);
  if (!cfg) throw unavailable('CONFIG_INVALID', 'startup configuration is invalid (run cloudalbum check-config)');
  let db: Knex;
  try {
    db = await createKnex(cfg);
  } catch (e) {
    throw unavailable('DB_UNAVAILABLE', `database unavailable: ${(e as Error).message}`);
  }
  try {
    return await fn(db, cfg);
  } catch (e) {
    if (e instanceof CliExit) throw e;
    const msg = (e as Error)?.message ?? String(e);
    if (/no such table|does not exist|ECONNREFUSED|ENOTFOUND|SQLITE_CANTOPEN/i.test(msg)) throw unavailable('DB_UNAVAILABLE', msg);
    throw e;
  } finally {
    await db.destroy().catch(() => undefined);
  }
}

/** 整数参数（含上下限） */
export function intArg(name: string, raw: string | undefined, min: number, max: number, def?: number): number {
  if (raw === undefined) {
    if (def === undefined) throw usage('ARG_MISSING', `--${name} is required`);
    return def;
  }
  if (!/^[0-9]{1,6}$/.test(raw)) throw usage('ARG_INVALID', `--${name} must be an integer`);
  const n = Number(raw);
  if (n < min || n > max) throw usage('ARG_OUT_OF_RANGE', `--${name} must be ${min}..${max}`);
  return n;
}

export const RUN_ID_RE = /^[0-9A-HJKMNP-TV-Z]{26}$/;
