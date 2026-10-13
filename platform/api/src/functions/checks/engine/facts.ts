/**
 * Everything a check run needs to know about a session, loaded once per invocation: LabSession, Environment,
 * PlatformConfig, the pinned content (expanded card), the attempt, step results and the hand-over chain (02 §8.4,
 * 04 §8.11). Content is immutable per catalog version and cached per container.
 */
import { WebKeys, type EnvironmentItem, type LabSessionItem, type PlatformConfigItem } from '@atl/shared';
import { Keys, SkPrefix } from '../../../data/keys.js';
import type { FunctionDeps } from '../../../runtime/deps.js';
import type { ItemStore } from '../../../services/progress/store.js';
import type { LabAttemptItem, StepResultItem } from '../../../services/progress/types.js';
import type { CardBuild, CheckDecl } from '../types.js';

export type SessionRecord = LabSessionItem & Record<string, unknown>;

export interface ChainSession {
  sid: string;
  sub: string;
  labId: string;
  createdAt: string;
  readyAt?: string | null;
  endedAt?: string | null;
}

export interface SessionFacts {
  session: SessionRecord;
  env: (EnvironmentItem & Record<string, unknown>) | null;
  platform: (PlatformConfigItem & Record<string, unknown>) | null;
  card: CardBuild;
  attempt: LabAttemptItem | null;
  steps: Map<string, StepResultItem>;
  /** Earlier sessions of this environment's hand-over chain (oldest first), excluding this one. */
  chain: ChainSession[];
}

const contentCache = new Map<string, CardBuild>();

export class ContentUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ContentUnavailableError';
  }
}

/** `content/<catalogVersion>/labs/<labId>.json` in `atl-web` (04 §2.5). */
export function cardContentKey(catalogVersion: string, labId: string): string {
  return `${WebKeys.content(catalogVersion)}labs/${labId}.json`;
}

export async function loadCard(deps: FunctionDeps, catalogVersion: string, labId: string): Promise<CardBuild> {
  const k = `${catalogVersion}/${labId}`;
  const hit = contentCache.get(k);
  if (hit) return hit;
  const raw = await deps.ports.objects.get(deps.env.buckets.web, cardContentKey(catalogVersion, labId));
  if (!raw) throw new ContentUnavailableError(`content ${cardContentKey(catalogVersion, labId)} not found`);
  const card = normalizeCard(JSON.parse(Buffer.from(raw).toString('utf8')) as Record<string, unknown>);
  if (!card) throw new ContentUnavailableError(`content of ${labId} is neither atl.card/v1 nor an expanded atl.lab/v2`);
  contentCache.set(k, card);
  return card;
}

/**
 * Two shapes of `labs/<id>.json` are accepted: the wrapped `atl.card/v1` (`{ lab, checks, sources, checkHashes,
 * pitfalls }`), and the expanded `atl.lab/v2` object at top level (what atl-api reads) with the build outputs
 * `checks` (or `checkDefs`) — the expanded check definitions by local id — and optional `pitfalls`, `checkSources`,
 * `checkHashes`, `contentDigest`.
 */
export function normalizeCard(o: Record<string, unknown>): CardBuild | null {
  if (!o || typeof o !== 'object') return null;
  if (o.schema === 'atl.card/v1' && o.lab && typeof o.checks === 'object') return o as unknown as CardBuild;
  if (o.schema === 'atl.lab/v2') {
    const defs = (o.checkDefs ?? o.checks) as Record<string, CheckDecl> | undefined;
    if (defs && (typeof defs !== 'object' || Array.isArray(defs))) return null;
    return {
      schema: 'atl.card/v1',
      lab: o as unknown as CardBuild['lab'],
      checks: defs ?? {},
      ...(o.checkSources ? { sources: o.checkSources as Record<string, string> } : {}),
      ...(o.checkHashes ? { checkHashes: o.checkHashes as Record<string, string> } : {}),
      ...(o.pitfalls && !Array.isArray(o.pitfalls) ? { pitfalls: o.pitfalls as CardBuild['pitfalls'] } : {}),
      ...(typeof o.contentDigest === 'string' ? { contentDigest: o.contentDigest } : {}),
    };
  }
  return null;
}

/** Test hook: seed / clear the content cache. */
export function primeContentCache(catalogVersion: string, labId: string, card: CardBuild | null): void {
  const k = `${catalogVersion}/${labId}`;
  if (card) contentCache.set(k, card);
  else contentCache.delete(k);
}

export async function loadFacts(deps: FunctionDeps, store: ItemStore, sid: string): Promise<SessionFacts> {
  const session = await store.get<SessionRecord>(Keys.labSession(sid));
  if (!session) throw new Error(`session ${sid} not found`);
  const [env, platform, attempt, stepItems] = await Promise.all([
    session.envId ? store.get<EnvironmentItem & Record<string, unknown>>(Keys.environment(session.envId)) : Promise.resolve(null),
    store.get<PlatformConfigItem & Record<string, unknown>>(Keys.platformConfig()),
    store.get<LabAttemptItem>(Keys.labAttempt(sid)),
    store.query<StepResultItem>(Keys.labSession(sid).PK, { skPrefix: SkPrefix.step }),
  ]);
  const card = await loadCard(deps, session.catalogVersion, session.labId);
  const chain: ChainSession[] = [];
  for (const other of env?.sessionChain ?? []) {
    if (other === sid) continue;
    const s = await store.get<SessionRecord>(Keys.labSession(other));
    if (s) chain.push({ sid: s.sid, sub: s.sub, labId: s.labId, createdAt: s.createdAt, readyAt: s.readyAt ?? null, endedAt: s.endedAt ?? null });
  }
  chain.sort((a, b) => (a.createdAt < b.createdAt ? -1 : 1));
  return { session, env, platform, card, attempt, steps: new Map(stepItems.map((s) => [s.stepId, s])), chain };
}

/**
 * Facts for operations that must not depend on the content release (health gates during PROVISIONING): when the card
 * JSON is missing, a minimal card (no steps, no checks) stands in.
 */
export async function loadFactsLenient(deps: FunctionDeps, store: ItemStore, sid: string): Promise<SessionFacts> {
  try {
    return await loadFacts(deps, store, sid);
  } catch (e) {
    if (!(e instanceof ContentUnavailableError)) throw e;
    const session = await store.get<SessionRecord>(Keys.labSession(sid));
    if (!session) throw e;
    const env = session.envId ? await store.get<EnvironmentItem & Record<string, unknown>>(Keys.environment(session.envId)) : null;
    const platform = await store.get<PlatformConfigItem & Record<string, unknown>>(Keys.platformConfig());
    const card = {
      schema: 'atl.card/v1',
      lab: { id: session.labId, version: session.labVersion ?? '0.0.0', steps: [], startProfile: { provisions: [] }, expectedWarnings: [], cleanup: { verify: [] } },
      checks: {},
    } as unknown as CardBuild;
    return { session, env, platform, card, attempt: null, steps: new Map(), chain: [] };
  }
}

/** Same-learner sessions of the chain (04 §8.11 rule 1). */
export function sameLearnerChain(f: SessionFacts): ChainSession[] {
  return f.chain.filter((c) => c.sub === f.session.sub);
}

// ---------------------------------------------------------------------------------------------------------------
// Check planning: which checks a run executes (steps, finalChecks, cleanup.verify), with `ref` overrides applied.

export interface PlannedCheck {
  localId: string;
  checkKey: string;
  stepId: string | null;
  decl: CheckDecl;
  required: boolean;
  drift: { policy: 'must-hold' | 'once'; monitor?: boolean };
  expectedWarnings: string[];
  /** `checks/*` of this card, a shared check, a guide reference or another card's check (04 §2.3). */
  origin: 'card' | 'shared' | 'guide' | 'lab';
}

export const FINAL_STEP = '_final';
export const CLEANUP_STEP = '_cleanup';

/** Default drift policy by type and step (04 §5.8): experiment / manual / observe steps → once; others must-hold. */
export function defaultDrift(decl: CheckDecl, stepType: string | null): { policy: 'must-hold' | 'once'; monitor?: boolean } {
  if (decl.drift) return decl.drift;
  if (decl.type === 'experiment' || decl.type === 'manual') return { policy: 'once' };
  if (stepType === 'observe') return { policy: 'once' };
  return { policy: 'must-hold' };
}

type Ref = string | { ref: string; as?: string; required?: boolean; when?: string; timeoutMs?: number; expectedWarnings?: string[]; drift?: { policy?: 'must-hold' | 'once'; monitor?: boolean } };

function resolveRef(card: CardBuild, ref: Ref): { localId: string; decl: CheckDecl; overrides: Exclude<Ref, string> | null } | null {
  const r = typeof ref === 'string' ? { ref } : ref;
  const refId = r.ref;
  const lastSeg = refId.includes('/') ? refId.slice(refId.lastIndexOf('/') + 1) : refId.includes('#') ? refId.slice(refId.lastIndexOf('#') + 1) : refId;
  const localId = r.as ?? lastSeg;
  const decl = card.checks[localId] ?? card.checks[refId] ?? card.checks[lastSeg];
  if (!decl) return null;
  return { localId, decl, overrides: typeof ref === 'string' ? null : ref };
}

function originOf(card: CardBuild, localId: string): PlannedCheck['origin'] {
  const src = card.sources?.[localId];
  if (!src) return 'card';
  if (src.startsWith('guide:')) return 'guide';
  if (src.startsWith('_shared/') || !src.includes('/')) return 'shared';
  return 'lab';
}

export function planCard(card: CardBuild): PlannedCheck[] {
  const out: PlannedCheck[] = [];
  const lab = card.lab;
  const cardWarnings = lab.expectedWarnings ?? [];
  const add = (ref: Ref, stepId: string | null, stepType: string | null, stepOptional: boolean) => {
    const r = resolveRef(card, ref);
    if (!r) return;
    const o = r.overrides;
    const decl: CheckDecl = {
      ...r.decl,
      id: r.localId,
      ...(o?.when !== undefined ? { when: o.when } : {}),
      ...(o?.timeoutMs !== undefined ? { timeoutMs: o.timeoutMs } : {}),
      ...(o?.drift ? { drift: { policy: o.drift.policy ?? r.decl.drift?.policy ?? 'must-hold', ...(o.drift.monitor !== undefined ? { monitor: o.drift.monitor } : {}) } } : {}),
      ...(o?.expectedWarnings && r.decl.type === 'capability' ? { expectedWarnings: o.expectedWarnings } : {}),
    } as CheckDecl;
    const required = !stepOptional && (o?.required ?? r.decl.required ?? true);
    const ew = decl.type === 'capability' && decl.expectedWarnings ? decl.expectedWarnings.filter((w) => cardWarnings.includes(w)) : cardWarnings;
    out.push({ localId: r.localId, checkKey: `${lab.id}/${r.localId}`, stepId, decl, required, drift: defaultDrift(decl, stepType), expectedWarnings: ew, origin: originOf(card, r.localId) });
  };
  for (const step of lab.steps) {
    const optional = step.optional === true || (typeof step.optional === 'object' && step.optional !== null);
    for (const ref of step.checks as Ref[]) add(ref, step.id, step.type, optional);
  }
  for (const ref of (lab.finalChecks ?? []) as Ref[]) add(ref, FINAL_STEP, null, false);
  return out;
}

export function planCleanup(card: CardBuild): PlannedCheck[] {
  const out: PlannedCheck[] = [];
  for (const ref of (card.lab.cleanup.verify ?? []) as Ref[]) {
    const r = resolveRef(card, ref);
    if (!r) continue;
    out.push({ localId: r.localId, checkKey: `${card.lab.id}/${r.localId}`, stepId: CLEANUP_STEP, decl: { ...r.decl, id: r.localId } as CheckDecl, required: false, drift: { policy: 'once' }, expectedWarnings: [], origin: originOf(card, r.localId) });
  }
  return out;
}
