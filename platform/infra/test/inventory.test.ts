/**
 * 01 §3 resource inventory ⊆ merged template, and every function role ⊆ the 01 §6.9 permission list (01 §13: inventory.test.ts).
 * Names come from @atl/shared (the code form of the 01 §14 name table).
 */
import {
  ACCESS_ANALYZER_NAME,
  ATL_MAIN_TABLE,
  BUDGET_NAME,
  CLOUDFRONT_FUNCTION,
  COGNITO_GROUPS,
  CUSTOM_RESOURCE_HANDLERS,
  EVENT_BUS,
  EVENT_RULES,
  GUARDRAIL_POLICIES,
  KMS_SIGNING_ALIAS,
  LAB_LOCKS_TABLE,
  LAMBDA_FUNCTIONS,
  LEARNER_INLINE_POLICIES,
  OPTIONAL_LAMBDA_FUNCTIONS,
  PERMISSION_BOUNDARIES,
  PROVISIONER_POLICY_PREFIX,
  RESPONSE_HEADERS_POLICIES,
  ROLE_NAMES,
  RUNNER_LOG_GROUP,
  RUNNER_PROJECT,
  SCHEDULE_GROUPS,
  SNS_TOPICS,
  SQS_QUEUES,
  SSM_DOCUMENTS,
  STATE_MACHINES,
  STATE_MANAGER_ASSOCIATION,
  SWEEPER_SCHEDULE,
  TERMINAL_RECORDING_LOG_GROUP,
  TERMINAL_RECORDING_POLICY,
  TRAIL_NAME,
  USER_POOL_NAME,
  WEB_CLIENT_NAME,
} from '@atl/shared';
import { describe, expect, it } from 'vitest';
import { actionsOf, byType, named, prop, resources, type Resource } from './support/template.js';

const names = (type: string, p: string) => named(type, p).map((x) => x.name);
function conditionOfName(type: string, p: string, name: string): string | undefined {
  return named(type, p).find((x) => x.name === name)?.condition;
}

describe('01 §3 inventory ⊆ template', () => {
  it('Lambda functions (01 §3.2); atl-tagger only with PlatformTrail=enabled', () => {
    expect(names('AWS::Lambda::Function', 'FunctionName').sort()).toEqual([...LAMBDA_FUNCTIONS].sort());
    for (const fn of OPTIONAL_LAMBDA_FUNCTIONS) expect(conditionOfName('AWS::Lambda::Function', 'FunctionName', fn)).toBe('TrailEnabled');
    const logGroups = names('AWS::Logs::LogGroup', 'LogGroupName');
    for (const fn of LAMBDA_FUNCTIONS) expect(logGroups).toContain(`/aws/lambda/${fn}`);
  });

  it('state machines (01 §3.3), STANDARD, ERROR logging into pre-created /aws/vendedlogs/states/<name>', () => {
    const sms = byType('AWS::StepFunctions::StateMachine');
    expect(sms.map(([, r]) => prop(r, 'StateMachineName')).sort()).toEqual([...STATE_MACHINES].sort());
    const logGroups = names('AWS::Logs::LogGroup', 'LogGroupName');
    for (const [, r] of sms) {
      expect(prop(r, 'StateMachineType')).toBe('STANDARD');
      expect(prop<{ Level: string }>(r, 'LoggingConfiguration').Level).toBe('ERROR');
      expect(logGroups).toContain(`/aws/vendedlogs/states/${prop(r, 'StateMachineName')}`);
    }
  });

  it('CodeBuild atl-runner (01 §3.4): ARM, S3 source from the pinned release, concurrency 2, its log group', () => {
    const [[, p]] = byType('AWS::CodeBuild::Project');
    expect(prop(p, 'Name')).toBe(RUNNER_PROJECT);
    expect(prop<Record<string, unknown>>(p, 'Environment')).toMatchObject({ Type: 'ARM_CONTAINER', ComputeType: 'BUILD_GENERAL1_SMALL' });
    expect(prop<Record<string, unknown>>(p, 'Source')).toMatchObject({ Type: 'S3', BuildSpec: 'platform/workflows/runner/buildspec.yml' });
    expect(prop(p, 'ConcurrentBuildLimit')).toBe(2);
    expect(names('AWS::Logs::LogGroup', 'LogGroupName')).toContain(RUNNER_LOG_GROUP);
  });

  it('Scheduler groups, atl-sweeper (disabled at install) and atl-timer-dlq (01 §3.5)', () => {
    expect(names('AWS::Scheduler::ScheduleGroup', 'Name').sort()).toEqual([...SCHEDULE_GROUPS].sort());
    const [[, sweeper]] = byType('AWS::Scheduler::Schedule');
    expect(prop(sweeper, 'Name')).toBe(SWEEPER_SCHEDULE);
    expect(prop(sweeper, 'State')).toBe('DISABLED');
    expect(prop(sweeper, 'ScheduleExpression')).toBe('rate(5 minutes)');
    expect(names('AWS::SQS::Queue', 'QueueName')).toEqual([...SQS_QUEUES]);
  });

  it('SSM documents, the State Manager association, /atl/ parameters and the conditional recording resources (01 §3.6)', () => {
    expect(names('AWS::SSM::Document', 'Name').sort()).toEqual([...SSM_DOCUMENTS].sort());
    const [[, assoc]] = byType('AWS::SSM::Association');
    expect(prop(assoc, 'AssociationName')).toBe(STATE_MANAGER_ASSOCIATION);
    expect(prop(assoc, 'Targets')).toEqual([{ Key: 'tag:atl:role', Values: ['lab-app', 'workstation'] }]);
    expect(conditionOfName('AWS::Logs::LogGroup', 'LogGroupName', TERMINAL_RECORDING_LOG_GROUP)).toBe('RecordingOn');
    const recording = byType('AWS::IAM::RolePolicy').filter(([, r]) => prop(r, 'PolicyName') === TERMINAL_RECORDING_POLICY);
    expect(recording).toHaveLength(2);
    for (const [, r] of recording) expect(r.Condition).toBe('RecordingOn');
    for (const [, r] of byType('AWS::SSM::Parameter')) {
      expect(String(prop(r, 'Name'))).toMatch(/^\/atl\//);
      expect(prop(r, 'Type')).toBe('String');
      expect(String(prop(r, 'Name'))).not.toMatch(/secret|password|token|key/i);
    }
  });

  it('buckets and tables (01 §3.7, §3.11)', () => {
    const buckets = byType('AWS::S3::Bucket').map(([, r]) => JSON.stringify(prop(r, 'BucketName')));
    for (const b of ['atl-web-', 'atl-artifacts-', 'atl-data-', 'cloudalbum-lab-state-', 'atl-trail-']) expect(buckets.some((x) => x.includes(b))).toBe(true);
    expect(names('AWS::DynamoDB::Table', 'TableName').sort()).toEqual([ATL_MAIN_TABLE, LAB_LOCKS_TABLE].sort());
  });

  it('CloudFront (01 §3.8): distribution, atl-spa-rewrite, three response headers policies, OAC', () => {
    expect(byType('AWS::CloudFront::Distribution')).toHaveLength(1);
    expect(names('AWS::CloudFront::Function', 'Name')).toEqual([CLOUDFRONT_FUNCTION]);
    const policies = byType('AWS::CloudFront::ResponseHeadersPolicy').map(([, r]) => (prop(r, 'ResponseHeadersPolicyConfig') as { Name: string }).Name);
    expect(policies.sort()).toEqual([...RESPONSE_HEADERS_POLICIES].sort());
    expect(byType('AWS::CloudFront::OriginAccessControl')).toHaveLength(1);
  });

  it('events, notifications, budget, analyzer, trail (01 §3.10, §3.12)', () => {
    expect(names('AWS::Events::EventBus', 'Name')).toEqual([EVENT_BUS]);
    expect(names('AWS::Events::Rule', 'Name').sort()).toEqual([...EVENT_RULES].sort());
    expect(conditionOfName('AWS::Events::Rule', 'Name', 'atl-tagger-api-calls')).toBe('TrailEnabled');
    expect(names('AWS::SNS::Topic', 'TopicName').sort()).toEqual([...SNS_TOPICS].sort());
    const [[, budget]] = byType('AWS::Budgets::Budget');
    expect((prop(budget, 'Budget') as { BudgetName: string }).BudgetName).toBe(BUDGET_NAME);
    expect(budget.Condition).toBe('HasBudget');
    expect(conditionOfName('AWS::AccessAnalyzer::Analyzer', 'AnalyzerName', ACCESS_ANALYZER_NAME)).toBe('CreateAnalyzer');
    expect(conditionOfName('AWS::CloudTrail::Trail', 'TrailName', TRAIL_NAME)).toBe('TrailEnabled');
  });

  it('KMS signing key and alias (01 §3.1, §10.5)', () => {
    const [[, key]] = byType('AWS::KMS::Key');
    expect(prop(key, 'KeySpec')).toBe('ECC_NIST_P256');
    expect(prop(key, 'KeyUsage')).toBe('SIGN_VERIFY');
    expect(names('AWS::KMS::Alias', 'AliasName')).toEqual([KMS_SIGNING_ALIAS]);
  });

  it('Cognito (01 §5.1): atl-users, atl-web public client with code flow, three groups', () => {
    expect(names('AWS::Cognito::UserPool', 'UserPoolName')).toEqual([USER_POOL_NAME]);
    const [[, client]] = byType('AWS::Cognito::UserPoolClient');
    expect(prop(client, 'ClientName')).toBe(WEB_CLIENT_NAME);
    expect(prop(client, 'GenerateSecret')).toBe(false);
    expect(prop(client, 'AllowedOAuthFlows')).toEqual(['code']);
    expect(names('AWS::Cognito::UserPoolGroup', 'GroupName').sort()).toEqual([...COGNITO_GROUPS].sort());
  });

  it('HTTP API (01 §5.3): four route families + the fallback route', () => {
    const routes = Object.fromEntries(byType('AWS::ApiGatewayV2::Route').map(([, r]) => [prop(r, 'RouteKey'), prop(r, 'AuthorizationType')]));
    expect(routes).toEqual({
      'ANY /api/v1/{proxy+}': 'JWT',
      'ANY /api/v1/agent/{proxy+}': 'AWS_IAM',
      'ANY /api/v1/internal/{proxy+}': 'AWS_IAM',
      'GET /api/v1/public/{proxy+}': 'NONE',
      'PUT /api/v1/agent-fallback/runs/{runId}/result': 'NONE',
    });
  });

  it('IAM: all roles, three boundaries, two guardrails, provisioner policies, learner inline policies (01 §6)', () => {
    const roles = named('AWS::IAM::Role', 'RoleName');
    expect(roles.map((r) => r.name).sort()).toEqual([...ROLE_NAMES].sort());
    expect(roles.find((r) => r.name === 'ATLTaggerFunctionRole')?.condition).toBe('TrailEnabled');
    const managed = names('AWS::IAM::ManagedPolicy', 'ManagedPolicyName') as string[];
    for (const p of [...PERMISSION_BOUNDARIES, ...GUARDRAIL_POLICIES]) expect(managed).toContain(p);
    expect(managed.filter((m) => m.startsWith(PROVISIONER_POLICY_PREFIX)).length).toBeGreaterThan(0);
    const learner = Object.values(resources()).find((r) => prop(r, 'RoleName') === 'ATLLearnerRole')!;
    const inline = (prop(learner, 'Policies') as { PolicyName: string }[]).map((p) => p.PolicyName);
    expect(inline.sort()).toEqual(LEARNER_INLINE_POLICIES.filter((p) => p !== 'ATLRevokedSessions').sort());
    expect(names('AWS::IAM::InstanceProfile', 'InstanceProfileName').sort()).toEqual(['ATLWorkstationRole', 'CloudAlbumAppRole']);
  });

  it('custom resources (01 §4.6): every handler is used', () => {
    const types = new Set(Object.values(resources()).map((r) => r.Type));
    for (const h of CUSTOM_RESOURCE_HANDLERS) expect(types.has(`Custom::${h}`), h).toBe(true);
  });
});

/** 01 §6.9: the operations each function role may hold (patterns; `svc:*` = any operation of the service on the listed data). */
const ROLE_ALLOW_LIST: Record<string, RegExp[]> = {
  ATLApiFunctionRole: [/^logs:(CreateLogStream|PutLogEvents)$/, /^dynamodb:/, /^lambda:InvokeFunction$/, /^states:(StartExecution|StopExecution)$/, /^sts:(AssumeRole|SetSourceIdentity)$/, /^cognito-idp:Admin\*$/, /^ssm:GetParameter$/, /^s3:(GetObject|PutObject|ListBucket)$/, /^ce:GetCostAndUsage$/, /^events:PutEvents$/, /^cloudformation:UpdateTerminationProtection$/],
  ATLPublicFunctionRole: [/^logs:(CreateLogStream|PutLogEvents)$/, /^dynamodb:(GetItem|Query)$/],
  ATLAgentFunctionRole: [/^logs:(CreateLogStream|PutLogEvents)$/, /^dynamodb:/, /^s3:(PutObject|GetObject)$/, /^lambda:InvokeFunction$/, /^events:PutEvents$/],
  ATLChecksFunctionRole: [/^logs:(CreateLogStream|PutLogEvents)$/, /^dynamodb:/, /^sts:(AssumeRole|TagSession)$/, /^lambda:InvokeFunction$/, /^s3:(PutObject|GetObject|ListBucket)$/, /^events:PutEvents$/],
  ATLLifecycleFunctionRole: [
    /^logs:(CreateLogStream|PutLogEvents)$/, /^dynamodb:/, /^scheduler:(CreateSchedule|UpdateSchedule|DeleteSchedule|GetSchedule)$/, /^iam:PassRole$/,
    /^ec2:(Describe\*|GetConsoleOutput|RebootInstances)$/, /^ssm:(DescribeInstanceInformation|SendCommand|GetCommandInvocation|ListCommandInvocations|DescribeSessions|TerminateSession)$/,
    /^iam:(PutRolePolicy|GetRolePolicy|DeleteRolePolicy|TagRole|UntagRole|ListRoleTags)$/, /^states:(StartExecution|StopExecution|DescribeExecution)$/,
    /^codebuild:(StopBuild|BatchGetBuilds|ListBuildsForProject)$/, /^cloudformation:(DescribeStacks|DescribeStackEvents|ListStackResources)$/, /^s3:(GetObject|ListBucket)$/,
    /^lambda:InvokeFunction$/, /^events:PutEvents$/, /^sns:Publish$/,
  ],
  ATLTimerFunctionRole: [
    /^logs:(CreateLogStream|PutLogEvents)$/, /^dynamodb:/, /^lambda:InvokeFunction$/, /^states:(StartExecution|ListExecutions|DescribeExecution)$/,
    /^scheduler:(CreateSchedule|UpdateSchedule|DeleteSchedule|GetSchedule)$/, /^iam:PassRole$/, /^sqs:(ReceiveMessage|DeleteMessage|GetQueueAttributes)$/,
    /^ec2:DescribeInstances$/, /^cloudformation:DescribeStacks$/, /^events:PutEvents$/, /^sns:Publish$/,
  ],
  ATLReaperFunctionRole: [
    /^logs:(CreateLogStream|PutLogEvents)$/, /^dynamodb:/, /^cloudtrail:LookupEvents$/, /^tag:GetResources$/, /^sts:AssumeRole$/, /^s3:(GetObject|ListBucket)$/,
    /^access-analyzer:(ListAnalyzers|ListFindings|ListFindingsV2|GetFinding)$/, /^events:PutEvents$/, /^cloudformation:ListStackResources$/,
    // read-only inventory (Describe / List / Get) of the reclaim rule table
    /^[a-z0-9-]+:(Describe|List|Get|BatchGet)[A-Za-z*]*$/, /^apigateway:GET$/,
  ],
  ATLCertsFunctionRole: [/^logs:(CreateLogStream|PutLogEvents)$/, /^dynamodb:/, /^kms:(Sign|GetPublicKey)$/, /^s3:(GetObject|PutObject|DeleteObject)$/, /^cloudfront:CreateInvalidation$/],
  ATLPricingFunctionRole: [/^logs:(CreateLogStream|PutLogEvents)$/, /^pricing:GetProducts$/, /^dynamodb:/],
  ATLTaggerFunctionRole: [/^logs:(CreateLogStream|PutLogEvents)$/, /^dynamodb:/, /^tag:TagResources$/, /^[a-z0-9-]+:(CreateTags|AddTags|AddTagsToResource|TagResource|TagQueue|PutBucketTagging)$/],
  ATLCustomResourceRole: [
    /^logs:(CreateLogStream|PutLogEvents)$/, /^dynamodb:/, /^s3:(GetObject|PutObject|DeleteObject|ListBucket|ListBucketVersions|DeleteObjectVersion|ListAllMyBuckets)$/,
    /^cloudfront:CreateInvalidation$/, /^cloudformation:(UpdateTerminationProtection|SetStackPolicy|ListStackResources|DescribeStacks|ListStacks)$/, /^kms:GetPublicKey$/,
    /^states:(StartExecution|ListStateMachines)$/, /^iam:(ListRolePolicies|DeleteRolePolicy|ListAttachedRolePolicies|DetachRolePolicy|ListRoleTags|UntagRole|List\*|GetRole|GetPolicy|GetPolicyVersion)$/,
    /^cognito-idp:(AdminCreateUser|AdminAddUserToGroup|AdminGetUser)$/,
    /^(ec2:Describe(Vpcs|Subnets|Instances)|servicequotas:GetServiceQuota|cloudtrail:DescribeTrails|guardduty:ListDetectors|config:DescribeConfigurationRecorders|inspector2:BatchGetAccountStatus|access-analyzer:ListAnalyzers|ses:GetAccount|organizations:DescribeOrganization|lambda:ListFunctions)$/,
  ],
};

function rolePolicies(roleLogicalId: string, role: Resource): unknown[] {
  const inline = ((prop(role, 'Policies') as { PolicyDocument: unknown }[] | undefined) ?? []).map((p) => p.PolicyDocument);
  const extra = Object.values(resources())
    .filter((r) => r.Type === 'AWS::IAM::RolePolicy' && JSON.stringify(prop(r, 'RoleName')) === JSON.stringify({ Ref: roleLogicalId }))
    .map((r) => prop(r, 'PolicyDocument'));
  return [...inline, ...extra];
}

describe('01 §6.9: function roles only hold the listed operations', () => {
  for (const [roleName, allowed] of Object.entries(ROLE_ALLOW_LIST)) {
    it(roleName, () => {
      const entry = Object.entries(resources()).find(([, r]) => r.Type === 'AWS::IAM::Role' && prop(r, 'RoleName') === roleName);
      expect(entry, roleName).toBeTruthy();
      const [id, role] = entry!;
      const actions = rolePolicies(id, role).flatMap((d) => actionsOf(d));
      expect(actions.length).toBeGreaterThan(0);
      const extra = actions.filter((a) => !allowed.some((re) => re.test(a)));
      expect(extra, `${roleName} holds operations outside 01 §6.9`).toEqual([]);
      expect(actions.some((a) => a === '*' || a.endsWith(':*'))).toBe(false);
    });
  }
});
