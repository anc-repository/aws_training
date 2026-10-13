// lab-metrics-run (04 §6.4, §7.4; alias atl.lab-metrics; 06 PM-14): server-side metrics of one experiment run.
export default async function labMetricsRun(args, ctx) {
  const argv = ['lab-metrics', '--run', args.runId];
  if (args.padSec !== undefined) argv.push('--pad', String(args.padSec));
  argv.push('--json');
  return ctx.cli(argv, { timeoutMs: 20_000 });
}
