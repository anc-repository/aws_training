/**
 * Production engine ports of atl-checks:
 *  - read-only AWS calls as `ATLVerifierRole` (`sts:AssumeRole` with role session name `atl-<sid>-verify` and session
 *    tags `atl:session-id` / `atl:env-id`, 04 §5.7), generic over the allowlisted services: `@aws-sdk/client-<x>` loaded
 *    on demand (the nodejs22.x runtime ships SDK v3), command `<Action>Command`;
 *  - outbound HTTP through the shared egress guard (`SafeFetch`, private targets rejected);
 *  - AWS IP ranges from https://ip-ranges.amazonaws.com/ip-ranges.json, cached for 24 h per container.
 * Never used in tests or ATL_DEV_MODE (it refuses to run there).
 */
import { RoleSessionNames, TAG_KEYS, PortError } from '@atl/shared';
import { Keys } from '../../../data/keys.js';
import type { FunctionDeps } from '../../../runtime/deps.js';
import type { PlatformEnv } from '../../../runtime/env.js';
import { DynamoItemStore } from '../../../services/progress/store.js';
import { parseIpRanges } from '../engine/builtins.js';
import { AwsCallError, type AwsReadPort, type AwsReadRequest, type CheckEnginePorts, type EngineConfig, type IpRange, type IpRangesPort } from '../engine/ports.js';
import { SafeFetch } from '../engine/safe-fetch.js';

/** IAM service prefix → SDK v3 package and client class (04 §5.7 naming convention). */
export const SDK_CLIENTS: Readonly<Record<string, { pkg: string; client: string }>> = {
  acm: { pkg: 'acm', client: 'ACMClient' },
  apigateway: { pkg: 'apigatewayv2', client: 'ApiGatewayV2Client' },
  autoscaling: { pkg: 'auto-scaling', client: 'AutoScalingClient' },
  athena: { pkg: 'athena', client: 'AthenaClient' },
  backup: { pkg: 'backup', client: 'BackupClient' },
  budgets: { pkg: 'budgets', client: 'BudgetsClient' },
  ce: { pkg: 'cost-explorer', client: 'CostExplorerClient' },
  cloudformation: { pkg: 'cloudformation', client: 'CloudFormationClient' },
  cloudfront: { pkg: 'cloudfront', client: 'CloudFrontClient' },
  cloudtrail: { pkg: 'cloudtrail', client: 'CloudTrailClient' },
  cloudwatch: { pkg: 'cloudwatch', client: 'CloudWatchClient' },
  'cognito-identity': { pkg: 'cognito-identity', client: 'CognitoIdentityClient' },
  'cognito-idp': { pkg: 'cognito-identity-provider', client: 'CognitoIdentityProviderClient' },
  config: { pkg: 'config-service', client: 'ConfigServiceClient' },
  dynamodb: { pkg: 'dynamodb', client: 'DynamoDBClient' },
  ec2: { pkg: 'ec2', client: 'EC2Client' },
  elasticache: { pkg: 'elasticache', client: 'ElastiCacheClient' },
  elasticfilesystem: { pkg: 'efs', client: 'EFSClient' },
  elasticloadbalancing: { pkg: 'elastic-load-balancing-v2', client: 'ElasticLoadBalancingV2Client' },
  events: { pkg: 'eventbridge', client: 'EventBridgeClient' },
  scheduler: { pkg: 'scheduler', client: 'SchedulerClient' },
  firehose: { pkg: 'firehose', client: 'FirehoseClient' },
  glue: { pkg: 'glue', client: 'GlueClient' },
  guardduty: { pkg: 'guardduty', client: 'GuardDutyClient' },
  iam: { pkg: 'iam', client: 'IAMClient' },
  imagebuilder: { pkg: 'imagebuilder', client: 'ImagebuilderClient' },
  inspector2: { pkg: 'inspector2', client: 'Inspector2Client' },
  kms: { pkg: 'kms', client: 'KMSClient' },
  lambda: { pkg: 'lambda', client: 'LambdaClient' },
  logs: { pkg: 'cloudwatch-logs', client: 'CloudWatchLogsClient' },
  rds: { pkg: 'rds', client: 'RDSClient' },
  route53: { pkg: 'route-53', client: 'Route53Client' },
  s3: { pkg: 's3', client: 'S3Client' },
  s3control: { pkg: 's3-control', client: 'S3ControlClient' },
  secretsmanager: { pkg: 'secrets-manager', client: 'SecretsManagerClient' },
  ses: { pkg: 'sesv2', client: 'SESv2Client' },
  states: { pkg: 'sfn', client: 'SFNClient' },
  sns: { pkg: 'sns', client: 'SNSClient' },
  sqs: { pkg: 'sqs', client: 'SQSClient' },
  ssm: { pkg: 'ssm', client: 'SSMClient' },
  tag: { pkg: 'resource-groups-tagging-api', client: 'ResourceGroupsTaggingAPIClient' },
  wafv2: { pkg: 'wafv2', client: 'WAFV2Client' },
  xray: { pkg: 'xray', client: 'XRayClient' },
};

function errName(e: unknown): string {
  return e && typeof e === 'object' && 'name' in e ? String((e as { name: unknown }).name) : '';
}

/** Classify an SDK error (exported for tests). */
export function classifyAwsError(e: unknown): AwsCallError {
  const name = errName(e) || 'Error';
  const msg = e instanceof Error ? e.message : String(e);
  const status = (e as { $metadata?: { httpStatusCode?: number } })?.$metadata?.httpStatusCode;
  if (/AccessDenied|UnauthorizedOperation|NotAuthorized|AuthorizationError|Forbidden|UnrecognizedClient/i.test(name)) return new AwsCallError('ACCESS_DENIED', name, msg);
  if (/Throttl|TooManyRequests|RequestLimitExceeded|SlowDown/i.test(name) || /Rate exceeded/i.test(msg)) return new AwsCallError('THROTTLED', name, msg);
  if (/NotFound|NoSuch|DoesNotExist|NotExist/i.test(name) || /does not exist|not found/i.test(msg)) return new AwsCallError('NOT_FOUND', name, msg);
  if (/Validation|InvalidParameter|InvalidInput|InvalidRequest|MissingParameter/i.test(name)) return new AwsCallError('INVALID', name, msg);
  if ((status !== undefined && status >= 500) || /ECONN|ETIMEDOUT|EAI_AGAIN|TimeoutError|NetworkingError|socket hang up/i.test(`${name} ${msg}`)) return new AwsCallError('NETWORK', name, msg);
  return new AwsCallError('OTHER', name, msg);
}

interface Creds {
  accessKeyId: string;
  secretAccessKey: string;
  sessionToken: string;
  expiration: number;
}

export class VerifierAwsRead implements AwsReadPort {
  private readonly creds = new Map<string, Creds>();
  private readonly clients = new Map<string, unknown>();

  constructor(private readonly env: PlatformEnv) {}

  roleArn(): string {
    return `arn:aws:iam::${this.env.accountId}:role/ATLVerifierRole`;
  }

  private async credentials(session: { sid: string; envId: string }): Promise<Creds> {
    const k = `${session.sid}|${session.envId}`;
    const hit = this.creds.get(k);
    if (hit && hit.expiration - Date.now() > 120_000) return hit;
    const { STSClient, AssumeRoleCommand } = await import('@aws-sdk/client-sts');
    const sts = new STSClient({ region: this.env.region });
    try {
      const r = await sts.send(
        new AssumeRoleCommand({
          RoleArn: this.roleArn(),
          RoleSessionName: RoleSessionNames.verify(session.sid),
          DurationSeconds: 900,
          Tags: [
            { Key: TAG_KEYS.sessionId, Value: session.sid },
            ...(session.envId ? [{ Key: TAG_KEYS.envId, Value: session.envId }] : []),
          ],
        }),
      );
      const c = r.Credentials;
      if (!c?.AccessKeyId || !c.SecretAccessKey || !c.SessionToken) throw new PortError('Unavailable', 'AssumeRole returned no credentials');
      const out = { accessKeyId: c.AccessKeyId, secretAccessKey: c.SecretAccessKey, sessionToken: c.SessionToken, expiration: c.Expiration ? new Date(c.Expiration).getTime() : Date.now() + 900_000 };
      this.creds.set(k, out);
      // clients are bound to credentials
      for (const key of [...this.clients.keys()]) if (key.startsWith(`${k}|`)) this.clients.delete(key);
      return out;
    } catch (e) {
      throw e instanceof PortError ? new AwsCallError('OTHER', 'AssumeRole', e.message) : classifyAwsError(e);
    }
  }

  async call(req: AwsReadRequest): Promise<Record<string, unknown>> {
    const spec = SDK_CLIENTS[req.service];
    if (!spec) throw new AwsCallError('INVALID', 'UnknownService', `no SDK mapping for ${req.service}`);
    const creds = await this.credentials(req.session);
    const ck = `${req.session.sid}|${req.session.envId}|${req.service}|${req.region}`;
    const pkgName = `@aws-sdk/client-${spec.pkg}`;
    const mod = (await import(/* @vite-ignore */ pkgName)) as Record<string, new (cfg: unknown) => { send(c: unknown): Promise<Record<string, unknown>> }>;
    let client = this.clients.get(ck) as { send(c: unknown): Promise<Record<string, unknown>> } | undefined;
    if (!client) {
      const Client = mod[spec.client];
      if (!Client) throw new AwsCallError('INVALID', 'UnknownClient', `${pkgName} has no ${spec.client}`);
      client = new Client({ region: req.region, credentials: { accessKeyId: creds.accessKeyId, secretAccessKey: creds.secretAccessKey, sessionToken: creds.sessionToken }, maxAttempts: 1 });
      this.clients.set(ck, client);
    }
    const Command = mod[`${req.action}Command`];
    if (!Command) throw new AwsCallError('INVALID', 'UnknownOperation', `${pkgName} has no ${req.action}Command`);
    const params = req.service === 's3control' && !('AccountId' in req.params) ? { ...req.params, AccountId: this.env.accountId } : req.params;
    try {
      const out = await client.send(new Command(params));
      const { $metadata: _m, ...rest } = out;
      return JSON.parse(JSON.stringify(rest, (_k, v: unknown) => (v instanceof Uint8Array ? Buffer.from(v).toString('base64') : v))) as Record<string, unknown>;
    } catch (e) {
      throw classifyAwsError(e);
    }
  }
}

export class PublishedIpRanges implements IpRangesPort {
  private cache: { at: number; ranges: IpRange[] } | null = null;
  constructor(private readonly url = 'https://ip-ranges.amazonaws.com/ip-ranges.json') {}
  async ranges(): Promise<IpRange[]> {
    if (this.cache && Date.now() - this.cache.at < 24 * 3600_000) return this.cache.ranges;
    const r = await fetch(this.url, { redirect: 'error', signal: AbortSignal.timeout(8000) });
    if (!r.ok) throw new AwsCallError('NETWORK', 'IpRanges', `ip-ranges.json returned ${r.status}`);
    const ranges = parseIpRanges(await r.json());
    this.cache = { at: Date.now(), ranges };
    return ranges;
  }
}

let shared: { aws: VerifierAwsRead; http: SafeFetch; ipRanges: PublishedIpRanges } | null = null;
let configCache: { at: number; config: EngineConfig } | null = null;

/**
 * Check bundle digest and ATL-RunCheck document pinning: `PlatformConfig.checks` (written at install / upgrade) or the
 * function environment (`ATL_CHECK_BUNDLE_DIGEST`, `ATL_RUNCHECK_DOCUMENT_VERSION`, `ATL_RUNCHECK_DOCUMENT_HASH`).
 */
export async function engineConfig(deps: FunctionDeps): Promise<EngineConfig> {
  if (configCache && Date.now() - configCache.at < 300_000) return configCache.config;
  const pc = await new DynamoItemStore(deps.db, deps.env.tableName).get<{ checks?: { bundleDigest?: string; runCheckDocumentVersion?: string; runCheckDocumentHash?: string } }>(Keys.platformConfig()).catch(() => null);
  const c = pc?.checks ?? {};
  const config: EngineConfig = {
    bundleDigest: c.bundleDigest ?? process.env.ATL_CHECK_BUNDLE_DIGEST ?? null,
    ...((c.runCheckDocumentVersion ?? process.env.ATL_RUNCHECK_DOCUMENT_VERSION) ? { runCheckDocumentVersion: (c.runCheckDocumentVersion ?? process.env.ATL_RUNCHECK_DOCUMENT_VERSION)! } : {}),
    ...((c.runCheckDocumentHash ?? process.env.ATL_RUNCHECK_DOCUMENT_HASH) ? { runCheckDocumentHash: (c.runCheckDocumentHash ?? process.env.ATL_RUNCHECK_DOCUMENT_HASH)! } : {}),
    allowPrivateTargets: false,
  };
  configCache = { at: Date.now(), config };
  return config;
}

export async function prodEnginePorts(deps: FunctionDeps): Promise<CheckEnginePorts> {
  if (deps.env.devMode) throw new Error('atl-checks: ATL_DEV_MODE needs the dev check engine (functions/checks/dev/engine-ports.ts); the production engine never runs in dev mode');
  shared ??= { aws: new VerifierAwsRead(deps.env), http: new SafeFetch(), ipRanges: new PublishedIpRanges() };
  return { ...shared, config: await engineConfig(deps) };
}
