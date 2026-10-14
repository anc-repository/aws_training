/**
 * 图标数据的查找表：模块 id（registry）与 taxonomy 服务 id / 附属服务（s3、ebs、shield …）都能找到同一个模块。
 */
import { GLYPH_GROUPS, GLYPH_MODULES, GLYPH_SERVICE_ALIAS, type GlyphGroupDef, type GlyphGroupId, type GlyphModule } from './registry.generated';

export type { GlyphDeps, GlyphGroupDef, GlyphGroupId, GlyphModule } from './registry.generated';
export { GLYPH_GROUPS, GLYPH_MODULES, GLYPH_SERVICE_ALIAS };

const BY_ID: ReadonlyMap<string, GlyphModule> = new Map(GLYPH_MODULES.map((m) => [m.id, m]));
const GROUP_BY_ID: ReadonlyMap<string, GlyphGroupDef> = new Map(GLYPH_GROUPS.map((g) => [g.id, g]));

/** registry 顺序的 40 个模块 id。 */
export const MODULE_IDS: readonly string[] = GLYPH_MODULES.map((m) => m.id);

/** 模块 id 或服务 id → 模块 id；不认识时为 null。 */
export function resolveModuleId(id: string | null | undefined): string | null {
  if (!id) return null;
  if (BY_ID.has(id)) return id;
  return GLYPH_SERVICE_ALIAS[id] ?? null;
}

export function glyphModule(id: string | null | undefined): GlyphModule | null {
  const m = resolveModuleId(id);
  return m ? (BY_ID.get(m) ?? null) : null;
}

export function glyphGroup(id: GlyphGroupId | string | null | undefined): GlyphGroupDef | null {
  return id ? (GROUP_BY_ID.get(id) ?? null) : null;
}

/** CSS 类后缀：base / a～f。 */
export function groupClass(group: string | null | undefined): string {
  return !group || group === 'base' ? 'g-base' : `g-${group.toLowerCase()}`;
}
