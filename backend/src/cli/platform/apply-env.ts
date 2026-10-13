// backend/src/cli/platform/apply-env.ts —— `platform:validate-env` 与 `platform:apply-env`（06 PM-02）
//
// 实验机上 `cloudalbum platform:apply-env` 是根子命令，由 infra/host/platform/apply-env.sh 实现（不以 root 运行 Node）：
//   1. 以 cloudalbum 身份调用 `node cli.js platform:validate-env --b64 … --json`（本文件）：解码、按 PM-01 校验、
//      计算与现有文件的差异与进程处理方式，输出规范化后的文件内容与 Nginx 槽位内容；
//   2. 根脚本据此原子写入 platform.env 与槽位、`nginx -t && reload`（失败则恢复旧文件、退出 5）、重启或 SIGHUP。
// Node 版的 `platform:apply-env` 只写文件、不碰系统服务：供开发机（ATL_DEV_MODE 的本地 L0）与测试使用。
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type { Command } from 'commander';
import { parseEnvFile } from '../../config/load-env.js';
import {
  applyAction, renderFrameAncestorsSlot, renderPlatformEnv, validatePlatformEnv, type PlatformEnvValidation,
} from '../../platform/env-schema.js';
import { readPlatformEnvFile } from '../../platform/mode.js';
import { action, emit, envDirOf, usage } from './common.js';

export const DEFAULT_SLOT_FILE = '/etc/nginx/cloudalbum.d/slot-atl-frame-ancestors.inc';
const B64URL_RE = /^[A-Za-z0-9_-]{1,8000}={0,2}$/;

export interface ApplyPlan {
  validation: PlatformEnvValidation;
  /** 规范化后的 platform.env 全文 */
  file: string;
  /** Nginx 槽位 slot-atl-frame-ancestors.inc 的内容 */
  slot: string;
  changed: string[];
  action: 'none' | 'reload' | 'restart';
}

/** 解码 --b64（base64url(文件全文)） */
export function decodeEnvB64(b64: string): { values: Record<string, string>; keys: string[] } {
  if (!B64URL_RE.test(b64)) throw usage('ARG_INVALID', '--b64 must be base64url (≤ 8000 characters)');
  const text = Buffer.from(b64, 'base64url').toString('utf8');
  if (text.includes('\u0000')) throw usage('ARG_INVALID', '--b64 decodes to binary data');
  const values = parseEnvFile(text);
  return { values, keys: Object.keys(values) };
}

/** CLOUDALBUM_ENV：取配置目录的 cloudalbum.env（缺省 lab，与 config/schema.ts 一致） */
export function cloudalbumEnvOf(envDir: string): string {
  const f = path.join(envDir, 'cloudalbum.env');
  if (!existsSync(f)) return 'lab';
  return parseEnvFile(readFileSync(f, 'utf8')).CLOUDALBUM_ENV || 'lab';
}

export function planApply(envDir: string, b64: string, restart: 'auto' | 'always' | 'never' = 'auto'): ApplyPlan {
  const { values, keys } = decodeEnvB64(b64);
  const validation = validatePlatformEnv(values, { cloudalbumEnv: cloudalbumEnvOf(envDir), rawKeys: keys });
  const prev = readPlatformEnvFile(envDir);
  const diff = applyAction(prev.values, validation.normalized);
  let act = diff.action;
  if (restart === 'always') act = 'restart';
  if (restart === 'never') act = 'none';
  return {
    validation, file: renderPlatformEnv(validation.normalized), slot: renderFrameAncestorsSlot(validation.values),
    changed: diff.changed, action: act,
  };
}

function atomicWrite(file: string, content: string): void {
  mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp.${process.pid}`;
  writeFileSync(tmp, content, { mode: 0o640 });
  renameSync(tmp, file);
}

function restartOpt(raw: string | undefined): 'auto' | 'always' | 'never' {
  const v = raw ?? 'auto';
  if (v !== 'auto' && v !== 'always' && v !== 'never') throw usage('ARG_INVALID', '--restart must be auto|always|never');
  return v;
}

export function registerApplyEnv(program: Command, envDirOption: () => import('commander').Option): void {
  program.command('platform:validate-env')
    .description('校验 platform.env 的新内容（apply-env.sh 的第 1 步，06 PM-02）：输出规范化文件、槽位与差异；不写任何文件')
    .addOption(envDirOption())
    .requiredOption('--b64 <b64url>', 'base64url(文件全文)')
    .option('--restart <mode>', 'auto | always | never', 'auto')
    .option('--json', 'JSON 输出（默认）')
    .action(action((opts: { envDir?: string; b64: string; restart?: string }) => {
      const plan = planApply(envDirOf(opts), opts.b64, restartOpt(opts.restart));
      if (!plan.validation.valid) {
        process.exitCode = 2;
        emit({ valid: false, errors: plan.validation.errors });
        return;
      }
      emit({ valid: true, errors: [], changed: plan.changed, action: plan.action, mode: plan.validation.values.mode, file: plan.file, slot: plan.slot });
    }));

  program.command('platform:apply-env')
    .description('写入平台配置（开发机 / 测试；实验机上由根脚本 infra/host/platform/apply-env.sh 实现，06 PM-02）')
    .addOption(envDirOption())
    .requiredOption('--b64 <b64url>', 'base64url(文件全文)')
    .option('--restart <mode>', 'auto | always | never', 'auto')
    .option('--slot-file <path>', 'Nginx 槽位文件（缺省 <env-dir>/nginx/slot-atl-frame-ancestors.inc）')
    .option('--json', 'JSON 输出（默认）')
    .action(action((opts: { envDir?: string; b64: string; restart?: string; slotFile?: string }) => {
      const envDir = envDirOf(opts);
      const plan = planApply(envDir, opts.b64, restartOpt(opts.restart));
      if (!plan.validation.valid) throw usage('PLATFORM_ENV_INVALID', plan.validation.errors.join('; '));
      atomicWrite(path.join(envDir, 'platform.env'), plan.file);
      atomicWrite(opts.slotFile ?? path.join(envDir, 'nginx', 'slot-atl-frame-ancestors.inc'), plan.slot);
      emit({ changed: plan.changed, action: plan.action, nginxReloaded: false });
    }));
}
