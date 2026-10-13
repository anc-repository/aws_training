/**
 * Content releases (04 §2.5, 05 §8.4): the current `CatalogRelease` (01 §7.2, `CATALOG / CURRENT` → `REL#<v>`) and
 * the immutable content package in the `atl-web` bucket under `content/<catalogVersion>/`:
 *
 *   catalog/index.json          CatalogIndex (05 §8.4; 04 §2.5 calls it index.json at the root — both are tried)
 *   catalog/cards/<id>.json     card intro (05)
 *   labs/<id>.json              the expanded card (lab.yaml v2 as JSON + build outputs), used for start / quotes / checks
 *   manifest.json               file digests and start-profile digests
 *
 * Quiz banks with answers are only in `atl-artifacts` under `releases/<catalogVersion>/private/quiz/<id>.json`
 * (04 §2.5 R-06). Content is immutable per version, so parsed objects are cached per container.
 */
import { AtlError, WebKeys, type LabV2 } from '@atl/shared';
import type { FunctionDeps } from '../../runtime/deps.js';
import type { CatalogReleaseItem, PlatformRepo } from '../../repositories/index.js';

/** The expanded card: lab.yaml v2 plus build outputs (`labs:build`). Only the fields the API reads are typed. */
export interface LabContent extends Omit<LabV2, 'platformOps'> {
  /** Start-profile digests by variant (build output; also found in manifest.json / catalog index). */
  startProfileDigests?: Record<string, string>;
  /** `platformOps[]` also contains the generated `xstk-<stackId>` actions (04 §3.2.15). */
  platformOps?: (NonNullable<LabV2['platformOps']>[number] | { id: string; op: 'extra-stack'; stackId?: string; title: string; optional?: boolean })[];
  [k: string]: unknown;
}

export interface CatalogIndexCard {
  id: string;
  kind: 'service' | 'scenario';
  version: string;
  status: string;
  title: string;
  costTier?: { required: string; withOptional?: string } | string;
  startProfiles?: { name: string; variant: string; select?: string; planDigest?: string }[];
  variants?: { id: string; select: string }[];
  tracks?: unknown[];
  reuseFrom?: { labId: string; extraModules?: string[]; warn?: string }[];
  services?: { id: string; role: string }[];
  credits?: string[];
  [k: string]: unknown;
}

export interface TrackItem {
  card?: string;
  role?: 'required' | 'optional' | 'elective';
  group?: string;
  title?: string;
  pick?: number;
  cards?: string[];
}

export interface TrackDef {
  id: string;
  title?: string;
  version?: string;
  domain?: string;
  stages?: { id: string; title?: string; items: TrackItem[] }[];
  completion?: { allowManual?: boolean; minAutoRatio?: number; excludeSelfReported?: boolean };
  certificate?: { enabled?: boolean; title?: string };
  [k: string]: unknown;
}

export interface CatalogIndex {
  schema?: string;
  catalogVersion?: string;
  contentDigest?: string;
  cards: CatalogIndexCard[];
  tracks: TrackDef[];
  serviceMap?: { id: string; module?: string; category?: string; serviceCard?: string; creditedBy?: string[]; appearsIn?: string[] }[];
  taxonomy?: unknown;
  [k: string]: unknown;
}

const MAX_CACHE = 300;
const cache = new Map<string, unknown>();

function remember<T>(key: string, value: T): T {
  if (cache.size >= MAX_CACHE) cache.delete(cache.keys().next().value as string);
  cache.set(key, value);
  return value;
}

/** Drop the content cache (tests, dev seeding). */
export function clearContentCache(): void {
  cache.clear();
}

export class CatalogStore {
  constructor(
    private readonly deps: FunctionDeps,
    private readonly platform: PlatformRepo,
  ) {}

  async current(): Promise<CatalogReleaseItem | null> {
    return this.platform.currentRelease();
  }

  async requireCurrent(): Promise<CatalogReleaseItem> {
    const rel = await this.current();
    if (!rel) throw new AtlError('NOT_FOUND', 'no content release is installed (CatalogRelease CURRENT is missing)');
    return rel;
  }

  private async json<T>(bucket: string, key: string): Promise<T | null> {
    const ck = `${bucket}/${key}`;
    if (cache.has(ck)) return cache.get(ck) as T;
    const bytes = await this.deps.ports.objects.get(bucket, key);
    if (!bytes) return null;
    try {
      return remember(ck, JSON.parse(Buffer.from(bytes).toString('utf8')) as T);
    } catch {
      throw new AtlError('INTERNAL', `content object ${key} is not valid JSON`);
    }
  }

  private web<T>(catalogVersion: string, rel: string): Promise<T | null> {
    return this.json<T>(this.deps.env.buckets.web, `${WebKeys.content(catalogVersion)}${rel}`);
  }

  async index(catalogVersion: string): Promise<CatalogIndex> {
    const idx = (await this.web<CatalogIndex>(catalogVersion, 'catalog/index.json')) ?? (await this.web<CatalogIndex>(catalogVersion, 'index.json'));
    return { cards: [], tracks: [], ...(idx ?? {}) } as CatalogIndex;
  }

  async manifest(catalogVersion: string): Promise<Record<string, unknown> | null> {
    return this.web<Record<string, unknown>>(catalogVersion, 'manifest.json');
  }

  async lab(labId: string, catalogVersion: string): Promise<LabContent | null> {
    if (!/^(svc|sc)-[a-z0-9-]{1,40}$/.test(labId)) return null;
    return this.web<LabContent>(catalogVersion, `labs/${labId}.json`);
  }

  /** The card in `catalogVersion`; drafts are invisible (04 §3.1 `status: draft`). */
  async requireLab(labId: string, catalogVersion: string): Promise<LabContent> {
    const lab = await this.lab(labId, catalogVersion);
    if (!lab || lab.status === 'draft') throw new AtlError('NOT_FOUND', `card ${labId} is not in content release ${catalogVersion}`);
    return lab;
  }

  /**
   * Quiz bank with answers in atl-artifacts (01 §3.7: `releases/<ver>/private/quiz/`). WebDeploy records the prefix it
   * wrote (`CatalogRelease.quizPrefix`, the release version's prefix); releases without it use `releases/<catalogVersion>/`.
   */
  async quizBank(labId: string, catalogVersion: string): Promise<QuizBank | null> {
    const rel = await this.platform.getRelease(catalogVersion).catch(() => null);
    const prefix = typeof rel?.quizPrefix === 'string' && /^releases\/[A-Za-z0-9._-]+\/private\/quiz\/$/.test(rel.quizPrefix) ? rel.quizPrefix : `releases/${catalogVersion}/private/quiz/`;
    return this.json<QuizBank>(this.deps.env.buckets.artifacts, `${prefix}${labId}.json`);
  }

  /** Start-profile digest of a variant: card build output → catalog index → manifest. */
  async profileDigest(lab: LabContent, variant: string, catalogVersion: string): Promise<string | null> {
    const fromLab = lab.startProfileDigests?.[variant];
    if (fromLab) return fromLab;
    const idx = await this.index(catalogVersion);
    const card = idx.cards.find((c) => c.id === lab.id);
    const sp = card?.startProfiles?.find((p) => p.variant === variant);
    if (sp?.planDigest) return sp.planDigest;
    const man = await this.manifest(catalogVersion);
    const profiles = (man?.startProfiles ?? man?.profiles) as Record<string, unknown> | undefined;
    const entry = profiles?.[`atl/${lab.id}/${variant}`];
    if (typeof entry === 'string') return entry;
    if (entry && typeof entry === 'object' && typeof (entry as { digest?: unknown }).digest === 'string') return (entry as { digest: string }).digest;
    return null;
  }
}

// ---------------------------------------------------------------------------------------------------------------
// Quiz bank (04 §3.2.11 QuizFile, compiled with answers)

export interface QuizQuestion {
  id: string;
  domain: 'secure' | 'resilient' | 'performance' | 'cost';
  type: 'single' | 'multi';
  kind?: 'concept' | 'scenario';
  services?: string[];
  stem: string;
  options: { id: string; text: string }[];
  answer: string[];
  explain: string;
  relatesTo?: string;
}

export interface QuizBank {
  schema?: 'atl.quiz/v1';
  version?: string;
  questions: QuizQuestion[];
  maxAttemptsPerDay?: number;
  timeLimitMinutes?: number;
}
