// disk-usage (04 §6.4): statfs of an allowlisted mount point (+ filesystem type from findmnt).
import fs from 'node:fs';
import { CheckError } from '../lib/context.mjs';

const MOUNTS = new Set(['/', '/var/lib/cloudalbum', '/var/lib/cloudalbum/media', '/mnt/efs', '/mnt/cloudalbum-efs']);

export default async function diskUsage(args, ctx) {
  if (!MOUNTS.has(args.mount)) throw new CheckError('NOT_ALLOWED', `mount not allowed: ${args.mount}`);
  const p = ctx.dev ? ctx.paths.etc ?? process.cwd() : args.mount;
  let st;
  try {
    st = fs.statfsSync(p);
  } catch {
    return { mounted: false, usedPct: null, fstype: null, sizeBytes: null };
  }
  const size = st.blocks * st.bsize;
  const free = st.bavail * st.bsize;
  let fstype = null;
  if (!ctx.dev) {
    const r = await ctx.exec('findmnt', ['-n', '-o', 'FSTYPE', '--target', args.mount]);
    if (r.code === 0) fstype = r.stdout.trim() || null;
  }
  return { mounted: true, usedPct: size > 0 ? Math.round(((size - free) / size) * 1000) / 10 : null, fstype, sizeBytes: size };
}
