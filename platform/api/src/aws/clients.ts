/**
 * Lazy AWS SDK v3 client factory for the production adapters. Clients are loaded with dynamic `import()` on first use so
 * a function only loads the SDK packages it actually calls (cold start), and are cached per region.
 * Credentials: the function's execution role (default provider chain). Nothing here runs in tests or ATL_DEV_MODE.
 */
type Ctor<T> = new (config: { region: string }) => T;

const cache = new Map<string, unknown>();

async function client<T>(key: string, region: string, load: () => Promise<Ctor<T>>): Promise<T> {
  const k = `${key}@${region}`;
  let c = cache.get(k) as T | undefined;
  if (!c) {
    const C = await load();
    c = new C({ region });
    cache.set(k, c);
  }
  return c;
}

export const aws = {
  sfn: (region: string) => client('sfn', region, async () => (await import('@aws-sdk/client-sfn')).SFNClient),
  codebuild: (region: string) => client('codebuild', region, async () => (await import('@aws-sdk/client-codebuild')).CodeBuildClient),
  ssm: (region: string) => client('ssm', region, async () => (await import('@aws-sdk/client-ssm')).SSMClient),
  scheduler: (region: string) => client('scheduler', region, async () => (await import('@aws-sdk/client-scheduler')).SchedulerClient),
  kms: (region: string) => client('kms', region, async () => (await import('@aws-sdk/client-kms')).KMSClient),
  cloudtrail: (region: string) => client('cloudtrail', region, async () => (await import('@aws-sdk/client-cloudtrail')).CloudTrailClient),
  lambda: (region: string) => client('lambda', region, async () => (await import('@aws-sdk/client-lambda')).LambdaClient),
  eventbridge: (region: string) => client('eventbridge', region, async () => (await import('@aws-sdk/client-eventbridge')).EventBridgeClient),
  s3: (region: string) => client('s3', region, async () => (await import('@aws-sdk/client-s3')).S3Client),
};

/** Name of an SDK v3 service exception (`err.name`). */
export function awsErrorName(e: unknown): string {
  return e && typeof e === 'object' && 'name' in e ? String((e as { name: unknown }).name) : '';
}

export function isThrottle(e: unknown): boolean {
  return /Throttl|TooManyRequests|RequestLimitExceeded|Rate exceeded/i.test(awsErrorName(e) + ' ' + String((e as Error)?.message ?? ''));
}
