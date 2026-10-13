// atl.channel (04 §6.4, 03): management-channel self check — SSM Agent, terminal helper, labuser.
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import { PATHS } from '../lib/context.mjs';

export default async function atlChannel(_args, ctx) {
  if (ctx.dev) return { ssmAgent: { running: true, version: 'dev' }, terminalHelper: { version: null, sha256: null }, labuserPresent: true, dev: true };
  const active = await ctx.exec('systemctl', ['is-active', 'amazon-ssm-agent']);
  const ver = await ctx.exec('amazon-ssm-agent', ['--version']);
  let helper = { version: null, sha256: null };
  try {
    const buf = fs.readFileSync(PATHS.terminalHelper);
    const m = /ATL_HELPER_VERSION=([0-9A-Za-z.-]+)/.exec(buf.toString('utf8'));
    helper = { version: m ? m[1] : null, sha256: createHash('sha256').update(buf).digest('hex') };
  } catch {
    /* not installed */
  }
  const v = /([0-9]+\.[0-9]+\.[0-9]+\.[0-9]+)/.exec(ver.stdout + ver.stderr);
  return { ssmAgent: { running: active.stdout.trim() === 'active', version: v ? v[1] : null }, terminalHelper: helper, labuserPresent: fs.existsSync('/home/labuser') };
}
