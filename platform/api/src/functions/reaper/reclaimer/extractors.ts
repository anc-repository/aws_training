/**
 * CloudTrail creation events → resources (02 §7.3 extractor table). Used by the reclaim scan (CLOUDTRAIL source) and by
 * OwnershipLookup (7.12). Write events that match a creation prefix but no extractor become REVIEW items
 * (“unrecognised creation event”).
 */
import type { TrailEvent } from '@atl/shared';

export interface ParsedEvent {
  eventId: string;
  eventName: string;
  eventSource: string;
  service: string;
  eventTime: string;
  region: string;
  errorCode: string | null;
  readOnly: boolean;
  userArn: string | null;
  /** role session name of an assumed-role caller */
  sessionName: string | null;
  /** `userIdentity.sessionContext.sessionIssuer.arn` */
  issuerArn: string | null;
  request: Record<string, unknown>;
  response: Record<string, unknown>;
}

export interface ExtractedRef {
  type: string;
  id: string;
  arn?: string | null;
  name?: string | null;
  region?: string;
  meta?: Record<string, unknown>;
  /**
   * The event creates *or overwrites* (PutMetricAlarm, PutRule, Route 53 UPSERT, Put*Config*, inspector2 Enable): it
   * succeeds just as well on a resource that existed before the session, so it is no creation evidence (02 §7.2 rule
   * 1, §7.3 “只删除本会话创建的记录 / 只处理本会话开启的”). Such refs are recorded for review only.
   */
  overwrite?: boolean;
}

type Obj = Record<string, unknown>;
const o = (v: unknown): Obj => (v && typeof v === 'object' ? (v as Obj) : {});
const s = (v: unknown): string | null => (typeof v === 'string' && v ? v : null);
const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);

export function parseTrailEvent(e: TrailEvent): ParsedEvent {
  let raw: Obj = {};
  try {
    raw = e.cloudTrailEvent ? (JSON.parse(e.cloudTrailEvent) as Obj) : {};
  } catch {
    raw = {};
  }
  const ui = o(raw.userIdentity);
  const userArn = s(ui.arn);
  const sessionName = userArn && /:assumed-role\/[^/]+\/(.+)$/.exec(userArn)?.[1];
  const issuer = o(o(ui.sessionContext).sessionIssuer);
  const source = s(raw.eventSource) ?? e.eventSource ?? '';
  return {
    eventId: s(raw.eventID) ?? e.eventId,
    eventName: s(raw.eventName) ?? e.eventName,
    eventSource: source,
    service: source.replace(/\.amazonaws\.com$/, ''),
    eventTime: s(raw.eventTime) ?? e.eventTime,
    region: s(raw.awsRegion) ?? e.region,
    errorCode: s(raw.errorCode),
    readOnly: raw.readOnly === true || e.readOnly === true,
    userArn,
    sessionName: sessionName ?? (e.username && /^atl-/.test(e.username) ? e.username : null),
    issuerArn: s(issuer.arn),
    request: o(raw.requestParameters),
    response: o(raw.responseElements),
  };
}

/** Creation-like event names (02 §7.3 client-side filter). */
export const WRITE_PREFIXES = ['Create', 'Run', 'Allocate', 'Put', 'Register', 'Request', 'Import', 'Copy', 'Start', 'Enable', 'Associate', 'Publish', 'Subscribe'];

export function looksLikeCreation(eventName: string): boolean {
  return WRITE_PREFIXES.some((p) => eventName.startsWith(p));
}

type Extractor = (ev: ParsedEvent) => ExtractedRef[];
const one = (type: string, id: string | null, extra: Partial<ExtractedRef> = {}): ExtractedRef[] => (id ? [{ type, id, ...extra }] : []);
/** create-or-overwrite: never creation evidence on its own (see ExtractedRef.overwrite) */
const upsert = (type: string, id: string | null, extra: Partial<ExtractedRef> = {}): ExtractedRef[] => one(type, id, { ...extra, overwrite: true });

const EXTRACTORS: Record<string, Extractor> = {
  'ec2:RunInstances': (ev) =>
    arr(o(o(ev.response).instancesSet).items).flatMap((i) => one('AWS::EC2::Instance', s(o(i).instanceId))),
  'ec2:CreateVolume': (ev) => one('AWS::EC2::Volume', s(ev.response.volumeId)),
  'ec2:CreateSnapshot': (ev) => one('AWS::EC2::Snapshot', s(ev.response.snapshotId)),
  'ec2:CreateImage': (ev) => one('AWS::EC2::Image', s(ev.response.imageId)),
  'ec2:RegisterImage': (ev) => one('AWS::EC2::Image', s(ev.response.imageId)),
  'ec2:CopyImage': (ev) => one('AWS::EC2::Image', s(ev.response.imageId)),
  'ec2:AllocateAddress': (ev) => one('AWS::EC2::EIP', s(ev.response.allocationId)),
  'ec2:CreateSecurityGroup': (ev) => one('AWS::EC2::SecurityGroup', s(ev.response.groupId)),
  'ec2:CreateKeyPair': (ev) => one('AWS::EC2::KeyPair', s(ev.response.keyName) ?? s(ev.request.keyName), { meta: { keyPairId: s(ev.response.keyPairId) } }),
  'ec2:ImportKeyPair': (ev) => one('AWS::EC2::KeyPair', s(ev.response.keyName) ?? s(ev.request.keyName)),
  'ec2:CreateLaunchTemplate': (ev) => one('AWS::EC2::LaunchTemplate', s(o(o(ev.response.CreateLaunchTemplateResponse ?? ev.response).launchTemplate).launchTemplateId)),
  'ec2:CreateVpc': (ev) => one('AWS::EC2::VPC', s(o(ev.response.vpc).vpcId)),
  'ec2:CreateSubnet': (ev) => one('AWS::EC2::Subnet', s(o(ev.response.subnet).subnetId)),
  'ec2:CreateInternetGateway': (ev) => one('AWS::EC2::InternetGateway', s(o(ev.response.internetGateway).internetGatewayId)),
  'ec2:CreateRouteTable': (ev) => one('AWS::EC2::RouteTable', s(o(ev.response.routeTable).routeTableId)),
  'ec2:CreateNatGateway': (ev) => one('AWS::EC2::NatGateway', s(o(o(ev.response.CreateNatGatewayResponse ?? ev.response).natGateway).natGatewayId)),
  'ec2:CreateVpcEndpoint': (ev) => one('AWS::EC2::VPCEndpoint', s(o(o(ev.response.CreateVpcEndpointResponse ?? ev.response).vpcEndpoint).vpcEndpointId)),
  'ec2:CreateNetworkInterface': (ev) => one('AWS::EC2::NetworkInterface', s(o(ev.response.networkInterface).networkInterfaceId)),
  'ec2:CreateFlowLogs': (ev) => arr(o(ev.response.CreateFlowLogsResponse ?? ev.response).flowLogIdSet).flatMap((x) => one('AWS::EC2::FlowLog', s(o(x).item) ?? s(x))),
  'ec2:CreateInstanceConnectEndpoint': (ev) => one('AWS::EC2::InstanceConnectEndpoint', s(o(o(ev.response.CreateInstanceConnectEndpointResponse ?? ev.response).instanceConnectEndpoint).instanceConnectEndpointId)),
  'autoscaling:CreateAutoScalingGroup': (ev) => one('AWS::AutoScaling::AutoScalingGroup', s(ev.request.autoScalingGroupName)),
  'elasticloadbalancing:CreateLoadBalancer': (ev) => arr(ev.response.loadBalancers).flatMap((x) => one('AWS::ElasticLoadBalancingV2::LoadBalancer', s(o(x).loadBalancerArn), { arn: s(o(x).loadBalancerArn) })),
  'elasticloadbalancing:CreateTargetGroup': (ev) => arr(ev.response.targetGroups).flatMap((x) => one('AWS::ElasticLoadBalancingV2::TargetGroup', s(o(x).targetGroupArn), { arn: s(o(x).targetGroupArn) })),
  's3:CreateBucket': (ev) => one('AWS::S3::Bucket', s(ev.request.bucketName), { name: s(ev.request.bucketName) }),
  'rds:CreateDBInstance': (ev) => one('AWS::RDS::DBInstance', s(ev.response.dBInstanceIdentifier) ?? s(ev.request.dBInstanceIdentifier), { arn: s(ev.response.dBInstanceArn) }),
  'rds:CreateDBInstanceReadReplica': (ev) => one('AWS::RDS::DBInstance', s(ev.response.dBInstanceIdentifier) ?? s(ev.request.dBInstanceIdentifier), { arn: s(ev.response.dBInstanceArn) }),
  'rds:RestoreDBInstanceFromDBSnapshot': (ev) => one('AWS::RDS::DBInstance', s(ev.response.dBInstanceIdentifier) ?? s(ev.request.dBInstanceIdentifier)),
  'rds:RestoreDBInstanceToPointInTime': (ev) => one('AWS::RDS::DBInstance', s(ev.response.dBInstanceIdentifier) ?? s(ev.request.targetDBInstanceIdentifier)),
  'rds:CreateDBCluster': (ev) => one('AWS::RDS::DBCluster', s(ev.response.dBClusterIdentifier) ?? s(ev.request.dBClusterIdentifier)),
  'rds:CreateDBSnapshot': (ev) => one('AWS::RDS::DBSnapshot', s(ev.response.dBSnapshotIdentifier) ?? s(ev.request.dBSnapshotIdentifier)),
  'rds:CreateDBProxy': (ev) => one('AWS::RDS::DBProxy', s(o(ev.response.dBProxy).dBProxyName) ?? s(ev.request.dBProxyName)),
  'rds:CreateDBSubnetGroup': (ev) => one('AWS::RDS::DBSubnetGroup', s(ev.request.dBSubnetGroupName)),
  'rds:CreateDBParameterGroup': (ev) => one('AWS::RDS::DBParameterGroup', s(ev.request.dBParameterGroupName)),
  'elasticache:CreateReplicationGroup': (ev) => one('AWS::ElastiCache::ReplicationGroup', s(ev.request.replicationGroupId)),
  'elasticache:CreateCacheCluster': (ev) => one('AWS::ElastiCache::CacheCluster', s(ev.request.cacheClusterId)),
  'elasticache:CreateServerlessCache': (ev) => one('AWS::ElastiCache::ServerlessCache', s(ev.request.serverlessCacheName)),
  'elasticache:CreateCacheSubnetGroup': (ev) => one('AWS::ElastiCache::SubnetGroup', s(ev.request.cacheSubnetGroupName)),
  'elasticfilesystem:CreateFileSystem': (ev) => one('AWS::EFS::FileSystem', s(ev.response.fileSystemId)),
  'elasticfilesystem:CreateMountTarget': (ev) => one('AWS::EFS::MountTarget', s(ev.response.mountTargetId)),
  'elasticfilesystem:CreateAccessPoint': (ev) => one('AWS::EFS::AccessPoint', s(ev.response.accessPointId)),
  'dynamodb:CreateTable': (ev) => one('AWS::DynamoDB::Table', s(o(ev.response.tableDescription).tableName) ?? s(ev.request.tableName), { arn: s(o(ev.response.tableDescription).tableArn) }),
  'dynamodb:RestoreTableFromBackup': (ev) => one('AWS::DynamoDB::Table', s(ev.request.targetTableName)),
  'dynamodb:RestoreTableToPointInTime': (ev) => one('AWS::DynamoDB::Table', s(ev.request.targetTableName)),
  'dynamodb:CreateBackup': (ev) => one('AWS::DynamoDB::Backup', s(o(ev.response.backupDetails).backupArn), { arn: s(o(ev.response.backupDetails).backupArn) }),
  'lambda:CreateFunction20150331': (ev) => one('AWS::Lambda::Function', s(ev.response.functionName) ?? s(ev.request.functionName), { arn: s(ev.response.functionArn) }),
  'lambda:CreateEventSourceMapping20150331': (ev) => one('AWS::Lambda::EventSourceMapping', s(ev.response.uUID) ?? s(ev.response.UUID)),
  'lambda:PublishLayerVersion20181031': (ev) => one('AWS::Lambda::LayerVersion', s(ev.response.layerVersionArn), { arn: s(ev.response.layerVersionArn) }),
  'sqs:CreateQueue': (ev) => one('AWS::SQS::Queue', s(ev.response.queueUrl)),
  'sns:CreateTopic': (ev) => one('AWS::SNS::Topic', s(ev.response.topicArn), { arn: s(ev.response.topicArn) }),
  'sns:Subscribe': (ev) => one('AWS::SNS::Subscription', s(ev.response.subscriptionArn), { arn: s(ev.response.subscriptionArn) }),
  'apigateway:CreateApi': (ev) => one('AWS::ApiGatewayV2::Api', s(ev.response.apiId)),
  'apigateway:CreateRestApi': (ev) => one('AWS::ApiGateway::RestApi', s(ev.response.id)),
  'cloudfront:CreateDistribution': (ev) => one('AWS::CloudFront::Distribution', s(o(ev.response.distribution).id), { region: 'us-east-1' }),
  'cloudfront:CreateDistributionWithTags': (ev) => one('AWS::CloudFront::Distribution', s(o(ev.response.distribution).id), { region: 'us-east-1' }),
  'cloudfront:CreateOriginAccessControl': (ev) => one('AWS::CloudFront::OriginAccessControl', s(o(ev.response.originAccessControl).id), { region: 'us-east-1' }),
  'cloudfront:CreateCachePolicy': (ev) => one('AWS::CloudFront::CachePolicy', s(o(ev.response.cachePolicy).id), { region: 'us-east-1' }),
  'cloudfront:CreateFunction': (ev) => one('AWS::CloudFront::Function', s(o(ev.response.functionSummary).name) ?? s(ev.request.name), { region: 'us-east-1' }),
  'wafv2:CreateWebACL': (ev) => one('AWS::WAFv2::WebACL', s(o(ev.response.summary).aRN) ?? s(o(ev.response.summary).ARN), { arn: s(o(ev.response.summary).aRN) ?? s(o(ev.response.summary).ARN) }),
  'wafv2:CreateIPSet': (ev) => one('AWS::WAFv2::IPSet', s(o(ev.response.summary).aRN) ?? s(o(ev.response.summary).ARN)),
  'wafv2:CreateRuleGroup': (ev) => one('AWS::WAFv2::RuleGroup', s(o(ev.response.summary).aRN) ?? s(o(ev.response.summary).ARN)),
  'acm:RequestCertificate': (ev) => one('AWS::CertificateManager::Certificate', s(ev.response.certificateArn), { arn: s(ev.response.certificateArn) }),
  'route53:CreateHostedZone': (ev) => one('AWS::Route53::HostedZone', s(o(ev.response.hostedZone).id)?.replace(/^\/hostedzone\//, '') ?? null, { region: 'us-east-1' }),
  // CREATE fails on an existing record (creation evidence); UPSERT also rewrites records of the learner's own zones
  'route53:ChangeResourceRecordSets': (ev) =>
    arr(o(ev.request.changeBatch).changes)
      .map((c) => o(c))
      .filter((c) => c.action === 'CREATE' || c.action === 'UPSERT')
      .flatMap((c) => {
        const rr = o(c.resourceRecordSet);
        const zone = s(ev.request.hostedZoneId);
        const id = zone && s(rr.name) ? `${zone}|${s(rr.name)}|${s(rr.type)}` : null;
        return c.action === 'CREATE' ? one('AWS::Route53::RecordSet', id, { region: 'us-east-1' }) : upsert('AWS::Route53::RecordSet', id, { region: 'us-east-1' });
      }),
  'cognito-idp:CreateUserPool': (ev) => one('AWS::Cognito::UserPool', s(o(ev.response.userPool).id)),
  'cognito-idp:CreateUserPoolDomain': (ev) => one('AWS::Cognito::UserPoolDomain', s(ev.request.domain), { meta: { userPoolId: s(ev.request.userPoolId) } }),
  'cognito-identity:CreateIdentityPool': (ev) => one('AWS::Cognito::IdentityPool', s(ev.response.identityPoolId)),
  'kms:CreateKey': (ev) => one('AWS::KMS::Key', s(o(ev.response.keyMetadata).keyId), { arn: s(o(ev.response.keyMetadata).arn) }),
  'kms:CreateAlias': (ev) => one('AWS::KMS::Alias', s(ev.request.aliasName)),
  'secretsmanager:CreateSecret': (ev) => one('AWS::SecretsManager::Secret', s(ev.response.arn), { arn: s(ev.response.arn), name: s(ev.response.name) }),
  'ssm:PutParameter': (ev) => (ev.request.overwrite === true ? [] : one('AWS::SSM::Parameter', s(ev.request.name), { name: s(ev.request.name) })),
  'ssm:CreateDocument': (ev) => one('AWS::SSM::Document', s(o(ev.response.documentDescription).name) ?? s(ev.request.name)),
  'ssm:CreateAssociation': (ev) => one('AWS::SSM::Association', s(o(ev.response.associationDescription).associationId)),
  'logs:CreateLogGroup': (ev) => one('AWS::Logs::LogGroup', s(ev.request.logGroupName), { name: s(ev.request.logGroupName) }),
  'monitoring:PutMetricAlarm': (ev) => upsert('AWS::CloudWatch::Alarm', s(ev.request.alarmName), { name: s(ev.request.alarmName) }),
  'monitoring:PutDashboard': (ev) => upsert('AWS::CloudWatch::Dashboard', s(ev.request.dashboardName)),
  'events:PutRule': (ev) => upsert('AWS::Events::Rule', s(ev.request.name) ? `${s(ev.request.eventBusName) ?? 'default'}|${s(ev.request.name)}` : null, { arn: s(ev.response.ruleArn) }),
  'events:CreateEventBus': (ev) => one('AWS::Events::EventBus', s(ev.request.name)),
  'scheduler:CreateSchedule': (ev) => one('AWS::Scheduler::Schedule', s(ev.request.name) ? `${s(ev.request.groupName) ?? 'default'}|${s(ev.request.name)}` : null),
  'scheduler:CreateScheduleGroup': (ev) => one('AWS::Scheduler::ScheduleGroup', s(ev.request.name)),
  'states:CreateStateMachine': (ev) => one('AWS::StepFunctions::StateMachine', s(ev.response.stateMachineArn), { arn: s(ev.response.stateMachineArn) }),
  'firehose:CreateDeliveryStream': (ev) => one('AWS::KinesisFirehose::DeliveryStream', s(ev.request.deliveryStreamName)),
  'glue:CreateDatabase': (ev) => one('AWS::Glue::Database', s(o(ev.request.databaseInput).name)),
  'glue:CreateTable': (ev) => one('AWS::Glue::Table', s(ev.request.databaseName) ? `${s(ev.request.databaseName)}|${s(o(ev.request.tableInput).name)}` : null),
  'glue:CreateCrawler': (ev) => one('AWS::Glue::Crawler', s(ev.request.name)),
  'athena:CreateWorkGroup': (ev) => one('AWS::Athena::WorkGroup', s(ev.request.name)),
  'backup:CreateBackupPlan': (ev) => one('AWS::Backup::BackupPlan', s(ev.response.backupPlanId)),
  'backup:CreateBackupVault': (ev) => one('AWS::Backup::BackupVault', s(ev.request.backupVaultName) ?? s(ev.response.backupVaultName)),
  'backup:StartBackupJob': (ev) => one('AWS::Backup::RecoveryPoint', s(ev.response.recoveryPointArn), { arn: s(ev.response.recoveryPointArn) }),
  'backup:StartCopyJob': (ev) => one('AWS::Backup::RecoveryPoint', s(ev.response.copyJobId)),
  'cloudtrail:CreateTrail': (ev) => one('AWS::CloudTrail::Trail', s(ev.response.trailARN) ?? s(ev.request.name), { arn: s(ev.response.trailARN) }),
  'guardduty:CreateDetector': (ev) => one('AWS::GuardDuty::Detector', s(ev.response.detectorId)),
  'config:PutConfigurationRecorder': (ev) => upsert('AWS::Config::ConfigurationRecorder', s(o(ev.request.configurationRecorder).name)),
  'config:PutDeliveryChannel': (ev) => upsert('AWS::Config::DeliveryChannel', s(o(ev.request.deliveryChannel).name)),
  'config:PutConfigRule': (ev) => upsert('AWS::Config::ConfigRule', s(o(ev.request.configRule).configRuleName)),
  'inspector2:Enable': (ev) => upsert('AWS::Inspector2::Enabler', `${(arr(ev.request.resourceTypes) as string[]).sort().join(',') || 'all'}`),
  'securityhub:EnableSecurityHub': () => one('AWS::SecurityHub::Hub', 'default'),
  'imagebuilder:CreateImagePipeline': (ev) => one('AWS::ImageBuilder::ImagePipeline', s(ev.response.imagePipelineArn), { arn: s(ev.response.imagePipelineArn) }),
  'imagebuilder:CreateImageRecipe': (ev) => one('AWS::ImageBuilder::ImageRecipe', s(ev.response.imageRecipeArn), { arn: s(ev.response.imageRecipeArn) }),
  'imagebuilder:CreateComponent': (ev) => one('AWS::ImageBuilder::Component', s(ev.response.componentBuildVersionArn), { arn: s(ev.response.componentBuildVersionArn) }),
  'imagebuilder:CreateInfrastructureConfiguration': (ev) => one('AWS::ImageBuilder::InfrastructureConfiguration', s(ev.response.infrastructureConfigurationArn)),
  'imagebuilder:CreateDistributionConfiguration': (ev) => one('AWS::ImageBuilder::DistributionConfiguration', s(ev.response.distributionConfigurationArn)),
  'iam:CreateRole': (ev) => one('AWS::IAM::Role', s(o(ev.response.role).roleName) ?? s(ev.request.roleName), { arn: s(o(ev.response.role).arn), region: 'us-east-1' }),
  'iam:CreatePolicy': (ev) => one('AWS::IAM::ManagedPolicy', s(o(ev.response.policy).arn), { arn: s(o(ev.response.policy).arn), region: 'us-east-1' }),
  'iam:CreateInstanceProfile': (ev) => one('AWS::IAM::InstanceProfile', s(ev.request.instanceProfileName), { region: 'us-east-1' }),
  'iam:CreateUser': (ev) => one('AWS::IAM::User', s(ev.request.userName), { region: 'us-east-1' }),
  'iam:CreateAccessKey': (ev) => one('AWS::IAM::AccessKey', s(o(ev.response.accessKey).accessKeyId), { region: 'us-east-1', meta: { userName: s(ev.request.userName) } }),
  'cloudformation:CreateStack': (ev) => one('AWS::CloudFormation::Stack', s(ev.request.stackName), { arn: s(ev.response.stackId) }),
  'budgets:CreateBudget': (ev) => one('AWS::Budgets::Budget', s(o(ev.request.budget).budgetName)),
  'ses:CreateEmailIdentity': (ev) => one('AWS::SES::EmailIdentity', s(ev.request.emailIdentity)),
  'sesv2:CreateEmailIdentity': (ev) => one('AWS::SES::EmailIdentity', s(ev.request.emailIdentity)),
};

/** Service-linked roles are always kept (7.3: CreateServiceLinkedRole). */
export const IGNORED_EVENTS = new Set(['iam:CreateServiceLinkedRole', 'sts:AssumeRole', 'ssm:StartSession', 'ssm:SendCommand', 'logs:CreateLogStream', 'logs:PutLogEvents', 'kms:CreateGrant']);

/** `null` when the event has no extractor (→ REVIEW when it looks like a creation). */
export function extractRefs(ev: ParsedEvent): ExtractedRef[] | null {
  const key = `${ev.service}:${ev.eventName}`;
  if (IGNORED_EVENTS.has(key)) return [];
  const x = EXTRACTORS[key];
  if (!x) return null;
  return x(ev).map((r) => ({ ...r, region: r.region ?? ev.region }));
}

/** Creation event names per resource type (OwnershipLookup's `EventName` fallback, 7.12 rule 3). */
export function creationEventsFor(type: string): { service: string; eventName: string }[] {
  return Object.entries(TYPE_OF)
    .filter(([, t]) => t === type)
    .map(([key]) => {
      const [service, eventName] = key.split(':') as [string, string];
      return { service, eventName };
    });
}

/** Type of each extractor (the extractors return nothing for an empty event, so the mapping is explicit). */
const TYPE_OF: Record<string, string> = Object.fromEntries(
  Object.entries({
    'AWS::EC2::Instance': ['ec2:RunInstances'],
    'AWS::EC2::Volume': ['ec2:CreateVolume'],
    'AWS::EC2::Snapshot': ['ec2:CreateSnapshot'],
    'AWS::EC2::Image': ['ec2:CreateImage', 'ec2:RegisterImage', 'ec2:CopyImage'],
    'AWS::EC2::EIP': ['ec2:AllocateAddress'],
    'AWS::EC2::SecurityGroup': ['ec2:CreateSecurityGroup'],
    'AWS::EC2::KeyPair': ['ec2:CreateKeyPair', 'ec2:ImportKeyPair'],
    'AWS::EC2::VPC': ['ec2:CreateVpc'],
    'AWS::EC2::NatGateway': ['ec2:CreateNatGateway'],
    'AWS::S3::Bucket': ['s3:CreateBucket'],
    'AWS::RDS::DBInstance': ['rds:CreateDBInstance', 'rds:CreateDBInstanceReadReplica', 'rds:RestoreDBInstanceFromDBSnapshot', 'rds:RestoreDBInstanceToPointInTime'],
    'AWS::DynamoDB::Table': ['dynamodb:CreateTable'],
    'AWS::Lambda::Function': ['lambda:CreateFunction20150331'],
    'AWS::SQS::Queue': ['sqs:CreateQueue'],
    'AWS::SNS::Topic': ['sns:CreateTopic'],
    'AWS::CloudFront::Distribution': ['cloudfront:CreateDistribution', 'cloudfront:CreateDistributionWithTags'],
    'AWS::WAFv2::WebACL': ['wafv2:CreateWebACL'],
    'AWS::CertificateManager::Certificate': ['acm:RequestCertificate'],
    'AWS::Route53::HostedZone': ['route53:CreateHostedZone'],
    'AWS::Cognito::UserPool': ['cognito-idp:CreateUserPool'],
    'AWS::KMS::Key': ['kms:CreateKey'],
    'AWS::SecretsManager::Secret': ['secretsmanager:CreateSecret'],
    'AWS::Logs::LogGroup': ['logs:CreateLogGroup'],
    'AWS::IAM::Role': ['iam:CreateRole'],
    'AWS::IAM::ManagedPolicy': ['iam:CreatePolicy'],
    'AWS::CloudFormation::Stack': ['cloudformation:CreateStack'],
    'AWS::ApiGatewayV2::Api': ['apigateway:CreateApi'],
    'AWS::ApiGateway::RestApi': ['apigateway:CreateRestApi'],
  }).flatMap(([type, keys]) => keys.map((k) => [k, type])),
);
