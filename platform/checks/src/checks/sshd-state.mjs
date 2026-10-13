// sshd-state (04 §6.4, svc-shell-access): sshd running, port 22 listening, password authentication.
import portListen from './port-listen.mjs';

export default async function sshdState(_args, ctx) {
  if (ctx.dev) return { active: false, port22Listening: false, passwordAuth: null, dev: true };
  const a = await ctx.exec('systemctl', ['is-active', 'sshd']);
  const listen = await portListen({ port: 22, proto: 'tcp' }, ctx);
  const t = await ctx.exec('sshd', ['-T']);
  const m = /^passwordauthentication\s+(\S+)/m.exec(t.stdout);
  return { active: a.stdout.trim() === 'active', port22Listening: listen.listening, passwordAuth: m ? m[1] === 'yes' : null };
}
