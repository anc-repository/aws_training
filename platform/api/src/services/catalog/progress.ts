/**
 * Pure functions over `LabProgress` (tracks-and-catalog §5): track progress and certificate eligibility (§5.5) and the
 * service mastery map (§5.4). `atl-api` computes them on demand (tracks §5.7, 04 §8.6); nothing is stored.
 */
import type { CatalogIndex, TrackDef } from './store.js';

export interface Badge {
  level?: 'verified' | 'attested' | 'self-reported';
  status?: 'valid' | 'pending' | 'withdrawn';
  earnedAt?: string;
  attemptId?: string;
  labVersion?: string;
  catalogVersion?: string;
  variant?: string;
  evidenceScore?: number;
  quiz?: { bestScore?: number; attempts?: number; byDomain?: Record<string, number> };
}

export interface ProgressRecord {
  labId: string;
  kind?: 'service' | 'scenario';
  status?: string;
  attempts?: number;
  bestAttemptId?: string;
  firstCompletedAt?: string;
  badge?: Badge | null;
  credits?: { serviceId: string; attemptId?: string; provenance?: string }[];
  regressions?: { serviceId: string; foundInSession?: string; checkKey?: string; at?: string }[];
  quizByService?: Record<string, number | { correct: number; total: number }>;
}

const countsForCertificate = (b: Badge | null | undefined): boolean => !!b && b.status === 'valid' && b.level !== 'self-reported';

export interface TrackProgress {
  trackId: string;
  required: { labId: string; done: boolean; badge: Badge | null }[];
  optional: { labId: string; done: boolean }[];
  groups: { groupId: string; title?: string; pick: number; cards: string[]; done: number }[];
  requiredDone: number;
  requiredTotal: number;
  verifiedRatio: number | null;
  completed: boolean;
  certificate: { eligible: boolean; reasons: { code: string; [k: string]: unknown }[] };
}

/** Track progress and certificate eligibility (§5.5 rules 1–4). `defectiveVersions`: catalog versions marked defective. */
export function trackProgress(track: TrackDef, progress: ProgressRecord[], defectiveVersions: ReadonlySet<string> = new Set()): TrackProgress {
  const byLab = new Map(progress.map((p) => [p.labId, p]));
  const required: TrackProgress['required'] = [];
  const optional: TrackProgress['optional'] = [];
  const groups: TrackProgress['groups'] = [];
  const reasons: TrackProgress['certificate']['reasons'] = [];
  const counted: Badge[] = [];
  for (const stage of track.stages ?? []) {
    for (const it of stage.items ?? []) {
      if (it.card) {
        const b = byLab.get(it.card)?.badge ?? null;
        const done = countsForCertificate(b);
        if (it.role === 'required') {
          required.push({ labId: it.card, done, badge: b });
          if (done) counted.push(b!);
          else reasons.push({ code: b?.status === 'pending' ? 'BADGE_PENDING' : 'REQUIRED_CARD_MISSING', labId: it.card });
        } else optional.push({ labId: it.card, done });
      } else if (it.group) {
        const cards = it.cards ?? [];
        const valid = cards.filter((c) => countsForCertificate(byLab.get(c)?.badge));
        const pick = it.pick ?? 1;
        groups.push({ groupId: it.group, ...(it.title ? { title: it.title } : {}), pick, cards, done: valid.length });
        for (const c of valid.slice(0, pick)) counted.push(byLab.get(c)!.badge!);
        if (valid.length < pick) reasons.push({ code: 'GROUP_PICK_UNMET', groupId: it.group, need: pick, have: valid.length });
      }
    }
  }
  const verified = counted.filter((b) => b.level === 'verified').length;
  const verifiedRatio = counted.length ? verified / counted.length : null;
  const minAutoRatio = track.completion?.minAutoRatio ?? 0.8;
  if (verifiedRatio !== null && verifiedRatio < minAutoRatio) reasons.push({ code: 'VERIFIED_RATIO_LOW', ratio: Number(verifiedRatio.toFixed(3)), min: minAutoRatio });
  for (const b of counted) if (b.catalogVersion && defectiveVersions.has(b.catalogVersion)) reasons.push({ code: 'CONTENT_DEFECTIVE', catalogVersion: b.catalogVersion });
  if (track.certificate?.enabled === false) reasons.push({ code: 'CERTIFICATE_DISABLED' });
  const requiredDone = required.filter((r) => r.done).length;
  const completed = requiredDone === required.length && groups.every((g) => g.done >= g.pick);
  return {
    trackId: track.id,
    required,
    optional,
    groups,
    requiredDone,
    requiredTotal: required.length,
    verifiedRatio,
    completed,
    certificate: { eligible: completed && reasons.length === 0, reasons },
  };
}

// ---------------------------------------------------------------------------------------------------------------
// Service mastery (§5.4)

export interface ServiceMastery {
  id: string;
  level: 'proficient' | 'mastered' | 'touched' | 'not_started';
  viaScenarios: boolean;
  score: number;
  needsReview: boolean;
  serviceCard: { labId: string; badgeLevel: string | null } | null;
  scenarioCredits: string[];
  quiz: { ratio: number | null };
}

function quizRatio(v: number | { correct: number; total: number } | undefined): { ratio: number; total: number } | null {
  if (v === undefined) return null;
  if (typeof v === 'number') return { ratio: v > 1 ? v / 100 : v, total: 3 };
  return v.total > 0 ? { ratio: v.correct / v.total, total: v.total } : null;
}

export function mastery(index: CatalogIndex, progress: ProgressRecord[]): ServiceMastery[] {
  const byLab = new Map(progress.map((p) => [p.labId, p]));
  const scenarioCards = new Set(index.cards.filter((c) => c.kind === 'scenario').map((c) => c.id));
  return (index.serviceMap ?? []).map((cell) => {
    const svc = cell.serviceCard ? byLab.get(cell.serviceCard) : undefined;
    const svcBadge = svc?.badge && svc.badge.status === 'valid' ? svc.badge : null;
    const eSvc = svcBadge ? (svcBadge.evidenceScore ?? 1) : 0;
    const scenarioCredits = progress
      .filter((p) => scenarioCards.has(p.labId) && p.badge?.status === 'valid' && (p.credits ?? []).some((c) => c.serviceId === cell.id))
      .map((p) => p.labId);
    const eSc = scenarioCredits.reduce((s, id) => s + (byLab.get(id)?.badge?.evidenceScore ?? 1), 0);
    let q: { ratio: number; total: number } | null = null;
    for (const p of progress) {
      const r = quizRatio(p.quizByService?.[cell.id]);
      if (r && (!q || r.ratio > q.ratio)) q = r;
    }
    const Q = q && q.total >= 3 ? q.ratio : 0;
    const hasScenario = (cell.creditedBy ?? []).length > 0;
    const score = Math.round(hasScenario ? 60 * eSvc + 25 * Math.min(1, eSc) + 15 * Q : 75 * eSvc + 25 * Q);
    const badgeLevel = svcBadge?.level ?? null;
    let level: ServiceMastery['level'] = 'not_started';
    let viaScenarios = false;
    if (
      (hasScenario && (badgeLevel === 'verified' || badgeLevel === 'attested') && scenarioCredits.length >= 1 && Q >= 0.8) ||
      (!hasScenario && badgeLevel === 'verified' && Q >= 0.8)
    ) {
      level = 'proficient';
    } else if (svcBadge || scenarioCredits.length >= 2) {
      level = 'mastered';
      viaScenarios = !svcBadge;
    } else if ((svc && (svc.attempts ?? 0) > 0) || scenarioCredits.length === 1 || q) {
      level = 'touched';
    }
    const needsReview = progress.some((p) => (p.regressions ?? []).some((r) => r.serviceId === cell.id));
    return {
      id: cell.id,
      level,
      viaScenarios,
      score,
      needsReview,
      serviceCard: cell.serviceCard ? { labId: cell.serviceCard, badgeLevel } : null,
      scenarioCredits,
      quiz: { ratio: q ? Number(q.ratio.toFixed(3)) : null },
    };
  });
}
