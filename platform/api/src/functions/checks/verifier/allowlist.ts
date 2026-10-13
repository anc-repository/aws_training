/**
 * Read-only API allowlist of `aws-readonly` checks (04 §5.7): service = IAM service prefix (`s3control` for account-level
 * S3), action = SDK operation name. The code allowlist is the second gate after IAM: an action that is not listed here
 * returns `error/NOT_ALLOWED` without sending any request. `labs:policy` intersects the content's actions with this base
 * list and converts them to IAM actions with `iam-map.ts`.
 */

export const BASE_ALLOWLIST: Readonly<Record<string, readonly string[]>> = {
  acm: ['DescribeCertificate', 'ListCertificates'],
  apigateway: ['GetApis', 'GetApi'],
  autoscaling: [
    'DescribeAutoScalingGroups',
    'DescribeAutoScalingInstances',
    'DescribeLifecycleHooks',
    'DescribePolicies',
    'DescribeScalingActivities',
    'DescribeScheduledActions',
  ],
  athena: ['GetWorkGroup', 'GetQueryExecution'],
  backup: [
    'DescribeBackupVault',
    'GetBackupPlan',
    'GetBackupSelection',
    'ListBackupPlans',
    'ListBackupSelections',
    'ListBackupVaults',
    'ListRecoveryPointsByBackupVault',
    'ListRecoveryPointsByResource',
    'ListCopyJobs',
  ],
  budgets: ['DescribeBudgets', 'DescribeNotificationsForBudget', 'DescribeBudgetActionsForBudget'],
  ce: ['ListCostAllocationTags'],
  cloudformation: ['DescribeStacks', 'ListStackResources', 'ListStacks', 'DescribeStackEvents'],
  cloudfront: [
    'GetCachePolicy',
    'GetDistribution',
    'GetDistributionConfig',
    'GetOriginAccessControl',
    'GetOriginRequestPolicy',
    'GetResponseHeadersPolicy',
    'ListDistributions',
    'ListOriginAccessControls',
    'ListTagsForResource',
    'GetInvalidation',
    'ListInvalidations',
    'ListCachePolicies',
  ],
  cloudtrail: ['DescribeTrails', 'GetEventSelectors', 'GetTrailStatus', 'LookupEvents'],
  cloudwatch: ['DescribeAlarms', 'GetMetricData', 'ListDashboards', 'ListMetrics'],
  'cognito-identity': ['DescribeIdentityPool', 'GetIdentityPoolRoles'],
  'cognito-idp': ['DescribeUserPool', 'DescribeUserPoolClient', 'DescribeUserPoolDomain', 'GetUserPoolMfaConfig', 'ListGroups', 'ListUserPoolClients'],
  config: [
    'DescribeConfigurationRecorders',
    'DescribeConfigurationRecorderStatus',
    'DescribeConfigRules',
    'DescribeComplianceByConfigRule',
    'GetComplianceDetailsByConfigRule',
    'GetResourceConfigHistory',
  ],
  dynamodb: ['DescribeContinuousBackups', 'DescribeTable', 'DescribeTimeToLive', 'ListTables'],
  ec2: [
    'DescribeAddresses',
    'DescribeFlowLogs',
    'DescribeIamInstanceProfileAssociations',
    'DescribeInstances',
    'DescribeInternetGateways',
    'DescribeLaunchTemplateVersions',
    'DescribeLaunchTemplates',
    'DescribeManagedPrefixLists',
    'DescribeNatGateways',
    'DescribeNetworkAcls',
    'DescribeRouteTables',
    'DescribeSecurityGroupRules',
    'DescribeSecurityGroups',
    'DescribeSubnets',
    'DescribeVolumes',
    'DescribeVpcEndpoints',
    'DescribeVpcs',
    'GetEbsEncryptionByDefault',
    'DescribeInstanceAttribute',
    'DescribeTags',
    'DescribeImages',
    'DescribeSnapshots',
    'DescribeInstanceConnectEndpoints',
  ],
  elasticache: ['DescribeCacheClusters', 'DescribeCacheSubnetGroups', 'DescribeReplicationGroups', 'DescribeServerlessCaches'],
  elasticfilesystem: ['DescribeFileSystems', 'DescribeMountTargets', 'DescribeAccessPoints'],
  elasticloadbalancing: [
    'DescribeListeners',
    'DescribeLoadBalancerAttributes',
    'DescribeLoadBalancers',
    'DescribeRules',
    'DescribeTargetGroups',
    'DescribeTargetHealth',
    'DescribeTags',
  ],
  events: ['DescribeRule', 'ListRules', 'ListTargetsByRule'],
  scheduler: ['GetSchedule', 'ListSchedules'],
  firehose: ['DescribeDeliveryStream', 'ListDeliveryStreams'],
  glue: ['GetTable'],
  guardduty: ['GetDetector', 'GetFindingsStatistics', 'ListDetectors', 'ListFindings'],
  iam: ['GetAccountSummary', 'GetInstanceProfile', 'GetRole', 'ListAttachedRolePolicies', 'ListRolePolicies', 'ListAccessKeys'],
  imagebuilder: ['GetImagePipeline', 'ListImagePipelineImages', 'GetImage'],
  inspector2: ['BatchGetAccountStatus', 'ListCoverage', 'ListFindings', 'ListFindingAggregations', 'GetEc2DeepInspectionConfiguration'],
  kms: ['DescribeKey', 'GetKeyPolicy', 'GetKeyRotationStatus', 'ListAliases'],
  lambda: [
    'GetEventSourceMapping',
    'GetFunctionConcurrency',
    'GetFunctionConfiguration',
    'GetFunctionEventInvokeConfig',
    'GetPolicy',
    'ListAliases',
    'ListEventSourceMappings',
    'ListFunctions',
  ],
  logs: ['DescribeLogGroups', 'DescribeLogStreams', 'DescribeMetricFilters'],
  rds: ['DescribeDBInstances', 'DescribeDBProxies', 'DescribeDBProxyTargets', 'DescribeDBSnapshots', 'DescribeDBSubnetGroups'],
  route53: ['GetHostedZone', 'ListHostedZones', 'ListHostedZonesByName', 'ListResourceRecordSets', 'GetHealthCheckStatus'],
  s3: [
    'GetPublicAccessBlock',
    'GetBucketCors',
    'GetBucketLocation',
    'GetBucketNotificationConfiguration',
    'GetBucketOwnershipControls',
    'GetBucketPolicy',
    'GetBucketPolicyStatus',
    'GetBucketTagging',
    'GetBucketVersioning',
    'GetBucketEncryption',
    'GetBucketLifecycleConfiguration',
    'GetBucketReplication',
    'ListBuckets',
  ],
  s3control: ['GetPublicAccessBlock'],
  secretsmanager: ['DescribeSecret', 'ListSecrets'],
  ses: ['GetAccount', 'GetEmailIdentity', 'ListEmailIdentities'],
  states: ['DescribeStateMachine', 'ListExecutions'],
  sns: ['GetSubscriptionAttributes', 'GetTopicAttributes', 'ListSubscriptionsByTopic', 'ListTopics'],
  sqs: ['GetQueueAttributes', 'GetQueueUrl', 'ListDeadLetterSourceQueues', 'ListQueues', 'ListMessageMoveTasks'],
  ssm: ['DescribeInstanceInformation', 'DescribeParameters', 'GetConnectionStatus', 'DescribeSessions'],
  tag: ['GetResources'],
  wafv2: ['GetSampledRequests', 'GetWebACL', 'GetWebACLForResource', 'ListWebACLs'],
  xray: ['GetSamplingRules', 'GetServiceGraph', 'GetTraceSummaries'],
};

/**
 * Never granted (04 §5.7 “刻意不授予”), written as IAM actions; `labs:lint` rejects content that needs them and the engine
 * refuses them even if a future allowlist edit adds them by mistake.
 */
export const FORBIDDEN_IAM_ACTIONS = [
  's3:GetObject',
  's3:ListBucket',
  'secretsmanager:GetSecretValue',
  'ssm:GetParameter',
  'ssm:GetParameters',
  'ssm:GetParametersByPath',
  'kms:Decrypt',
  'kms:GenerateDataKey',
  'kms:GenerateDataKeyWithoutPlaintext',
  'dynamodb:GetItem',
  'dynamodb:Query',
  'dynamodb:Scan',
  'sqs:ReceiveMessage',
  'lambda:GetFunction',
  'logs:GetLogEvents',
  'logs:FilterLogEvents',
  'cognito-idp:ListUsers',
  'cognito-idp:AdminGetUser',
  'rekognition:*',
  'ce:GetCostAndUsage',
] as const;

/** `region: dr-region` checks may only use these services (04 §5.7). */
export const DR_REGION_SERVICES = ['backup', 's3', 'rds', 'route53'] as const;

/** Services whose control plane lives in us-east-1 (`region: global`, 04 §5.2.4). */
export const GLOBAL_SERVICES = ['cloudfront', 'iam', 'route53', 'budgets', 'ce'] as const;

export function isAllowed(service: string, action: string, allowlist: Readonly<Record<string, readonly string[]>> = BASE_ALLOWLIST): boolean {
  return Object.prototype.hasOwnProperty.call(allowlist, service) && allowlist[service]!.includes(action);
}

/** Every allowed `service:action` pair, sorted (for `labs:policy` and tests). */
export function allowlistPairs(allowlist: Readonly<Record<string, readonly string[]>> = BASE_ALLOWLIST): string[] {
  return Object.entries(allowlist)
    .flatMap(([s, actions]) => actions.map((a) => `${s}:${a}`))
    .sort();
}
