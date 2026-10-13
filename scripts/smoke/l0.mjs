#!/usr/bin/env node
// scripts/smoke/l0.mjs —— npm run smoke:l0：L0 与两个本地档的端到端自测（开发机直连 Node，不需要 Nginx）
//
//   1. l0            默认配置：SQLite、本地存储、本地认证、inline 缩略图、sync 队列、无缓存
//   2. worker-memory IMAGE_PROCESSOR=worker + QUEUE_DRIVER=memory（缩略图异步）
//   3. cache-memory  CACHE_DRIVER=memory（时间线 cache-aside + 管理员旁路）
//   另：规则引擎（不合法的配置组合 → check-config / server 以 78 退出并给出可读报告），见 rules.mjs。
// 用法：node scripts/smoke/l0.mjs [--only l0,worker-memory,cache-memory,rules] [--keep]
import path from 'node:path';
import { argFlag, argValue, Reporter, requireBuild, ROOT } from './lib.mjs';
import { runRules } from './rules.mjs';
import { runVariant } from './run.mjs';

const L0_MODULES = { ec2: { allow: ['ok', 'degraded'] } };

export const VARIANTS = {
  l0: {
    modules: {},
    profile: {
      name: 'L0 默认', storage: 'local', imageAsync: false, imageDriver: 'inline', cacheDriver: 'none', dbDriver: 'sqlite', expectNoAwsSdk: true,
      f14: true,
      expectModules: { ...L0_MODULES, storage: { driver: 'local' }, 'image-processing': { driver: 'inline' }, queue: { driver: 'sync' },
        cache: { driver: 'none' }, database: { driver: 'sqlite' }, auth: { driver: 'local' }, iam: { driver: 'none' } },
    },
  },
  'worker-memory': {
    modules: { 'image-processing': { IMAGE_PROCESSOR: 'worker' }, queue: { QUEUE_DRIVER: 'memory' } },
    profile: {
      name: '本地档 worker + memory', storage: 'local', imageAsync: true, imageDriver: 'worker', cacheDriver: 'none', dbDriver: 'sqlite', expectNoAwsSdk: true,
      expectModules: { ...L0_MODULES, 'image-processing': { driver: 'worker' }, queue: { driver: 'memory' } },
    },
  },
  'cache-memory': {
    modules: { cache: { CACHE_DRIVER: 'memory' } },
    profile: {
      name: '本地档 cache=memory', storage: 'local', imageAsync: false, imageDriver: 'inline', cacheDriver: 'memory', dbDriver: 'sqlite', expectNoAwsSdk: true,
      expectModules: { ...L0_MODULES, cache: { driver: 'memory' } },
    },
  },
};

async function main() {
  requireBuild();
  const only = argValue('only', 'l0,worker-memory,cache-memory,rules').split(',');
  const keep = argFlag('keep');
  const t = new Reporter('smoke:l0');
  for (const [key, v] of Object.entries(VARIANTS)) {
    if (only.includes(key)) await runVariant(t, key, v, { keep });
  }
  if (only.includes('rules')) await runRules(t);
  process.exitCode = t.finish(path.join(ROOT, '.cloudalbum', 'smoke', 'last-l0.json'));
}

await main();
