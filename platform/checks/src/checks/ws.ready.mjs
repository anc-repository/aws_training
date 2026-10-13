// ws.ready (04 §6.4, 02/03 health gate, `on: workstation`): the workstation readiness report written by
// atl-workstation-setup.sh (03 §4.6) at /var/lib/atl/ready.json.
import fs from 'node:fs';
import { PATHS } from '../lib/context.mjs';

export default async function wsReady(_args, ctx) {
  if (ctx.dev) return { labuserPresent: true, cliProfileOk: true, repoCommit: null, tools: {}, dev: true };
  let r = null;
  try {
    r = JSON.parse(fs.readFileSync(PATHS.wsReady, 'utf8'));
  } catch {
    return { ready: false, labuserPresent: fs.existsSync('/home/labuser'), cliProfileOk: false, repoCommit: null, tools: {} };
  }
  return {
    ready: r.ready !== false,
    labuserPresent: r.labuserPresent ?? fs.existsSync('/home/labuser'),
    cliProfileOk: r.cliProfileOk ?? false,
    repoCommit: r.repoCommit ?? null,
    tools: r.tools ?? {},
    sessionId: r.sessionId ?? null,
    at: r.at ?? null,
  };
}
