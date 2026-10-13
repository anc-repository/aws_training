/**
 * Check references (04 §3.2.8 `checkRef`, §2.3 resolution rules) and the expanded check set of a card
 * (`labs/<id>.json` → `checks` by local id, `sources`, `checkHashes`; 04 §2.5, read by atl-checks `normalizeCard`).
 */
import crypto from 'node:crypto';
import { canonicalJson, type CheckRef, type LabV2 } from '@atl/shared';
import type { CardContent, CheckDef, ContentSet } from './content.js';

/** 04 §2.1: old names of the shared check, accepted with a warning during the migration. */
export const SHARED_CHECK_ALIASES: Readonly<Record<string, string>> = {
  'lab-no-world-ssh': 'no-world-ssh',
  'lab2-no-world-ssh': 'no-world-ssh',
};

export type CheckRefObject = Exclude<CheckRef, string>;

export interface CheckUse {
  where: 'step' | 'final' | 'cleanup';
  stepId: string | null;
  stepIndex: number;
  ref: string;
  localId: string;
  overrides: CheckRefObject | null;
}

function lastSegment(ref: string): string {
  if (ref.includes('/')) return ref.slice(ref.lastIndexOf('/') + 1);
  if (ref.includes('#')) return ref.slice(ref.lastIndexOf('#') + 1);
  return ref;
}

export function useOf(ref: CheckRef, where: CheckUse['where'], stepId: string | null, stepIndex: number): CheckUse {
  if (typeof ref === 'string') return { where, stepId, stepIndex, ref, localId: lastSegment(ref), overrides: null };
  return { where, stepId, stepIndex, ref: ref.ref, localId: ref.as ?? lastSegment(ref.ref), overrides: ref };
}

/** Every check reference of the card in order: steps, finalChecks, cleanup.verify. */
export function checkUses(lab: LabV2): CheckUse[] {
  const out: CheckUse[] = [];
  (lab.steps ?? []).forEach((s, i) => {
    for (const r of s.checks ?? []) out.push(useOf(r, 'step', s.id, i));
  });
  for (const r of lab.finalChecks ?? []) out.push(useOf(r, 'final', null, Number.MAX_SAFE_INTEGER));
  for (const r of lab.cleanup?.verify ?? []) out.push(useOf(r, 'cleanup', null, Number.MAX_SAFE_INTEGER));
  return out;
}

export type CheckOrigin = 'card' | 'shared' | 'lab' | 'guide';

export interface ResolvedCheck {
  decl: CheckDef;
  origin: CheckOrigin;
  /** where it came from: `checks/x.yaml`, `_shared/<id>`, `<cardId>/<checkId>` */
  source: string;
  alias?: string;
  /** source card of a foreign (`<cardId>/<checkId>`) check: its dependsOn and pitfalls resolve there */
  card?: string;
}

export type Resolution = { ok: true; check: ResolvedCheck } | { ok: false; message: string };

function strip(c: CheckDef & { __file?: string }): CheckDef {
  const { __file: _f, ...rest } = c;
  return rest as CheckDef;
}

/** Resolves a reference as seen from `card` (04 §2.3, §3.5 A7). */
export function resolveRef(set: ContentSet, card: CardContent, ref: string): Resolution {
  if (ref.startsWith('guide:')) {
    return { ok: false, message: `${ref}: guides/<module>.yaml are not part of this repository; define the check in checks/*.yaml` };
  }
  const slash = ref.indexOf('/');
  if (slash > 0) {
    const cardId = ref.slice(0, slash);
    const checkId = ref.slice(slash + 1);
    const other = set.byId.get(cardId);
    if (!other) return { ok: false, message: `${ref}: card ${cardId} does not exist` };
    const c = other.checks.get(checkId);
    if (!c) return { ok: false, message: `${ref}: card ${cardId} has no check ${checkId}` };
    return { ok: true, check: { decl: strip(c), origin: 'lab', source: ref, card: cardId } };
  }
  const local = card.checks.get(ref);
  if (local) return { ok: true, check: { decl: strip(local), origin: 'card', source: local.__file } };
  const sharedId = SHARED_CHECK_ALIASES[ref] ?? ref;
  const shared = set.sharedChecks.get(sharedId);
  if (shared) {
    return { ok: true, check: { decl: strip(shared), origin: 'shared', source: `_shared/${sharedId}`, ...(sharedId !== ref ? { alias: ref } : {}) } };
  }
  return { ok: false, message: `check ${ref} is defined neither in checks/*.yaml nor in _shared/checks` };
}

/** Effective drift policy of a use (04 §5.8: override → declaration → type / step default). */
export function effectiveDrift(decl: CheckDef, use: CheckUse | null, stepType: string | null): 'must-hold' | 'once' {
  const o = use?.overrides?.drift?.policy;
  if (o) return o;
  const d = (decl.drift as { policy?: 'must-hold' | 'once' } | undefined)?.policy;
  if (d) return d;
  if (decl.type === 'experiment' || decl.type === 'manual') return 'once';
  if (stepType === 'observe') return 'once';
  return 'must-hold';
}

export function isRequiredUse(decl: CheckDef, use: CheckUse): boolean {
  if (use.overrides?.required !== undefined) return use.overrides.required;
  return decl.required !== false;
}

/** `{{$check.<id>.…}}` references and `dependsOn` of a declaration. */
/**
 * A reference made by a check that came from `owner` (another card): the referencing card's own checks win, otherwise the
 * reference resolves in the owner card (`<owner>/<ref>`), so foreign checks keep their dependencies and pitfalls.
 */
export function refFromOwner(card: CardContent, owner: string | undefined, ref: string): string {
  if (!owner || owner === card.id || ref.includes('/') || card.checks.has(ref)) return ref;
  return `${owner}/${ref}`;
}

export function dependenciesOf(decl: CheckDef): string[] {
  const out = new Set<string>(Array.isArray(decl.dependsOn) ? (decl.dependsOn as string[]) : []);
  for (const m of JSON.stringify(decl).matchAll(/\{\{\s*\$check\.([a-z][a-z0-9-]*)\./g)) out.add(m[1]!);
  return [...out];
}

export function checkHash(decl: CheckDef): string {
  return `sha256:${crypto.createHash('sha256').update(canonicalJson(decl)).digest('hex')}`;
}

export interface ExpandedChecks {
  checks: Record<string, CheckDef>;
  sources: Record<string, string>;
  checkHashes: Record<string, string>;
  unresolved: { ref: string; message: string }[];
}

/**
 * The expanded check set written into `labs/<id>.json`: every check of the card's own files, every referenced shared /
 * foreign check (keyed by its local id = `as` or the last path segment, which is how atl-checks resolves references),
 * dependencies and `corroborateWith` checks included.
 */
export function expandChecks(set: ContentSet, card: CardContent): ExpandedChecks {
  const out: ExpandedChecks = { checks: {}, sources: {}, checkHashes: {}, unresolved: [] };
  const owners = new Map<string, string | undefined>();
  const put = (localId: string, r: ResolvedCheck) => {
    if (out.checks[localId]) return;
    const decl = { ...r.decl, id: localId };
    out.checks[localId] = decl;
    owners.set(localId, r.card);
    if (r.origin !== 'card') out.sources[localId] = r.source;
    out.checkHashes[localId] = checkHash(decl);
  };
  for (const [id, c] of card.checks) put(id, { decl: strip(c), origin: 'card', source: c.__file });
  const queue: { ref: string; localId: string }[] = checkUses(card.lab).map((u) => ({ ref: u.ref, localId: u.localId }));
  for (const e of card.lab.experiments ?? []) for (const c of e.corroborateWith ?? []) queue.push({ ref: c, localId: c });
  while (queue.length) {
    const { ref, localId } = queue.shift()!;
    if (!out.checks[localId]) {
      const r = resolveRef(set, card, ref);
      if (!r.ok) {
        out.unresolved.push({ ref, message: r.message });
        continue;
      }
      put(localId, r.check);
    }
    const decl = out.checks[localId];
    if (!decl) continue;
    for (const dep of dependenciesOf(decl)) if (!out.checks[dep]) queue.push({ ref: refFromOwner(card, owners.get(localId), dep), localId: dep });
  }
  return out;
}

/** Pitfalls by id: the card's files plus the shared ones (atl-checks `CardBuild.pitfalls`). */
export function expandPitfalls(set: ContentSet, card: CardContent): Record<string, Record<string, unknown>> {
  const out: Record<string, Record<string, unknown>> = {};
  for (const [id, p] of set.sharedPitfalls) out[id] = { ...p };
  // pitfalls of foreign checks (`<cardId>/<checkId>`) come from their source card; the card's own definitions win
  const foreign = new Set(Object.values(expandChecks(set, card).sources).filter((s) => /^[a-z][a-z0-9-]*\/[a-z]/.test(s) && !s.startsWith('_shared/')).map((s) => s.slice(0, s.indexOf('/'))));
  for (const id of [...foreign].sort()) for (const [pid, p] of set.byId.get(id)?.pitfalls ?? []) out[pid] = { ...p };
  for (const [id, p] of card.pitfalls) out[id] = { ...p };
  return out;
}
