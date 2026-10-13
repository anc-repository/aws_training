// port-listen (04 §6.4): `ss -ltnH` (fixed argv). Dev: a TCP connect to 127.0.0.1 (port 80 maps to the local app port).
import net from 'node:net';
import { CheckError } from '../lib/context.mjs';

export default async function portListen(args, ctx) {
  const port = args.port;
  if (ctx.dev) {
    const url = ctx.appBaseUrl ? new URL(ctx.appBaseUrl) : null;
    const target = port === 80 && url ? Number(url.port || 80) : port;
    const ok = await new Promise((resolve) => {
      const s = net.connect({ host: '127.0.0.1', port: target });
      s.setTimeout(1500, () => {
        s.destroy();
        resolve(false);
      });
      s.on('connect', () => {
        s.destroy();
        resolve(true);
      });
      s.on('error', () => resolve(false));
    });
    return { listening: ok, addresses: ok ? [`127.0.0.1:${target}`] : [], dev: true };
  }
  const r = await ctx.exec('ss', ['-ltnH']);
  if (r.code !== 0) throw new CheckError('RUNNER_UNAVAILABLE', `ss failed (${r.code})`);
  const addresses = [];
  for (const line of r.stdout.split(/\r?\n/)) {
    const local = line.trim().split(/\s+/)[3];
    if (!local) continue;
    const m = /:(\d+)$/.exec(local);
    if (m && Number(m[1]) === port) addresses.push(local);
  }
  return { listening: addresses.length > 0, addresses };
}
