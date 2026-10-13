// registry 与 rules.ts、config/schema.ts 的交叉检查（与 npm run registry:check 同一套逻辑），以及 registry 推导函数
import { describe, expect, it } from 'vitest';
import { MODULE_IDS } from '@cloudalbum/contracts';
import { REGISTRY_DOCUMENT } from '@cloudalbum/contracts/registry';
import { checkRegistry } from '../../../scripts/registry/checks.js';
import {
  driverOf, enabledModules, isActive, isEnabled, isKeyAllowedForModule, isSelfHosted, ownerOfKey,
} from '../../src/modules/registry.js';
import { ENABLE } from '../helpers/config.js';

describe('modules/registry.yaml 交叉检查', () => {
  it('registry:check 没有错误', () => {
    const report = checkRegistry();
    expect(report.errors).toEqual([]);
    expect(report.stats.modules).toBe(40);
  });

  it('生成的注册表包含全部 40 个模块，顺序与 ModuleId 一致', () => {
    expect(Object.keys(REGISTRY_DOCUMENT.modules)).toEqual([...MODULE_IDS]);
  });
});

describe('registry 推导', () => {
  it('ownsEnv 按最长前缀唯一归属', () => {
    expect(ownerOfKey('DB_HOST')).toBe('database');
    expect(ownerOfKey('DB_PROXY_ENDPOINT')).toBe('db-proxy');
    expect(ownerOfKey('STORAGE_S3_RAW_BUCKET')).toBe('storage');
    expect(ownerOfKey('STORAGE_LOCAL_ROOT')).toBe('shared-fs');
    expect(ownerOfKey('APP_BASE_URL')).toBe('dns');
    expect(ownerOfKey('SQS_QUEUE_URL')).toBe('queue');
    expect(ownerOfKey('NOT_A_MODULE_KEY')).toBeUndefined();
  });

  it('modules.d 文件允许的键：ownsEnv + MODULE_<ID>(_VERSION) + 开关变量', () => {
    expect(isKeyAllowedForModule('MODULE_STORAGE', 'storage')).toBe(true);
    expect(isKeyAllowedForModule('MODULE_STORAGE_VERSION', 'storage')).toBe(true);
    expect(isKeyAllowedForModule('STORAGE_DRIVER', 'storage')).toBe(true);
    expect(isKeyAllowedForModule('STORAGE_DRIVER', 'shared-fs')).toBe(true);
    expect(isKeyAllowedForModule('DB_HOST', 'storage')).toBe(false);
    expect(isKeyAllowedForModule('DB_PROXY_MODE', 'database')).toBe(false);
  });

  it('驱动名：参数型模块为推导出的驱动名', () => {
    expect(driverOf({}, 'cdn')).toBe('direct');
    expect(driverOf(ENABLE.cdn, 'cdn')).toBe('cloudfront');
    expect(driverOf({}, 'identity-pool')).toBe('none');
    expect(driverOf({}, 'kms')).toBe('local');
    expect(driverOf({}, 'social-api')).toBe('express');
    expect(driverOf({}, 'ec2')).toBe('single');
    expect(driverOf({}, 'storage')).toBe('local');
    expect(driverOf({}, 'iam')).toBe('none');
  });

  it('启用 = 开关取 AWS 值且没有命中 selfHosted.match', () => {
    expect(enabledModules({})).toEqual([]);
    expect(isEnabled(ENABLE.rds, 'database')).toBe(true);
    expect(isEnabled(ENABLE.pgLocal, 'database')).toBe(false);
    expect(isSelfHosted(ENABLE.pgLocal, 'database')).toBe(true);
    expect(isActive(ENABLE.pgLocal, 'database')).toBe(true);
    expect(isEnabled(ENABLE.valkeyLocal, 'cache')).toBe(false);
    expect(isEnabled({ CACHE_DRIVER: 'memory' }, 'cache')).toBe(false);
    expect(isEnabled(ENABLE.iamRole, 'iam')).toBe(true);
    expect(isEnabled({ STORAGE_DRIVER: 's3' }, 'storage')).toBe(true);
    expect(isEnabled({ STORAGE_DRIVER: 's3' }, 'shared-fs')).toBe(false);
    expect(isEnabled({ DB_PROXY_MODE: 'pgbouncer', DB_PROXY_ENDPOINT: '127.0.0.1' }, 'db-proxy')).toBe(false);
  });
});
