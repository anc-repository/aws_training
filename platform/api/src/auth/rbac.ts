/**
 * Role checks (01 §5.2): one table — the `auth` column of the shared route table — not scattered in handlers.
 */
import type { CognitoGroup, ResolvedRouteDef, RouteAuth } from '@atl/shared';

const GROUP_CODE: Readonly<Record<CognitoGroup, RouteAuth>> = { learner: 'L', assistant: 'A', observer: 'O' };

export function groupCodes(groups: readonly CognitoGroup[]): RouteAuth[] {
  return groups.map((g) => GROUP_CODE[g]).filter(Boolean);
}

/** May a JWT principal with these groups call this route? */
export function isRouteAllowed(route: ResolvedRouteDef, groups: readonly CognitoGroup[]): boolean {
  if (route.kind !== 'jwt') return false;
  const codes = groupCodes(groups);
  return route.auth.some((a) => codes.includes(a));
}

/** Sensitive routes require a real login (`auth_time`) within this window (01 §5.3). */
export const RECENT_AUTH_SECONDS = 60 * 60;

export function isRecentAuth(authTimeEpochSeconds: number, nowMs: number): boolean {
  return nowMs / 1000 - authTimeEpochSeconds <= RECENT_AUTH_SECONDS;
}
