// module-state (04 §6.4; 06 PM-15): enabled modules, drivers and recent operations (modules.state.json via the CLI;
// the file itself as a fallback).
import fs from 'node:fs';

export default async function moduleState(args, ctx) {
  let data;
  try {
    data = await ctx.cli(['module-state', ...(args.module ? ['--module', args.module] : []), '--json']);
  } catch (e) {
    try {
      data = JSON.parse(fs.readFileSync(ctx.paths.modulesState, 'utf8'));
    } catch {
      throw e;
    }
  }
  const modules = data.modules ?? {};
  const pick = args.module ? { [args.module]: modules[args.module] ?? null } : modules;
  const history = Array.isArray(data.history) ? data.history.filter((h) => !args.module || h.module === args.module).slice(-5) : [];
  return { modules: pick, pending: data.pending ?? null, history };
}
