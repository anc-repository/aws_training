/**
 * Production ports of atl-custom-resources (AWS SDK v3 shipped with the Lambda nodejs22.x runtime; @aws-sdk/* stays external
 * in the bundle). Clients that are not dependencies of this repository (Preflight's GuardDuty, Config, Inspector, Access
 * Analyzer, SES, Organizations, Service Quotas) are loaded with a dynamic import of a computed name, so type checking and
 * bundling do not need them; a missing client only turns the corresponding Preflight item into `unknown`.
 */
import { CloudFormationClient, ListStacksCommand, SetStackPolicyCommand, UpdateTerminationProtectionCommand } from '@aws-sdk/client-cloudformation';
import { CloudFrontClient, CreateInvalidationCommand } from '@aws-sdk/client-cloudfront';
import { CloudTrailClient, DescribeTrailsCommand } from '@aws-sdk/client-cloudtrail';
import {
  AdminAddUserToGroupCommand,
  AdminCreateUserCommand,
  AdminGetUserCommand,
  CognitoIdentityProviderClient,
} from '@aws-sdk/client-cognito-identity-provider';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DescribeInstancesCommand, DescribeVpcsCommand, EC2Client } from '@aws-sdk/client-ec2';
import {
  DeleteRolePolicyCommand,
  DetachRolePolicyCommand,
  IAMClient,
  ListAttachedRolePoliciesCommand,
  ListRolePoliciesCommand,
  ListRoleTagsCommand,
  UntagRoleCommand,
} from '@aws-sdk/client-iam';
import { GetPublicKeyCommand, KMSClient } from '@aws-sdk/client-kms';
import { LambdaClient, ListFunctionsCommand } from '@aws-sdk/client-lambda';
import {
  DeleteObjectsCommand,
  GetObjectCommand,
  HeadBucketCommand,
  ListObjectsV2Command,
  ListObjectVersionsCommand,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import { SFNClient, StartExecutionCommand } from '@aws-sdk/client-sfn';
import { DynamoDBDocumentClient, GetCommand, PutCommand, QueryCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import type { FetchLike } from './cfn.js';
import type { Item, Ports, PreflightItem } from './ports.js';

function errName(e: unknown): string {
  return e && typeof e === 'object' && 'name' in e ? String((e as { name: unknown }).name) : '';
}

export function createAwsPorts(): Ports {
  const s3 = new S3Client({});
  const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({}), { marshallOptions: { removeUndefinedValues: true } });
  const iam = new IAMClient({});
  const cfn = new CloudFormationClient({});
  const sfn = new SFNClient({});
  const kms = new KMSClient({});
  const cloudfront = new CloudFrontClient({});
  const cognito = new CognitoIdentityProviderClient({});

  return {
    s3: {
      async bucketExists(bucket) {
        try {
          await s3.send(new HeadBucketCommand({ Bucket: bucket }));
          return true;
        } catch (e) {
          if (['NotFound', 'NoSuchBucket'].includes(errName(e))) return false;
          throw e;
        }
      },
      async listObjectVersions(bucket, marker) {
        const r = await s3.send(
          new ListObjectVersionsCommand({ Bucket: bucket, KeyMarker: marker?.keyMarker, VersionIdMarker: marker?.versionIdMarker, MaxKeys: 1000 }),
        );
        const items = [...(r.Versions ?? []), ...(r.DeleteMarkers ?? [])]
          .filter((v) => v.Key)
          .map((v) => ({ key: v.Key!, ...(v.VersionId ? { versionId: v.VersionId } : {}) }));
        return { items, ...(r.IsTruncated ? { next: { keyMarker: r.NextKeyMarker, versionIdMarker: r.NextVersionIdMarker } } : {}) };
      },
      async deleteObjects(bucket, items) {
        for (let i = 0; i < items.length; i += 1000) {
          const chunk = items.slice(i, i + 1000);
          const r = await s3.send(
            new DeleteObjectsCommand({ Bucket: bucket, Delete: { Quiet: true, Objects: chunk.map((o) => ({ Key: o.key, VersionId: o.versionId })) } }),
          );
          if (r.Errors?.length) throw new Error(`could not delete ${r.Errors.length} object(s) of ${bucket}: ${r.Errors[0]?.Code} ${r.Errors[0]?.Message}`);
        }
      },
      async getObject(bucket, key) {
        try {
          const r = await s3.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
          return Buffer.from(await r.Body!.transformToByteArray());
        } catch (e) {
          if (['NoSuchKey', 'NotFound'].includes(errName(e))) return null;
          throw e;
        }
      },
      async putObject(bucket, key, body, meta) {
        await s3.send(new PutObjectCommand({ Bucket: bucket, Key: key, Body: body, ContentType: meta?.contentType, CacheControl: meta?.cacheControl }));
      },
      async listKeys(bucket, prefix) {
        const keys: string[] = [];
        let token: string | undefined;
        do {
          const r = await s3.send(new ListObjectsV2Command({ Bucket: bucket, Prefix: prefix, ContinuationToken: token }));
          for (const o of r.Contents ?? []) if (o.Key) keys.push(o.Key);
          token = r.IsTruncated ? r.NextContinuationToken : undefined;
        } while (token);
        return keys;
      },
    },
    table: {
      async get(table, key) {
        return (await ddb.send(new GetCommand({ TableName: table, Key: key, ConsistentRead: true }))).Item as Item | undefined;
      },
      async put(table, item, opts) {
        try {
          await ddb.send(new PutCommand({ TableName: table, Item: item, ...(opts?.ifNotExists ? { ConditionExpression: 'attribute_not_exists(PK)' } : {}) }));
          return true;
        } catch (e) {
          if (opts?.ifNotExists && errName(e) === 'ConditionalCheckFailedException') return false;
          throw e;
        }
      },
      async update(table, key, set) {
        const names: Record<string, string> = {};
        const values: Record<string, unknown> = {};
        const parts = Object.entries(set).map(([k, v], i) => {
          names[`#a${i}`] = k;
          values[`:v${i}`] = v;
          return `#a${i} = :v${i}`;
        });
        if (!parts.length) return;
        await ddb.send(
          new UpdateCommand({ TableName: table, Key: key, UpdateExpression: `SET ${parts.join(', ')}`, ExpressionAttributeNames: names, ExpressionAttributeValues: values }),
        );
      },
      async increment(table, key, attr) {
        const r = await ddb.send(
          new UpdateCommand({
            TableName: table,
            Key: key,
            UpdateExpression: 'ADD #n :one',
            ExpressionAttributeNames: { '#n': attr },
            ExpressionAttributeValues: { ':one': 1 },
            ReturnValues: 'UPDATED_NEW',
          }),
        );
        return Number(r.Attributes?.[attr] ?? 0);
      },
      async queryIndex(table, index, partition, limit) {
        const pk = index === 'GSI1' ? 'GSI1PK' : 'GSI2PK';
        const r = await ddb.send(
          new QueryCommand({ TableName: table, IndexName: index, KeyConditionExpression: '#p = :p', ExpressionAttributeNames: { '#p': pk }, ExpressionAttributeValues: { ':p': partition }, Limit: limit }),
        );
        return (r.Items ?? []) as Item[];
      },
    },
    iam: {
      async listRolePolicies(role) {
        const out: string[] = [];
        let marker: string | undefined;
        do {
          const r = await iam.send(new ListRolePoliciesCommand({ RoleName: role, Marker: marker }));
          out.push(...(r.PolicyNames ?? []));
          marker = r.IsTruncated ? r.Marker : undefined;
        } while (marker);
        return out;
      },
      async deleteRolePolicy(role, name) {
        try {
          await iam.send(new DeleteRolePolicyCommand({ RoleName: role, PolicyName: name }));
        } catch (e) {
          if (errName(e) !== 'NoSuchEntityException') throw e;
        }
      },
      async listAttachedRolePolicies(role) {
        const out: string[] = [];
        let marker: string | undefined;
        do {
          const r = await iam.send(new ListAttachedRolePoliciesCommand({ RoleName: role, Marker: marker }));
          out.push(...(r.AttachedPolicies ?? []).map((p) => p.PolicyArn!).filter(Boolean));
          marker = r.IsTruncated ? r.Marker : undefined;
        } while (marker);
        return out;
      },
      async detachRolePolicy(role, arn) {
        try {
          await iam.send(new DetachRolePolicyCommand({ RoleName: role, PolicyArn: arn }));
        } catch (e) {
          if (errName(e) !== 'NoSuchEntityException') throw e;
        }
      },
      async listRoleTags(role) {
        const r = await iam.send(new ListRoleTagsCommand({ RoleName: role }));
        return (r.Tags ?? []).map((t) => ({ key: t.Key!, value: t.Value ?? '' }));
      },
      async untagRole(role, keys) {
        await iam.send(new UntagRoleCommand({ RoleName: role, TagKeys: keys }));
      },
    },
    stack: {
      async updateTerminationProtection(stackId, enable) {
        await cfn.send(new UpdateTerminationProtectionCommand({ StackName: stackId, EnableTerminationProtection: enable }));
      },
      async setStackPolicy(stackId, policyBody) {
        await cfn.send(new SetStackPolicyCommand({ StackName: stackId, StackPolicyBody: policyBody }));
      },
    },
    workflow: {
      async startExecution(stateMachineArn, name, input) {
        try {
          const r = await sfn.send(new StartExecutionCommand({ stateMachineArn, name, input: JSON.stringify(input) }));
          return { executionArn: r.executionArn!, alreadyExists: false };
        } catch (e) {
          if (errName(e) === 'ExecutionAlreadyExists') {
            return { executionArn: `${stateMachineArn.replace(':stateMachine:', ':execution:')}:${name}`, alreadyExists: true };
          }
          throw e;
        }
      },
    },
    kms: {
      async getPublicKey(keyId) {
        const r = await kms.send(new GetPublicKeyCommand({ KeyId: keyId }));
        return { der: r.PublicKey!, keySpec: String(r.KeySpec), keyArn: r.KeyId ?? keyId };
      },
    },
    cdn: {
      async invalidate(distributionId, paths) {
        await cloudfront.send(
          new CreateInvalidationCommand({
            DistributionId: distributionId,
            InvalidationBatch: { CallerReference: `atl-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`, Paths: { Quantity: paths.length, Items: paths } },
          }),
        );
      },
    },
    users: {
      async ensureUser(userPoolId, email, group) {
        let created: 'created' | 'exists' = 'exists';
        try {
          await cognito.send(new AdminGetUserCommand({ UserPoolId: userPoolId, Username: email }));
        } catch (e) {
          if (errName(e) !== 'UserNotFoundException') throw e;
          await cognito.send(
            new AdminCreateUserCommand({
              UserPoolId: userPoolId,
              Username: email,
              DesiredDeliveryMediums: ['EMAIL'],
              UserAttributes: [
                { Name: 'email', Value: email },
                { Name: 'email_verified', Value: 'true' },
              ],
            }),
          );
          created = 'created';
        }
        await cognito.send(new AdminAddUserToGroupCommand({ UserPoolId: userPoolId, Username: email, GroupName: group }));
        return created;
      },
    },
    preflight: { run: runPreflight },
    fetch: fetch as unknown as FetchLike,
    now: () => new Date(),
    log: (message, extra) => console.log(JSON.stringify({ level: 'info', message, ...extra })),
  };
}

// ---------------------------------------------------------------------------------------------------------------
// Preflight (01 §4.1) — read-only, best effort

type AnyClient = { send(cmd: unknown): Promise<Record<string, unknown>> };

async function optionalClient(moduleName: string, clientName: string, commandName: string): Promise<{ client: AnyClient; Command: new (input: unknown) => unknown } | null> {
  try {
    const mod = (await import(moduleName)) as Record<string, unknown>;
    const Client = mod[clientName] as new (cfg: unknown) => AnyClient;
    const Command = mod[commandName] as new (input: unknown) => unknown;
    return Client && Command ? { client: new Client({}), Command } : null;
  } catch {
    return null;
  }
}

async function check(id: string, fn: () => Promise<PreflightItem>): Promise<PreflightItem> {
  try {
    return await fn();
  } catch (e) {
    return { id, status: 'unknown', detail: `check failed: ${e instanceof Error ? e.message : String(e)}` };
  }
}

export async function runPreflight(input: { region: string; externalAccessAnalyzer: string; workstationInstanceType: string }): Promise<PreflightItem[]> {
  const ec2 = new EC2Client({});
  const items: PreflightItem[] = [];
  items.push(
    await check('default-vpc', async () => {
      const r = await ec2.send(new DescribeVpcsCommand({ Filters: [{ Name: 'is-default', Values: ['true'] }] }));
      return r.Vpcs?.length
        ? { id: 'default-vpc', status: 'ok', detail: `default VPC ${r.Vpcs[0]!.VpcId}` }
        : { id: 'default-vpc', status: 'warn', detail: 'no default VPC in this region', hint: 'aws ec2 create-default-vpc (run it yourself; ATL never creates or deletes the default VPC)' };
    }),
  );
  items.push(
    await check('vcpu-quota', async () => {
      const sq = await optionalClient('@aws-sdk/client-service-quotas', 'ServiceQuotasClient', 'GetServiceQuotaCommand');
      if (!sq) return { id: 'vcpu-quota', status: 'unknown', detail: 'Service Quotas client unavailable' };
      const r = await sq.client.send(new sq.Command({ ServiceCode: 'ec2', QuotaCode: 'L-1216C47A' }));
      const value = Number((r.Quota as { Value?: number } | undefined)?.Value ?? 0);
      return value >= 4
        ? { id: 'vcpu-quota', status: 'ok', detail: `On-Demand standard vCPU quota ${value}` }
        : { id: 'vcpu-quota', status: 'warn', detail: `On-Demand standard vCPU quota ${value}`, hint: 'request a quota increase (lab instance + workstation run at the same time)' };
    }),
  );
  items.push(
    await check('existing-trail', async () => {
      const r = await new CloudTrailClient({}).send(new DescribeTrailsCommand({ includeShadowTrails: true }));
      const trails = (r.trailList ?? []).filter((t) => t.Name !== 'atl-trail');
      return trails.length
        ? { id: 'existing-trail', status: 'info', detail: `${trails.length} CloudTrail trail(s) exist`, hint: 'audit cards run in read-only mode' }
        : { id: 'existing-trail', status: 'ok', detail: 'no CloudTrail trail' };
    }),
  );
  for (const [id, mod, client, cmd, field, label] of [
    ['guardduty', '@aws-sdk/client-guardduty', 'GuardDutyClient', 'ListDetectorsCommand', 'DetectorIds', 'GuardDuty detector'],
    ['config-recorder', '@aws-sdk/client-config-service', 'ConfigServiceClient', 'DescribeConfigurationRecordersCommand', 'ConfigurationRecorders', 'Config recorder'],
  ] as const) {
    items.push(
      await check(id, async () => {
        const c = await optionalClient(mod, client, cmd);
        if (!c) return { id, status: 'unknown', detail: `${label}: client unavailable` };
        const r = await c.client.send(new c.Command({}));
        const n = Array.isArray(r[field]) ? (r[field] as unknown[]).length : 0;
        return n ? { id, status: 'info', detail: `${label} exists`, hint: 'the related cards run in read-only mode' } : { id, status: 'ok', detail: `no ${label}` };
      }),
    );
  }
  items.push(
    await check('access-analyzer', async () => {
      const c = await optionalClient('@aws-sdk/client-accessanalyzer', 'AccessAnalyzerClient', 'ListAnalyzersCommand');
      if (!c) return { id: 'access-analyzer', status: 'unknown', detail: 'Access Analyzer client unavailable' };
      const r = await c.client.send(new c.Command({ type: 'ACCOUNT' }));
      const others = ((r.analyzers as { name?: string }[] | undefined) ?? []).filter((a) => a.name !== 'atl-external-access');
      if (others.length && input.externalAccessAnalyzer === 'create')
        return { id: 'access-analyzer', status: 'warn', detail: `${others.length} account analyzer(s) already exist`, hint: 'set ExternalAccessAnalyzer=existing' };
      return { id: 'access-analyzer', status: 'ok', detail: `${others.length} other account analyzer(s)` };
    }),
  );
  items.push(
    await check('ses-sandbox', async () => {
      const c = await optionalClient('@aws-sdk/client-sesv2', 'SESv2Client', 'GetAccountCommand');
      if (!c) return { id: 'ses-sandbox', status: 'unknown', detail: 'SES client unavailable' };
      const r = await c.client.send(new c.Command({}));
      return r.ProductionAccessEnabled
        ? { id: 'ses-sandbox', status: 'ok', detail: 'SES production access' }
        : { id: 'ses-sandbox', status: 'info', detail: 'SES is in the sandbox', hint: 'email cards can only send to verified addresses' };
    }),
  );
  items.push(
    await check('organizations', async () => {
      const c = await optionalClient('@aws-sdk/client-organizations', 'OrganizationsClient', 'DescribeOrganizationCommand');
      if (!c) return { id: 'organizations', status: 'unknown', detail: 'Organizations client unavailable' };
      try {
        await c.client.send(new c.Command({}));
        return { id: 'organizations', status: 'info', detail: 'the account belongs to an organization', hint: 'SCPs may deny some lab actions' };
      } catch (e) {
        if (errName(e) === 'AWSOrganizationsNotInUseException') return { id: 'organizations', status: 'ok', detail: 'not in an organization' };
        throw e;
      }
    }),
  );
  items.push(
    await check('residual-stacks', async () => {
      const r = await new CloudFormationClient({}).send(
        new ListStacksCommand({ StackStatusFilter: ['CREATE_COMPLETE', 'UPDATE_COMPLETE', 'ROLLBACK_COMPLETE', 'DELETE_FAILED', 'UPDATE_ROLLBACK_COMPLETE', 'CREATE_FAILED'] }),
      );
      const left = (r.StackSummaries ?? []).filter((s) => s.StackName?.startsWith('cloudalbum-'));
      return left.length
        ? { id: 'residual-stacks', status: 'warn', detail: `${left.length} cloudalbum-* stack(s) exist`, hint: 'delete stacks left over from standalone mode before starting a card' }
        : { id: 'residual-stacks', status: 'ok', detail: 'no cloudalbum-* stacks' };
    }),
  );
  items.push(
    await check('borrowable-compute', async () => {
      const inst = await ec2.send(new DescribeInstancesCommand({ Filters: [{ Name: 'instance-state-name', Values: ['running', 'stopped'] }] }));
      const withProfile = (inst.Reservations ?? []).flatMap((r) => r.Instances ?? []).filter((i) => i.IamInstanceProfile).length;
      const fns = await new LambdaClient({}).send(new ListFunctionsCommand({ MaxItems: 50 }));
      const foreign = (fns.Functions ?? []).filter((f) => !f.FunctionName?.startsWith('atl-')).length;
      return withProfile || foreign
        ? {
            id: 'borrowable-compute',
            status: 'warn',
            detail: `${withProfile} instance(s) with an instance profile, ${foreign} other Lambda function(s)`,
            hint: 'the learner boundary cannot stop borrowing existing privileged resources; use a dedicated practice account (01 §6.10 #4)',
          }
        : { id: 'borrowable-compute', status: 'ok', detail: 'no existing compute with roles found' };
    }),
  );
  return items;
}
