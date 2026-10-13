/**
 * Production implementation of the reclaim cloud port (02 §7.1, §7.5, §7.6). Discovery (stacks, tags, inventory,
 * existence checks) uses the read-only permissions of the reaper function role; every delete runs as
 * `ATLProvisionerRole` with the role session name `atl-<sid>-reap-<n>` and a session policy generated from the ARN of the
 * item being deleted (02 §7.6). Deletes that cannot be narrowed to an ARN go to the manual list until the learner
 * confirms them (`meta.learnerConfirmed`). Types without a dedicated handler use the Cloud Control API.
 * Never used in tests or ATL_DEV_MODE (no AWS credentials there).
 */
import { TAG_KEYS } from '@atl/shared';
import type { PlatformEnv } from '../../../runtime/env.js';
import type { DeleteContext, ReclaimCloud, ResourceRef, StackResource, StackSummary, StepResult } from '../../lifecycle/cloud/port.js';
import { call, errText, isDenied, isDependency, isNotFound, isThrottled, paginate, type Credentials, type Service } from '../../lifecycle/cloud/sdk.js';
import { refFromArn } from './arn.js';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Json = Record<string, any>;

const DONE: StepResult = { status: 'DONE' };
const pending = (waitSeconds = 30): StepResult => ({ status: 'PENDING', waitSeconds });
const retry = (reason: string, waitSeconds = 30): StepResult => ({ status: 'RETRY', waitSeconds, reason });
const manual = (reason: string, severity: 'BLOCKING' | 'REVIEW' | 'INFO' = 'BLOCKING'): StepResult => ({ status: 'MANUAL', reason, severity });

const PROVISIONER_ROLE = 'ATLProvisionerRole';
const APP_ROLE = 'CloudAlbumAppRole';

interface Cx {
  ref: ResourceRef;
  ctx: DeleteContext;
  acct: string;
  /** read with the reaper function role */
  r: (svc: Service, cmd: string, input?: Json) => Promise<Json>;
  /** write as atl-<sid>-reap-<n> with the item's session policy */
  w: (svc: Service, cmd: string, input?: Json) => Promise<Json>;
}

interface Handler {
  /** ARNs the delete needs (session policy); null → only `Resource: "*"` works (manual unless confirmed) */
  arns(ref: ResourceRef, acct: string): string[] | null;
  /** extra statements, e.g. CloudFormation acting on the caller's behalf */
  calledVia?: string;
  exists(c: Cx): Promise<boolean>;
  delete(c: Cx): Promise<StepResult>;
  /** default: gone → DONE, else PENDING */
  poll?(c: Cx): Promise<StepResult>;
  hint?(ref: ResourceRef): { cli: string; console: string };
}

const ec2Arn = (kind: string) => (ref: ResourceRef, acct: string) => [ref.arn ?? `arn:aws:ec2:${ref.region}:${acct}:${kind}/${ref.id}`];
const swallowNotFound = async (p: Promise<unknown>): Promise<void> => {
  try {
    await p;
  } catch (e) {
    if (!isNotFound(e)) throw e;
  }
};
const existsBy = (f: (c: Cx) => Promise<boolean>) => async (c: Cx) => {
  try {
    return await f(c);
  } catch (e) {
    if (isNotFound(e)) return false;
    throw e;
  }
};

const H: Record<string, Handler> = {
  'AWS::CloudFormation::Stack': {
    arns: (ref, acct) => [ref.arn ?? `arn:aws:cloudformation:${ref.region}:${acct}:stack/${ref.id}/*`],
    calledVia: 'cloudformation.amazonaws.com',
    exists: existsBy(async (c) => {
      const st = (await c.r('cloudformation', 'DescribeStacks', { StackName: c.ref.id })).Stacks?.[0];
      return !!st && st.StackStatus !== 'DELETE_COMPLETE';
    }),
    async delete(c) {
      const st = (await c.r('cloudformation', 'DescribeStacks', { StackName: c.ref.id }).catch((e: unknown) => (isNotFound(e) || /does not exist/.test(errText(e)) ? { Stacks: [] } : Promise.reject(e)))).Stacks?.[0];
      if (!st || st.StackStatus === 'DELETE_COMPLETE') return DONE;
      if (st.StackStatus === 'DELETE_IN_PROGRESS') return pending(30);
      if (st.EnableTerminationProtection) await c.w('cloudformation', 'UpdateTerminationProtection', { StackName: c.ref.id, EnableTerminationProtection: false });
      await c.w('cloudformation', 'DeleteStack', { StackName: c.ref.id });
      return pending(30);
    },
    async poll(c) {
      const st = (await c.r('cloudformation', 'DescribeStacks', { StackName: c.ref.id }).catch((e: unknown) => (/does not exist/.test(errText(e)) ? { Stacks: [] } : Promise.reject(e)))).Stacks?.[0];
      if (!st || st.StackStatus === 'DELETE_COMPLETE') return DONE;
      if (st.StackStatus === 'DELETE_FAILED') {
        // the stack's own resources are separate ledger items of later stages; try again after them
        return c.ctx.attempt < 3 ? retry(`DELETE_FAILED: ${st.StackStatusReason ?? ''}`, 60) : manual(`stack DELETE_FAILED: ${st.StackStatusReason ?? ''}`);
      }
      return pending(30);
    },
    hint: (ref) => ({ cli: `aws cloudformation delete-stack --stack-name ${ref.id} --region ${ref.region}`, console: `https://${ref.region}.console.aws.amazon.com/cloudformation/home?region=${ref.region}#/stacks` }),
  },

  'AWS::EC2::Instance': {
    arns: ec2Arn('instance'),
    exists: existsBy(async (c) => {
      const i = (await c.r('ec2', 'DescribeInstances', { InstanceIds: [c.ref.id] })).Reservations?.[0]?.Instances?.[0];
      return !!i && i.State?.Name !== 'terminated';
    }),
    async delete(c) {
      await c.w('ec2', 'ModifyInstanceAttribute', { InstanceId: c.ref.id, DisableApiTermination: { Value: false } }).catch(() => undefined);
      await swallowNotFound(c.w('ec2', 'TerminateInstances', { InstanceIds: [c.ref.id] }));
      return pending(30);
    },
    hint: (ref) => ({ cli: `aws ec2 terminate-instances --instance-ids ${ref.id} --region ${ref.region}`, console: `https://${ref.region}.console.aws.amazon.com/ec2/home?region=${ref.region}#Instances:` }),
  },

  'AWS::EC2::Volume': simpleEc2('volume', 'DescribeVolumes', 'VolumeIds', 'Volumes', 'DeleteVolume', 'VolumeId'),
  'AWS::EC2::Snapshot': simpleEc2('snapshot', 'DescribeSnapshots', 'SnapshotIds', 'Snapshots', 'DeleteSnapshot', 'SnapshotId'),
  'AWS::EC2::SecurityGroup': simpleEc2('security-group', 'DescribeSecurityGroups', 'GroupIds', 'SecurityGroups', 'DeleteSecurityGroup', 'GroupId'),
  'AWS::EC2::Subnet': simpleEc2('subnet', 'DescribeSubnets', 'SubnetIds', 'Subnets', 'DeleteSubnet', 'SubnetId'),
  'AWS::EC2::VPC': simpleEc2('vpc', 'DescribeVpcs', 'VpcIds', 'Vpcs', 'DeleteVpc', 'VpcId'),
  'AWS::EC2::NetworkInterface': simpleEc2('network-interface', 'DescribeNetworkInterfaces', 'NetworkInterfaceIds', 'NetworkInterfaces', 'DeleteNetworkInterface', 'NetworkInterfaceId'),
  'AWS::EC2::LaunchTemplate': simpleEc2('launch-template', 'DescribeLaunchTemplates', 'LaunchTemplateIds', 'LaunchTemplates', 'DeleteLaunchTemplate', 'LaunchTemplateId'),
  'AWS::EC2::FlowLog': {
    arns: ec2Arn('vpc-flow-log'),
    exists: existsBy(async (c) => !!(await c.r('ec2', 'DescribeFlowLogs', { FlowLogIds: [c.ref.id] })).FlowLogs?.length),
    async delete(c) {
      await c.w('ec2', 'DeleteFlowLogs', { FlowLogIds: [c.ref.id] });
      return DONE;
    },
  },
  'AWS::EC2::Image': {
    arns: (ref, acct) => [ref.arn ?? `arn:aws:ec2:${ref.region}::image/${ref.id}`, `arn:aws:ec2:${ref.region}:${acct}:image/${ref.id}`],
    exists: existsBy(async (c) => !!(await c.r('ec2', 'DescribeImages', { ImageIds: [c.ref.id] })).Images?.length),
    async delete(c) {
      await swallowNotFound(c.w('ec2', 'DeregisterImage', { ImageId: c.ref.id }));
      return DONE; // its snapshots are DERIVED items of S4
    },
  },
  'AWS::EC2::KeyPair': {
    arns: ec2Arn('key-pair'),
    exists: existsBy(async (c) => !!(await c.r('ec2', 'DescribeKeyPairs', c.ref.id.startsWith('key-') ? { KeyPairIds: [c.ref.id] } : { KeyNames: [c.ref.id] })).KeyPairs?.length),
    async delete(c) {
      await swallowNotFound(c.w('ec2', 'DeleteKeyPair', c.ref.id.startsWith('key-') ? { KeyPairId: c.ref.id } : { KeyName: c.ref.id }));
      return DONE;
    },
  },
  'AWS::EC2::EIP': {
    arns: (ref, acct) => [ref.arn ?? `arn:aws:ec2:${ref.region}:${acct}:elastic-ip/${ref.id}`, `arn:aws:ec2:${ref.region}:${acct}:instance/*`, `arn:aws:ec2:${ref.region}:${acct}:network-interface/*`],
    exists: existsBy(async (c) => !!(await c.r('ec2', 'DescribeAddresses', c.ref.id.startsWith('eipalloc-') ? { AllocationIds: [c.ref.id] } : { PublicIps: [c.ref.id] })).Addresses?.length),
    async delete(c) {
      const a = (await c.r('ec2', 'DescribeAddresses', c.ref.id.startsWith('eipalloc-') ? { AllocationIds: [c.ref.id] } : { PublicIps: [c.ref.id] }).catch(() => ({ Addresses: [] }))).Addresses?.[0];
      if (!a) return DONE;
      if (a.AssociationId) await c.w('ec2', 'DisassociateAddress', { AssociationId: a.AssociationId });
      await c.w('ec2', 'ReleaseAddress', a.AllocationId ? { AllocationId: a.AllocationId } : { PublicIp: a.PublicIp });
      return DONE;
    },
  },
  'AWS::EC2::NatGateway': {
    arns: ec2Arn('natgateway'),
    exists: existsBy(async (c) => {
      const n = (await c.r('ec2', 'DescribeNatGateways', { NatGatewayIds: [c.ref.id] })).NatGateways?.[0];
      return !!n && n.State !== 'deleted';
    }),
    async delete(c) {
      await swallowNotFound(c.w('ec2', 'DeleteNatGateway', { NatGatewayId: c.ref.id }));
      return pending(30);
    },
  },
  'AWS::EC2::VPCEndpoint': {
    arns: ec2Arn('vpc-endpoint'),
    exists: existsBy(async (c) => {
      const v = (await c.r('ec2', 'DescribeVpcEndpoints', { VpcEndpointIds: [c.ref.id] })).VpcEndpoints?.[0];
      return !!v && !['deleted', 'Deleted'].includes(String(v.State));
    }),
    async delete(c) {
      await swallowNotFound(c.w('ec2', 'DeleteVpcEndpoints', { VpcEndpointIds: [c.ref.id] }));
      return pending(20);
    },
  },
  'AWS::EC2::InternetGateway': {
    arns: (ref, acct) => [...ec2Arn('internet-gateway')(ref, acct), `arn:aws:ec2:${ref.region}:${acct}:vpc/*`],
    exists: existsBy(async (c) => !!(await c.r('ec2', 'DescribeInternetGateways', { InternetGatewayIds: [c.ref.id] })).InternetGateways?.length),
    async delete(c) {
      const g = (await c.r('ec2', 'DescribeInternetGateways', { InternetGatewayIds: [c.ref.id] })).InternetGateways?.[0];
      for (const a of (g?.Attachments ?? []) as Json[]) await c.w('ec2', 'DetachInternetGateway', { InternetGatewayId: c.ref.id, VpcId: a.VpcId });
      await swallowNotFound(c.w('ec2', 'DeleteInternetGateway', { InternetGatewayId: c.ref.id }));
      return DONE;
    },
  },
  'AWS::EC2::RouteTable': {
    arns: (ref, acct) => [...ec2Arn('route-table')(ref, acct), `arn:aws:ec2:${ref.region}:${acct}:subnet/*`],
    exists: existsBy(async (c) => !!(await c.r('ec2', 'DescribeRouteTables', { RouteTableIds: [c.ref.id] })).RouteTables?.length),
    async delete(c) {
      const t = (await c.r('ec2', 'DescribeRouteTables', { RouteTableIds: [c.ref.id] })).RouteTables?.[0];
      if ((t?.Associations ?? []).some((a: Json) => a.Main)) return manual('main route table of a VPC: deleted with the VPC', 'INFO');
      for (const a of (t?.Associations ?? []) as Json[]) if (a.RouteTableAssociationId) await c.w('ec2', 'DisassociateRouteTable', { AssociationId: a.RouteTableAssociationId });
      await swallowNotFound(c.w('ec2', 'DeleteRouteTable', { RouteTableId: c.ref.id }));
      return DONE;
    },
  },

  'AWS::S3::Bucket': {
    arns: (ref) => [`arn:aws:s3:::${ref.id}`, `arn:aws:s3:::${ref.id}/*`],
    exists: existsBy(async (c) => {
      await c.r('s3', 'HeadBucket', { Bucket: c.ref.id });
      return true;
    }),
    delete: (c) => emptyAndDeleteBucket(c),
    poll: (c) => emptyAndDeleteBucket(c),
    hint: (ref) => ({ cli: `aws s3 rb s3://${ref.id} --force`, console: `https://s3.console.aws.amazon.com/s3/buckets/${ref.id}` }),
  },

  'AWS::Lambda::Function': {
    arns: (ref, acct) => [ref.arn ?? `arn:aws:lambda:${ref.region}:${acct}:function:${ref.id}`, `arn:aws:lambda:${ref.region}:${acct}:function:${ref.id}:*`],
    exists: existsBy(async (c) => !!(await c.r('lambda', 'GetFunctionConfiguration', { FunctionName: c.ref.id })).FunctionName),
    async delete(c) {
      await swallowNotFound(c.w('lambda', 'DeleteFunction', { FunctionName: c.ref.id }));
      return DONE;
    },
  },
  'AWS::Logs::LogGroup': {
    arns: (ref, acct) => [`arn:aws:logs:${ref.region}:${acct}:log-group:${ref.id}`, `arn:aws:logs:${ref.region}:${acct}:log-group:${ref.id}:*`],
    exists: existsBy(async (c) => ((await c.r('logs', 'DescribeLogGroups', { logGroupNamePrefix: c.ref.id })).logGroups ?? []).some((g: Json) => g.logGroupName === c.ref.id)),
    async delete(c) {
      await swallowNotFound(c.w('logs', 'DeleteLogGroup', { logGroupName: c.ref.id }));
      return DONE;
    },
  },
  'AWS::DynamoDB::Table': {
    arns: (ref, acct) => [ref.arn ?? `arn:aws:dynamodb:${ref.region}:${acct}:table/${ref.id}`],
    exists: existsBy(async (c) => !!(await c.r('dynamodb', 'DescribeTable', { TableName: c.ref.id })).Table),
    async delete(c) {
      const t = (await c.r('dynamodb', 'DescribeTable', { TableName: c.ref.id }).catch((e: unknown) => (isNotFound(e) ? ({} as Json) : Promise.reject(e)))).Table;
      if (!t) return DONE;
      if (t.TableStatus === 'DELETING') return pending(15);
      if (t.DeletionProtectionEnabled) await c.w('dynamodb', 'UpdateTable', { TableName: c.ref.id, DeletionProtectionEnabled: false });
      await c.w('dynamodb', 'DeleteTable', { TableName: c.ref.id });
      return pending(15);
    },
  },
  'AWS::SSM::Parameter': {
    arns: (ref, acct) => [`arn:aws:ssm:${ref.region}:${acct}:parameter${ref.id.startsWith('/') ? ref.id : `/${ref.id}`}`],
    exists: existsBy(async (c) => !!(await c.r('ssm', 'GetParameter', { Name: c.ref.id })).Parameter),
    async delete(c) {
      await swallowNotFound(c.w('ssm', 'DeleteParameter', { Name: c.ref.id }));
      return DONE;
    },
  },
  'AWS::SQS::Queue': {
    arns: (ref, acct) => [ref.arn ?? `arn:aws:sqs:${ref.region}:${acct}:${ref.id.split('/').pop()}`],
    exists: existsBy(async (c) => !!(await c.r('sqs', 'GetQueueAttributes', { QueueUrl: queueUrl(c), AttributeNames: ['QueueArn'] })).Attributes),
    async delete(c) {
      await swallowNotFound(c.w('sqs', 'DeleteQueue', { QueueUrl: queueUrl(c) }));
      return DONE;
    },
  },
  'AWS::SNS::Topic': {
    arns: (ref) => [ref.arn ?? ref.id],
    exists: existsBy(async (c) => !!(await c.r('sns', 'GetTopicAttributes', { TopicArn: c.ref.arn ?? c.ref.id })).Attributes),
    async delete(c) {
      await swallowNotFound(c.w('sns', 'DeleteTopic', { TopicArn: c.ref.arn ?? c.ref.id }));
      return DONE;
    },
  },
  'AWS::SecretsManager::Secret': {
    arns: (ref, acct) => [ref.arn ?? (ref.id.startsWith('arn:') ? ref.id : `arn:aws:secretsmanager:${ref.region}:${acct}:secret:${ref.id}-*`)],
    exists: existsBy(async (c) => {
      const d = await c.r('secretsmanager', 'DescribeSecret', { SecretId: c.ref.arn ?? c.ref.id });
      return !d.DeletedDate;
    }),
    async delete(c) {
      await swallowNotFound(c.w('secretsmanager', 'DeleteSecret', { SecretId: c.ref.arn ?? c.ref.id, ForceDeleteWithoutRecovery: true }));
      return DONE;
    },
  },
  'AWS::KMS::Key': {
    arns: (ref, acct) => [ref.arn ?? `arn:aws:kms:${ref.region}:${acct}:key/${ref.id}`],
    exists: existsBy(async (c) => {
      const k = (await c.r('kms', 'DescribeKey', { KeyId: c.ref.id })).KeyMetadata;
      return !!k && !['PendingDeletion', 'PendingReplicaDeletion'].includes(k.KeyState);
    }),
    async delete(c) {
      await c.w('kms', 'ScheduleKeyDeletion', { KeyId: c.ref.id, PendingWindowInDays: 7 });
      return DONE; // a key pending deletion is not billed
    },
  },
  'AWS::KMS::Alias': {
    arns: (ref, acct) => [`arn:aws:kms:${ref.region}:${acct}:${ref.id}`, `arn:aws:kms:${ref.region}:${acct}:key/*`],
    exists: existsBy(async (c) => ((await c.r('kms', 'ListAliases', {})).Aliases ?? []).some((a: Json) => a.AliasName === c.ref.id)),
    async delete(c) {
      await swallowNotFound(c.w('kms', 'DeleteAlias', { AliasName: c.ref.id }));
      return DONE;
    },
  },

  'AWS::RDS::DBInstance': {
    arns: (ref, acct) => [ref.arn ?? `arn:aws:rds:${ref.region}:${acct}:db:${ref.id}`],
    exists: existsBy(async (c) => !!(await c.r('rds', 'DescribeDBInstances', { DBInstanceIdentifier: c.ref.id })).DBInstances?.length),
    async delete(c) {
      const db = (await c.r('rds', 'DescribeDBInstances', { DBInstanceIdentifier: c.ref.id }).catch((e: unknown) => (isNotFound(e) ? ({} as Json) : Promise.reject(e)))).DBInstances?.[0];
      if (!db) return DONE;
      if (db.DBInstanceStatus === 'deleting') return pending(60);
      if (db.DeletionProtection) {
        try {
          await c.w('rds', 'ModifyDBInstance', { DBInstanceIdentifier: c.ref.id, DeletionProtection: false, ApplyImmediately: true });
        } catch (e) {
          if (isDenied(e)) return manual('deletion protection could not be disabled');
          throw e;
        }
      }
      await c.w('rds', 'DeleteDBInstance', { DBInstanceIdentifier: c.ref.id, SkipFinalSnapshot: true, DeleteAutomatedBackups: true });
      return pending(60);
    },
    hint: (ref) => ({ cli: `aws rds delete-db-instance --db-instance-identifier ${ref.id} --skip-final-snapshot --region ${ref.region}`, console: `https://${ref.region}.console.aws.amazon.com/rds/home?region=${ref.region}#databases:` }),
  },
  'AWS::RDS::DBCluster': {
    arns: (ref, acct) => [ref.arn ?? `arn:aws:rds:${ref.region}:${acct}:cluster:${ref.id}`],
    exists: existsBy(async (c) => !!(await c.r('rds', 'DescribeDBClusters', { DBClusterIdentifier: c.ref.id })).DBClusters?.length),
    async delete(c) {
      const cl = (await c.r('rds', 'DescribeDBClusters', { DBClusterIdentifier: c.ref.id }).catch((e: unknown) => (isNotFound(e) ? ({} as Json) : Promise.reject(e)))).DBClusters?.[0];
      if (!cl) return DONE;
      if (cl.Status === 'deleting') return pending(60);
      if ((cl.DBClusterMembers ?? []).length) return retry('cluster members are still being deleted', 60);
      if (cl.DeletionProtection) await c.w('rds', 'ModifyDBCluster', { DBClusterIdentifier: c.ref.id, DeletionProtection: false, ApplyImmediately: true });
      await c.w('rds', 'DeleteDBCluster', { DBClusterIdentifier: c.ref.id, SkipFinalSnapshot: true });
      return pending(60);
    },
  },
  'AWS::RDS::DBSnapshot': rdsSimple('snapshot', 'DescribeDBSnapshots', 'DBSnapshotIdentifier', 'DBSnapshots', 'DeleteDBSnapshot'),
  'AWS::RDS::DBClusterSnapshot': rdsSimple('cluster-snapshot', 'DescribeDBClusterSnapshots', 'DBClusterSnapshotIdentifier', 'DBClusterSnapshots', 'DeleteDBClusterSnapshot'),
  'AWS::RDS::DBSubnetGroup': rdsSimple('subgrp', 'DescribeDBSubnetGroups', 'DBSubnetGroupName', 'DBSubnetGroups', 'DeleteDBSubnetGroup'),
  'AWS::RDS::DBParameterGroup': rdsSimple('pg', 'DescribeDBParameterGroups', 'DBParameterGroupName', 'DBParameterGroups', 'DeleteDBParameterGroup'),

  'AWS::ElastiCache::ReplicationGroup': {
    arns: (ref, acct) => [ref.arn ?? `arn:aws:elasticache:${ref.region}:${acct}:replicationgroup:${ref.id}`, `arn:aws:elasticache:${ref.region}:${acct}:cluster:${ref.id}-*`],
    exists: existsBy(async (c) => !!(await c.r('elasticache', 'DescribeReplicationGroups', { ReplicationGroupId: c.ref.id })).ReplicationGroups?.length),
    async delete(c) {
      const g = (await c.r('elasticache', 'DescribeReplicationGroups', { ReplicationGroupId: c.ref.id }).catch((e: unknown) => (isNotFound(e) ? ({} as Json) : Promise.reject(e)))).ReplicationGroups?.[0];
      if (!g) return DONE;
      if (g.Status !== 'deleting') await c.w('elasticache', 'DeleteReplicationGroup', { ReplicationGroupId: c.ref.id, RetainPrimaryCluster: false });
      return pending(60);
    },
  },
  'AWS::ElastiCache::CacheCluster': {
    arns: (ref, acct) => [ref.arn ?? `arn:aws:elasticache:${ref.region}:${acct}:cluster:${ref.id}`],
    exists: existsBy(async (c) => !!(await c.r('elasticache', 'DescribeCacheClusters', { CacheClusterId: c.ref.id })).CacheClusters?.length),
    async delete(c) {
      const cl = (await c.r('elasticache', 'DescribeCacheClusters', { CacheClusterId: c.ref.id }).catch((e: unknown) => (isNotFound(e) ? ({} as Json) : Promise.reject(e)))).CacheClusters?.[0];
      if (!cl) return DONE;
      if (cl.ReplicationGroupId) return retry('member of a replication group (deleted with the group)', 60);
      if (cl.CacheClusterStatus !== 'deleting') await c.w('elasticache', 'DeleteCacheCluster', { CacheClusterId: c.ref.id });
      return pending(60);
    },
  },
  'AWS::ElastiCache::ServerlessCache': {
    arns: (ref, acct) => [ref.arn ?? `arn:aws:elasticache:${ref.region}:${acct}:serverlesscache:${ref.id}`],
    exists: existsBy(async (c) => !!(await c.r('elasticache', 'DescribeServerlessCaches', { ServerlessCacheName: c.ref.id })).ServerlessCaches?.length),
    async delete(c) {
      await swallowNotFound(c.w('elasticache', 'DeleteServerlessCache', { ServerlessCacheName: c.ref.id }));
      return pending(60);
    },
  },
  'AWS::EFS::FileSystem': {
    arns: (ref, acct) => [ref.arn ?? `arn:aws:elasticfilesystem:${ref.region}:${acct}:file-system/${ref.id}`],
    exists: existsBy(async (c) => !!(await c.r('efs', 'DescribeFileSystems', { FileSystemId: c.ref.id })).FileSystems?.length),
    async delete(c) {
      const mts = (await c.r('efs', 'DescribeMountTargets', { FileSystemId: c.ref.id }).catch(() => ({ MountTargets: [] }))).MountTargets ?? [];
      for (const mt of mts as Json[]) await c.w('efs', 'DeleteMountTarget', { MountTargetId: mt.MountTargetId }).catch(() => undefined);
      if (mts.length) return retry('mount targets are being deleted', 30);
      await swallowNotFound(c.w('efs', 'DeleteFileSystem', { FileSystemId: c.ref.id }));
      return pending(15);
    },
  },

  'AWS::ElasticLoadBalancingV2::LoadBalancer': {
    arns: (ref) => [ref.arn ?? ref.id],
    exists: existsBy(async (c) => !!(await c.r('elbv2', 'DescribeLoadBalancers', { LoadBalancerArns: [c.ref.arn ?? c.ref.id] })).LoadBalancers?.length),
    async delete(c) {
      const arn = c.ref.arn ?? c.ref.id;
      await c.w('elbv2', 'ModifyLoadBalancerAttributes', { LoadBalancerArn: arn, Attributes: [{ Key: 'deletion_protection.enabled', Value: 'false' }] }).catch(() => undefined);
      await swallowNotFound(c.w('elbv2', 'DeleteLoadBalancer', { LoadBalancerArn: arn }));
      return pending(15);
    },
  },
  'AWS::ElasticLoadBalancingV2::TargetGroup': {
    arns: (ref) => [ref.arn ?? ref.id],
    exists: existsBy(async (c) => !!(await c.r('elbv2', 'DescribeTargetGroups', { TargetGroupArns: [c.ref.arn ?? c.ref.id] })).TargetGroups?.length),
    async delete(c) {
      await swallowNotFound(c.w('elbv2', 'DeleteTargetGroup', { TargetGroupArn: c.ref.arn ?? c.ref.id }));
      return DONE;
    },
  },
  'AWS::ElasticLoadBalancingV2::Listener': {
    arns: (ref) => [ref.arn ?? ref.id],
    exists: existsBy(async (c) => !!(await c.r('elbv2', 'DescribeListeners', { ListenerArns: [c.ref.arn ?? c.ref.id] })).Listeners?.length),
    async delete(c) {
      await swallowNotFound(c.w('elbv2', 'DeleteListener', { ListenerArn: c.ref.arn ?? c.ref.id }));
      return DONE;
    },
  },
  'AWS::AutoScaling::AutoScalingGroup': {
    arns: (ref, acct) => [ref.arn ?? `arn:aws:autoscaling:${ref.region}:${acct}:autoScalingGroup:*:autoScalingGroupName/${ref.id}`],
    exists: existsBy(async (c) => !!(await c.r('autoscaling', 'DescribeAutoScalingGroups', { AutoScalingGroupNames: [c.ref.id] })).AutoScalingGroups?.length),
    async delete(c) {
      const g = (await c.r('autoscaling', 'DescribeAutoScalingGroups', { AutoScalingGroupNames: [c.ref.id] })).AutoScalingGroups?.[0];
      if (!g) return DONE;
      if (g.Status !== 'Delete in progress') await c.w('autoscaling', 'DeleteAutoScalingGroup', { AutoScalingGroupName: c.ref.id, ForceDelete: true });
      return pending(30);
    },
  },
  'AWS::CloudFront::Distribution': {
    arns: (ref, acct) => [ref.arn ?? `arn:aws:cloudfront::${acct}:distribution/${ref.id}`],
    exists: existsBy(async (c) => !!(await c.r('cloudfront', 'GetDistribution', { Id: c.ref.id })).Distribution),
    delete: (c) => disableAndDeleteDistribution(c),
    poll: (c) => disableAndDeleteDistribution(c),
  },
  'AWS::Events::Rule': {
    arns: (ref, acct) => {
      const [bus, name] = ref.id.includes('|') ? ref.id.split('|') : ['default', ref.id];
      return [ref.arn ?? (bus === 'default' ? `arn:aws:events:${ref.region}:${acct}:rule/${name}` : `arn:aws:events:${ref.region}:${acct}:rule/${bus}/${name}`)];
    },
    exists: existsBy(async (c) => !!(await c.r('eventbridge', 'DescribeRule', ruleId(c))).Name),
    async delete(c) {
      const id = ruleId(c);
      const targets = ((await c.r('eventbridge', 'ListTargetsByRule', { Rule: id.Name, EventBusName: id.EventBusName }).catch(() => ({ Targets: [] }))).Targets ?? []) as Json[];
      if (targets.length) await c.w('eventbridge', 'RemoveTargets', { Rule: id.Name, EventBusName: id.EventBusName, Ids: targets.map((t) => t.Id), Force: true });
      await swallowNotFound(c.w('eventbridge', 'DeleteRule', { ...id, Force: true }));
      return DONE;
    },
  },
  'AWS::Scheduler::Schedule': {
    arns: (ref, acct) => {
      const [group, name] = ref.id.includes('|') ? ref.id.split('|') : ['default', ref.id];
      return [ref.arn ?? `arn:aws:scheduler:${ref.region}:${acct}:schedule/${group}/${name}`];
    },
    exists: existsBy(async (c) => !!(await c.r('scheduler', 'GetSchedule', scheduleId(c))).Name),
    async delete(c) {
      await swallowNotFound(c.w('scheduler', 'DeleteSchedule', scheduleId(c)));
      return DONE;
    },
  },
  'AWS::StepFunctions::StateMachine': {
    arns: (ref) => [ref.arn ?? ref.id],
    exists: existsBy(async (c) => (await c.r('sfn', 'DescribeStateMachine', { stateMachineArn: c.ref.arn ?? c.ref.id })).status !== 'DELETING'),
    async delete(c) {
      await swallowNotFound(c.w('sfn', 'DeleteStateMachine', { stateMachineArn: c.ref.arn ?? c.ref.id }));
      return pending(10);
    },
  },
  'AWS::Cognito::UserPool': {
    arns: (ref, acct) => [ref.arn ?? `arn:aws:cognito-idp:${ref.region}:${acct}:userpool/${ref.id}`],
    exists: existsBy(async (c) => !!(await c.r('cognito', 'DescribeUserPool', { UserPoolId: c.ref.id })).UserPool),
    async delete(c) {
      const p = (await c.r('cognito', 'DescribeUserPool', { UserPoolId: c.ref.id }).catch((e: unknown) => (isNotFound(e) ? ({} as Json) : Promise.reject(e)))).UserPool;
      if (!p) return DONE;
      if (p.DeletionProtection === 'ACTIVE') return manual('user pool deletion protection is active');
      if (p.Domain) await c.w('cognito', 'DeleteUserPoolDomain', { UserPoolId: c.ref.id, Domain: p.Domain }).catch(() => undefined);
      if (p.CustomDomain) await c.w('cognito', 'DeleteUserPoolDomain', { UserPoolId: c.ref.id, Domain: p.CustomDomain }).catch(() => undefined);
      await c.w('cognito', 'DeleteUserPool', { UserPoolId: c.ref.id });
      return DONE;
    },
  },
  'AWS::CloudWatch::Alarm': {
    arns: (ref, acct) => [ref.arn ?? `arn:aws:cloudwatch:${ref.region}:${acct}:alarm:${ref.id}`],
    exists: existsBy(async (c) => !!(await c.r('cloudwatch', 'DescribeAlarms', { AlarmNames: [c.ref.id] })).MetricAlarms?.length),
    async delete(c) {
      await c.w('cloudwatch', 'DeleteAlarms', { AlarmNames: [c.ref.id] });
      return DONE;
    },
  },

  'AWS::IAM::Role': {
    arns: (ref, acct) => [ref.arn ?? `arn:aws:iam::${acct}:role/${ref.id}`, `arn:aws:iam::${acct}:instance-profile/*`],
    exists: existsBy(async (c) => !!(await c.r('iam', 'GetRole', { RoleName: c.ref.id })).Role),
    async delete(c) {
      const name = c.ref.id;
      for await (const p of paginate('iam', 'us-east-1', 'ListAttachedRolePolicies', { RoleName: name }, { tokenIn: 'Marker', tokenOut: 'Marker' })) {
        for (const a of (p.AttachedPolicies ?? []) as Json[]) await c.w('iam', 'DetachRolePolicy', { RoleName: name, PolicyArn: a.PolicyArn });
      }
      for await (const p of paginate('iam', 'us-east-1', 'ListRolePolicies', { RoleName: name }, { tokenIn: 'Marker', tokenOut: 'Marker' })) {
        for (const n of (p.PolicyNames ?? []) as string[]) await c.w('iam', 'DeleteRolePolicy', { RoleName: name, PolicyName: n });
      }
      for await (const p of paginate('iam', 'us-east-1', 'ListInstanceProfilesForRole', { RoleName: name }, { tokenIn: 'Marker', tokenOut: 'Marker' })) {
        for (const ip of (p.InstanceProfiles ?? []) as Json[]) await c.w('iam', 'RemoveRoleFromInstanceProfile', { RoleName: name, InstanceProfileName: ip.InstanceProfileName });
      }
      await c.w('iam', 'DeleteRolePermissionsBoundary', { RoleName: name }).catch(() => undefined);
      await swallowNotFound(c.w('iam', 'DeleteRole', { RoleName: name }));
      return DONE;
    },
  },
  'AWS::IAM::InstanceProfile': {
    arns: (ref, acct) => [ref.arn ?? `arn:aws:iam::${acct}:instance-profile/${ref.id}`, `arn:aws:iam::${acct}:role/*`],
    exists: existsBy(async (c) => !!(await c.r('iam', 'GetInstanceProfile', { InstanceProfileName: c.ref.id })).InstanceProfile),
    async delete(c) {
      const ip = (await c.r('iam', 'GetInstanceProfile', { InstanceProfileName: c.ref.id }).catch((e: unknown) => (isNotFound(e) ? ({} as Json) : Promise.reject(e)))).InstanceProfile;
      if (!ip) return DONE;
      for (const role of (ip.Roles ?? []) as Json[]) await c.w('iam', 'RemoveRoleFromInstanceProfile', { InstanceProfileName: c.ref.id, RoleName: role.RoleName });
      await c.w('iam', 'DeleteInstanceProfile', { InstanceProfileName: c.ref.id });
      return DONE;
    },
  },
  'AWS::IAM::ManagedPolicy': {
    arns: (ref, acct) => [ref.arn ?? (ref.id.startsWith('arn:') ? ref.id : `arn:aws:iam::${acct}:policy/${ref.id}`), `arn:aws:iam::${acct}:role/*`, `arn:aws:iam::${acct}:user/*`, `arn:aws:iam::${acct}:group/*`],
    exists: existsBy(async (c) => !!(await c.r('iam', 'GetPolicy', { PolicyArn: policyArn(c) })).Policy),
    async delete(c) {
      const arn = policyArn(c);
      for await (const p of paginate('iam', 'us-east-1', 'ListEntitiesForPolicy', { PolicyArn: arn }, { tokenIn: 'Marker', tokenOut: 'Marker' })) {
        for (const r of (p.PolicyRoles ?? []) as Json[]) {
          if (r.RoleName === APP_ROLE && !c.ctx.ownsSharedObjects) return retry('attached to CloudAlbumAppRole of another environment (S6 resets it)', 60);
          await c.w('iam', 'DetachRolePolicy', { RoleName: r.RoleName, PolicyArn: arn });
        }
        for (const u of (p.PolicyUsers ?? []) as Json[]) await c.w('iam', 'DetachUserPolicy', { UserName: u.UserName, PolicyArn: arn });
        for (const g of (p.PolicyGroups ?? []) as Json[]) await c.w('iam', 'DetachGroupPolicy', { GroupName: g.GroupName, PolicyArn: arn });
      }
      const versions = ((await c.r('iam', 'ListPolicyVersions', { PolicyArn: arn })).Versions ?? []) as Json[];
      for (const v of versions) if (!v.IsDefaultVersion) await c.w('iam', 'DeletePolicyVersion', { PolicyArn: arn, VersionId: v.VersionId });
      await swallowNotFound(c.w('iam', 'DeletePolicy', { PolicyArn: arn }));
      return DONE;
    },
  },
  'AWS::IAM::User': {
    arns: (ref, acct) => [ref.arn ?? `arn:aws:iam::${acct}:user/${ref.id}`, `arn:aws:iam::${acct}:group/*`],
    exists: existsBy(async (c) => !!(await c.r('iam', 'GetUser', { UserName: c.ref.id })).User),
    async delete(c) {
      const u = c.ref.id;
      for (const k of ((await c.r('iam', 'ListAccessKeys', { UserName: u })).AccessKeyMetadata ?? []) as Json[]) await c.w('iam', 'DeleteAccessKey', { UserName: u, AccessKeyId: k.AccessKeyId });
      await c.w('iam', 'DeleteLoginProfile', { UserName: u }).catch(() => undefined);
      for (const a of ((await c.r('iam', 'ListAttachedUserPolicies', { UserName: u })).AttachedPolicies ?? []) as Json[]) await c.w('iam', 'DetachUserPolicy', { UserName: u, PolicyArn: a.PolicyArn });
      for (const n of ((await c.r('iam', 'ListUserPolicies', { UserName: u })).PolicyNames ?? []) as string[]) await c.w('iam', 'DeleteUserPolicy', { UserName: u, PolicyName: n });
      for (const g of ((await c.r('iam', 'ListGroupsForUser', { UserName: u })).Groups ?? []) as Json[]) await c.w('iam', 'RemoveUserFromGroup', { UserName: u, GroupName: g.GroupName });
      for (const d of ((await c.r('iam', 'ListMFADevices', { UserName: u })).MFADevices ?? []) as Json[]) await c.w('iam', 'DeactivateMFADevice', { UserName: u, SerialNumber: d.SerialNumber });
      await swallowNotFound(c.w('iam', 'DeleteUser', { UserName: u }));
      return DONE;
    },
  },

  // S6 resets (pseudo types)
  'ATL::IAM::AppRoleReset': {
    arns: (_ref, acct) => [`arn:aws:iam::${acct}:role/${APP_ROLE}`],
    exists: async () => true,
    async delete(c) {
      // own lock (or free lock) → remove every cloudalbum-* attachment / inline policy; otherwise only this ledger's
      const own = c.ctx.ownsSharedObjects;
      const ledger = new Set(c.ctx.policyArns);
      for await (const p of paginate('iam', 'us-east-1', 'ListAttachedRolePolicies', { RoleName: APP_ROLE }, { tokenIn: 'Marker', tokenOut: 'Marker' })) {
        for (const a of (p.AttachedPolicies ?? []) as Json[]) {
          if (ledger.has(a.PolicyArn) || (own && /:policy\/cloudalbum-/.test(String(a.PolicyArn)))) await swallowNotFound(c.w('iam', 'DetachRolePolicy', { RoleName: APP_ROLE, PolicyArn: a.PolicyArn }));
        }
      }
      if (own) {
        for await (const p of paginate('iam', 'us-east-1', 'ListRolePolicies', { RoleName: APP_ROLE }, { tokenIn: 'Marker', tokenOut: 'Marker' })) {
          for (const n of (p.PolicyNames ?? []) as string[]) if (/^cloudalbum-/.test(n)) await c.w('iam', 'DeleteRolePolicy', { RoleName: APP_ROLE, PolicyName: n });
        }
      }
      return DONE;
    },
  },
  'ATL::SSM::DocumentDefaultVersion': {
    arns: (ref, acct) => [`arn:aws:ssm:${ref.region}:${acct}:document/${ref.id}`],
    exists: async () => true,
    async delete(c) {
      const v = c.ctx.meta.defaultVersion;
      if (typeof v !== 'string' && typeof v !== 'number') return DONE;
      await swallowNotFound(c.w('ssm', 'UpdateDocumentDefaultVersion', { Name: c.ref.id, DocumentVersion: String(v) }));
      return DONE;
    },
  },
};

function simpleEc2(kind: string, describe: string, idsField: string, listField: string, del: string, idField: string): Handler {
  return {
    arns: ec2Arn(kind),
    exists: existsBy(async (c) => {
      const items = ((await c.r('ec2', describe, { [idsField]: [c.ref.id] }))[listField] ?? []) as Json[];
      return items.some((i) => !['deleted', 'deleting'].includes(String(i.State ?? i.state ?? '')));
    }),
    async delete(c) {
      await swallowNotFound(c.w('ec2', del, { [idField]: c.ref.id }));
      return DONE;
    },
  };
}

function rdsSimple(kind: string, describe: string, idField: string, listField: string, del: string): Handler {
  return {
    arns: (ref, acct) => [ref.arn ?? `arn:aws:rds:${ref.region}:${acct}:${kind}:${ref.id}`],
    exists: existsBy(async (c) => !!((await c.r('rds', describe, { [idField]: c.ref.id }))[listField] ?? []).length),
    async delete(c) {
      await swallowNotFound(c.w('rds', del, { [idField]: c.ref.id }));
      return DONE;
    },
  };
}

function queueUrl(c: Cx): string {
  if (c.ref.id.startsWith('https://')) return c.ref.id;
  return `https://sqs.${c.ref.region}.amazonaws.com/${c.acct}/${c.ref.id}`;
}

function ruleId(c: Cx): { Name: string; EventBusName: string } {
  const [bus, name] = c.ref.id.includes('|') ? (c.ref.id.split('|') as [string, string]) : ['default', c.ref.id];
  return { Name: name, EventBusName: bus };
}

function scheduleId(c: Cx): { Name: string; GroupName: string } {
  const [group, name] = c.ref.id.includes('|') ? (c.ref.id.split('|') as [string, string]) : ['default', c.ref.id];
  return { Name: name, GroupName: group };
}

function policyArn(c: Cx): string {
  return c.ref.arn ?? (c.ref.id.startsWith('arn:') ? c.ref.id : `arn:aws:iam::${c.acct}:policy/${c.ref.id}`);
}

/** Empties a bucket (all versions and delete markers) in bounded batches, then deletes it. */
async function emptyAndDeleteBucket(c: Cx): Promise<StepResult> {
  const bucket = c.ref.id;
  let batches = 0;
  for (;;) {
    let out: Json;
    try {
      out = await c.w('s3', 'ListObjectVersions', { Bucket: bucket, MaxKeys: 1000 });
    } catch (e) {
      if (isNotFound(e)) return DONE;
      throw e;
    }
    const objects = [...((out.Versions ?? []) as Json[]), ...((out.DeleteMarkers ?? []) as Json[])].map((v) => ({ Key: v.Key, VersionId: v.VersionId }));
    if (!objects.length) break;
    await c.w('s3', 'DeleteObjects', { Bucket: bucket, Delete: { Objects: objects, Quiet: true } });
    if (++batches >= 20) return pending(5); // continue on the next poll (20 000 objects per call)
  }
  try {
    await c.w('s3', 'DeleteBucket', { Bucket: bucket });
  } catch (e) {
    if (isNotFound(e)) return DONE;
    if (/BucketNotEmpty/.test(errText(e))) return pending(5);
    throw e;
  }
  return DONE;
}

async function disableAndDeleteDistribution(c: Cx): Promise<StepResult> {
  let d: Json;
  try {
    d = await c.r('cloudfront', 'GetDistribution', { Id: c.ref.id });
  } catch (e) {
    if (isNotFound(e)) return DONE;
    throw e;
  }
  const dist = d.Distribution as Json;
  if (dist.DistributionConfig?.Enabled) {
    const cfg = await c.r('cloudfront', 'GetDistributionConfig', { Id: c.ref.id });
    await c.w('cloudfront', 'UpdateDistribution', { Id: c.ref.id, IfMatch: cfg.ETag, DistributionConfig: { ...cfg.DistributionConfig, Enabled: false } });
    return pending(120);
  }
  if (dist.Status !== 'Deployed') return pending(120);
  await c.w('cloudfront', 'DeleteDistribution', { Id: c.ref.id, IfMatch: d.ETag });
  return DONE;
}

/** Cloud Control fallback for types without a dedicated handler. */
const CLOUD_CONTROL: Handler = {
  arns: (ref) => (ref.arn ? [ref.arn, `${ref.arn}/*`] : null),
  calledVia: 'cloudformation.amazonaws.com',
  exists: existsBy(async (c) => !!(await c.r('cloudcontrol', 'GetResource', { TypeName: c.ref.type, Identifier: c.ref.id })).ResourceDescription),
  async delete(c) {
    try {
      await c.w('cloudcontrol', 'DeleteResource', { TypeName: c.ref.type, Identifier: c.ref.id });
    } catch (e) {
      if (isNotFound(e)) return DONE;
      if (/UnsupportedActionException|TypeNotFoundException/.test(errText(e))) return manual(`${c.ref.type} cannot be deleted through Cloud Control`, 'REVIEW');
      throw e;
    }
    return pending(30);
  },
};

function handlerFor(type: string): Handler {
  return H[type] ?? CLOUD_CONTROL;
}

/** Session policy of one delete (02 §7.6): the item's ARNs (+ CloudFormation acting for the caller when it needs to). */
export function deleteSessionPolicy(arns: string[], calledVia?: string): string {
  const statements: Json[] = [{ Sid: 'ReapItem', Effect: 'Allow', Action: '*', Resource: arns }];
  if (calledVia) {
    statements.push({ Sid: 'ReapViaService', Effect: 'Allow', Action: '*', Resource: '*', Condition: { 'ForAnyValue:StringEquals': { 'aws:CalledVia': [calledVia] } } });
    statements.push({ Sid: 'ReapControl', Effect: 'Allow', Action: ['cloudformation:DeleteResource', 'cloudformation:GetResource', 'cloudformation:GetResourceRequestStatus'], Resource: '*' });
  }
  return JSON.stringify({ Version: '2012-10-17', Statement: statements });
}

export class AwsReclaimCloud implements ReclaimCloud {
  private readonly creds = new Map<string, Credentials>();

  constructor(private readonly env: PlatformEnv) {}

  private async assume(ctx: DeleteContext, policy: string): Promise<Credentials> {
    const key = `${ctx.roleSessionName}|${policy}`;
    const cached = this.creds.get(key);
    if (cached?.expiration && cached.expiration.getTime() - Date.now() > 120_000) return cached;
    const out = await call('sts', this.env.region, 'AssumeRole', {
      RoleArn: `arn:aws:iam::${this.env.accountId}:role/${PROVISIONER_ROLE}`,
      RoleSessionName: ctx.roleSessionName,
      Policy: policy,
      DurationSeconds: 900,
    });
    const c = out.Credentials as { AccessKeyId: string; SecretAccessKey: string; SessionToken: string; Expiration: Date };
    const creds: Credentials = { accessKeyId: c.AccessKeyId, secretAccessKey: c.SecretAccessKey, sessionToken: c.SessionToken, expiration: new Date(c.Expiration) };
    if (this.creds.size > 32) this.creds.clear();
    this.creds.set(key, creds);
    return creds;
  }

  private regionOf(ref: ResourceRef): string {
    return /^AWS::(IAM|CloudFront)::/.test(ref.type) || ref.type.startsWith('ATL::IAM::') ? 'us-east-1' : ref.region;
  }

  private async cx(ref: ResourceRef, ctx: DeleteContext, h: Handler): Promise<Cx | StepResult> {
    const acct = this.env.accountId;
    const region = this.regionOf(ref);
    const arns = h.arns(ref, acct);
    let policyArns = arns;
    if (!policyArns) {
      if (ctx.meta.learnerConfirmed !== true) return manual('the delete cannot be narrowed to an ARN: confirm it in the manual list first', 'REVIEW');
      policyArns = ['*'];
    }
    const policy = deleteSessionPolicy(policyArns, h.calledVia);
    let creds: Credentials | null = null;
    return {
      ref: { ...ref, region },
      ctx,
      acct,
      r: (svc, cmd, input = {}) => call(svc, region, cmd, input),
      w: async (svc, cmd, input = {}) => {
        creds ??= await this.assume(ctx, policy);
        return call(svc, region, cmd, input, creds);
      },
    };
  }

  private async run(ref: ResourceRef, ctx: DeleteContext, step: 'delete' | 'poll'): Promise<StepResult> {
    const h = handlerFor(ref.type);
    const cx = await this.cx(ref, ctx, h);
    if ('status' in cx) return cx;
    try {
      if (step === 'delete') return await h.delete(cx);
      if (h.poll) return await h.poll(cx);
      return (await h.exists(cx)) ? pending(30) : DONE;
    } catch (e) {
      if (isNotFound(e)) return DONE;
      if (isThrottled(e)) return retry(errText(e), 30);
      if (isDependency(e)) return retry(errText(e), 30);
      if (isDenied(e)) return manual(errText(e), 'BLOCKING');
      throw e;
    }
  }

  delete(ref: ResourceRef, ctx: DeleteContext): Promise<StepResult> {
    return this.run(ref, ctx, 'delete');
  }

  poll(ref: ResourceRef, ctx: DeleteContext): Promise<StepResult> {
    return this.run(ref, ctx, 'poll');
  }

  async exists(ref: ResourceRef): Promise<boolean> {
    if (ref.type.startsWith('ATL::')) return true;
    const h = handlerFor(ref.type);
    const region = this.regionOf(ref);
    const cx: Cx = {
      ref: { ...ref, region },
      ctx: { sessionId: '', roleSessionName: '', attempt: 0, ownsSharedObjects: false, policyArns: [], meta: {} },
      acct: this.env.accountId,
      r: (svc, cmd, input = {}) => call(svc, region, cmd, input),
      w: () => Promise.reject(new Error('exists() is read-only')),
    };
    return h.exists(cx);
  }

  async listEnvStacks(q: { envId: string; envName: string; sessionIds: string[]; regions: string[] }): Promise<StackSummary[]> {
    const out: StackSummary[] = [];
    const wsNames = new Set(q.sessionIds.map((sid) => `atl-ws-${sid}`));
    for (const region of q.regions) {
      for await (const page of paginate('cloudformation', region, 'DescribeStacks', {})) {
        for (const st of (page.Stacks ?? []) as Json[]) {
          const tags = Object.fromEntries(((st.Tags ?? []) as { Key: string; Value: string }[]).map((t) => [t.Key, t.Value]));
          const name = String(st.StackName);
          if (name.startsWith(`cloudalbum-${q.envName}-`) || wsNames.has(name) || tags[TAG_KEYS.envId] === q.envId) {
            out.push({ name, region, status: String(st.StackStatus), tags });
          }
        }
      }
    }
    return out;
  }

  async listStackResources(q: { stackName: string; region: string }): Promise<StackResource[]> {
    const out: StackResource[] = [];
    for await (const page of paginate('cloudformation', q.region, 'ListStackResources', { StackName: q.stackName })) {
      for (const r of (page.StackResourceSummaries ?? []) as Json[]) {
        out.push({ logicalId: r.LogicalResourceId, physicalId: r.PhysicalResourceId ?? '', type: r.ResourceType, status: r.ResourceStatus });
      }
    }
    return out;
  }

  async taggedResources(q: { region: string; key: string; value: string }): Promise<{ arn: string; type: string | null }[]> {
    const out: { arn: string; type: string | null }[] = [];
    for await (const page of paginate('tagging', q.region, 'GetResources', { TagFilters: [{ Key: q.key, Values: [q.value] }], ResourcesPerPage: 100 }, { tokenIn: 'PaginationToken', tokenOut: 'PaginationToken' })) {
      for (const m of (page.ResourceTagMappingList ?? []) as Json[]) out.push({ arn: m.ResourceARN, type: refFromArn(m.ResourceARN, q.region)?.type ?? null });
    }
    // blind spots of the Tagging API (7.1): Auto Scaling groups per region, IAM roles once (home region)
    for await (const page of paginate('autoscaling', q.region, 'DescribeAutoScalingGroups', { Filters: [{ Name: `tag:${q.key}`, Values: [q.value] }] })) {
      for (const g of (page.AutoScalingGroups ?? []) as Json[]) out.push({ arn: g.AutoScalingGroupARN, type: 'AWS::AutoScaling::AutoScalingGroup' });
    }
    if (q.region === this.env.region) {
      for await (const page of paginate('iam', 'us-east-1', 'ListRoles', {}, { tokenIn: 'Marker', tokenOut: 'Marker' })) {
        for (const role of (page.Roles ?? []) as Json[]) {
          const name = String(role.RoleName);
          if (!/^cloudalbum-/i.test(name)) continue; // CloudAlbum stacks name their roles cloudalbum-<env>-*
          const tags = ((await call('iam', 'us-east-1', 'ListRoleTags', { RoleName: name })).Tags ?? []) as { Key: string; Value: string }[];
          if (tags.some((t) => t.Key === q.key && t.Value === q.value)) out.push({ arn: role.Arn, type: 'AWS::IAM::Role' });
        }
      }
    }
    return out;
  }

  /** Hourly-billed resources currently in the region (7.1 INVENTORY). */
  async inventory(q: { region: string }): Promise<{ type: string; id: string; arn?: string | null }[]> {
    const out: { type: string; id: string; arn?: string | null }[] = [];
    const safe = async (f: () => Promise<void>) => {
      try {
        await f();
      } catch (e) {
        if (!isDenied(e) && !/OptInRequired|not available|Unsupported|UnrecognizedClient/i.test(errText(e))) throw e;
      }
    };
    await safe(async () => {
      for await (const p of paginate('ec2', q.region, 'DescribeInstances', { Filters: [{ Name: 'instance-state-name', Values: ['pending', 'running', 'stopping', 'stopped'] }] })) {
        for (const r of (p.Reservations ?? []) as Json[]) for (const i of (r.Instances ?? []) as Json[]) out.push({ type: 'AWS::EC2::Instance', id: i.InstanceId });
      }
    });
    await safe(async () => {
      for await (const p of paginate('ec2', q.region, 'DescribeNatGateways', { Filter: [{ Name: 'state', Values: ['pending', 'available'] }] })) {
        for (const n of (p.NatGateways ?? []) as Json[]) out.push({ type: 'AWS::EC2::NatGateway', id: n.NatGatewayId });
      }
    });
    await safe(async () => {
      for (const a of ((await call('ec2', q.region, 'DescribeAddresses', {})).Addresses ?? []) as Json[]) out.push({ type: 'AWS::EC2::EIP', id: a.AllocationId ?? a.PublicIp });
    });
    await safe(async () => {
      for await (const p of paginate('ec2', q.region, 'DescribeVpcEndpoints', { Filters: [{ Name: 'vpc-endpoint-type', Values: ['Interface', 'GatewayLoadBalancer'] }] })) {
        for (const v of (p.VpcEndpoints ?? []) as Json[]) if (!['deleted', 'deleting'].includes(String(v.State).toLowerCase())) out.push({ type: 'AWS::EC2::VPCEndpoint', id: v.VpcEndpointId });
      }
    });
    await safe(async () => {
      for await (const p of paginate('elbv2', q.region, 'DescribeLoadBalancers', {}, { tokenIn: 'Marker', tokenOut: 'NextMarker' })) {
        for (const lb of (p.LoadBalancers ?? []) as Json[]) out.push({ type: 'AWS::ElasticLoadBalancingV2::LoadBalancer', id: lb.LoadBalancerArn, arn: lb.LoadBalancerArn });
      }
    });
    await safe(async () => {
      for await (const p of paginate('rds', q.region, 'DescribeDBInstances', {}, { tokenIn: 'Marker', tokenOut: 'Marker' })) {
        for (const db of (p.DBInstances ?? []) as Json[]) out.push({ type: 'AWS::RDS::DBInstance', id: db.DBInstanceIdentifier, arn: db.DBInstanceArn });
      }
      for await (const p of paginate('rds', q.region, 'DescribeDBClusters', {}, { tokenIn: 'Marker', tokenOut: 'Marker' })) {
        for (const cl of (p.DBClusters ?? []) as Json[]) out.push({ type: 'AWS::RDS::DBCluster', id: cl.DBClusterIdentifier, arn: cl.DBClusterArn });
      }
    });
    await safe(async () => {
      for await (const p of paginate('elasticache', q.region, 'DescribeReplicationGroups', {}, { tokenIn: 'Marker', tokenOut: 'Marker' })) {
        for (const g of (p.ReplicationGroups ?? []) as Json[]) out.push({ type: 'AWS::ElastiCache::ReplicationGroup', id: g.ReplicationGroupId, arn: g.ARN });
      }
      for await (const p of paginate('elasticache', q.region, 'DescribeServerlessCaches', {})) {
        for (const s of (p.ServerlessCaches ?? []) as Json[]) out.push({ type: 'AWS::ElastiCache::ServerlessCache', id: s.ServerlessCacheName, arn: s.ARN });
      }
    });
    await safe(async () => {
      for await (const p of paginate('autoscaling', q.region, 'DescribeAutoScalingGroups', {})) {
        for (const g of (p.AutoScalingGroups ?? []) as Json[]) out.push({ type: 'AWS::AutoScaling::AutoScalingGroup', id: g.AutoScalingGroupName, arn: g.AutoScalingGroupARN });
      }
    });
    return out;
  }

  manualHint(ref: ResourceRef): { consoleUrl: string; cli: string; note?: string } {
    const h = H[ref.type]?.hint?.(ref);
    if (h) return { consoleUrl: h.console, cli: h.cli };
    return {
      consoleUrl: `https://${ref.region}.console.aws.amazon.com/cloudcontrolapi/home?region=${ref.region}`,
      cli: `aws cloudcontrol delete-resource --type-name ${ref.type} --identifier '${ref.id}' --region ${ref.region}`,
      note: 'generic Cloud Control command; the service console may offer a more specific way',
    };
  }
}
