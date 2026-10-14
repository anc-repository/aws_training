// adapters/aws/clients.ts：懒加载工厂（L0 拒绝创建客户端；有凭证时按需 import）+ aws-sdk-client-mock 的用法示例
import { HeadBucketCommand, S3Client } from '@aws-sdk/client-s3';
import { mockClient } from 'aws-sdk-client-mock';
import { afterEach, describe, expect, it } from 'vitest';
import { AwsCredentialsUnavailableError, awsSdkLoadReport, isAwsTransient, lazyAwsClients, withAwsRetry } from '../../src/adapters/aws/clients.js';

const fakeCredentials = async () => ({ accessKeyId: 'ASIAEXAMPLE', secretAccessKey: 'secret', sessionToken: 'token' });
const s3Mock = mockClient(S3Client);

afterEach(() => s3Mock.reset());

describe('lazyAwsClients', () => {
  it('IAM_CREDENTIALS=none（provider 为 null）时拒绝创建任何客户端，也不加载 SDK', async () => {
    const aws = lazyAwsClients({ region: 'ap-northeast-1', credentials: null });
    expect(aws.enabled).toBe(false);
    await expect(aws.s3()).rejects.toBeInstanceOf(AwsCredentialsUnavailableError);
    await expect(aws.sqs()).rejects.toBeInstanceOf(AwsCredentialsUnavailableError);
    expect(awsSdkLoadReport().viaFactory).toEqual([]);
  });

  it('有凭证时按需 import 并缓存客户端；记录已加载的包', async () => {
    const aws = lazyAwsClients({ region: 'ap-northeast-1', credentials: fakeCredentials });
    const a = await aws.s3();
    const b = await aws.s3();
    expect(a).toBe(b);
    expect(await a.config.region()).toBe('ap-northeast-1');
    const usEast = await aws.s3({ region: 'us-east-1' });
    expect(usEast).not.toBe(a);
    expect(awsSdkLoadReport().viaFactory).toContain('@aws-sdk/client-s3');
    aws.destroy();
  });

  it('适配器测试用 aws-sdk-client-mock 拦截 send()，不发出任何网络请求', async () => {
    s3Mock.on(HeadBucketCommand).resolves({});
    const aws = lazyAwsClients({ region: 'ap-northeast-1', credentials: fakeCredentials });
    const s3 = await aws.s3();
    await expect(s3.send(new HeadBucketCommand({ Bucket: 'cloudalbum-lab-raw' }))).resolves.toEqual({});
    expect(s3Mock.commandCalls(HeadBucketCommand)).toHaveLength(1);
    aws.destroy();
  });

  it('第 1 波模块的客户端（wave1-prep）：按需加载，可按区域覆盖（us-east-1 的全局类控制面）', async () => {
    const aws = lazyAwsClients({ region: 'ap-northeast-1', credentials: fakeCredentials });
    const clients = await Promise.all([
      aws.sns(), aws.sesv2(), aws.cloudwatch(), aws.cloudwatchLogs(), aws.cognitoIdentity(), aws.ec2(),
      aws.budgets({ region: 'us-east-1' }), aws.costExplorer({ region: 'us-east-1' }), aws.wafv2({ region: 'us-east-1' }),
      aws.route53({ region: 'us-east-1' }), aws.acm({ region: 'us-east-1' }),
    ]);
    expect(clients.every((c) => typeof c.send === 'function')).toBe(true);
    expect(await clients[6]!.config.region()).toBe('us-east-1');
    expect(await clients[0]!.config.region()).toBe('ap-northeast-1');
    for (const pkg of ['client-sns', 'client-sesv2', 'client-cloudwatch', 'client-cloudwatch-logs', 'client-budgets', 'client-cost-explorer',
      'client-cognito-identity', 'client-wafv2', 'client-route-53', 'client-acm', 'client-ec2']) {
      expect(awsSdkLoadReport().viaFactory).toContain(`@aws-sdk/${pkg}`);
    }
    aws.destroy();
  });
});

describe('withAwsRetry / isAwsTransient（探针与控制面只读调用）', () => {
  const err = (name: string, status?: number) => Object.assign(new Error(name), { name, ...(status ? { $metadata: { httpStatusCode: status } } : {}) });

  it('瞬时错误（超时、限流、5xx）重试；权限与不存在不重试', async () => {
    expect(isAwsTransient(err('ThrottlingException', 400))).toBe(true);
    expect(isAwsTransient(err('TimeoutError'))).toBe(true);
    expect(isAwsTransient(err('InternalFailure', 500))).toBe(true);
    expect(isAwsTransient(err('AccessDeniedException', 403))).toBe(false);
    expect(isAwsTransient(err('NotFoundException', 404))).toBe(false);

    let calls = 0;
    await expect(withAwsRetry(async () => {
      calls += 1;
      if (calls < 3) throw err('ThrottlingException', 400);
      return 'ok';
    }, { delaysMs: [0, 0] })).resolves.toBe('ok');
    expect(calls).toBe(3);

    calls = 0;
    await expect(withAwsRetry(async () => { calls += 1; throw err('AccessDeniedException', 403); }, { delaysMs: [0] })).rejects.toThrow('AccessDenied');
    expect(calls).toBe(1);
  });

  it('每次尝试有自己的超时', async () => {
    let calls = 0;
    await expect(withAwsRetry(() => { calls += 1; return new Promise(() => undefined); }, { attempts: 2, timeoutMs: 5, delaysMs: [0] }))
      .rejects.toThrow('超时');
    expect(calls).toBe(2);
  });
});
