/**
 * Session policy of `atl-<sid>-prov-<op>` (01 §6.7 rule 6 and its example): a short whitelist of direct calls scoped to
 * this environment, everything else only through CloudFormation (`aws:CalledVia`), plus the statements of the current
 * `ATL_OP` / platform action. Generated per build from sid, envId and envName.
 *
 * AssumeRole limits an inline session policy to 2 048 characters, which the full 01 example exceeds. The statements that
 * do not depend on the session (reads, SSM documents, the internal API route, the CalledVia rule, the registry's
 * out-of-band operations) therefore live in the managed policy `ATLProvisionerPolicy-RunnerSession`
 * (`staticRunnerStatements`, created by the platform stack and passed with `--policy-arns`); the inline part keeps every
 * environment-scoped statement (platform-lifecycle note).
 */
import { keyPairName, PROVISIONER_POLICY_PREFIX } from '@atl/shared';
import { extraStackRegion, type RunnerContext } from './context.js';

type Statement = Record<string, unknown>;

export interface PolicyDocument {
  Version: '2012-10-17';
  Statement: Statement[];
}

/** Managed session policy with the session-independent statements. */
export const RUNNER_SESSION_STATIC_POLICY = `${PROVISIONER_POLICY_PREFIX}RunnerSession`;
/** AssumeRole: plaintext limit of the inline session policy. */
export const INLINE_SESSION_POLICY_LIMIT = 2048;

/** API id of `https://<apiId>.execute-api.<region>.amazonaws.com`. */
export function apiIdOf(agentApiBase: string): string {
  return /^https:\/\/([a-z0-9]+)\.execute-api\./.exec(agentApiBase)?.[1] ?? '*';
}

/** Statements of `ATLProvisionerPolicy-RunnerSession` (install-time values only: region, account, API id). */
export function staticRunnerStatements(p: { region: string; accountId: string; apiId: string }): Statement[] {
  const { region, accountId: acct } = p;
  return [
    {
      Sid: 'DirectReads',
      Effect: 'Allow',
      Resource: '*',
      Action: [
        'cloudformation:Describe*',
        'cloudformation:List*',
        'cloudformation:Get*',
        'cloudformation:ValidateTemplate',
        'ssm:GetCommandInvocation',
        'ssm:ListCommandInvocations',
        'ssm:DescribeInstanceInformation',
        'iam:ListAttachedRolePolicies',
        'iam:GetRole',
        'iam:GetPolicy*',
        'ec2:Describe*',
        'sts:GetCallerIdentity',
      ],
    },
    { Sid: 'SendCommandDocuments', Effect: 'Allow', Action: 'ssm:SendCommand', Resource: [`arn:aws:ssm:${region}::document/AWS-RunShellScript`, `arn:aws:ssm:${region}:${acct}:document/ATL-*`] },
    { Sid: 'ReportToPlatform', Effect: 'Allow', Action: 'execute-api:Invoke', Resource: `arn:aws:execute-api:${region}:${acct}:${p.apiId}/*/*/api/v1/internal/*` },
    {
      Sid: 'EverythingElseViaCloudFormation',
      Effect: 'Allow',
      NotAction: ['iam:CreateUser', 'iam:CreateAccessKey'],
      Resource: '*',
      Condition: { 'ForAnyValue:StringEquals': { 'aws:CalledVia': ['cloudformation.amazonaws.com'] } },
    },
    {
      Sid: 'OutOfBandFromRegistry',
      Effect: 'Allow',
      Resource: '*',
      Action: [
        'guardduty:CreateDetector',
        'guardduty:DeleteDetector',
        'config:PutConfigurationRecorder',
        'config:StartConfigurationRecorder',
        'config:StopConfigurationRecorder',
        'config:DeleteConfigurationRecorder',
        'inspector2:Enable',
        'inspector2:Disable',
      ],
    },
  ];
}

/** Environment-scoped statements of this build (inline session policy). */
export function envRunnerStatements(ctx: RunnerContext): Statement[] {
  const { region, accountId: acct, sessionId: sid, envId, op } = ctx.input;
  const env = ctx.envName;
  const cfnWrites =
    op === 'extra-stack' || (op === 'destroy' && ctx.card.extraStacks.length)
      ? // card stacks only in their own name space (lab region, us-east-1, DR region); destroy also needs the module stacks
        [...new Set([region, 'us-east-1', ...ctx.card.extraStacks.map((x) => safeRegion(ctx, x.region))].filter((r): r is string => !!r))].map(
          (r) => `arn:aws:cloudformation:${r}:${acct}:stack/cloudalbum-${env}-${op === 'destroy' && r === region ? '' : 'x-'}*`,
        )
      : [`arn:aws:cloudformation:${region}:${acct}:stack/cloudalbum-${env}-*`, `arn:aws:cloudformation:${region}:${acct}:stack/atl-ws-${sid}/*`];
  const s: Statement[] = [
    { Sid: 'EnvStacks', Effect: 'Allow', Action: 'cloudformation:*', Resource: [...cfnWrites, `arn:aws:cloudformation:*:${acct}:changeSet/*`] },
    {
      // parameters of this environment, CloudAlbumAppRole attachments and (base-deploy only) the session key pair: one
      // statement, since actions of one service never match another service's ARNs
      Sid: 'EnvDirect',
      Effect: 'Allow',
      Action: [
        'ssm:GetParameter*',
        'ssm:PutParameter',
        'ssm:DeleteParameter',
        'ssm:AddTagsToResource',
        'iam:AttachRolePolicy',
        'iam:DetachRolePolicy',
        ...(op === 'base-deploy' ? ['ec2:CreateKeyPair', 'ec2:DeleteKeyPair', 'ec2:CreateTags'] : []),
      ],
      Resource: [
        `arn:aws:ssm:${region}:${acct}:parameter/cloudalbum/${env}/*`,
        `arn:aws:iam::${acct}:role/CloudAlbumAppRole`,
        ...(op === 'base-deploy' ? [`arn:aws:ec2:${region}:${acct}:key-pair/${keyPairName(env)}`] : []),
      ],
    },
    {
      Sid: 'SendCommandToThisEnvOnly',
      Effect: 'Allow',
      Action: 'ssm:SendCommand',
      Resource: `arn:aws:ec2:${region}:${acct}:instance/*`,
      Condition: { StringEquals: { 'ssm:resourceTag/atl:env-id': envId } },
    },
    {
      Sid: 'EnvStorage',
      Effect: 'Allow',
      Action: 's3:*',
      Resource: [`arn:aws:s3:::cloudalbum-${env}-toolchain-*`, `arn:aws:s3:::${ctx.buckets.labState}/${env}/*`],
    },
    { Sid: 'EnvStateList', Effect: 'Allow', Action: 's3:ListBucket', Resource: `arn:aws:s3:::${ctx.buckets.labState}`, Condition: { StringLike: { 's3:prefix': `${env}/*` } } },
    {
      Sid: 'EnvLock',
      Effect: 'Allow',
      Action: ['dynamodb:GetItem', 'dynamodb:PutItem', 'dynamodb:UpdateItem', 'dynamodb:DeleteItem'],
      Resource: `arn:aws:dynamodb:${region}:${acct}:table/${ctx.moduleEnv.CLOUDALBUM_LOCK_TABLE}`,
      Condition: { 'ForAllValues:StringEquals': { 'dynamodb:LeadingKeys': [`env#${env}`] } },
    },
    {
      Sid: 'RunArtifacts',
      Effect: 'Allow',
      Action: ['s3:PutObject', 's3:GetObject'],
      Resource: [`arn:aws:s3:::${ctx.buckets.data}/runs/${sid}-*`, `arn:aws:s3:::${ctx.buckets.data}/archive/${sid}/*`],
    },
  ];
  if (op === 'module-op') s.push(...platformActionStatements(ctx, String(ctx.input.args?.actionId ?? '')));
  return s;
}

/** The whole policy of one build (managed + inline), e.g. for documentation and review. */
export function runnerSessionPolicy(ctx: RunnerContext): PolicyDocument {
  return {
    Version: '2012-10-17',
    Statement: [...staticRunnerStatements({ region: ctx.input.region, accountId: ctx.input.accountId, apiId: apiIdOf(ctx.agentApiBase) }), ...envRunnerStatements(ctx)],
  };
}

/** Inline session policy for AssumeRole (no `Sid`, minified); throws when it would exceed the AssumeRole limit. */
export function inlineSessionPolicy(ctx: RunnerContext): string {
  const statements = envRunnerStatements(ctx).map(({ Sid: _sid, ...rest }) => rest);
  const json = JSON.stringify({ Version: '2012-10-17', Statement: statements });
  if (json.length > INLINE_SESSION_POLICY_LIMIT) throw new Error(`inline session policy is ${json.length} characters (limit ${INLINE_SESSION_POLICY_LIMIT})`);
  return json;
}

export function staticPolicyArn(accountId: string): string {
  return `arn:aws:iam::${accountId}:policy/${RUNNER_SESSION_STATIC_POLICY}`;
}

function safeRegion(ctx: RunnerContext, r: string): string | null {
  try {
    return extraStackRegion(ctx, r);
  } catch {
    return null;
  }
}

/** 01 §6.7 “平台动作追加的语句” (by registry action). */
export function platformActionStatements(ctx: RunnerContext, actionId: string): Statement[] {
  const { region, accountId: acct, envId } = ctx.input;
  const env = ctx.envName;
  const action = ctx.card.platformActions.find((a) => a.id === actionId);
  const key = `${action?.module ?? ''}:${action?.op ?? ''}:${actionId}`;
  if (/keys/.test(key)) {
    return [
      {
        Sid: 'KeysModeUser',
        Effect: 'Allow',
        Action: ['iam:CreateUser', 'iam:DeleteUser', 'iam:TagUser', 'iam:*AccessKey', 'iam:AttachUserPolicy', 'iam:DetachUserPolicy'],
        Resource: `arn:aws:iam::${acct}:user/cloudalbum/cloudalbum-${env}-demo-keys`,
        Condition: { StringEqualsIfExists: { 'iam:PermissionsBoundary': ctx.moduleEnv.CLOUDALBUM_PERMISSIONS_BOUNDARY_ARN } },
      },
    ];
  }
  if (/revoke/.test(key)) {
    return [{ Sid: 'RevokeOlderSessions', Effect: 'Allow', Action: ['iam:PutRolePolicy', 'iam:DeleteRolePolicy', 'iam:GetRolePolicy'], Resource: `arn:aws:iam::${acct}:role/CloudAlbumAppRole` }];
  }
  if (/refresh/.test(key)) {
    return [
      {
        Sid: 'RefreshInstanceCredentials',
        Effect: 'Allow',
        Action: ['ec2:ReplaceIamInstanceProfileAssociation', 'ec2:RebootInstances'],
        Resource: `arn:aws:ec2:${region}:${acct}:instance/*`,
        Condition: { StringEquals: { 'aws:ResourceTag/atl:env-id': envId } },
      },
      { Sid: 'RefreshPassRole', Effect: 'Allow', Action: 'iam:PassRole', Resource: `arn:aws:iam::${acct}:role/CloudAlbumAppRole` },
    ];
  }
  if (/cost/.test(key)) return [{ Sid: 'CostAllocationTags', Effect: 'Allow', Action: 'ce:UpdateCostAllocationTagsStatus', Resource: '*' }];
  return [];
}
