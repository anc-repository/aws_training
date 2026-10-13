// adapters/aws/clients.ts：懒加载工厂（L0 拒绝创建客户端；有凭证时按需 import）+ aws-sdk-client-mock 的用法示例
import { HeadBucketCommand, S3Client } from '@aws-sdk/client-s3';
import { mockClient } from 'aws-sdk-client-mock';
import { afterEach, describe, expect, it } from 'vitest';
import { AwsCredentialsUnavailableError, awsSdkLoadReport, lazyAwsClients } from '../../src/adapters/aws/clients.js';

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
});
