/**
 * 服务图标集（I6 a）与视觉组件共用的 t() 适配层。数据来自 modules/registry.yaml（scripts/gen-glyph-registry.mjs 生成）。
 */
export { ServiceGlyph, PseudoGlyph, GroupSymbol, ServiceChip, GLYPH_BADGE_MIN } from './ServiceGlyph';
export type { ServiceGlyphProps, PseudoGlyphProps, ServiceChipProps, GlyphTone, GlyphVariant } from './ServiceGlyph';
export { MOTIFS, PSEUDO_MOTIFS, GROUP_SYMBOLS } from './motifs';
export { GLYPH_GROUPS, GLYPH_MODULES, GLYPH_SERVICE_ALIAS, MODULE_IDS, glyphGroup, glyphModule, groupClass, resolveModuleId } from './data';
export type { GlyphDeps, GlyphGroupDef, GlyphGroupId, GlyphModule } from './data';
export { VisualI18nProvider, makeVisualI18n, resolveVisualLang, useVisualI18n, visualT, VISUAL_LANGS } from './visualI18n';
export type { ExternalTranslator, VisualI18n, VisualI18nProviderProps, VisualKey, VisualLang, VisualVars } from './visualI18n';
export { VISUAL_MESSAGES } from './visualMessages';
