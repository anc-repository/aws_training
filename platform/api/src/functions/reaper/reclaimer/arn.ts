/**
 * ARN → (CloudFormation type, physical id) for the services the Tagging API returns (7.1 TAG source), so that a tagged
 * resource and the same resource from the stack ledger share one ledger key.
 */
export interface ArnRef {
  type: string;
  id: string;
  region: string;
}

export function refFromArn(arn: string, fallbackRegion: string): ArnRef | null {
  const m = /^arn:aws[a-z-]*:([a-z0-9-]+):([a-z0-9-]*):(\d{12})?:(.+)$/.exec(arn);
  if (!m) return null;
  const [, service, regionRaw, , rest] = m as unknown as [string, string, string, string, string];
  const region = regionRaw || (service === 'iam' || service === 'cloudfront' || service === 'route53' ? 'us-east-1' : fallbackRegion);
  const slash = (prefix: string) => (rest.startsWith(prefix) ? rest.slice(prefix.length) : null);
  const colon = (prefix: string) => (rest.startsWith(prefix) ? rest.slice(prefix.length) : null);
  const table: [string, string, () => string | null][] = [
    ['ec2', 'AWS::EC2::Instance', () => slash('instance/')],
    ['ec2', 'AWS::EC2::Volume', () => slash('volume/')],
    ['ec2', 'AWS::EC2::Snapshot', () => slash('snapshot/')],
    ['ec2', 'AWS::EC2::Image', () => slash('image/')],
    ['ec2', 'AWS::EC2::SecurityGroup', () => slash('security-group/')],
    ['ec2', 'AWS::EC2::VPC', () => slash('vpc/')],
    ['ec2', 'AWS::EC2::Subnet', () => slash('subnet/')],
    ['ec2', 'AWS::EC2::RouteTable', () => slash('route-table/')],
    ['ec2', 'AWS::EC2::InternetGateway', () => slash('internet-gateway/')],
    ['ec2', 'AWS::EC2::NatGateway', () => slash('natgateway/')],
    ['ec2', 'AWS::EC2::EIP', () => slash('elastic-ip/')],
    ['ec2', 'AWS::EC2::VPCEndpoint', () => slash('vpc-endpoint/')],
    ['ec2', 'AWS::EC2::NetworkInterface', () => slash('network-interface/')],
    ['ec2', 'AWS::EC2::KeyPair', () => slash('key-pair/')],
    ['ec2', 'AWS::EC2::LaunchTemplate', () => slash('launch-template/')],
    ['s3', 'AWS::S3::Bucket', () => (rest.includes('/') ? null : rest)],
    ['lambda', 'AWS::Lambda::Function', () => colon('function:')?.split(':')[0] ?? null],
    ['logs', 'AWS::Logs::LogGroup', () => colon('log-group:')?.replace(/:\*$/, '') ?? null],
    ['dynamodb', 'AWS::DynamoDB::Table', () => slash('table/')?.split('/')[0] ?? null],
    ['rds', 'AWS::RDS::DBInstance', () => colon('db:')],
    ['rds', 'AWS::RDS::DBCluster', () => colon('cluster:')],
    ['rds', 'AWS::RDS::DBSnapshot', () => colon('snapshot:')],
    ['rds', 'AWS::RDS::DBSubnetGroup', () => colon('subgrp:')],
    ['elasticache', 'AWS::ElastiCache::ReplicationGroup', () => colon('replicationgroup:')],
    ['elasticache', 'AWS::ElastiCache::CacheCluster', () => colon('cluster:')],
    ['elasticache', 'AWS::ElastiCache::ServerlessCache', () => colon('serverlesscache:')],
    ['elasticfilesystem', 'AWS::EFS::FileSystem', () => slash('file-system/')],
    ['sqs', 'AWS::SQS::Queue', () => null],
    ['sns', 'AWS::SNS::Topic', () => (rest.includes(':') ? null : arn)],
    ['kms', 'AWS::KMS::Key', () => slash('key/')],
    ['kms', 'AWS::KMS::Alias', () => (rest.startsWith('alias/') ? rest : null)],
    ['secretsmanager', 'AWS::SecretsManager::Secret', () => (rest.startsWith('secret:') ? arn : null)],
    ['ssm', 'AWS::SSM::Parameter', () => slash('parameter')],
    ['states', 'AWS::StepFunctions::StateMachine', () => (rest.startsWith('stateMachine:') ? arn : null)],
    ['elasticloadbalancing', 'AWS::ElasticLoadBalancingV2::LoadBalancer', () => (rest.startsWith('loadbalancer/') ? arn : null)],
    ['elasticloadbalancing', 'AWS::ElasticLoadBalancingV2::TargetGroup', () => (rest.startsWith('targetgroup/') ? arn : null)],
    ['cloudfront', 'AWS::CloudFront::Distribution', () => slash('distribution/')],
    ['iam', 'AWS::IAM::Role', () => slash('role/')?.split('/').pop() ?? null],
    ['iam', 'AWS::IAM::ManagedPolicy', () => (rest.startsWith('policy/') ? arn : null)],
    ['iam', 'AWS::IAM::User', () => slash('user/')?.split('/').pop() ?? null],
    ['acm', 'AWS::CertificateManager::Certificate', () => (rest.startsWith('certificate/') ? arn : null)],
    ['cloudformation', 'AWS::CloudFormation::Stack', () => slash('stack/')?.split('/')[0] ?? null],
    ['events', 'AWS::Events::Rule', () => slash('rule/')?.replace(/^(?:(.+)\/)?([^/]+)$/, (_m, bus: string | undefined, name: string) => `${bus ?? 'default'}|${name}`) ?? null],
    ['scheduler', 'AWS::Scheduler::Schedule', () => slash('schedule/')?.replace('/', '|') ?? null],
    ['cognito-idp', 'AWS::Cognito::UserPool', () => slash('userpool/')],
    ['wafv2', 'AWS::WAFv2::WebACL', () => (/\/webacl\//.test(rest) ? arn : null)],
    ['autoscaling', 'AWS::AutoScaling::AutoScalingGroup', () => /autoScalingGroupName\/(.+)$/.exec(rest)?.[1] ?? null],
  ];
  for (const [svc, type, f] of table) {
    if (svc !== service) continue;
    const id = f();
    if (id) return { type, id, region };
  }
  return null;
}
