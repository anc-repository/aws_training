// imds-get (04 §6.4): exact-match path allowlist; never requests iam/security-credentials/<role> (temporary credentials).
import { CheckError } from '../lib/context.mjs';

const EXACT = new Set(['instance-id', 'ami-id', 'placement/availability-zone', 'public-ipv4', 'iam/info', 'iam/security-credentials/']);
const MAC_VPC = /^network\/interfaces\/macs\/[0-9a-f]{2}(:[0-9a-f]{2}){5}\/vpc-id$/;

export default async function imdsGet(args, ctx) {
  const p = args.path;
  if (!EXACT.has(p) && !MAC_VPC.test(p)) throw new CheckError('NOT_ALLOWED', `IMDS path not allowed: ${p}`);
  const r = await ctx.imds(p);
  let value = r.value;
  if (p === 'iam/security-credentials/' && typeof value === 'string') value = value.split(/\r?\n/).filter(Boolean); // role names only
  if (p === 'iam/info' && typeof value === 'string') {
    try {
      const j = JSON.parse(value);
      value = { code: j.Code ?? null, instanceProfileArn: j.InstanceProfileArn ?? null };
    } catch {
      value = null;
    }
  }
  const out = { value, status: r.status };
  if (args.checkV1Rejected) {
    const v1 = await ctx.imds('instance-id', { v1: true });
    out.v1Status = v1.status;
  }
  return out;
}
