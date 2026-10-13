// adapters/aws/clients.ts 的辅助：错误分类、loadAwsPackage 登记、describeDbInstance（只读控制面查询）
import { DescribeDBInstancesCommand, RDSClient } from '@aws-sdk/client-rds';
import { mockClient } from 'aws-sdk-client-mock';
import { afterEach, describe, expect, it } from 'vitest';
import {
  awsErrorName, awsHttpStatus, awsSdkLoadReport, describeAwsError, describeDbInstance, isAwsAccessDenied, isAwsNotFound,
  lazyAwsClients, loadAwsPackage,
} from '../../../src/adapters/aws/clients.js';
import { awsError, fakeCredentials } from './helpers.js';

const rds = mockClient(RDSClient);
afterEach(() => rds.reset());

describe('AWS 错误分类', () => {
  it('按 name 与 HTTP 状态识别“不存在”与“无权限”', () => {
    expect(isAwsNotFound(awsError('NoSuchKey', 404))).toBe(true);
    expect(isAwsNotFound(awsError('AWS.SimpleQueueService.NonExistentQueue', 400))).toBe(true);
    expect(isAwsNotFound(awsError('Whatever', 404))).toBe(true);
    expect(isAwsNotFound(awsError('Throttling', 400))).toBe(false);
    expect(isAwsAccessDenied(awsError('AccessDeniedException', 400))).toBe(true);
    expect(isAwsAccessDenied(awsError('Forbidden', 403))).toBe(true);
    expect(isAwsAccessDenied(new Error('x'))).toBe(false);
    expect(awsErrorName(null)).toBe('Error');
    expect(awsHttpStatus(awsError('X', 503))).toBe(503);
    expect(describeAwsError(awsError('AccessDenied', 403, 'not authorized'))).toBe('AccessDenied（HTTP 403）：not authorized');
  });
});

describe('loadAwsPackage', () => {
  it('动态加载的包记入 awsSdkLoadReport().viaFactory', async () => {
    await loadAwsPackage('@aws-sdk/s3-request-presigner', () => import('@aws-sdk/s3-request-presigner'));
    expect(awsSdkLoadReport().viaFactory).toContain('@aws-sdk/s3-request-presigner');
  });
});

describe('describeDbInstance', () => {
  it('返回与 SDK 无关的摘要；不存在返回 null；其他错误照常抛出；无凭证时拒绝', async () => {
    const aws = lazyAwsClients({ region: 'ap-northeast-1', credentials: fakeCredentials });
    rds.on(DescribeDBInstancesCommand).resolvesOnce({ DBInstances: [{
      DBInstanceIdentifier: 'db1', DBInstanceStatus: 'available', MultiAZ: false, PendingModifiedValues: { MultiAZ: true, PendingCloudwatchLogsExports: undefined },
    }] }).rejectsOnce(awsError('DBInstanceNotFound', 404)).rejects(awsError('Throttling', 400));
    expect(await describeDbInstance(aws, 'db1')).toEqual({ id: 'db1', status: 'available', multiAz: false, pendingModified: ['MultiAZ'], readReplicaIds: [] });
    expect(await describeDbInstance(aws, 'db1')).toBeNull();
    await expect(describeDbInstance(aws, 'db1')).rejects.toMatchObject({ name: 'Throttling' });
    await expect(describeDbInstance(lazyAwsClients({ region: 'ap-northeast-1', credentials: null }), 'db1')).rejects.toMatchObject({ code: 'AWS_CREDENTIALS_UNAVAILABLE' });
    aws.destroy();
  });
});
