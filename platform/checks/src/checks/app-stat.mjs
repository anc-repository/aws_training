// app-stat (04 §6.4; 06 PM-16): one registered business statistic, optionally scoped to an experiment run.
export default async function appStat(args, ctx) {
  const argv = ['app-stat', '--stat', args.stat];
  if (args.runId) argv.push('--run', args.runId);
  argv.push('--json');
  const r = await ctx.cli(argv);
  return { stat: r.stat ?? args.stat, value: r.value ?? null, unit: r.unit ?? null, at: r.at ?? null, scope: r.scope ?? (args.runId ? 'run' : 'now'), ...(args.runId ? { runId: args.runId } : {}) };
}
