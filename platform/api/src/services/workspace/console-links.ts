/**
 * Console deep-link registry (03 §5.4). Keys are the stable `linkId`s referenced by `::console-link`, the card's
 * `platform.consoleLinks` and the console tab; parameters are validated by their regexes before substitution.
 *
 * 03 §5.4 places the registry in `platform/api/contracts/console-links.ts` (`@atl/contracts`, not created yet); it lives
 * here until then and `scripts/labs/src/console-links.ts` (the lint transcription) must list the same ids (tested).
 * URL fragments follow the console of 2026-10 and are examples (03: weekly patrol, fall back to the service home).
 */

export interface ConsoleLinkDef {
  /** `{region}` and the parameters below are substituted (URI-encoded). */
  template: string;
  params: Readonly<Record<string, RegExp>>;
  /** Service home used when a parameter is missing or invalid (03 §5.4 “失效时退回该服务首页”). */
  home: string;
  label: string;
}

export const CONSOLE_LINKS: Readonly<Record<string, ConsoleLinkDef>> = {
  'ec2.instance': {
    template: 'https://{region}.console.aws.amazon.com/ec2/home?region={region}#InstanceDetails:instanceId={instanceId}',
    params: { instanceId: /^i-[0-9a-f]{8,17}$/ },
    home: 'https://{region}.console.aws.amazon.com/ec2/home?region={region}#Instances:',
    label: 'EC2 · 实例',
  },
  'ec2.securityGroup': {
    template: 'https://{region}.console.aws.amazon.com/ec2/home?region={region}#SecurityGroup:groupId={sgId}',
    params: { sgId: /^sg-[0-9a-f]{8,17}$/ },
    home: 'https://{region}.console.aws.amazon.com/ec2/home?region={region}#SecurityGroups:',
    label: 'EC2 · 安全组',
  },
  'iam.role': {
    template: 'https://console.aws.amazon.com/iam/home#/roles/details/{roleName}',
    params: { roleName: /^[\w+=,.@-]{1,64}$/ },
    home: 'https://console.aws.amazon.com/iam/home#/roles',
    label: 'IAM · 角色',
  },
  'budgets.home': { template: 'https://console.aws.amazon.com/billing/home#/budgets', params: {}, home: 'https://console.aws.amazon.com/billing/home#/budgets', label: 'Billing · Budgets' },
  'ssm.sessions': {
    template: 'https://{region}.console.aws.amazon.com/systems-manager/session-manager/sessions?region={region}',
    params: {},
    home: 'https://{region}.console.aws.amazon.com/systems-manager/home?region={region}',
    label: 'Systems Manager · Session Manager',
  },
  'logs.group': {
    template: 'https://{region}.console.aws.amazon.com/cloudwatch/home?region={region}#logsV2:log-groups/log-group/{logGroupEncoded}',
    params: { logGroupEncoded: /^[\w$%.\-/#]{1,1024}$/ },
    home: 'https://{region}.console.aws.amazon.com/cloudwatch/home?region={region}#logsV2:log-groups',
    label: 'CloudWatch · 日志组',
  },
  's3.bucket': {
    template: 'https://s3.console.aws.amazon.com/s3/buckets/{bucket}?region={region}&tab=objects',
    params: { bucket: /^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/ },
    home: 'https://s3.console.aws.amazon.com/s3/buckets?region={region}',
    label: 'S3 · 桶',
  },
  'cloudfront.distribution': {
    template: 'https://us-east-1.console.aws.amazon.com/cloudfront/v4/home#/distributions/{distributionId}',
    params: { distributionId: /^E[0-9A-Z]{8,20}$/ },
    home: 'https://us-east-1.console.aws.amazon.com/cloudfront/v4/home#/distributions',
    label: 'CloudFront · 分配',
  },
  'cloudfront.createDistribution': {
    template: 'https://us-east-1.console.aws.amazon.com/cloudfront/v4/home#/distributions/create',
    params: {},
    home: 'https://us-east-1.console.aws.amazon.com/cloudfront/v4/home#/distributions',
    label: 'CloudFront · 创建分配',
  },
  'wafv2.webAcls': {
    template: 'https://us-east-1.console.aws.amazon.com/wafv2/homev2/web-acls?region=global',
    params: {},
    home: 'https://us-east-1.console.aws.amazon.com/wafv2/homev2/web-acls?region=global',
    label: 'WAF · Web ACL',
  },
  'cognito.userPool': {
    template: 'https://{region}.console.aws.amazon.com/cognito/v2/idp/user-pools/{userPoolId}/users?region={region}',
    params: { userPoolId: /^[\w-]+_[0-9a-zA-Z]+$/ },
    home: 'https://{region}.console.aws.amazon.com/cognito/v2/idp/user-pools?region={region}',
    label: 'Cognito · 用户池',
  },
  'sqs.queue': {
    template: 'https://{region}.console.aws.amazon.com/sqs/v3/home?region={region}#/queues/{queueUrlEncoded}',
    params: { queueUrlEncoded: /^https%3A%2F%2Fsqs\.[a-z0-9-]+\.amazonaws\.com%2F\d{12}%2F[\w-]{1,80}(\.fifo)?$/ },
    home: 'https://{region}.console.aws.amazon.com/sqs/v3/home?region={region}#/queues',
    label: 'SQS · 队列',
  },
  'lambda.function': {
    template: 'https://{region}.console.aws.amazon.com/lambda/home?region={region}#/functions/{functionName}',
    params: { functionName: /^[\w-]{1,64}$/ },
    home: 'https://{region}.console.aws.amazon.com/lambda/home?region={region}#/functions',
    label: 'Lambda · 函数',
  },
  'vpc.vpc': {
    template: 'https://{region}.console.aws.amazon.com/vpcconsole/home?region={region}#VpcDetails:VpcId={vpcId}',
    params: { vpcId: /^vpc-[0-9a-f]{8,17}$/ },
    home: 'https://{region}.console.aws.amazon.com/vpcconsole/home?region={region}#vpcs:',
    label: 'VPC',
  },
  'rds.database': {
    template: 'https://{region}.console.aws.amazon.com/rds/home?region={region}#database:id={dbId}',
    params: { dbId: /^[a-zA-Z][a-zA-Z0-9-]{0,62}$/ },
    home: 'https://{region}.console.aws.amazon.com/rds/home?region={region}#databases:',
    label: 'RDS · 数据库',
  },
  'dynamodb.table': {
    template: 'https://{region}.console.aws.amazon.com/dynamodbv2/home?region={region}#table?name={table}',
    params: { table: /^[\w.-]{3,255}$/ },
    home: 'https://{region}.console.aws.amazon.com/dynamodbv2/home?region={region}#tables',
    label: 'DynamoDB · 表',
  },
  'ec2.loadBalancers': {
    template: 'https://{region}.console.aws.amazon.com/ec2/home?region={region}#LoadBalancers:',
    params: {},
    home: 'https://{region}.console.aws.amazon.com/ec2/home?region={region}#LoadBalancers:',
    label: 'EC2 · 负载均衡器',
  },
  'cloudtrail.events': {
    template: 'https://{region}.console.aws.amazon.com/cloudtrail/home?region={region}#/events',
    params: {},
    home: 'https://{region}.console.aws.amazon.com/cloudtrail/home?region={region}#/events',
    label: 'CloudTrail · 事件历史',
  },
  'cloudshell.home': {
    template: 'https://{region}.console.aws.amazon.com/cloudshell/home?region={region}',
    params: {},
    home: 'https://{region}.console.aws.amazon.com/cloudshell/home?region={region}',
    label: 'CloudShell',
  },
};

const REGION_RE = /^[a-z]{2}(-[a-z]+)+-\d$/;

export function consoleHome(region: string): string {
  return `https://${region}.console.aws.amazon.com/console/home?region=${region}`;
}

function fill(template: string, region: string, params: Record<string, string>): string {
  // `…Encoded` parameters arrive in the console's own encoding (validated by their regex) and are inserted as they are
  return template.replace(/\{(\w+)\}/g, (_m, k: string) => (k === 'region' ? region : k.endsWith('Encoded') ? (params[k] ?? '') : encodeURIComponent(params[k] ?? '')));
}

export interface ResolvedDestination {
  url: string;
  linkId: string | null;
  /** The registry entry's service home was used (missing / invalid parameters). */
  fallback: boolean;
}

/** `linkId` (+ params) → URL; parameters that fail their regex fall back to the service home. */
export function resolveConsoleLink(linkId: string, region: string, params: Record<string, string> = {}): ResolvedDestination | null {
  const def = CONSOLE_LINKS[linkId];
  if (!def || !REGION_RE.test(region)) return null;
  const ok = Object.entries(def.params).every(([k, re]) => typeof params[k] === 'string' && re.test(params[k]!));
  return ok ? { url: fill(def.template, region, params), linkId, fallback: false } : { url: fill(def.home, region, {}), linkId, fallback: true };
}

/** Hosts a `Destination` may point at (03 §5.4 白名单): the console hosts used by the registry for this region. */
export function allowedConsoleHosts(region: string): Set<string> {
  const hosts = new Set(['console.aws.amazon.com', `${region}.console.aws.amazon.com`, 's3.console.aws.amazon.com']);
  for (const d of Object.values(CONSOLE_LINKS)) {
    for (const t of [d.template, d.home]) hosts.add(new URL(fill(t, region, Object.fromEntries(Object.keys(d.params).map((k) => [k, 'x'])))).hostname);
  }
  return hosts;
}

/** A free `destination` URL is accepted only on an allowed console host, over https, without credentials or port. */
export function checkDestination(raw: string, region: string): string | null {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return null;
  }
  if (u.protocol !== 'https:' || u.username || u.password || u.port) return null;
  if (!allowedConsoleHosts(region).has(u.hostname)) return null;
  return u.toString();
}
