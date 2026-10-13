/**
 * atl-reaper — the reclaimer (02 §7): discovery from six sources, eligibility, staged deletion S0–S6, verification,
 * CaptureLedger (start workflow), OwnershipLookup (atl-checks), ResolveItem (atl-lifecycle for “我已处理”) and
 * PurgeEnvState (end of the rescan window, 9.5). Dispatches on `action`; unknown actions throw `Atl.NotImplemented`.
 */
import { createActionDispatcher, type ActionHandler, type DepsProvider } from '../../runtime/deps.js';
import { makeCtx } from '../lifecycle/context.js';
import { ownershipLookup, type OwnershipLookupRequest } from '../ownership/ownership.js';
import { buildDeletionPlan, deleteItem, markManual, pollItem, purgeEnvState, resolveItem, verify, type DeleteItemInput } from './reclaimer/actions.js';
import { captureLedger, discoverPage, planDiscovery, recordDiscoverGap, type DiscoveryItem } from './reclaimer/discovery.js';

export const FUNCTION_NAME = 'atl-reaper';

type P = Record<string, unknown>;
const s = (v: unknown): string => String(v ?? '');
const ctxOf = (deps: Parameters<ActionHandler>[1]) => makeCtx(deps, 'system');

export const ACTIONS: Record<string, ActionHandler> = {
  CaptureLedger: (p, d) => captureLedger(ctxOf(d), { envId: s(p.envId), sessionId: s(p.sessionId) }),
  PlanDiscovery: (p, d) => planDiscovery(ctxOf(d), { input: p.input as never, executionName: s(p.executionName) }),
  DiscoverPage: (p, d) => discoverPage(ctxOf(d), { item: p.item as DiscoveryItem }),
  RecordDiscoverGap: (p, d) => recordDiscoverGap(ctxOf(d), { item: p.item as never }),
  BuildDeletionPlan: (p: P, d) => buildDeletionPlan(ctxOf(d), { envId: s(p.envId), sessionId: s(p.sessionId), passNo: Number(p.passNo ?? 0), mode: (s(p.mode) || 'PRIMARY') as 'PRIMARY' }),
  DeleteItem: (p, d) => deleteItem(ctxOf(d), { item: p.item as DeleteItemInput }),
  PollItem: (p, d) => pollItem(ctxOf(d), { item: p.item as DeleteItemInput }),
  MarkManual: (p, d) => markManual(ctxOf(d), { item: p.item as DeleteItemInput, error: (p.error as { Error?: string; Cause?: string } | null) ?? null }),
  Verify: (p, d) => verify(ctxOf(d), { envId: s(p.envId), sessionId: s(p.sessionId), mode: (s(p.mode) || 'PRIMARY') as 'PRIMARY', passNo: Number(p.passNo ?? 0) }),
  OwnershipLookup: (p, d) => ownershipLookup(ctxOf(d), p as unknown as OwnershipLookupRequest),
  ResolveItem: (p, d) => resolveItem(ctxOf(d), { envId: s(p.envId), resourceKey: s(p.resourceKey), sessionId: s(p.sessionId) }),
  PurgeEnvState: (p, d) => purgeEnvState(ctxOf(d), { envId: s(p.envId), sessionId: s(p.sessionId) }),
};

export function createReaperHandler(getDeps: DepsProvider, actions: Record<string, ActionHandler> = ACTIONS) {
  return createActionDispatcher(FUNCTION_NAME, actions, getDeps);
}
