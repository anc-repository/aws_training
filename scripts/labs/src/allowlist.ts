/**
 * 04 §5.7: the read-only API base whitelist of `aws-readonly` checks (service = IAM prefix, action = SDK operation name),
 * the SDK → IAM action exceptions, and the actions that must never appear (“刻意不授予”). Transcribed from the doc;
 * `labs:policy` intersects the content's actions with this list (actions outside it fail the build).
 */

export const BASE_ALLOWLIST: Readonly<Record<string, readonly string[]>> = {
  acm: ['DescribeCertificate', 'ListCertificates'],
  apigateway: ['GetApis', 'GetApi'],
  autoscaling: ['DescribeAutoScalingGroups', 'DescribeAutoScalingInstances', 'DescribeLifecycleHooks', 'DescribePolicies', 'DescribeScalingActivities', 'DescribeScheduledActions'],
  athena: ['GetWorkGroup', 'GetQueryExecution'],
  backup: ['DescribeBackupVault', 'GetBackupPlan', 'GetBackupSelection', 'ListBackupPlans', 'ListBackupSelections', 'ListBackupVaults',
    'ListRecoveryPointsByBackupVault', 'ListRecoveryPointsByResource', 'ListCopyJobs'],
  budgets: ['DescribeBudgets', 'DescribeNotificationsForBudget', 'DescribeBudgetActionsForBudget'],
  ce: ['ListCostAllocationTags'],
  cloudformation: ['DescribeStacks', 'ListStackResources', 'ListStacks', 'DescribeStackEvents'],
  cloudfront: ['GetCachePolicy', 'GetDistribution', 'GetDistributionConfig', 'GetOriginAccessControl', 'GetOriginRequestPolicy', 'GetResponseHeadersPolicy',
    'ListDistributions', 'ListOriginAccessControls', 'ListTagsForResource', 'GetInvalidation', 'ListInvalidations', 'ListCachePolicies'],
  cloudtrail: ['DescribeTrails', 'GetEventSelectors', 'GetTrailStatus', 'LookupEvents'],
  cloudwatch: ['DescribeAlarms', 'GetMetricData', 'ListDashboards', 'ListMetrics'],
  'cognito-identity': ['DescribeIdentityPool', 'GetIdentityPoolRoles'],
  'cognito-idp': ['DescribeUserPool', 'DescribeUserPoolClient', 'DescribeUserPoolDomain', 'GetUserPoolMfaConfig', 'ListGroups', 'ListUserPoolClients'],
  config: ['DescribeConfigurationRecorders', 'DescribeConfigurationRecorderStatus', 'DescribeConfigRules', 'DescribeComplianceByConfigRule',
    'GetComplianceDetailsByConfigRule', 'GetResourceConfigHistory'],
  dynamodb: ['DescribeContinuousBackups', 'DescribeTable', 'DescribeTimeToLive', 'ListTables'],
  ec2: ['DescribeAddresses', 'DescribeFlowLogs', 'DescribeIamInstanceProfileAssociations', 'DescribeInstances', 'DescribeInternetGateways',
    'DescribeLaunchTemplateVersions', 'DescribeLaunchTemplates', 'DescribeManagedPrefixLists', 'DescribeNatGateways', 'DescribeNetworkAcls',
    'DescribeRouteTables', 'DescribeSecurityGroupRules', 'DescribeSecurityGroups', 'DescribeSubnets', 'DescribeVolumes', 'DescribeVpcEndpoints',
    'DescribeVpcs', 'GetEbsEncryptionByDefault', 'DescribeInstanceAttribute', 'DescribeTags', 'DescribeImages', 'DescribeSnapshots',
    'DescribeInstanceConnectEndpoints'],
  elasticache: ['DescribeCacheClusters', 'DescribeCacheSubnetGroups', 'DescribeReplicationGroups', 'DescribeServerlessCaches'],
  elasticfilesystem: ['DescribeFileSystems', 'DescribeMountTargets', 'DescribeAccessPoints'],
  elasticloadbalancing: ['DescribeListeners', 'DescribeLoadBalancerAttributes', 'DescribeLoadBalancers', 'DescribeRules', 'DescribeTargetGroups',
    'DescribeTargetHealth', 'DescribeTags'],
  events: ['DescribeRule', 'ListRules', 'ListTargetsByRule'],
  scheduler: ['GetSchedule', 'ListSchedules'],
  firehose: ['DescribeDeliveryStream', 'ListDeliveryStreams'],
  glue: ['GetTable'],
  guardduty: ['GetDetector', 'GetFindingsStatistics', 'ListDetectors', 'ListFindings'],
  iam: ['GetAccountSummary', 'GetInstanceProfile', 'GetRole', 'ListAttachedRolePolicies', 'ListRolePolicies', 'ListAccessKeys'],
  imagebuilder: ['GetImagePipeline', 'ListImagePipelineImages', 'GetImage'],
  inspector2: ['BatchGetAccountStatus', 'ListCoverage', 'ListFindings', 'ListFindingAggregations', 'GetEc2DeepInspectionConfiguration'],
  kms: ['DescribeKey', 'GetKeyPolicy', 'GetKeyRotationStatus', 'ListAliases'],
  lambda: ['GetEventSourceMapping', 'GetFunctionConcurrency', 'GetFunctionConfiguration', 'GetFunctionEventInvokeConfig', 'GetPolicy', 'ListAliases',
    'ListEventSourceMappings', 'ListFunctions'],
  logs: ['DescribeLogGroups', 'DescribeLogStreams', 'DescribeMetricFilters'],
  rds: ['DescribeDBInstances', 'DescribeDBProxies', 'DescribeDBProxyTargets', 'DescribeDBSnapshots', 'DescribeDBSubnetGroups'],
  route53: ['GetHostedZone', 'ListHostedZones', 'ListHostedZonesByName', 'ListResourceRecordSets', 'GetHealthCheckStatus'],
  s3: ['GetPublicAccessBlock', 'GetBucketCors', 'GetBucketLocation', 'GetBucketNotificationConfiguration', 'GetBucketOwnershipControls', 'GetBucketPolicy',
    'GetBucketPolicyStatus', 'GetBucketTagging', 'GetBucketVersioning', 'GetBucketEncryption', 'GetBucketLifecycleConfiguration', 'GetBucketReplication',
    'ListBuckets'],
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

/** SDK operation → IAM action where the names differ (04 §5.7 table; the official Service Authorization Reference rules). */
const IAM_EXCEPTIONS: Readonly<Record<string, string>> = {
  's3:GetPublicAccessBlock': 's3:GetBucketPublicAccessBlock',
  's3control:GetPublicAccessBlock': 's3:GetAccountPublicAccessBlock',
  's3:GetBucketNotificationConfiguration': 's3:GetBucketNotification',
  's3:GetBucketEncryption': 's3:GetEncryptionConfiguration',
  's3:GetBucketLifecycleConfiguration': 's3:GetLifecycleConfiguration',
  's3:GetBucketReplication': 's3:GetReplicationConfiguration',
  's3:GetBucketCors': 's3:GetBucketCORS',
  's3:ListBuckets': 's3:ListAllMyBuckets',
  'budgets:DescribeBudgets': 'budgets:ViewBudget',
  'budgets:DescribeNotificationsForBudget': 'budgets:ViewBudget',
  'apigateway:GetApis': 'apigateway:GET',
  'apigateway:GetApi': 'apigateway:GET',
};

/** 04 §5.7 “刻意不授予”: never allowed in content (IAM action names). */
export const FORBIDDEN_IAM_ACTIONS: readonly string[] = [
  's3:GetObject', 's3:ListBucket', 'secretsmanager:GetSecretValue', 'ssm:GetParameter', 'ssm:GetParameters', 'ssm:GetParametersByPath', 'kms:Decrypt',
  'kms:GenerateDataKey', 'dynamodb:GetItem', 'dynamodb:Query', 'dynamodb:Scan', 'sqs:ReceiveMessage', 'lambda:GetFunction', 'logs:GetLogEvents',
  'logs:FilterLogEvents', 'cognito-idp:ListUsers', 'cognito-idp:AdminGetUser', 'ce:GetCostAndUsage',
];

export function isAllowed(service: string, action: string): boolean {
  return (BASE_ALLOWLIST[service] ?? []).includes(action);
}

export function iamActionOf(service: string, action: string): string {
  return IAM_EXCEPTIONS[`${service}:${action}`] ?? `${service === 's3control' ? 's3' : service}:${action}`;
}

/** Services whose control plane is global: `region: global` is the only sensible choice (04 §5.2.4). */
export const GLOBAL_SERVICES = new Set(['cloudfront', 'iam', 'route53']);

/** 04 §5.7: actions allowed with `region: dr-region`. */
export const DR_REGION_SERVICES = new Set(['backup', 's3', 'rds', 'route53']);
