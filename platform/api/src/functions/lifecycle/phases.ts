/**
 * Progress phases (02 §11.3): `LabSession.phases[]` + `session.phase_changed`. Phase names follow the proposal of
 * 08 §9.2 #8 (start.*, provision.*, end.*, clean.*) and statuses `PHASE_STATUSES` of @atl/shared; 01 has not
 * registered them yet.
 */
import type { Ctx } from './context.js';
import { applyPhaseMarks, mutateSession } from './store/sessions.js';
import type { SessionRecord } from './store/model.js';

export interface Mark {
  phase: string;
  status: 'QUEUED' | 'RUNNING' | 'RETRYING' | 'DONE' | 'FAILED' | 'SKIPPED';
  detail?: string | null;
}

/** Phase marks as a session patch (to combine with another mutation). */
export function phasePatch(ctx: Ctx, s: SessionRecord, marks: Mark[]): { patch: Partial<SessionRecord>; events: ReturnType<typeof applyPhaseMarks>['events'] } {
  const { phases, events } = applyPhaseMarks(s, marks, ctx.nowIso());
  return { patch: events.length ? { phases } : {}, events };
}

export async function markPhases(ctx: Ctx, sid: string, marks: Mark[], extra: Partial<SessionRecord> = {}): Promise<void> {
  await mutateSession(ctx, sid, (s) => {
    const p = phasePatch(ctx, s, marks);
    const hasExtra = Object.keys(extra).length > 0;
    if (!p.events.length && !hasExtra) return null;
    return { patch: { ...p.patch, ...extra }, events: p.events };
  });
}
