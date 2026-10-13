/**
 * Reclaim rules by resource type (02 §7.5 stages, §2.5 per-item deadlines, §7.6 billing) and the safety rails of 7.2
 * (platform resources and the keep list are never deleted). 01 §13 places the rule table in
 * `platform/workflows/reclaimer/`; it lives here because the production bundle of atl-reaper must not include
 * platform/workflows (the bundle guard of build.mjs).
 */
import type { ResourceBilling } from '@atl/shared';
import type { Stage } from '../../lifecycle/cloud/port.js';

export interface TypeRule {
  stage: Stage;
  billing: ResourceBilling;
  /** per-item deadline (02 §2.5): default 15 min; CloudFront 60; RDS, ElastiCache, EFS, Lambda ENIs 45 */
  deadlineMinutes: number;
}

const r = (stage: Stage, billing: ResourceBilling, deadlineMinutes = 15): TypeRule => ({ stage, billing, deadlineMinutes });

export const TYPE_RULES: Readonly<Record<string, TypeRule>> = {
  // S0 entry points and triggers
  'AWS::CloudFormation::Stack': r('S0', 'none', 60),
  'AWS::Events::Rule': r('S0', 'none'),
  'AWS::Scheduler::Schedule': r('S0', 'none'),
  'AWS::Scheduler::ScheduleGroup': r('S0', 'none'),
  'AWS::Lambda::EventSourceMapping': r('S0', 'none'),
  'AWS::SNS::Subscription': r('S0', 'none'),
  'AWS::AutoScaling::AutoScalingGroup': r('S0', 'hourly', 30),
  'AWS::ApiGateway::RestApi': r('S0', 'usage'),
  'AWS::ApiGatewayV2::Api': r('S0', 'usage'),
  'AWS::CloudFront::Distribution': r('S0', 'usage', 60),
  'AWS::CloudFront::Function': r('S0', 'usage'),
  'AWS::CloudFront::OriginAccessControl': r('S0', 'none'),
  'AWS::CloudFront::CachePolicy': r('S0', 'none'),
  'AWS::CloudFront::ResponseHeadersPolicy': r('S0', 'none'),
  'AWS::WAFv2::WebACLAssociation': r('S0', 'none'),
  'AWS::ElasticLoadBalancingV2::LoadBalancer': r('S0', 'hourly'),
  'AWS::ElasticLoadBalancingV2::TargetGroup': r('S0', 'none'),
  'AWS::ElasticLoadBalancingV2::Listener': r('S0', 'none'),
  // S1 compute
  'AWS::EC2::Instance': r('S1', 'hourly'),
  'AWS::Lambda::Function': r('S1', 'usage'),
  'AWS::Lambda::LayerVersion': r('S1', 'storage'),
  'AWS::StepFunctions::StateMachine': r('S1', 'usage'),
  'AWS::ImageBuilder::ImagePipeline': r('S1', 'usage'),
  'AWS::ImageBuilder::ImageRecipe': r('S1', 'none'),
  'AWS::ImageBuilder::Component': r('S1', 'none'),
  'AWS::ImageBuilder::InfrastructureConfiguration': r('S1', 'none'),
  'AWS::ImageBuilder::DistributionConfiguration': r('S1', 'none'),
  'AWS::KinesisFirehose::DeliveryStream': r('S1', 'usage'),
  // S2 data and managed services
  'AWS::RDS::DBProxy': r('S2', 'hourly', 45),
  'AWS::RDS::DBInstance': r('S2', 'hourly', 45),
  'AWS::RDS::DBCluster': r('S2', 'hourly', 45),
  'AWS::RDS::DBSnapshot': r('S2', 'storage'),
  'AWS::RDS::DBClusterSnapshot': r('S2', 'storage'),
  'AWS::RDS::DBSubnetGroup': r('S2', 'none'),
  'AWS::RDS::DBParameterGroup': r('S2', 'none'),
  'AWS::ElastiCache::ReplicationGroup': r('S2', 'hourly', 45),
  'AWS::ElastiCache::CacheCluster': r('S2', 'hourly', 45),
  'AWS::ElastiCache::ServerlessCache': r('S2', 'hourly', 45),
  'AWS::ElastiCache::SubnetGroup': r('S2', 'none'),
  'AWS::EFS::MountTarget': r('S2', 'none', 45),
  'AWS::EFS::AccessPoint': r('S2', 'none'),
  'AWS::EFS::FileSystem': r('S2', 'storage', 45),
  'AWS::DynamoDB::Table': r('S2', 'storage'),
  'AWS::DynamoDB::Backup': r('S2', 'storage'),
  'AWS::SQS::Queue': r('S2', 'usage'),
  'AWS::SNS::Topic': r('S2', 'usage'),
  'AWS::Cognito::UserPoolDomain': r('S2', 'none'),
  'AWS::Cognito::UserPool': r('S2', 'monthly'),
  'AWS::Cognito::IdentityPool': r('S2', 'none'),
  'AWS::SecretsManager::Secret': r('S2', 'monthly'),
  'AWS::SSM::Parameter': r('S2', 'none'),
  'AWS::SSM::Document': r('S2', 'none'),
  'AWS::SSM::Association': r('S2', 'none'),
  'AWS::S3::Bucket': r('S2', 'storage', 30),
  'AWS::Backup::BackupPlan': r('S2', 'none'),
  'AWS::Backup::RecoveryPoint': r('S2', 'storage'),
  'AWS::Backup::BackupVault': r('S2', 'none'),
  'AWS::Glue::Database': r('S2', 'none'),
  'AWS::Glue::Table': r('S2', 'none'),
  'AWS::Glue::Crawler': r('S2', 'usage'),
  'AWS::Athena::WorkGroup': r('S2', 'none'),
  'AWS::Logs::LogGroup': r('S2', 'storage'),
  'AWS::CloudWatch::Alarm': r('S2', 'monthly'),
  'AWS::CloudWatch::Dashboard': r('S2', 'monthly'),
  'AWS::XRay::Group': r('S2', 'none'),
  'AWS::XRay::SamplingRule': r('S2', 'none'),
  'AWS::CloudTrail::Trail': r('S2', 'usage'),
  'AWS::GuardDuty::Detector': r('S2', 'usage'),
  'AWS::Config::ConfigurationRecorder': r('S2', 'usage'),
  'AWS::Config::DeliveryChannel': r('S2', 'none'),
  'AWS::Config::ConfigRule': r('S2', 'usage'),
  'AWS::Inspector2::Enabler': r('S2', 'usage'),
  'AWS::SecurityHub::Hub': r('S2', 'usage'),
  'AWS::Budgets::Budget': r('S2', 'none'),
  'AWS::CertificateManager::Certificate': r('S2', 'none'),
  'AWS::WAFv2::WebACL': r('S2', 'monthly'),
  'AWS::WAFv2::IPSet': r('S2', 'none'),
  'AWS::WAFv2::RuleGroup': r('S2', 'monthly'),
  'AWS::Route53::RecordSet': r('S2', 'none'),
  'AWS::Route53::HostedZone': r('S2', 'monthly'),
  'AWS::SES::EmailIdentity': r('S2', 'none'),
  // S3 network
  'AWS::EC2::NatGateway': r('S3', 'hourly', 20),
  'AWS::EC2::EIP': r('S3', 'hourly'),
  'AWS::EC2::VPCEndpoint': r('S3', 'hourly'),
  'AWS::EC2::NetworkInterface': r('S3', 'none', 45),
  'AWS::EC2::SecurityGroup': r('S3', 'none'),
  'AWS::EC2::Subnet': r('S3', 'none'),
  'AWS::EC2::RouteTable': r('S3', 'none'),
  'AWS::EC2::InternetGateway': r('S3', 'none'),
  'AWS::EC2::VPC': r('S3', 'none'),
  'AWS::EC2::FlowLog': r('S3', 'usage'),
  'AWS::EC2::InstanceConnectEndpoint': r('S3', 'none'),
  'AWS::EC2::KeyPair': r('S3', 'none'),
  'AWS::EC2::LaunchTemplate': r('S3', 'none'),
  // S4 images and volumes
  'AWS::EC2::Image': r('S4', 'storage'),
  'AWS::EC2::Snapshot': r('S4', 'storage'),
  'AWS::EC2::Volume': r('S4', 'storage'),
  // S5 identity and keys
  'AWS::IAM::InstanceProfile': r('S5', 'none'),
  'AWS::IAM::Role': r('S5', 'none'),
  'AWS::IAM::ManagedPolicy': r('S5', 'none'),
  'AWS::IAM::Policy': r('S5', 'none'),
  'AWS::IAM::User': r('S5', 'none'),
  'AWS::IAM::AccessKey': r('S5', 'none'),
  'AWS::KMS::Alias': r('S5', 'none'),
  'AWS::KMS::Key': r('S5', 'monthly'),
  // S6 resets and environment state (pseudo types)
  'ATL::IAM::AppRoleReset': r('S6', 'none'),
  'ATL::SSM::DocumentDefaultVersion': r('S6', 'none'),
};

export const DEFAULT_RULE: TypeRule = r('S2', 'none');

export function ruleFor(type: string): TypeRule {
  return TYPE_RULES[type] ?? DEFAULT_RULE;
}

export function isKnownType(type: string): boolean {
  return type in TYPE_RULES;
}

export const STAGES: readonly Stage[] = ['S0', 'S1', 'S2', 'S3', 'S4', 'S5', 'S6'];

/** Platform-level resources whose names start with `cloudalbum-` but that only get their environment slice removed (7.2 rule 2). */
export const PLATFORM_OWNED_NAMES = [/^cloudalbum-lab-state-/, /^cloudalbum-lab-locks$/, /^CloudAlbumAppRole$/];

export interface EligibilityFacts {
  type: string;
  id: string;
  name: string | null;
  arn: string | null;
  stackName: string | null;
  tags?: Record<string, string> | null;
  /** sessions of the environment's hand-over chain (their workstation stacks are session resources) */
  chain: string[];
  /** the learner chose to keep these prerequisite types at the end (7.2 rule 3) */
  keepPrerequisites: string[];
  isDefaultVpcResource?: boolean;
}

export type Eligibility = { delete: true } | { delete: false; state: 'RETAINED' | 'REVIEW'; severity: 'INFO' | 'REVIEW'; reason: string };

const KEEPABLE_TYPES: Record<string, string> = {
  'route53-hosted-zone': 'AWS::Route53::HostedZone',
  'ses-identity': 'AWS::SES::EmailIdentity',
  'acm-certificate': 'AWS::CertificateManager::Certificate',
};

/** 7.2 rules 2 and 3 (rule 1 — creation evidence — is checked by the caller from the item's sources). */
export function eligibility(f: EligibilityFacts): Eligibility {
  const name = f.name ?? f.id;
  const wsStacks = new Set(f.chain.map((sid) => `atl-ws-${sid}`));
  const inWorkstationStack = (f.stackName && wsStacks.has(f.stackName)) || (f.type === 'AWS::CloudFormation::Stack' && wsStacks.has(name));
  if (f.tags?.['atl:component'] === 'platform') return { delete: false, state: 'RETAINED', severity: 'INFO', reason: 'platform resource (atl:component=platform)' };
  if (f.stackName === 'atl') return { delete: false, state: 'RETAINED', severity: 'INFO', reason: 'resource of the platform stack' };
  if (/^atl-/.test(name) && !inWorkstationStack) return { delete: false, state: 'RETAINED', severity: 'INFO', reason: 'platform name prefix atl-' };
  if (PLATFORM_OWNED_NAMES.some((re) => re.test(name))) return { delete: false, state: 'RETAINED', severity: 'INFO', reason: 'platform-owned shared object (only its environment slice is reset)' };
  if (f.type === 'AWS::IAM::Role' && (/^AWSServiceRoleFor/.test(name) || /:role\/aws-service-role\//.test(f.arn ?? ''))) {
    return { delete: false, state: 'RETAINED', severity: 'INFO', reason: 'service-linked role (kept)' };
  }
  if (f.isDefaultVpcResource) return { delete: false, state: 'RETAINED', severity: 'INFO', reason: 'default VPC resource (kept)' };
  if ((f.type === 'AWS::KMS::Alias' && /^alias\/aws\//.test(name)) || (f.type.startsWith('AWS::IAM::') && /^arn:aws[a-z-]*:iam::aws:policy\//.test(f.arn ?? ''))) {
    return { delete: false, state: 'RETAINED', severity: 'INFO', reason: 'AWS managed (kept)' };
  }
  for (const k of f.keepPrerequisites) if (KEEPABLE_TYPES[k] === f.type) return { delete: false, state: 'RETAINED', severity: 'INFO', reason: `kept prerequisite (${k})` };
  return { delete: true };
}

/** Sources that count as creation evidence (7.2 rule 1). TAG and INVENTORY alone never delete. */
export const EVIDENCE_SOURCES = ['STACK', 'RETAINED', 'OUT_OF_BAND', 'DERIVED', 'REALTIME', 'CLOUDTRAIL', 'OWNERSHIP_LOOKUP'] as const;

/** Global services and edge-scoped resources are looked up in us-east-1 (02 §7.12 rule 2). */
export function lookupRegion(type: string, region: string): string {
  if (/^AWS::(CloudFront|IAM|Route53)::/.test(type)) return 'us-east-1';
  return region;
}
