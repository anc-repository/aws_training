/**
 * Billing dimensions of atl-pricing (04 §3.4): `pricingKey` → Price List query conditions, plus the expansion tables of
 * `ref: start-profile | workstation | target-modules` (`base`, `workstation`, `modules`). **No prices.**
 *
 * This is a transcription of `labs/_pricing/dimensions.yaml` (the authoring source, linted by `labs:lint` A14). The content
 * release does not publish the file and the Lambda bundle cannot read the repository, so the table is compiled in;
 * `test/pricing.test.ts` fails when the two differ (re-run the transcription instead of editing by hand).
 */

export interface PricingDimension {
  serviceCode: string;
  /** Price List attribute → value; `{placeholder}` values are substituted at expansion (`PlaceholderValues`). */
  filters: Record<string, string>;
  /** Price List unit of the price (`Hrs`, `GB-Mo`, `Requests`, …). */
  unit: string;
  freeTierNote?: boolean;
  note?: string;
}

export interface DimensionItem {
  key: string;
  pricingKey: string;
  billing: 'hourly' | 'monthly' | 'usage' | 'one-time';
  quantity: number;
  unit?: string;
  assumedUsagePerHour?: number;
  note?: string;
  /** Quantity multiplier from a module parameter or switch (`MultiAz=true` → 2); no match → `default` (1). */
  scaleBy?: { key: string; values: Record<string, number>; default?: number };
}

export interface DimensionSet {
  schema: 'atl.pricing-dimensions/v1';
  dimensions: Record<string, PricingDimension>;
  base: DimensionItem[];
  workstation: DimensionItem[];
  modules: Record<string, DimensionItem[]>;
}

export const PRICING_DIMENSION_SET: DimensionSet = {
  schema: 'atl.pricing-dimensions/v1',
  dimensions: {
    "ec2.instance": {"serviceCode":"AmazonEC2","filters":{"instanceType":"{instanceType}","operatingSystem":"Linux","tenancy":"Shared","preInstalledSw":"NA","capacitystatus":"Used"},"unit":"Hrs"},
    "ebs.gp3.storage": {"serviceCode":"AmazonEC2","filters":{"volumeApiName":"gp3","productFamily":"Storage"},"unit":"GB-Mo"},
    "ebs.snapshot.storage": {"serviceCode":"AmazonEC2","filters":{"productFamily":"Storage Snapshot"},"unit":"GB-Mo"},
    "vpc.public-ipv4": {"serviceCode":"AmazonVPC","filters":{"group":"VPCPublicIPv4Address"},"unit":"Hrs"},
    "cloudfront.requests.https": {"serviceCode":"AmazonCloudFront","filters":{"requestType":"CloudFront-Request-HTTPS-Proxy","location":"{edgeLocationGroup}"},"unit":"Requests","freeTierNote":true},
    "cloudfront.dto": {"serviceCode":"AmazonCloudFront","filters":{"transferType":"CloudFront Outbound","fromLocation":"{edgeLocationGroup}"},"unit":"GB","freeTierNote":true},
    "cloudfront.invalidation": {"serviceCode":"AmazonCloudFront","filters":{"productFamily":"Invalidations"},"unit":"Paths","freeTierNote":true},
    "route53.hosted-zone": {"serviceCode":"AmazonRoute53","filters":{"productFamily":"DNS Zone"},"unit":"HostedZone"},
    "route53.queries": {"serviceCode":"AmazonRoute53","filters":{"productFamily":"DNS Query"},"unit":"Queries","note":"指向 AWS 资源的 Alias 查询不收费，以官方定价为准"},
    "elb.alb.hours": {"serviceCode":"AWSELB","filters":{"productFamily":"Load Balancer-Application","usagetype":"{regionPrefix}LoadBalancerUsage"},"unit":"Hrs"},
    "elb.alb.lcu": {"serviceCode":"AWSELB","filters":{"productFamily":"Load Balancer-Application","usagetype":"{regionPrefix}LCUUsage"},"unit":"LCU-Hrs"},
    "waf.web-acl": {"serviceCode":"awswaf","filters":{"group":"WebACL"},"unit":"Month"},
    "waf.requests": {"serviceCode":"awswaf","filters":{"group":"Request"},"unit":"Requests"},
    "s3.standard.storage": {"serviceCode":"AmazonS3","filters":{"storageClass":"General Purpose","volumeType":"Standard"},"unit":"GB-Mo","freeTierNote":true},
    "s3.requests.put": {"serviceCode":"AmazonS3","filters":{"group":"S3-API-Tier1"},"unit":"Requests","freeTierNote":true},
    "s3.requests.get": {"serviceCode":"AmazonS3","filters":{"group":"S3-API-Tier2"},"unit":"Requests","freeTierNote":true},
    "efs.storage": {"serviceCode":"AmazonEFS","filters":{"storageClass":"General Purpose"},"unit":"GB-Mo"},
    "rds.instance": {"serviceCode":"AmazonRDS","filters":{"instanceType":"{dbInstanceClass}","databaseEngine":"PostgreSQL","deploymentOption":"Single-AZ"},"unit":"Hrs"},
    "rds.storage.gp3": {"serviceCode":"AmazonRDS","filters":{"productFamily":"Database Storage","volumeType":"General Purpose-GP3","databaseEngine":"PostgreSQL","deploymentOption":"Single-AZ"},"unit":"GB-Mo"},
    "rds.backup.storage": {"serviceCode":"AmazonRDS","filters":{"productFamily":"Storage Snapshot"},"unit":"GB-Mo","note":"不超过数据库存储大小的自动备份不另收费，以官方定价为准"},
    "rds.proxy": {"serviceCode":"AmazonRDS","filters":{"productFamily":"RDS Proxy"},"unit":"vCPU-Hours"},
    "elasticache.node": {"serviceCode":"AmazonElastiCache","filters":{"instanceType":"{cacheNodeType}","cacheEngine":"Valkey"},"unit":"Hrs"},
    "dynamodb.ondemand.writes": {"serviceCode":"AmazonDynamoDB","filters":{"group":"DDB-WriteUnits"},"unit":"WriteRequestUnits"},
    "dynamodb.ondemand.reads": {"serviceCode":"AmazonDynamoDB","filters":{"group":"DDB-ReadUnits"},"unit":"ReadRequestUnits"},
    "dynamodb.provisioned.capacity": {"serviceCode":"AmazonDynamoDB","filters":{"group":"DDB-WriteUnits-Provisioned"},"unit":"WriteCapacityUnit-Hrs"},
    "firehose.ingestion": {"serviceCode":"AmazonKinesisFirehose","filters":{"group":"Event-by-Event Processing"},"unit":"GB"},
    "backup.storage": {"serviceCode":"AWSBackup","filters":{"productFamily":"Backup Storage"},"unit":"GB-Mo"},
    "lambda.requests": {"serviceCode":"AWSLambda","filters":{"group":"AWS-Lambda-Requests-ARM"},"unit":"Requests","freeTierNote":true},
    "lambda.duration": {"serviceCode":"AWSLambda","filters":{"group":"AWS-Lambda-Duration-ARM"},"unit":"Lambda-GB-Second","freeTierNote":true},
    "lambda.provisioned-concurrency": {"serviceCode":"AWSLambda","filters":{"group":"AWS-Lambda-Provisioned-Concurrency-ARM"},"unit":"Lambda-GB-Second","note":"预置并发按配置的并发与时长计费，测完立即删除"},
    "sqs.requests": {"serviceCode":"AWSQueueService","filters":{"queueType":"Standard"},"unit":"Requests","freeTierNote":true},
    "sns.requests": {"serviceCode":"AmazonSNS","filters":{"productFamily":"Message Delivery"},"unit":"Requests","freeTierNote":true},
    "ses.messages": {"serviceCode":"AmazonSES","filters":{"productFamily":"Sending Email"},"unit":"Count"},
    "scheduler.invocations": {"serviceCode":"AmazonEventBridge","filters":{"productFamily":"EventBridge Scheduler"},"unit":"Invocations","freeTierNote":true},
    "rekognition.images": {"serviceCode":"AmazonRekognition","filters":{"group":"Image-Analysis-Group1"},"unit":"Images","freeTierNote":true},
    "apigateway.http.requests": {"serviceCode":"AmazonApiGateway","filters":{"group":"ApiGatewayHttpApi"},"unit":"Requests","freeTierNote":true},
    "states.transitions": {"serviceCode":"AmazonStates","filters":{"group":"SFN-StateTransitions"},"unit":"Transitions","freeTierNote":true},
    "cognito.mau": {"serviceCode":"AmazonCognito","filters":{"productFamily":"User Pool MAU"},"unit":"MAU","freeTierNote":true},
    "kms.key": {"serviceCode":"awskms","filters":{"productFamily":"Encryption Key"},"unit":"Keys"},
    "kms.requests": {"serviceCode":"awskms","filters":{"productFamily":"KMS Requests"},"unit":"Requests","freeTierNote":true},
    "secretsmanager.secret": {"serviceCode":"AWSSecretsManager","filters":{"productFamily":"Secret"},"unit":"Secrets"},
    "logs.ingestion": {"serviceCode":"AmazonCloudWatch","filters":{"productFamily":"Data Payload","group":"Ingested Logs"},"unit":"GB","freeTierNote":true},
    "cloudwatch.metrics": {"serviceCode":"AmazonCloudWatch","filters":{"productFamily":"Metric"},"unit":"Metrics","freeTierNote":true},
    "cloudwatch.alarms": {"serviceCode":"AmazonCloudWatch","filters":{"productFamily":"Alarm"},"unit":"Alarms","freeTierNote":true},
    "xray.traces": {"serviceCode":"AWSXRay","filters":{"group":"Traces-Recorded"},"unit":"Traces","freeTierNote":true},
    "cloudtrail.trail-events": {"serviceCode":"AWSCloudTrail","filters":{"productFamily":"Management Tools - AWS CloudTrail Paid Events Recorded"},"unit":"Events"},
    "nat-gateway.hours": {"serviceCode":"AmazonEC2","filters":{"productFamily":"NAT Gateway","group":"NGW:NatGateway"},"unit":"Hrs"},
    "vpc-endpoint.interface.hours": {"serviceCode":"AmazonVPC","filters":{"productFamily":"VpcEndpoint"},"unit":"Hrs"},
    "guardduty.analysis": {"serviceCode":"AmazonGuardDuty","filters":{"productFamily":"Security Services"},"unit":"GB"},
    "config.items": {"serviceCode":"AWSConfig","filters":{"productFamily":"Management Tools - AWS Config"},"unit":"ConfigItems"},
    "inspector.ec2": {"serviceCode":"AmazonInspectorV2","filters":{"group":"EC2 Scanning"},"unit":"Instances"},
    "budgets.actions": {"serviceCode":"AWSBudgets","filters":{"productFamily":"Budgets"},"unit":"Budget-Days"},
    "imagebuilder.build-instance": {"serviceCode":"AmazonEC2","filters":{"instanceType":"{instanceType}","operatingSystem":"Linux","tenancy":"Shared","preInstalledSw":"NA","capacitystatus":"Used"},"unit":"Hrs","note":"Image Builder 本身不收费，构建与测试实例按 EC2 计费"},
  },
  base: [
    {"key":"lab-instance","pricingKey":"ec2.instance","billing":"hourly","quantity":1,"note":"实验机（基础栈参数 InstanceType，默认 t4g.small）"},
    {"key":"lab-ebs","pricingKey":"ebs.gp3.storage","billing":"monthly","quantity":40,"unit":"GB-month","note":"根卷与数据卷"},
    {"key":"lab-ipv4","pricingKey":"vpc.public-ipv4","billing":"hourly","quantity":1,"note":"弹性 IP"},
  ],
  workstation: [
    {"key":"ws-instance","pricingKey":"ec2.instance","billing":"hourly","quantity":1,"note":"工作台 EC2"},
    {"key":"ws-ebs","pricingKey":"ebs.gp3.storage","billing":"monthly","quantity":20,"unit":"GB-month"},
    {"key":"ws-ipv4","pricingKey":"vpc.public-ipv4","billing":"hourly","quantity":1},
  ],
  modules: {
    "iam": [],
    "storage": [{"key":"s3-storage","pricingKey":"s3.standard.storage","billing":"usage","quantity":1,"unit":"GB-month","assumedUsagePerHour":0.002}],
    "cdn": [{"key":"cf-requests","pricingKey":"cloudfront.requests.https","billing":"usage","quantity":1,"unit":"requests","assumedUsagePerHour":5000}, {"key":"cf-dto","pricingKey":"cloudfront.dto","billing":"usage","quantity":1,"unit":"GB","assumedUsagePerHour":0.2}],
    "queue": [{"key":"sqs-requests","pricingKey":"sqs.requests","billing":"usage","quantity":1,"unit":"requests","assumedUsagePerHour":20000}],
    "image-processing": [{"key":"lambda-requests","pricingKey":"lambda.requests","billing":"usage","quantity":1,"unit":"requests","assumedUsagePerHour":2000}, {"key":"lambda-duration","pricingKey":"lambda.duration","billing":"usage","quantity":1,"unit":"GB-second","assumedUsagePerHour":2000}],
    "auth": [{"key":"cognito-mau","pricingKey":"cognito.mau","billing":"usage","quantity":1,"unit":"MAU","assumedUsagePerHour":0.5}],
    "database": [{"key":"rds-instance","pricingKey":"rds.instance","billing":"hourly","quantity":1,"scaleBy":{"key":"MultiAz","values":{"true":2}},"note":"Multi-AZ 的备库按实例计（05 §3.3）"}, {"key":"rds-storage","pricingKey":"rds.storage.gp3","billing":"monthly","quantity":20,"unit":"GB-month","scaleBy":{"key":"MultiAz","values":{"true":2}}}],
    "cache": [{"key":"elasticache-node","pricingKey":"elasticache.node","billing":"hourly","quantity":1}],
    "db-proxy": [{"key":"rds-proxy","pricingKey":"rds.proxy","billing":"hourly","quantity":1}],
    "load-balancer": [{"key":"alb-hours","pricingKey":"elb.alb.hours","billing":"hourly","quantity":1}, {"key":"alb-lcu","pricingKey":"elb.alb.lcu","billing":"usage","quantity":1,"unit":"LCU-hour","assumedUsagePerHour":1}],
    "autoscaling": [{"key":"asg-instances","pricingKey":"ec2.instance","billing":"hourly","quantity":2,"note":"ASG 最少 2 台实例（第一台取代 L0 实例的工作量另计）"}],
    "network": [{"key":"nat-gateway","pricingKey":"nat-gateway.hours","billing":"hourly","quantity":1,"scaleBy":{"key":"NETWORK_NAT_MODE","values":{"gateway":1},"default":0},"note":"public 放置不建 NAT；gateway 时 1 个单位"}],
    "shared-fs": [{"key":"efs-storage","pricingKey":"efs.storage","billing":"usage","quantity":1,"unit":"GB-month","assumedUsagePerHour":0.002}],
    "secrets": [{"key":"secrets","pricingKey":"secretsmanager.secret","billing":"monthly","quantity":3}],
    "kms": [{"key":"kms-key","pricingKey":"kms.key","billing":"monthly","quantity":1}],
    "social-store": [{"key":"ddb-writes","pricingKey":"dynamodb.ondemand.writes","billing":"usage","quantity":1,"unit":"WRU","assumedUsagePerHour":5000}],
    "dns": [{"key":"hosted-zone","pricingKey":"route53.hosted-zone","billing":"monthly","quantity":1}],
    "tls": [],
    "waf": [{"key":"web-acl","pricingKey":"waf.web-acl","billing":"monthly","quantity":1}],
    "analytics": [{"key":"firehose","pricingKey":"firehose.ingestion","billing":"usage","quantity":1,"unit":"GB","assumedUsagePerHour":0.01}],
    "backup": [{"key":"backup-storage","pricingKey":"backup.storage","billing":"usage","quantity":1,"unit":"GB-month","assumedUsagePerHour":0.03}],
  },
};
