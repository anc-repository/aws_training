// config/load-env.ts：分层加载、ownsEnv 归属（CFG-002）、重复键（CFG-003）、机密类键、local.override.env（CFG-005）
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { isSecretLikeKey, loadEnvLayersSync, parseEnvFile } from '../../src/config/load-env.js';
import { validateConfig } from '../../src/config/validate.js';
import { ENABLE, evaluate, outcomeOf, tempEnvDir } from '../helpers/config.js';

describe('parseEnvFile', () => {
  it('支持注释、export、引号与行尾注释', () => {
    const env = parseEnvFile([
      '﻿# comment',
      'A=1',
      'export B=two',
      'C="quoted # not comment"',
      "D='single'",
      'E=value # trailing comment',
      'F="line\\nbreak"',
      'G=',
      'bad line',
      '1BAD=x',
    ].join('\r\n'));
    expect(env).toEqual({ A: '1', B: 'two', C: 'quoted # not comment', D: 'single', E: 'value', F: 'line\nbreak', G: '' });
  });
});

describe('isSecretLikeKey（4.4 第 2 层的定义）', () => {
  it.each([
    ['DB_PASSWORD', true], ['REDIS_AUTH_TOKEN', true], ['JWT_SIGNING_KEY_FILE', true], ['IAM_KEYS_ACCESS_KEY_ID', true],
    ['ORIGIN_VERIFY', true], ['COGNITO_CLIENT_SECRET', true], ['MY_PRIVATE_KEY', true],
    ['DB_PASSWORD_SECRET_ARN', false], ['COGNITO_CLIENT_SECRET_ARN', false], ['REDIS_AUTH_SECRET_ARN', false],
    ['STORAGE_S3_RAW_BUCKET', false], ['SECRETS_DRIVER', false],
  ])('%s → %s', (key, expected) => {
    expect(isSecretLikeKey(key)).toBe(expected);
  });
});

describe('loadEnvLayers', () => {
  it('按 基础 → modules.d（文件名排序）→ secrets.env → local.override.env → 进程白名单 的顺序合并', () => {
    const dir = tempEnvDir({
      base: { AWS_REGION: 'ap-northeast-1', APP_BASE_URL: 'http://203.0.113.10', CACHE_DRIVER: 'none' },
      modules: { cache: { CACHE_DRIVER: 'memory', CACHE_MEMORY_MAX_ITEMS: '100' } },
      secrets: { UPLOAD_HMAC_KEY: 'k1', SECRETS_ORIGIN: 'instance' },
      override: { CACHE_MEMORY_MAX_ITEMS: '7' },
    });
    const layers = loadEnvLayersSync(dir, { processEnv: { PORT: '3001', AWS_SECRET_ACCESS_KEY: 'should-not-leak', NODE_ENV: 'test' } });
    expect(layers.exists).toBe(true);
    expect(layers.issues).toEqual([]);
    expect(layers.merged.CACHE_DRIVER).toBe('memory');
    expect(layers.merged.CACHE_MEMORY_MAX_ITEMS).toBe('7');
    expect(layers.merged.UPLOAD_HMAC_KEY).toBe('k1');
    expect(layers.merged.PORT).toBe('3001');
    expect(layers.merged.AWS_SECRET_ACCESS_KEY).toBeUndefined();     // 进程环境只取白名单键
    expect(layers.merged.CLOUDALBUM_ENV_DIR).toBe(path.resolve(dir));
    expect(layers.localOverride).toBe(true);
    expect(layers.sources.CACHE_MEMORY_MAX_ITEMS).toBe(path.join(path.resolve(dir), 'local.override.env'));
  });

  it('目录不存在时全部取默认值（L0）', () => {
    const layers = loadEnvLayersSync(path.join(tempEnvDir({}), 'missing'), { processEnv: {} });
    expect(layers.exists).toBe(false);
    expect(Object.keys(layers.merged)).toEqual(['CLOUDALBUM_ENV_DIR']);
  });

  it('CFG-002：modules.d 出现不属于该模块的键、机密类键、未知模块文件', () => {
    const dir = tempEnvDir({
      modules: {
        storage: { MODULE_STORAGE: 'on', STORAGE_DRIVER: 's3', STORAGE_S3_RAW_BUCKET: 'r', STORAGE_S3_MEDIA_BUCKET: 'm', DB_HOST: 'x' },
        database: { DB_PASSWORD: 'leaked' },
        'not-a-module': { FOO: 'bar' },
      },
    });
    const layers = loadEnvLayersSync(dir, { processEnv: {} });
    const keys = layers.issues.filter((i) => i.code === 'CFG-002').map((i) => `${i.module}:${i.key}`).sort();
    expect(keys).toEqual(['database:DB_PASSWORD', 'not-a-module:FOO', 'storage:DB_HOST']);
  });

  it('CFG-003：同一个键出现在两个模块文件中', () => {
    const dir = tempEnvDir({ modules: { storage: { STORAGE_DRIVER: 's3' }, 'shared-fs': { STORAGE_DRIVER: 'efs' } } });
    const layers = loadEnvLayersSync(dir, { processEnv: {} });
    expect(layers.issues.filter((i) => i.code === 'CFG-003').map((i) => i.key)).toEqual(['STORAGE_DRIVER']);
  });

  it('secrets.env 只允许 SecretName 映射出的变量、SECRETS_ORIGIN、IAM_KEYS_*', () => {
    const dir = tempEnvDir({ secrets: { UPLOAD_HMAC_KEY: 'x', JWT_SIGNING_KEY_FILE: '/k.pem', IAM_KEYS_ACCESS_KEY_ID: 'AKIA', STORAGE_DRIVER: 's3' } });
    const layers = loadEnvLayersSync(dir, { processEnv: {} });
    expect(layers.issues.map((i) => i.key)).toEqual(['STORAGE_DRIVER']);
  });

  it('规则引擎读取分层结果：CFG-002 / CFG-005 / CRED-003', async () => {
    const dir = tempEnvDir({
      modules: {
        iam: { ...ENABLE.iamRole },
        'image-processing': { ...ENABLE.lambdaQueue, IMAGE_LAMBDA_FUNCTION: 'arn:aws:lambda:us-west-2:123456789012:function:t' },
        storage: { ...ENABLE.s3 },
      },
      override: { CRYPTO_LOCAL_PLAINTEXT: 'on' },
    });
    const layers = loadEnvLayersSync(dir, { processEnv: {} });
    const { verdict } = evaluate({}, { layers });
    expect(outcomeOf(verdict, 'CRED-003')).toBe('error');
    expect(outcomeOf(verdict, 'CFG-005')).toBe('warn');
    expect(outcomeOf(verdict, 'CFG-002')).toBe('none');

    const v = await validateConfig({ role: 'api', envDir: dir, processEnv: {} });
    expect(v.ok).toBe(false);
    expect(v.verdict.errors.map((e) => e.rule)).toContain('CRED-003');
  });

  it('结构校验失败时仍一次性列出 CFG-002 / CFG-003', async () => {
    const dir = tempEnvDir({ modules: { storage: { STORAGE_DRIVER: 'bogus', DB_HOST: 'x' } } });
    const v = await validateConfig({ role: 'api', envDir: dir, processEnv: {} });
    expect(v.ok).toBe(false);
    expect(v.parsed.errors.length).toBeGreaterThan(0);
    expect(v.verdict.errors.map((e) => e.rule)).toEqual(['CFG-002']);
  });
});
