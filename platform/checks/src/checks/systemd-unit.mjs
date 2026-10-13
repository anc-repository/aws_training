// systemd-unit (04 §6.4): `systemctl show` with a fixed property list, allowlisted units only.
import { CheckError } from '../lib/context.mjs';
import { probe } from '../lib/http.mjs';

const UNIT = /^(cloudalbum-api|cloudalbum-api@[0-9]{2,5}|cloudalbum-worker|cloudalbum-worker-[0-9]{1,2}|cloudalbum-pgbouncer|nginx|amazon-ssm-agent|amazon-cloudwatch-agent|sshd|fail2ban)$/;

export default async function systemdUnit(args, ctx) {
  if (!UNIT.test(args.unit)) throw new CheckError('NOT_ALLOWED', `unit not allowed: ${args.unit}`);
  if (ctx.dev) {
    // dev: the local CloudAlbum api stands in for every unit of the lab instance
    let up = false;
    try {
      up = (await probe({ url: `${ctx.appBaseUrl}/api/health/live`, timeoutMs: 3000 }))[0].status === 200;
    } catch {
      up = false;
    }
    return { active: up ? 'active' : 'inactive', sub: up ? 'running' : 'dead', enabled: 'enabled', since: null, dev: true };
  }
  const r = await ctx.exec('systemctl', ['show', args.unit, '--property=ActiveState,SubState,UnitFileState,ActiveEnterTimestamp', '--no-pager']);
  if (r.code === 127) throw new CheckError('RUNNER_UNAVAILABLE', 'systemctl not found');
  const kv = {};
  for (const l of r.stdout.split(/\r?\n/)) {
    const i = l.indexOf('=');
    if (i > 0) kv[l.slice(0, i)] = l.slice(i + 1);
  }
  let since = null;
  if (kv.ActiveEnterTimestamp && kv.ActiveEnterTimestamp !== 'n/a') {
    const d = new Date(kv.ActiveEnterTimestamp.replace(/^[A-Za-z]{3} /, ''));
    since = Number.isNaN(d.getTime()) ? kv.ActiveEnterTimestamp : d.toISOString();
  }
  return { active: kv.ActiveState ?? 'unknown', sub: kv.SubState ?? 'unknown', enabled: kv.UnitFileState ?? 'unknown', since };
}
