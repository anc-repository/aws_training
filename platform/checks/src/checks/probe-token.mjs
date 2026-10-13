// probe-token (04 §6.4; 06 PM-13; old name cloudalbum-probe-token): one-time probe tokens for the platform's requests to
// /api/lab/probe/* through an entry (CloudFront, ALB, …). The platform keeps them in memory and redacts them from evidence.
export default async function probeToken(args, ctx) {
  const r = await ctx.oneTimeProbeTokens(args.count ?? 1, args.ttlSec ?? 60);
  return { tokens: r.tokens, expiresAt: r.expiresAt ?? null };
}
