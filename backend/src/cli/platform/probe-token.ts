// backend/src/cli/platform/probe-token.ts —— `cloudalbum probe-token`（06 PM-13）
//
//   probe-token --ttl <1..60> [--count <1..5>] --json   签发一次性令牌：{"tokens":["atlpt1.…"],"expiresAt":"<ISO>"}
//   probe-token --status --json                         {"present":true,"fingerprint":"sha256:…"}（从不打印密钥本身）
//   probe-token --init | --rotate                       生成 / 轮换本机密钥。实验机上是根子命令（infra/host/platform/probe-secret.sh）；
//                                                       这里的 Node 实现供开发机与测试使用
// 平台模式关闭或密钥不存在 → 退出 3。签发不访问数据库（nonce 在使用时才登记）。
// 旧名 `cloudalbum-probe-token`（检查目录第 1 轮的写法）在一个次版本内作为别名保留。
import { existsSync, mkdirSync, renameSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type { Command, Option } from 'commander';
import { probeTokenPath, readLocalProbeSecret, secretFingerprint } from '../../platform/mode.js';
import { generateLocalSecret, issueLabToken, issueProbeToken } from '../../platform/probe-token.js';
import { cloudalbumEnvOf } from './apply-env.js';
import { action, emit, envDirOf, intArg, platformFromDir, unavailable, usage } from './common.js';

interface ProbeTokenOpts { envDir?: string; ttl?: string; count?: string; status?: boolean; init?: boolean; rotate?: boolean }

function writeSecret(file: string): void {
  mkdirSync(path.dirname(file), { recursive: true, mode: 0o750 });
  const tmp = `${file}.tmp.${process.pid}`;
  writeFileSync(tmp, `${generateLocalSecret()}\n`, { mode: 0o640 });
  renameSync(tmp, file);
}

export function probeTokenCommand(opts: ProbeTokenOpts): Record<string, unknown> {
  const envDir = envDirOf(opts);
  const s = platformFromDir(envDir, cloudalbumEnvOf(envDir));
  const modes = [opts.status, opts.init, opts.rotate, opts.ttl !== undefined].filter(Boolean).length;
  if (modes !== 1) throw usage('ARG_INVALID', 'exactly one of --ttl, --status, --init, --rotate');
  const file = probeTokenPath(s);
  if (opts.init || opts.rotate) {
    if (opts.init && existsSync(file)) {
      const cur = readLocalProbeSecret(s);
      if (cur) return { present: true, fingerprint: secretFingerprint(cur), created: false };
    }
    writeSecret(file);
    const now = readLocalProbeSecret(s);
    return { present: now !== null, fingerprint: now ? secretFingerprint(now) : null, created: true };
  }
  const secret = readLocalProbeSecret(s);
  if (opts.status) return { present: secret !== null, ...(secret ? { fingerprint: secretFingerprint(secret) } : {}) };
  const ttl = intArg('ttl', opts.ttl, 1, 60);
  const count = intArg('count', opts.count, 1, 5, 1);
  if (s.mode !== 'on') throw unavailable('PLATFORM_MODE_OFF', 'platform mode is off');
  if (!secret) throw unavailable('PROBE_SECRET_MISSING', 'local probe secret is missing (cloudalbum probe-token --init)');
  const nowSec = Math.floor(Date.now() / 1000);
  const tokens = Array.from({ length: count }, () => issueProbeToken(secret, ttl, nowSec).token);
  return { tokens, expiresAt: new Date((nowSec + ttl) * 1000).toISOString() };
}

/** `cloudalbum lab-token --ttl <60..14400>`（06 PM-17）：实验主体令牌，有效期内可重复使用 */
export function labTokenCommand(opts: { envDir?: string; ttl?: string }): Record<string, unknown> {
  const envDir = envDirOf(opts);
  const s = platformFromDir(envDir, cloudalbumEnvOf(envDir));
  const ttl = intArg('ttl', opts.ttl, 60, 14_400, 3600);
  const secret = readLocalProbeSecret(s);
  if (s.mode !== 'on') throw unavailable('PLATFORM_MODE_OFF', 'platform mode is off');
  if (!secret) throw unavailable('PROBE_SECRET_MISSING', 'local probe secret is missing (cloudalbum probe-token --init)');
  const t = issueLabToken(secret, ttl);
  return { token: t.token, expiresAt: new Date(t.exp * 1000).toISOString() };
}

export function registerProbeToken(program: Command, envDirOption: () => Option): void {
  for (const name of ['probe-token', 'cloudalbum-probe-token']) {
    program.command(name)
      .description(name === 'probe-token' ? '探测令牌（06 PM-13）：签发一次性令牌、查看或生成本机密钥' : 'probe-token 的旧名（保留一个次版本）')
      .addOption(envDirOption())
      .option('--ttl <sec>', '一次性令牌的有效期 1..60 秒')
      .option('--count <n>', '一次签发的个数 1..5', undefined)
      .option('--status', '密钥是否存在与指纹')
      .option('--init', '生成本机密钥（已存在则不变；实验机上为 root 子命令）')
      .option('--rotate', '重新生成本机密钥（已签发的一次性令牌与 lab-token 全部失效）')
      .option('--json', 'JSON 输出（默认）')
      .action(action((opts: ProbeTokenOpts) => { emit(probeTokenCommand(opts)); }));
  }
  program.command('lab-token')
    .description('实验主体令牌 atllt1.*（06 PM-17）：Authorization: CA-Lab <token>')
    .addOption(envDirOption())
    .option('--ttl <sec>', '有效期 60..14400 秒（默认 3600）')
    .option('--json', 'JSON 输出（默认）')
    .action(action((opts: { envDir?: string; ttl?: string }) => { emit(labTokenCommand(opts)); }));
}
