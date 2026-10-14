/**
 * The single place where scripts/module talks to AWS (deployer identity). Every call goes through AwsGateway.send():
 *   - real mode: the SDK v3 client is imported lazily (dynamic import) and the command is sent
 *   - --dry-run: the call is printed (secret parameters redacted) and NOT executed; send() returns undefined and callers
 *     continue with placeholders. Read-only calls are not executed either (no credentials needed for a dry run).
 */
import type { Printer } from './printer.js';

export type AwsService = 'cloudformation' | 'ec2' | 'iam' | 's3' | 'ssm' | 'sts' | 'dynamodb' | 'cognito-idp' | 'rds'
  // wave1-prep: out-of-band calls and preflight checks of the wave 1 module hooks (module-hooks/<id>.ts)
  | 'route53' | 'acm' | 'wafv2' | 'sesv2' | 'ce' | 'budgets' | 'sns' | 'logs' | 'cloudfront';

const CLIENTS: Record<AwsService, { pkg: string; client: string }> = {
  cloudformation: { pkg: '@aws-sdk/client-cloudformation', client: 'CloudFormationClient' },
  ec2: { pkg: '@aws-sdk/client-ec2', client: 'EC2Client' },
  iam: { pkg: '@aws-sdk/client-iam', client: 'IAMClient' },
  s3: { pkg: '@aws-sdk/client-s3', client: 'S3Client' },
  ssm: { pkg: '@aws-sdk/client-ssm', client: 'SSMClient' },
  sts: { pkg: '@aws-sdk/client-sts', client: 'STSClient' },
  // platform mode (06 PM-28 lock table, PM-36 cognito-passwords hook)
  dynamodb: { pkg: '@aws-sdk/client-dynamodb', client: 'DynamoDBClient' },
  'cognito-idp': { pkg: '@aws-sdk/client-cognito-identity-provider', client: 'CognitoIdentityProviderClient' },
  rds: { pkg: '@aws-sdk/client-rds', client: 'RDSClient' },   // env suspend / resume (02 §8.2)
  // wave1-prep (module-hooks): dns hosted-zone checks, tls ACME endpoint / EAB, waf IP-set import, email identity checks,
  // cost allocation tags, notification / monitoring subscriptions, shell-access session logs, CloudFront association checks
  route53: { pkg: '@aws-sdk/client-route-53', client: 'Route53Client' },
  acm: { pkg: '@aws-sdk/client-acm', client: 'ACMClient' },
  wafv2: { pkg: '@aws-sdk/client-wafv2', client: 'WAFV2Client' },
  sesv2: { pkg: '@aws-sdk/client-sesv2', client: 'SESv2Client' },
  ce: { pkg: '@aws-sdk/client-cost-explorer', client: 'CostExplorerClient' },
  budgets: { pkg: '@aws-sdk/client-budgets', client: 'BudgetsClient' },
  sns: { pkg: '@aws-sdk/client-sns', client: 'SNSClient' },
  logs: { pkg: '@aws-sdk/client-cloudwatch-logs', client: 'CloudWatchLogsClient' },
  cloudfront: { pkg: '@aws-sdk/client-cloudfront', client: 'CloudFrontClient' },
};

/** Services whose control plane is global and served from us-east-1 (default region of a call without `region`). */
export const GLOBAL_SERVICES: ReadonlySet<AwsService> = new Set<AwsService>(['iam', 'route53', 'budgets', 'ce', 'cloudfront']);

export interface AwsCall {
  service: AwsService;
  /** command name without the Command suffix, e.g. DescribeStacks */
  op: string;
  input: Record<string, unknown>;
  region?: string;
  /** what to print instead of input (NoEcho parameters, file bodies) */
  display?: Record<string, unknown>;
}

export interface AwsGateway {
  readonly dryRun: boolean;
  send<T = Record<string, unknown>>(call: AwsCall): Promise<T | undefined>;
}

export class AwsCallError extends Error {
  constructor(readonly call: AwsCall, override readonly cause: unknown) {
    super(`${call.service}:${call.op} failed: ${(cause as { name?: string; message?: string })?.name ?? 'Error'}: ${(cause as Error)?.message ?? String(cause)}`);
  }
  get awsName(): string | undefined {
    return (this.cause as { name?: string })?.name;
  }
}

export function describeCall(call: AwsCall): string {
  const body = JSON.stringify(call.display ?? call.input);
  return `${call.service}:${call.op}${call.region ? ` [${call.region}]` : ''} ${body.length > 600 ? `${body.slice(0, 600)}…` : body}`;
}

export class DryRunGateway implements AwsGateway {
  readonly dryRun = true;
  readonly calls: AwsCall[] = [];
  constructor(private readonly out?: Printer) {}
  async send<T>(call: AwsCall): Promise<T | undefined> {
    this.calls.push(call);
    this.out?.dry(`aws ${describeCall(call)}`);
    return undefined;
  }
}

type SdkModule = Record<string, new (arg: unknown) => unknown>;
type SdkClient = { send(cmd: unknown): Promise<unknown> };

export class SdkGateway implements AwsGateway {
  readonly dryRun = false;
  private readonly clients = new Map<string, SdkClient>();
  private readonly modules = new Map<string, SdkModule>();
  constructor(private readonly defaultRegion: string, private readonly out?: Printer) {}

  private async load(service: AwsService): Promise<SdkModule> {
    const spec = CLIENTS[service];
    let mod = this.modules.get(spec.pkg);
    if (!mod) {
      mod = (await import(spec.pkg)) as SdkModule;
      this.modules.set(spec.pkg, mod);
    }
    return mod;
  }

  async send<T>(call: AwsCall): Promise<T | undefined> {
    const region = call.region ?? (GLOBAL_SERVICES.has(call.service) ? 'us-east-1' : this.defaultRegion);
    const mod = await this.load(call.service);
    const key = `${call.service}@${region}`;
    let client = this.clients.get(key);
    if (!client) {
      const Ctor = mod[CLIENTS[call.service].client];
      if (!Ctor) throw new Error(`${CLIENTS[call.service].pkg} has no ${CLIENTS[call.service].client}`);
      client = new Ctor({ region }) as SdkClient;
      this.clients.set(key, client);
    }
    const Cmd = mod[`${call.op}Command`];
    if (!Cmd) throw new Error(`${CLIENTS[call.service].pkg} has no ${call.op}Command`);
    this.out?.debug(`aws ${describeCall(call)}`);
    try {
      return (await client.send(new Cmd(call.input))) as T;
    } catch (e) {
      throw new AwsCallError(call, e);
    }
  }
}

export function isAwsError(e: unknown, ...names: string[]): boolean {
  const n = e instanceof AwsCallError ? e.awsName : (e as { name?: string })?.name;
  const msg = e instanceof Error ? e.message : '';
  return names.some((x) => n === x || msg.includes(x));
}
