/**
 * Learning paths and mastery (04 §8.7; tracks-and-catalog §4.6, §5.4, §5.5): pure functions over `LabProgress`.
 * `trackProgress` also yields the certificate eligibility reasons shared by `GET /tracks/{trackId}` and
 * `POST /certificates` (08 §9.2 #17).
 */
import type { BadgeRecord, LabProgressItem } from './types.js';

export type TrackItem = { card: string; role: 'required' | 'optional'; legacyLab?: number | string; note?: string } | { group: string; title?: string; pick: number; cards: string[] };

export interface TrackDef {
  schema: 'atl.track/v2';
  id: string;
  version: string;
  title: string;
  summary?: string;
  stages: { id: string; title: string; items: TrackItem[] }[];
  completion: { allowManual?: boolean; minAutoRatio: number; excludeSelfReported?: boolean };
  certificate?: { enabled: boolean; title?: string };
}

export interface TrackProgress {
  trackId: string;
  status: 'not_started' | 'in_progress' | 'completed';
  stages: { id: string; title: string; items: { card?: string; group?: string; role?: string; done: boolean; pick?: number; doneCount?: number; badge?: BadgeRecord | null }[] }[];
  requiredDone: string;
  groups: { group: string; pick: number; done: number; cards: string[] }[];
  verifiedRatio: number;
  countedCards: string[];
  /** Why a certificate cannot be claimed yet (empty = eligible). */
  reasons: string[];
}

/** A badge counts when valid and not “self-reported” (pending waits for the cross-check, tracks §5.5). */
export function countsForTrack(b: BadgeRecord | null | undefined): boolean {
  return !!b && b.status === 'valid' && b.level !== 'self-reported';
}

export function trackProgress(track: TrackDef, progress: LabProgressItem[]): TrackProgress {
  const byLab = new Map(progress.map((p) => [p.labId, p]));
  const counted = (card: string) => countsForTrack(byLab.get(card)?.badge);
  const reasons: string[] = [];
  let reqTotal = 0;
  let reqDone = 0;
  const groups: TrackProgress['groups'] = [];
  const countedCards: string[] = [];
  const stages = track.stages.map((st) => ({
    id: st.id,
    title: st.title,
    items: st.items.map((it) => {
      if ('card' in it) {
        const done = counted(it.card);
        if (it.role === 'required') {
          reqTotal++;
          if (done) {
            reqDone++;
            countedCards.push(it.card);
          } else {
            const b = byLab.get(it.card)?.badge;
            reasons.push(!b ? `必修卡片 ${it.card} 尚无徽章` : b.status === 'pending' ? `必修卡片 ${it.card} 的徽章仍在交叉核验` : b.status === 'withdrawn' ? `必修卡片 ${it.card} 的徽章已撤回` : `必修卡片 ${it.card} 的徽章为“自述为主”，不计入`);
          }
        }
        return { card: it.card, role: it.role, done, badge: byLab.get(it.card)?.badge ?? null };
      }
      const doneCards = it.cards.filter(counted);
      groups.push({ group: it.group, pick: it.pick, done: doneCards.length, cards: it.cards });
      countedCards.push(...doneCards);
      if (doneCards.length < it.pick) reasons.push(`选修组 ${it.title ?? it.group} 还需 ${it.pick - doneCards.length} 张有效徽章`);
      return { group: it.group, pick: it.pick, doneCount: doneCards.length, done: doneCards.length >= it.pick };
    }),
  }));
  const uniq = [...new Set(countedCards)];
  const verified = uniq.filter((c) => byLab.get(c)?.badge?.level === 'verified').length;
  const verifiedRatio = uniq.length ? Math.round((verified / uniq.length) * 1000) / 1000 : 0;
  if (uniq.length && verifiedRatio < track.completion.minAutoRatio) reasons.push(`“已核验”徽章占比 ${verifiedRatio} 低于 ${track.completion.minAutoRatio}`);
  const complete = reqDone === reqTotal && groups.every((g) => g.done >= g.pick) && verifiedRatio >= track.completion.minAutoRatio && (reqTotal > 0 || groups.length > 0);
  const anyActivity = track.stages.some((st) => st.items.some((it) => ('card' in it ? !!byLab.get(it.card) : it.cards.some((c) => !!byLab.get(c)))));
  return {
    trackId: track.id,
    status: complete ? 'completed' : anyActivity ? 'in_progress' : 'not_started',
    stages,
    requiredDone: `${reqDone}/${reqTotal}`,
    groups,
    verifiedRatio,
    countedCards: uniq,
    reasons: complete ? [] : reasons.length ? reasons : ['路径尚未完成'],
  };
}

// ---------------------------------------------------------------------------------------------------------------
// mastery (tracks-and-catalog §5.4)

export interface CatalogService {
  id: string;
  /** The single-service card of this service (svc-<module>), if any. */
  serviceCard?: string | null;
  /** Scenario cards that can credit this service. */
  scenarioCards: string[];
}

export interface ServiceMastery {
  serviceId: string;
  score: number;
  level: 'proficient' | 'mastered' | 'touched' | 'not_started';
  viaScenarios?: boolean;
  needsReview: boolean;
}

export function mastery(progress: LabProgressItem[], quizByService: Record<string, { correctRatio: number; answered: number }>, catalog: CatalogService[]): ServiceMastery[] {
  const byLab = new Map(progress.map((p) => [p.labId, p]));
  const valid = (lab: string | null | undefined) => {
    const b = lab ? byLab.get(lab)?.badge : null;
    return b && b.status === 'valid' ? b : null;
  };
  return catalog.map((svc) => {
    const single = valid(svc.serviceCard);
    const eSvc = single ? single.evidenceScore : 0;
    const credited = svc.scenarioCards.filter((c) => valid(c) && (byLab.get(c)?.credits ?? []).some((k) => k.serviceId === svc.id));
    const eSc = credited.reduce((a, c) => a + (valid(c)?.evidenceScore ?? 0), 0);
    const q = quizByService[svc.id];
    const Q = q && q.answered >= 3 ? q.correctRatio : 0;
    const hasScenario = svc.scenarioCards.length > 0;
    const score = Math.round(hasScenario ? 60 * eSvc + 25 * Math.min(1, eSc) + 15 * Q : 75 * eSvc + 25 * Q);
    let level: ServiceMastery['level'] = 'not_started';
    const singleGood = single && (single.level === 'verified' || single.level === 'attested');
    if ((hasScenario && singleGood && credited.length >= 1 && Q >= 0.8) || (!hasScenario && single?.level === 'verified' && Q >= 0.8)) level = 'proficient';
    else if (single || credited.length >= 2) level = 'mastered';
    else if ((svc.serviceCard && byLab.get(svc.serviceCard)) || credited.length === 1 || svc.scenarioCards.some((c) => byLab.get(c)) || (q && q.answered > 0)) level = 'touched';
    const needsReview = progress.some((p) => (p.regressions ?? []).some((r) => r.serviceId === svc.id));
    return { serviceId: svc.id, score, level, ...(level === 'mastered' && !single ? { viaScenarios: true } : {}), needsReview };
  });
}
