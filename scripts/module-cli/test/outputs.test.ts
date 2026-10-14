import { describe, expect, it } from 'vitest';
import {
  EnvOwnershipError, OutputNameError, buildModuleEnv, classifyOutput, envKeyToOutputName, outputNameToEnvKey,
  splitOutputs, validateModuleEnv,
} from '../src/outputs.js';
import { loadTemplate, mainTemplatePath } from '../src/template.js';
import { REPO_ROOT, modulesWithTemplates } from './helpers.js';

describe('Outputs -> env key conversion (9.1)', () => {
  it.each([
    ['EnvStorageS3RawBucket', 'STORAGE_S3_RAW_BUCKET'],
    ['EnvStorageS3MediaBucket', 'STORAGE_S3_MEDIA_BUCKET'],
    ['EnvCdnBaseUrl', 'CDN_BASE_URL'],
    ['EnvSqsQueueUrl', 'SQS_QUEUE_URL'],
    ['EnvSqsWaitTimeSec', 'SQS_WAIT_TIME_SEC'],
    ['EnvDbSslCa', 'DB_SSL_CA'],
    ['EnvDbPasswordSecretArn', 'DB_PASSWORD_SECRET_ARN'],
    ['EnvRedisUrl', 'REDIS_URL'],
    ['EnvCognitoUserPoolId', 'COGNITO_USER_POOL_ID'],
    ['EnvImageLambdaFunction', 'IMAGE_LAMBDA_FUNCTION'],
    ['EnvIamCredentials', 'IAM_CREDENTIALS'],
    ['EnvCacheDriver', 'CACHE_DRIVER'],
  ])('%s -> %s', (name, key) => {
    expect(outputNameToEnvKey(name)).toBe(key);
    expect(envKeyToOutputName(key)).toBe(name);
  });

  it('rejects abbreviations written in capitals and non-Env names', () => {
    expect(() => outputNameToEnvKey('EnvSQSQueueURL')).toThrow(OutputNameError);
    expect(() => outputNameToEnvKey('EnvCdnBaseURL')).toThrow(OutputNameError);
    expect(() => outputNameToEnvKey('InfoQueueArn')).toThrow(OutputNameError);
    expect(() => outputNameToEnvKey('Env')).toThrow(OutputNameError);
    expect(() => outputNameToEnvKey('Envlower')).toThrow(OutputNameError);
  });

  it('classifies outputs', () => {
    expect(classifyOutput('ModuleId')).toBe('module-id');
    expect(classifyOutput('ModuleVersion')).toBe('module-version');
    expect(classifyOutput('PolicyArn')).toBe('policy');
    expect(classifyOutput('EnvRedisUrl')).toBe('env');
    expect(classifyOutput('InfoReplicationGroupId')).toBe('info');
    expect(classifyOutput('InstanceSecurityGroupId')).toBe('context');
    expect(classifyOutput('Environment')).toBe('context');
  });

  it('splits a stack output set', () => {
    const r = splitOutputs({
      ModuleId: 'storage', ModuleVersion: '1', PolicyArn: 'arn:aws:iam::1:policy/x',
      EnvStorageDriver: 's3', EnvStorageS3RawBucket: 'raw', InfoRawBucketArn: 'arn:aws:s3:::raw',
    });
    expect(r.moduleId).toBe('storage');
    expect(r.policyArn).toBe('arn:aws:iam::1:policy/x');
    expect(r.env).toEqual({ STORAGE_DRIVER: 's3', STORAGE_S3_RAW_BUCKET: 'raw' });
    expect(r.info).toEqual({ InfoRawBucketArn: 'arn:aws:s3:::raw' });
  });
});

describe('modules.d/<id>.env content (9.2 step 4, CFG-002)', () => {
  it('AWS tier: MODULE flags first, then the switch, outputs, settings', () => {
    const env = buildModuleEnv({
      module: 'queue', awsTier: true, switchValue: 'sqs',
      outputs: { ModuleId: 'queue', PolicyArn: 'p', EnvQueueDriver: 'sqs', EnvSqsQueueUrl: 'https://q', EnvSqsDlqUrl: 'https://d', InfoQueueArn: 'a' },
      settings: { QUEUE_SQS_POLLERS: '3' },
    });
    expect(Object.keys(env)).toEqual(['MODULE_QUEUE', 'MODULE_QUEUE_VERSION', 'QUEUE_DRIVER', 'SQS_QUEUE_URL', 'SQS_DLQ_URL', 'QUEUE_SQS_POLLERS']);
    expect(env.MODULE_QUEUE).toBe('on');
    expect(env.MODULE_QUEUE_VERSION).toBe('1');
  });

  it('local tier: no MODULE flag (CFG-004 exemption)', () => {
    const env = buildModuleEnv({ module: 'cache', awsTier: false, switchValue: 'memory', settings: { CACHE_MEMORY_MAX_ITEMS: '5000' } });
    expect(env).toEqual({ CACHE_DRIVER: 'memory', CACHE_MEMORY_MAX_ITEMS: '5000' });
  });

  it('parameter module: the switch value comes from an Env* output', () => {
    const env = buildModuleEnv({ module: 'cdn', awsTier: true, outputs: { EnvCdnBaseUrl: 'https://d1.cloudfront.net', EnvCdnDistributionId: 'E1' } });
    expect(env.CDN_BASE_URL).toBe('https://d1.cloudfront.net');
    expect(env.MODULE_CDN).toBe('on');
  });

  it('rejects secret-like keys and keys owned by another module', () => {
    expect(() => buildModuleEnv({ module: 'database', awsTier: true, settings: { DB_PASSWORD: 'x' } })).toThrow(EnvOwnershipError);
    expect(() => buildModuleEnv({ module: 'cache', awsTier: true, settings: { REDIS_AUTH_TOKEN: 'x' } })).toThrow(EnvOwnershipError);
    expect(() => buildModuleEnv({ module: 'storage', awsTier: true, settings: { CDN_BASE_URL: 'x' } })).toThrow(/not in ownsEnv of storage/);
    expect(validateModuleEnv('database', { DB_PASSWORD_SECRET_ARN: 'arn' })).toEqual([]);
    expect(validateModuleEnv('database', { DB_PROXY_MODE: 'pgbouncer' })).toEqual(['DB_PROXY_MODE: not in ownsEnv of database']);
  });

  it('every Env* output of every MVP template is a valid key owned by that module', () => {
    for (const id of modulesWithTemplates()) {
      const t = loadTemplate(REPO_ROOT, mainTemplatePath(id));
      const envOutputs = Object.keys(t.Outputs).filter((k) => classifyOutput(k) === 'env');
      expect(envOutputs.length, id).toBeGreaterThan(0);
      const env = Object.fromEntries(envOutputs.map((k) => [outputNameToEnvKey(k), 'x']));
      expect(validateModuleEnv(id, env), id).toEqual([]);
    }
  });
});
