/**
 * CloudFront invalidations of the `atl-web` distribution for files atl-certs rewrites (jwks, revocations, public
 * certificates, verify page, share links; 04 §9.5, §10.6). The distribution id comes from `ATL_WEB_DISTRIBUTION_ID`
 * (set by the platform template); without it — and always in ATL_DEV_MODE — invalidation is skipped (files are served
 * with short TTLs anyway).
 */
import type { FunctionDeps } from '../../runtime/deps.js';

export type Invalidator = (paths: string[]) => Promise<void>;

export const WEB_DISTRIBUTION_ENV = 'ATL_WEB_DISTRIBUTION_ID';

export function createInvalidator(deps: FunctionDeps, env: NodeJS.ProcessEnv = process.env): Invalidator {
  const distributionId = env[WEB_DISTRIBUTION_ENV];
  if (deps.env.devMode || !distributionId) return async () => undefined;
  return async (paths) => {
    if (!paths.length) return;
    try {
      const { CloudFrontClient, CreateInvalidationCommand } = await import('@aws-sdk/client-cloudfront');
      const cf = new CloudFrontClient({ region: 'us-east-1' });
      await cf.send(
        new CreateInvalidationCommand({
          DistributionId: distributionId,
          InvalidationBatch: { CallerReference: `atl-certs-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`, Paths: { Quantity: paths.length, Items: paths } },
        }),
      );
    } catch (e) {
      // short TTLs bound the staleness; never fail the operation because of an invalidation
      console.warn(JSON.stringify({ level: 'warn', msg: 'CloudFront invalidation failed', paths, error: e instanceof Error ? e.message : String(e) }));
    }
  };
}
