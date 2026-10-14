#!/usr/bin/env node
// scripts/smoke/remote.mjs —— 对已经部署到 EC2 的 L0 跑同一份相册全流程（flow.mjs），用于真实 AWS 验证（07 V3-2）
//
// 和 smoke:l0 的区别：不在本机启动 api / worker，而是直接请求 --base-url；需要本机 CLI 的步骤（admin:create）
// 通过 SSH 在实例上执行。
//
// 用法：
//   node scripts/smoke/remote.mjs --base-url http://<EIP> --ssh-host <EIP> --ssh-key <pem> [--ssh-user ec2-user]
//        [--known-hosts <file>] [--profile l0|s3] [--entry nginx|cloudfront>nginx] [--report <file>]
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { argValue, Reporter, ROOT } from './lib.mjs';
import { runFlow } from './flow.mjs';

const REMOTE_CLI = 'sudo runuser -u cloudalbum -- env CLOUDALBUM_ENV_DIR=/etc/cloudalbum CLOUDALBUM_ROLE=cli /usr/bin/node /opt/cloudalbum/backend/dist/cli.js';

function shellQuote(s) {
  return `'${String(s).replace(/'/g, `'\\''`)}'`;
}

function remoteCli({ host, key, user, knownHosts }) {
  return (args) => {
    const sshArgs = ['-i', key, '-o', 'BatchMode=yes', '-o', 'StrictHostKeyChecking=accept-new', '-o', 'ConnectTimeout=20'];
    if (knownHosts) sshArgs.push('-o', `UserKnownHostsFile=${knownHosts}`);
    sshArgs.push(`${user}@${host}`, `${REMOTE_CLI} ${args.map(shellQuote).join(' ')}`);
    const r = spawnSync('ssh', sshArgs, { encoding: 'utf8', timeout: 120_000 });
    return { status: r.status, stdout: r.stdout ?? '', stderr: r.stderr ?? r.error?.message ?? '' };
  };
}

const L0_EXPECT = {
  ec2: { allow: ['ok', 'degraded'] }, storage: { driver: 'local' }, 'image-processing': { driver: 'inline' }, queue: { driver: 'sync' },
  cache: { driver: 'none' }, database: { driver: 'sqlite' }, auth: { driver: 'local' }, iam: { driver: 'none' },
};
const L0_PROFILE = {
  storage: 'local', imageAsync: false, imageDriver: 'inline', cacheDriver: 'none', dbDriver: 'sqlite', f14: true,
  // 已部署实例上看不到进程里加载了哪些模块，所以不检查“没有加载 AWS SDK”（那是 smoke:l0 在本机进程上做的）
  expectNoAwsSdk: false,
  entry: 'nginx',
};
const PROFILES = {
  l0: { ...L0_PROFILE, name: 'EC2 上的 L0', expectModules: L0_EXPECT },
  // 启用 iam(role) + storage(s3) 之后
  s3: {
    ...L0_PROFILE, name: 'EC2 上的 L0 + S3', storage: 's3', f14: false,
    expectModules: { ...L0_EXPECT, storage: { driver: 's3' }, iam: { driver: 'role' } },
  },
};

async function main() {
  const baseUrl = argValue('base-url', '');
  const host = argValue('ssh-host', '');
  const key = argValue('ssh-key', '');
  if (!baseUrl || !host || !key) {
    console.error('usage: node scripts/smoke/remote.mjs --base-url http://<EIP> --ssh-host <EIP> --ssh-key <pem> [--profile l0|s3]');
    process.exitCode = 2;
    return;
  }
  const profileName = argValue('profile', 'l0');
  const base = PROFILES[profileName];
  if (!base) throw new Error(`unknown --profile ${profileName} (l0, s3)`);
  // --entry：经 CloudFront 访问时为 cloudfront>nginx
  const profile = { ...base, entry: argValue('entry', base.entry) };
  const t = new Reporter(`smoke:remote:${profileName}`);
  const env = {
    baseUrl: baseUrl.replace(/\/$/, ''),
    adminCli: remoteCli({ host, key, user: argValue('ssh-user', 'ec2-user'), knownHosts: argValue('known-hosts', '') }),
  };
  await runFlow(t, env, profile);
  process.exitCode = t.finish(argValue('report', path.join(ROOT, '.cloudalbum', 'smoke', `last-remote-${profileName}.json`)));
}

await main();
