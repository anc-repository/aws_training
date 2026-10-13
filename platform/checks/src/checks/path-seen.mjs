// path-seen (04 §6.4; 06 PM-16): `cloudalbum path-seen --segment … --pattern … --window … [--min-count n] [--distinct] --json`.
export default async function pathSeen(args, ctx) {
  const argv = ['path-seen', '--segment', args.segment, '--pattern', args.pattern, '--window', args.window];
  if (args.minCount !== undefined) argv.push('--min-count', String(args.minCount));
  if (args.distinct) argv.push('--distinct');
  argv.push('--json');
  const r = await ctx.cli(argv);
  return {
    count: r.count ?? 0,
    distinctValues: r.distinctValues ?? [],
    firstTs: r.firstTs ?? null,
    lastTs: r.lastTs ?? null,
    samples: Array.isArray(r.samples) ? r.samples.slice(0, 3) : [],
    minCount: args.minCount ?? 1,
  };
}
