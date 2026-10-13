// env-key (04 §6.4): one key of modules.d/<module>.env; secret-like keys only report presence (04 §4.4 rule 3).
import { SECRET_KEY_RE } from '../lib/context.mjs';

export default async function envKey(args, ctx) {
  const env = ctx.moduleEnv(args.module);
  if (!env) return { present: false, fileExists: false };
  if (!Object.prototype.hasOwnProperty.call(env, args.key)) return { present: false, fileExists: true };
  if (SECRET_KEY_RE.test(args.key)) return { present: true, secret: true };
  return { present: true, value: env[args.key] };
}
