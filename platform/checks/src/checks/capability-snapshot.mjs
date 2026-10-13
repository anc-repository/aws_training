// capability-snapshot (04 §5.2.2, §6.4; alias atl.capabilities): projected /api/capabilities from the loopback address.
import { capabilitySnapshot } from '../lib/caps.mjs';

export default async function capabilitySnapshotCheck(args, ctx) {
  const r = await capabilitySnapshot(ctx, { modules: args.modules, view: args.view ?? 'public', fields: args.fields });
  return { via: r.via, ...r.data };
}
