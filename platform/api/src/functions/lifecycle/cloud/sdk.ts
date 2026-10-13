/**
 * Generic AWS SDK v3 access for the production lifecycle / reclaim clouds: `call(service, region, 'DescribeStacks', input)`.
 * Packages load lazily with a computed specifier, so the bundle keeps `@aws-sdk/*` external (the nodejs22.x runtime
 * ships the full SDK v3) and services the reclaimer only rarely needs (RDS, ElastiCache, Cloud Control …) do not have
 * to be compile-time dependencies. Optional credentials (the reaper's `atl-<sid>-reap-<n>` session) get their own
 * client. Nothing here runs in tests or ATL_DEV_MODE.
 */

export const SERVICES = {
  autoscaling: ['@aws-sdk/client-auto-scaling', 'AutoScalingClient'],
  cloudcontrol: ['@aws-sdk/client-cloudcontrol', 'CloudControlClient'],
  cloudformation: ['@aws-sdk/client-cloudformation', 'CloudFormationClient'],
  cloudfront: ['@aws-sdk/client-cloudfront', 'CloudFrontClient'],
  cloudwatch: ['@aws-sdk/client-cloudwatch', 'CloudWatchClient'],
  codebuild: ['@aws-sdk/client-codebuild', 'CodeBuildClient'],
  cognito: ['@aws-sdk/client-cognito-identity-provider', 'CognitoIdentityProviderClient'],
  dynamodb: ['@aws-sdk/client-dynamodb', 'DynamoDBClient'],
  ec2: ['@aws-sdk/client-ec2', 'EC2Client'],
  ecr: ['@aws-sdk/client-ecr', 'ECRClient'],
  ecs: ['@aws-sdk/client-ecs', 'ECSClient'],
  efs: ['@aws-sdk/client-efs', 'EFSClient'],
  elasticache: ['@aws-sdk/client-elasticache', 'ElastiCacheClient'],
  elbv2: ['@aws-sdk/client-elastic-load-balancing-v2', 'ElasticLoadBalancingV2Client'],
  eventbridge: ['@aws-sdk/client-eventbridge', 'EventBridgeClient'],
  iam: ['@aws-sdk/client-iam', 'IAMClient'],
  kms: ['@aws-sdk/client-kms', 'KMSClient'],
  lambda: ['@aws-sdk/client-lambda', 'LambdaClient'],
  logs: ['@aws-sdk/client-cloudwatch-logs', 'CloudWatchLogsClient'],
  rds: ['@aws-sdk/client-rds', 'RDSClient'],
  s3: ['@aws-sdk/client-s3', 'S3Client'],
  scheduler: ['@aws-sdk/client-scheduler', 'SchedulerClient'],
  secretsmanager: ['@aws-sdk/client-secrets-manager', 'SecretsManagerClient'],
  sfn: ['@aws-sdk/client-sfn', 'SFNClient'],
  sns: ['@aws-sdk/client-sns', 'SNSClient'],
  sqs: ['@aws-sdk/client-sqs', 'SQSClient'],
  ssm: ['@aws-sdk/client-ssm', 'SSMClient'],
  sts: ['@aws-sdk/client-sts', 'STSClient'],
  tagging: ['@aws-sdk/client-resource-groups-tagging-api', 'ResourceGroupsTaggingAPIClient'],
} as const;
export type Service = keyof typeof SERVICES;

export interface Credentials {
  accessKeyId: string;
  secretAccessKey: string;
  sessionToken?: string;
  expiration?: Date;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Json = Record<string, any>;
type SdkModule = Record<string, unknown>;
interface SdkClient {
  send(command: unknown): Promise<Json>;
}

const modules = new Map<Service, Promise<SdkModule>>();
const clients = new Map<string, SdkClient>();

function load(service: Service): Promise<SdkModule> {
  let m = modules.get(service);
  if (!m) {
    const spec: string = SERVICES[service][0];
    m = import(spec) as Promise<SdkModule>;
    modules.set(service, m);
  }
  return m;
}

/** `service` call in `region`; `creds` → a client of its own (not cached beyond the credentials' lifetime). */
export async function call<T extends Json = Json>(service: Service, region: string, command: string, input: object = {}, creds?: Credentials): Promise<T> {
  const mod = await load(service);
  const key = `${service}@${region}${creds ? `#${creds.accessKeyId}` : ''}`;
  let c = clients.get(key);
  if (!c) {
    const Ctor = mod[SERVICES[service][1]] as new (cfg: object) => SdkClient;
    c = new Ctor(creds ? { region, credentials: creds } : { region });
    if (creds) {
      // keep at most a handful of assumed-role clients
      for (const k of [...clients.keys()].filter((k) => k.includes('#')).slice(0, -8)) clients.delete(k);
    }
    clients.set(key, c);
  }
  const Cmd = mod[`${command}Command`] as (new (input: object) => unknown) | undefined;
  if (!Cmd) throw new Error(`${SERVICES[service][0]} has no ${command}Command`);
  return (await c.send(new Cmd(input))) as T;
}

/** Follow `NextToken`-style pagination (`tokenIn` / `tokenOut` field names differ per service). */
export async function* paginate(
  service: Service,
  region: string,
  command: string,
  input: Json,
  opts: { tokenIn?: string; tokenOut?: string; maxPages?: number; creds?: Credentials } = {},
): AsyncGenerator<Json> {
  const tokenIn = opts.tokenIn ?? 'NextToken';
  const tokenOut = opts.tokenOut ?? 'NextToken';
  let token: string | undefined;
  let pages = 0;
  do {
    const out = await call(service, region, command, token ? { ...input, [tokenIn]: token } : input, opts.creds);
    yield out;
    token = (out[tokenOut] as string | undefined) || undefined;
    pages++;
  } while (token && pages < (opts.maxPages ?? 50));
}

export function errName(e: unknown): string {
  return e && typeof e === 'object' && 'name' in e ? String((e as { name: unknown }).name) : '';
}

export function errText(e: unknown): string {
  return `${errName(e)}: ${e instanceof Error ? e.message : String(e)}`;
}

export const isNotFound = (e: unknown): boolean =>
  /NotFound|NoSuch|does not exist|DoesNotExist|InvalidGroup\.NotFound|\.NotFound$|ResourceNotFound|NotFoundException|InvalidParameterValue.*not found|Unknown/i.test(errText(e));
export const isThrottled = (e: unknown): boolean => /Throttl|TooManyRequests|RequestLimitExceeded|Rate exceeded|SlowDown/i.test(errText(e));
export const isDenied = (e: unknown): boolean => /AccessDenied|UnauthorizedOperation|not authorized|AuthorizationError|explicit deny/i.test(errText(e));
export const isDependency = (e: unknown): boolean => /DependencyViolation|InUse|in use|ResourceInUse|DeleteConflict|has dependent|InvalidState|currently being|IncorrectState|Conflict/i.test(errText(e));
