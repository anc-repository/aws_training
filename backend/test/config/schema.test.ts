// config/schema.ts：L0 默认值、路径派生、判别联合、跨字段校验、键清单
import { describe, expect, it } from 'vitest';
import { REGISTRY_DOCUMENT } from '@cloudalbum/contracts/registry';
import { CONFIG_KEYS, parseConfig, storageLocalRoot } from '../../src/config/schema.js';
import { ENABLE } from '../helpers/config.js';

describe('parseConfig', () => {
  it('L0 默认值与总纲一致', () => {
    const { config, errors, effective } = parseConfig({ CLOUDALBUM_ROLE: 'api' });
    expect(errors).toEqual([]);
    expect(config?.core.IAM_CREDENTIALS).toBe('none');
    expect(config?.core.DEPLOY_MODE).toBe('single');
    expect(config?.core.TLS_MODE).toBe('selfsigned');
    expect(config?.core.EXPOSE_PATH_HEADERS).toBe('all');
    expect(config?.storage.STORAGE_DRIVER).toBe('local');
    expect(config && storageLocalRoot(config)).toBe('/var/lib/cloudalbum/uploads');
    expect(config?.db).toEqual({ DB_DRIVER: 'sqlite', SQLITE_PATH: '/var/lib/cloudalbum/db/cloudalbum.sqlite' });
    expect(config?.cache.CACHE_DRIVER).toBe('none');
    expect(config?.queue.QUEUE_DRIVER).toBe('sync');
    expect(config?.image.IMAGE_PROCESSOR).toBe('inline');
    expect(config?.image.IMAGE_INLINE_CONCURRENCY).toBe(2);
    expect(config?.auth.AUTH_DRIVER).toBe('local');
    expect(config?.auth.AUTH_ACCESS_TTL_SEC).toBe(900);
    expect(config?.auth.JWT_SIGNING_KEY_FILE).toBe('/etc/cloudalbum/keys/jwt-es256.pem');
    expect(config?.email.EMAIL_DRIVER).toBe('outbox');
    expect(config?.scheduler.SCHEDULER_DRIVER).toBe('cron');
    expect(effective.STORAGE_DRIVER).toBe('local');
    expect(effective.CLOUDALBUM_ALLOW_UNSAFE).toBe('');
  });

  it('路径类默认值由 CLOUDALBUM_DATA_DIR / CLOUDALBUM_ENV_DIR 派生（开发机）', () => {
    const { config } = parseConfig({ CLOUDALBUM_ROLE: 'api', CLOUDALBUM_DATA_DIR: '/tmp/ca/data', CLOUDALBUM_ENV_DIR: '/tmp/ca/etc' });
    expect(config && storageLocalRoot(config)).toBe('/tmp/ca/data/uploads');
    expect(config?.db.DB_DRIVER === 'sqlite' && config.db.SQLITE_PATH).toBe('/tmp/ca/data/db/cloudalbum.sqlite');
    expect(config?.email.OUTBOX_DIR).toBe('/tmp/ca/data/outbox');
    expect(config?.auth.JWT_SIGNING_KEY_FILE).toBe('/tmp/ca/etc/keys/jwt-es256.pem');
  });

  it('一次性收集所有分段的错误', () => {
    const { config, errors } = parseConfig({
      CLOUDALBUM_ROLE: 'api', STORAGE_DRIVER: 's3', QUEUE_DRIVER: 'sqs', APP_BASE_URL: 'not a url',
    }, { checkImplemented: false });
    expect(config).toBeUndefined();
    const sections = new Set(errors.map((e) => e.section));
    expect(sections).toEqual(new Set(['core', 'storage', 'queue']));
  });

  it('开关取值不在 values 中', () => {
    const { errors } = parseConfig({ CLOUDALBUM_ROLE: 'api', CACHE_DRIVER: 'memcached' });
    expect(errors.some((e) => e.section === 'cache')).toBe(true);
  });

  it('image-processing：callback 通道需要 IMAGE_CALLBACK_URL', () => {
    const { lambdaCallback } = ENABLE;
    const { IMAGE_CALLBACK_URL: _omit, ...withoutUrl } = lambdaCallback;
    const r = parseConfig({ CLOUDALBUM_ROLE: 'api', ...withoutUrl });
    expect(r.errors.map((e) => e.message).join()).toContain('IMAGE_CALLBACK_URL');
    expect(parseConfig({ CLOUDALBUM_ROLE: 'api', ...lambdaCallback }).errors).toEqual([]);
  });

  it('storage(s3)：STORAGE_S3_URL_REUSE_SEC 必须小于 GET TTL', () => {
    const r = parseConfig({ CLOUDALBUM_ROLE: 'api', ...ENABLE.s3, STORAGE_S3_URL_REUSE_SEC: '600' });
    expect(r.errors.map((e) => e.message).join()).toContain('STORAGE_S3_URL_REUSE_SEC');
  });

  it('database(postgres)：密码与 ARN 至少一个；pgbouncer 端点必须是回环地址', () => {
    const { DB_PASSWORD: _p, ...noPassword } = ENABLE.rds;
    expect(parseConfig({ CLOUDALBUM_ROLE: 'api', ...noPassword }).errors.length).toBeGreaterThan(0);
    const bad = parseConfig({ CLOUDALBUM_ROLE: 'api', ...ENABLE.pgLocal, DB_PROXY_MODE: 'pgbouncer', DB_PROXY_ENDPOINT: '10.0.0.5' });
    expect(bad.errors.map((e) => e.message).join()).toContain('回环');
  });

  it('iam(keys)：长期密钥必填', () => {
    expect(parseConfig({ CLOUDALBUM_ROLE: 'api', IAM_CREDENTIALS: 'keys' }).errors.length).toBeGreaterThan(0);
    expect(parseConfig({ CLOUDALBUM_ROLE: 'api', ...ENABLE.iamKeys }).errors).toEqual([]);
  });

  it('CONFIG_KEYS 覆盖 registry 中全部开关变量', () => {
    for (const m of Object.values(REGISTRY_DOCUMENT.modules)) {
      if (m.switch) expect(CONFIG_KEYS.has(m.switch.var), m.switch.var).toBe(true);
    }
  });
});
