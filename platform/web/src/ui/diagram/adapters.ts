/**
 * 把三种数据形状转成 <ArchDiagram input>：目录卡片（catalog index 的 cards[]）、简介页静态数据（catalog/cards/<id>.json）、
 * lab.yaml（atl.lab/v2 的 startProfile / targetModules）。只读用到的字段，其余字段不关心（类型故意写得宽松）。
 */
import type { ArchInput, ArchTarget } from './model';

type Loose<T> = T | null | undefined;

export interface CatalogCardLike {
  startProfiles?: Loose<readonly { select?: string; variant?: string; modules?: Loose<readonly (string | { id?: string; module?: string })[]> }[]>;
  targets?: Loose<readonly { module: string; from?: Loose<string>; to?: Loose<string>; optional?: Loose<boolean> }[]>;
}

/** 目录卡片：默认起始变体（select=default，没有时取第一个）的 modules + targets。 */
export function archInputFromCatalogCard(card: CatalogCardLike, variant?: string): ArchInput {
  const profiles = card.startProfiles ?? [];
  const p = (variant ? profiles.find((x) => x.variant === variant) : null) ?? profiles.find((x) => x.select === 'default') ?? profiles[0];
  const start = (p?.modules ?? []).map((m) => (typeof m === 'string' ? m : (m.id ?? m.module ?? ''))).filter(Boolean);
  const targets: ArchTarget[] = (card.targets ?? []).map((t) => ({ id: t.module, from: t.from ?? null, to: t.to ?? null, optional: !!t.optional }));
  return { start, targets };
}

export interface CardIntroLike {
  resources?: Loose<{
    provisions?: Loose<readonly { item: string; kind: string }[]>;
    targets?: Loose<readonly { moduleId: string; from?: Loose<string>; to?: Loose<string>; optional?: Loose<boolean> }[]>;
  }>;
}

/** 简介页数据：provisions 中 kind=module 的条目 + resources.targets。 */
export function archInputFromIntro(intro: CardIntroLike): ArchInput {
  const r = intro.resources ?? {};
  return {
    start: (r.provisions ?? []).filter((p) => p.kind === 'module').map((p) => p.item),
    targets: (r.targets ?? []).map((t) => ({ id: t.moduleId, from: t.from ?? null, to: t.to ?? null, optional: !!t.optional })),
  };
}

export interface LabYamlLike {
  startProfile?: Loose<{ provisions?: Loose<readonly { item: string; kind: string; set?: Loose<Record<string, unknown>> }[]> }>;
  targetModules?: Loose<readonly { id: string; driver?: Loose<string>; fromDriver?: Loose<string>; optional?: Loose<boolean>; set?: Loose<Record<string, unknown>> }[]>;
}

/** lab.yaml：起始 provisions（kind=module）+ targetModules；各条目的 set 合并为 options（连线规则用，例如 CDN_MEDIA_ORIGIN）。 */
export function archInputFromLab(lab: LabYamlLike): ArchInput {
  const options: Record<string, string> = {};
  const merge = (set: Loose<Record<string, unknown>>) => {
    for (const [k, v] of Object.entries(set ?? {})) if (v != null) options[k] = String(v);
  };
  const provisions = lab.startProfile?.provisions ?? [];
  for (const p of provisions) merge(p.set);
  for (const t of lab.targetModules ?? []) merge(t.set);
  return {
    start: provisions.filter((p) => p.kind === 'module').map((p) => p.item),
    targets: (lab.targetModules ?? []).map((t) => ({ id: t.id, from: t.fromDriver ?? null, to: t.driver ?? null, optional: !!t.optional })),
    options,
  };
}
