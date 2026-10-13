/**
 * Loads everything a session view needs in parallel: environment, platform config, the session's quote, the attempt,
 * step results, the session's resources (AP15) and the card's required steps (pinned `catalogVersion`).
 */
import { SkPrefix } from '../../data/keys.js';
import type { SessionItem } from '../../repositories/index.js';
import { buildSessionView } from './view.js';
import type { ServiceContext } from './types.js';

export async function requiredStepIds(ctx: ServiceContext, s: SessionItem): Promise<string[] | null> {
  if (typeof s.catalogVersion !== 'string') return null;
  try {
    const lab = await ctx.catalog.lab(s.labId, s.catalogVersion);
    if (!lab?.steps) return null;
    return lab.steps.filter((st) => !st.optional).map((st) => st.id);
  } catch {
    return null;
  }
}

export async function sessionView(ctx: ServiceContext, s: SessionItem): Promise<Record<string, unknown>> {
  const quoteId = (s.costQuote as { quoteId?: string } | undefined)?.quoteId;
  const [env, config, quote, attempt, steps, resources, required] = await Promise.all([
    typeof s.envId === 'string' ? ctx.repos.environments.get(s.envId) : Promise.resolve(null),
    ctx.repos.platform.config(),
    quoteId ? ctx.repos.users.quote(s.sub, quoteId) : Promise.resolve(null),
    ctx.repos.sessions.attempt(s.sid),
    ctx.repos.sessions.children(s.sid, SkPrefix.step, { all: true }).then((p) => p.items),
    ctx.repos.environments.resourcesBySession(s.sid).catch(() => []),
    requiredStepIds(ctx, s),
  ]);
  return buildSessionView({ session: s, env, config, quote, attempt, steps, requiredStepIds: required, resources, nowMs: ctx.nowMs });
}
