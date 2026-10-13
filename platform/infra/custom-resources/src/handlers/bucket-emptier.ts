/**
 * BucketEmptier (01 §4.6, §4.8): on stack deletion, delete every object version and delete marker of the platform buckets
 * (atl-web, atl-artifacts, atl-data, the state bucket; the optional trail bucket has its own instance) so that CloudFormation
 * can delete them. Create / Update do nothing. Idempotent: a retried deletion continues where the previous one stopped.
 */
import type { CfnEvent, CfnResult } from '../cfn.js';
import { defaultPhysicalId } from '../cfn.js';
import type { Ports } from '../ports.js';

/** Stop listing early so the function can still answer CloudFormation before its own timeout. */
export const EMPTY_TIME_BUDGET_MS = 13 * 60 * 1000;

export async function emptyBucket(ports: Ports, bucket: string, deadline: number): Promise<number> {
  if (!(await ports.s3.bucketExists(bucket))) return 0;
  let deleted = 0;
  for (;;) {
    // always restart from the beginning: deleted versions disappear from the listing
    const page = await ports.s3.listObjectVersions(bucket);
    if (!page.items.length) return deleted;
    await ports.s3.deleteObjects(bucket, page.items);
    deleted += page.items.length;
    if (ports.now().getTime() > deadline) throw new Error(`bucket ${bucket} is not empty yet (${deleted} versions deleted); retry the stack deletion`);
  }
}

export async function bucketEmptier(event: CfnEvent, ports: Ports): Promise<CfnResult> {
  const id = defaultPhysicalId(event);
  if (event.RequestType !== 'Delete') return { physicalResourceId: id };
  const buckets = event.ResourceProperties.Buckets;
  if (!Array.isArray(buckets)) throw new Error('BucketEmptier: Buckets must be a list');
  const deadline = ports.now().getTime() + EMPTY_TIME_BUDGET_MS;
  for (const b of buckets) {
    const n = await emptyBucket(ports, String(b), deadline);
    ports.log('bucket emptied', { bucket: b, versions: n });
  }
  return { physicalResourceId: id };
}
