/**
 * The `USER#<sub>` partition and the `MEMBERS` collection (01 §7.2, AP11, AP17, AP21, AP26): `Learner` / `Member`
 * profiles, `LabProgress`, `QuizAttempt` and `CostQuote`.
 */
import type { CognitoGroup } from '@atl/shared';
import { Gsi1, Keys, SkPrefix, ttlAfterHours, TTL_POLICY } from '../data/keys.js';
import type { Item, Table } from './table.js';

export type ProfileItem = Item & { sub: string; email: string; role: CognitoGroup; displayName?: string };
export type ProgressItem = Item & { labId: string };
export type QuoteItem = Item & { quoteId: string; purpose: string; labId: string; expiresAt: string; sub: string };

/** GSI1 partition of the member collection and the learner prefix, derived from the key builders (01 §7.1). */
const MEMBERS_PK = Gsi1.learner('x').GSI1PK;
const LEARNER_PREFIX = Gsi1.learner('x').GSI1SK.slice(0, -1);

export class UsersRepo {
  constructor(private readonly table: Table) {}

  async profile(sub: string): Promise<ProfileItem | null> {
    return this.table.get<ProfileItem>(Keys.userProfile(sub), true);
  }

  /** Create the profile on first sight (`Learner` for the learner group, `Member` otherwise). */
  async ensureProfile(p: { sub: string; email: string; role: CognitoGroup; displayName?: string }, nowIso: string): Promise<ProfileItem> {
    const existing = await this.profile(p.sub);
    if (existing) return existing;
    const item: ProfileItem = {
      ...Keys.userProfile(p.sub),
      ...(p.role === 'learner' ? Gsi1.learner(p.email) : Gsi1.member(p.role, p.email)),
      type: p.role === 'learner' ? 'Learner' : 'Member',
      ver: 1,
      createdAt: nowIso,
      updatedAt: nowIso,
      sub: p.sub,
      email: p.email,
      role: p.role,
      displayName: p.displayName ?? p.email.split('@')[0] ?? p.sub,
      ...(p.role === 'learner' ? { certName: null, locale: 'zh-CN', notify: {}, currentTrackId: 'saa-main' } : {}),
    };
    try {
      await this.table.put(item, { expression: 'attribute_not_exists(PK)' });
      return item;
    } catch {
      return (await this.profile(p.sub)) ?? item;
    }
  }

  async patchProfile(sub: string, set: Record<string, unknown>, nowIso: string): Promise<ProfileItem> {
    return this.table.update<ProfileItem>(Keys.userProfile(sub), { set: { ...set, updatedAt: nowIso }, add: { ver: 1 }, condition: { expression: 'attribute_exists(PK)' } });
  }

  /** AP17: all members (learner + assistants + observers). */
  async members(): Promise<ProfileItem[]> {
    return this.table.queryAll<ProfileItem>({ index: 'GSI1', pk: MEMBERS_PK }, 500);
  }

  /** The single learner of the installation (single-learner model, 01 §5.2), if known. */
  async learner(): Promise<ProfileItem | null> {
    const page = await this.table.query<ProfileItem>({ index: 'GSI1', pk: MEMBERS_PK, sk: { beginsWith: LEARNER_PREFIX }, limit: 1 });
    return page.items[0] ?? null;
  }

  /** Member written by `POST /members` before the invitee first signs in. */
  async putMember(p: { sub: string; email: string; role: 'assistant' | 'observer'; invitedBy: string }, nowIso: string): Promise<ProfileItem> {
    const item: ProfileItem = {
      ...Keys.userProfile(p.sub),
      ...Gsi1.member(p.role, p.email),
      type: 'Member',
      ver: 1,
      createdAt: nowIso,
      updatedAt: nowIso,
      sub: p.sub,
      email: p.email,
      role: p.role,
      displayName: p.email.split('@')[0] ?? p.email,
      invitedBy: p.invitedBy,
      invitedAt: nowIso,
    };
    await this.table.put(item);
    return item;
  }

  async deleteProfile(sub: string): Promise<void> {
    await this.table.delete(Keys.userProfile(sub));
  }

  // ---------------------------------------------------------------------------------------------------------------
  // LabProgress (AP11) and QuizAttempt (AP26)

  async progress(sub: string): Promise<ProgressItem[]> {
    return this.table.queryAll<ProgressItem>({ pk: Keys.userProfile(sub).PK, sk: { beginsWith: SkPrefix.lab } }, 500);
  }

  async progressOf(sub: string, labId: string): Promise<ProgressItem | null> {
    return this.table.get<ProgressItem>(Keys.labProgress(sub, labId), true);
  }

  async quizAttempts(sub: string, labId?: string): Promise<Item[]> {
    return this.table.queryAll({ pk: Keys.userProfile(sub).PK, sk: { beginsWith: labId ? SkPrefix.quizForLab(labId) : SkPrefix.quiz } }, 500);
  }

  async quizAttempt(sub: string, labId: string, attemptId: string): Promise<Item | null> {
    return this.table.get(Keys.quizAttempt(sub, labId, attemptId), true);
  }

  async putQuizAttempt(sub: string, labId: string, attemptId: string, attrs: Item, nowIso: string): Promise<Item> {
    const item = { ...Keys.quizAttempt(sub, labId, attemptId), type: 'QuizAttempt', ver: 1, createdAt: nowIso, updatedAt: nowIso, attemptId, labId, sub, ...attrs };
    await this.table.put(item, { expression: 'attribute_not_exists(PK)' });
    return item;
  }

  async updateQuizAttempt(sub: string, labId: string, attemptId: string, set: Record<string, unknown>, expectStatus: string, nowIso: string): Promise<Item> {
    return this.table.update(Keys.quizAttempt(sub, labId, attemptId), {
      set: { ...set, updatedAt: nowIso },
      add: { ver: 1 },
      condition: { expression: '#qs = :qs', names: { '#qs': 'status' }, values: { ':qs': expectStatus } },
    });
  }

  /** Best quiz results on the badge (04 §8.6; written by atl-api after grading, only if `LabProgress` exists). */
  async updateProgressQuiz(sub: string, labId: string, set: Record<string, unknown>, nowIso: string): Promise<Item | null> {
    try {
      return await this.table.update(Keys.labProgress(sub, labId), { set: { ...set, updatedAt: nowIso }, condition: { expression: 'attribute_exists(PK)' } });
    } catch {
      return null;
    }
  }

  // ---------------------------------------------------------------------------------------------------------------
  // CostQuote (AP21). TTL only cleans up; validity is decided on `expiresAt`.

  async putQuote(sub: string, quote: Item & { quoteId: string; expiresAt: string }, nowIso: string): Promise<QuoteItem> {
    const item = {
      ...Keys.costQuote(sub, quote.quoteId),
      type: 'CostQuote',
      ver: 1,
      createdAt: nowIso,
      updatedAt: nowIso,
      sub,
      ...quote,
      ttl: ttlAfterHours(nowIso, TTL_POLICY.costQuoteCleanupHours),
    } as unknown as QuoteItem;
    await this.table.put(item);
    return item;
  }

  async quote(sub: string, quoteId: string): Promise<QuoteItem | null> {
    return this.table.get<QuoteItem>(Keys.costQuote(sub, quoteId), true);
  }
}
