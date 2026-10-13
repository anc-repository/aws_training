// file-stat (04 §6.4): stat only (never reads content) under allowlisted prefixes.
import fs from 'node:fs';
import path from 'node:path';
import { CheckError } from '../lib/context.mjs';

const PREFIXES = ['/etc/cloudalbum/', '/var/lib/cloudalbum/', '/opt/cloudalbum/'];
const NGINX = /^\/etc\/nginx\/cloudalbum[A-Za-z0-9._-]*$/;

export default async function fileStat(args, ctx) {
  const p = path.posix.normalize(args.path);
  if (p !== args.path || p.includes('..') || (!PREFIXES.some((x) => p.startsWith(x)) && !NGINX.test(p))) {
    throw new CheckError('NOT_ALLOWED', `path not allowed: ${args.path}`);
  }
  const real = ctx.dev && p.startsWith('/etc/cloudalbum/') && ctx.paths.etc ? path.join(ctx.paths.etc, p.slice('/etc/cloudalbum/'.length)) : p;
  try {
    const st = fs.lstatSync(real);
    return {
      exists: true,
      mode: `0${(st.mode & 0o7777).toString(8)}`,
      owner: st.uid,
      sizeBytes: st.size,
      type: st.isDirectory() ? 'dir' : st.isSymbolicLink() ? 'symlink' : 'file',
    };
  } catch {
    return { exists: false, mode: null, owner: null, sizeBytes: null };
  }
}
