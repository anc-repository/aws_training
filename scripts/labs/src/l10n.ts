/**
 * Content languages in the labs toolchain (09-i18n-and-visual.md §2, decision I4).
 *
 * - Text fields: the JSON Schemas mark every translatable string as `anyOf: [<string>, { $ref: '#/$defs/l10n' }]`;
 *   `textPatterns()` walks a schema and returns the JSON-pointer patterns of those fields, so the toolchain needs no
 *   second list of translatable fields.
 * - `localizeDoc()` resolves a document to one language (fallback chain: language → en → zh-CN). With `mark`, every value
 *   shown in another language gets `FALLBACK_MARK` in front: labs:build renders a marked copy of the output next to the
 *   real one and compares them to find the output fields that show a fallback (`i18n.fallback`).
 * - Manuals: `manual/*.md` and `manual/zh-CN/*.md` are zh-CN, `manual/ja/*.md` and `manual/en/*.md` are translations of
 *   the zh-CN file with the same name; other sub-directories keep their old meaning (zh-CN, path kept).
 */
import { CONTENT_LANGS, fallbackChain, isLocalizedObject, resolveLocalized, SOURCE_LANG, type ContentLang } from '@atl/shared';
import { schemaObject, type SchemaName } from './schemas/index.js';

export { CONTENT_LANGS, SOURCE_LANG, TRANSLATED_LANGS, fallbackChain, type ContentLang } from '@atl/shared';

/** Prefix of fallback values in marked documents (never written to a file). */
export const FALLBACK_MARK = '\u0001';

type Json = Record<string, unknown>;

const patternCache = new Map<SchemaName, string[][]>();

function resolveRef(root: Json, ref: string): unknown {
  if (!ref.startsWith('#/')) return undefined;
  let cur: unknown = root;
  for (const seg of ref.slice(2).split('/')) cur = cur && typeof cur === 'object' ? (cur as Json)[seg.replace(/~1/g, '/').replace(/~0/g, '~')] : undefined;
  return cur;
}

function isL10nWrapper(node: Json): boolean {
  return Array.isArray(node.anyOf) && node.anyOf.some((b) => !!b && typeof b === 'object' && (b as Json).$ref === '#/$defs/l10n');
}

/** JSON-pointer patterns (segments; `*` = any index or key) of the translatable fields of a schema. */
export function textPatterns(name: SchemaName): string[][] {
  const cached = patternCache.get(name === 'lab-planned' ? 'lab' : name);
  if (cached) return cached;
  const root = schemaObject(name === 'lab-planned' ? 'lab' : name);
  const out: string[][] = [];
  const seen = new Set<string>();
  const walk = (node: unknown, ptr: string[]) => {
    if (!node || typeof node !== 'object' || ptr.length > 24) return;
    const n = node as Json;
    if (typeof n.$ref === 'string') {
      const key = `${n.$ref}@${ptr.join('/')}`;
      if (seen.has(key)) return;
      seen.add(key);
      walk(resolveRef(root, n.$ref), ptr);
    }
    if (isL10nWrapper(n)) {
      out.push(ptr);
      return;
    }
    for (const k of ['anyOf', 'oneOf', 'allOf'] as const) if (Array.isArray(n[k])) for (const b of n[k] as unknown[]) walk(b, ptr);
    for (const k of ['then', 'else'] as const) walk(n[k], ptr);
    if (n.properties && typeof n.properties === 'object') for (const [k, v] of Object.entries(n.properties as Json)) walk(v, [...ptr, k]);
    if (n.items && typeof n.items === 'object') walk(n.items, [...ptr, '*']);
    if (n.additionalProperties && typeof n.additionalProperties === 'object') walk(n.additionalProperties, [...ptr, '*']);
  };
  walk(root, []);
  const unique = [...new Map(out.map((p) => [p.join('/'), p])).values()];
  patternCache.set(name === 'lab-planned' ? 'lab' : name, unique);
  return unique;
}

function unescapeSeg(s: string): string {
  return s.replace(/~1/g, '/').replace(/~0/g, '~');
}

export function splitPointer(pointer: string): string[] {
  return pointer === '' ? [] : pointer.slice(1).split('/').map(unescapeSeg);
}

export function escapeSeg(s: string): string {
  return s.replace(/~/g, '~0').replace(/\//g, '~1');
}

/** Is `pointer` a translatable field of `schema`? */
export function isTextPointer(name: SchemaName, pointer: string): boolean {
  const segs = splitPointer(pointer);
  return textPatterns(name).some((p) => p.length === segs.length && p.every((s, i) => s === '*' || s === segs[i]));
}

/**
 * A plain string without Chinese or Japanese characters (a service or resource name, an id, a `{{ … }}` template, a
 * command) reads the same in every language (I3): it needs no localized object, is not a fallback and counts as
 * translated. Text with Han or kana characters is zh-CN source text.
 */
export function isNeutralText(s: string): boolean {
  // kana, CJK ideographs (extension A and the unified block), compatibility ideographs, half-width katakana
  return !/[\u3040-\u30ff\u3400-\u9fff\uf900-\ufaff\uff66-\uff9f]/.test(s);
}

export interface LocalizeOptions {
  lang: ContentLang;
  /** prefix fallback values with FALLBACK_MARK */
  mark?: boolean;
  /** source pointers of the values shown in another language */
  onFallback?: (pointer: string) => void;
}

/** A content document resolved to `lang` (plain strings at text fields count as zh-CN). */
export function localizeDoc<T>(doc: T, schema: SchemaName, opts: LocalizeOptions): T {
  if (doc === undefined || doc === null) return doc;
  return resolveLocalized(doc, opts.lang, {
    isTextPointer: (p, v) => isTextPointer(schema, p) && !isNeutralText(v),
    ...(opts.onFallback ? { onFallback: (p: string) => opts.onFallback!(p) } : {}),
    ...(opts.mark ? { mark: (t: string) => `${FALLBACK_MARK}${t}` } : {}),
  });
}

/** Localized objects at fields that are not translatable (ids, enums, commands …): lint rule I2. */
export function misplacedLocalized(doc: unknown, schema: SchemaName): string[] {
  const out: string[] = [];
  const walk = (v: unknown, ptr: string) => {
    if (isLocalizedObject(v)) {
      if (!isTextPointer(schema, ptr)) out.push(ptr || '/');
      return;
    }
    if (Array.isArray(v)) v.forEach((x, i) => walk(x, `${ptr}/${i}`));
    else if (v && typeof v === 'object') for (const [k, x] of Object.entries(v as Json)) walk(x, `${ptr}/${escapeSeg(k)}`);
  };
  walk(doc, '');
  return out;
}

/** Text fields of a document with their texts per language (translation coverage, placeholder comparison). */
export function textFields(doc: unknown, schema: SchemaName): { pointer: string; texts: Partial<Record<ContentLang, string>> }[] {
  const out: { pointer: string; texts: Partial<Record<ContentLang, string>> }[] = [];
  const walk = (v: unknown, ptr: string) => {
    if (isLocalizedObject(v) || (typeof v === 'string' && isTextPointer(schema, ptr))) {
      const texts: Partial<Record<ContentLang, string>> = {};
      if (typeof v === 'string') {
        texts['zh-CN'] = v;
        if (isNeutralText(v)) for (const l of CONTENT_LANGS) texts[l] = v;
      } else for (const l of CONTENT_LANGS) if (typeof v[l] === 'string' && v[l] !== '') texts[l] = v[l];
      out.push({ pointer: ptr, texts });
      return;
    }
    if (Array.isArray(v)) v.forEach((x, i) => walk(x, `${ptr}/${i}`));
    else if (v && typeof v === 'object') for (const [k, x] of Object.entries(v as Json)) walk(x, `${ptr}/${escapeSeg(k)}`);
  };
  walk(doc, '');
  return out;
}

/** `{{ … }}` expressions of a text (sorted), for comparing a translation with its source. */
export function placeholdersOf(text: string): string[] {
  return [...text.matchAll(/\{\{\s*([^}]+?)\s*\}\}/g)].map((m) => m[1]!.replace(/\s+/g, ' ')).sort();
}

/**
 * Where a manual file belongs: `manual/<f>` and `manual/zh-CN/<f>` → zh-CN `manual/<f>`; `manual/ja/<f>`, `manual/en/<f>`
 * → that language, logical file `manual/<f>`; anything else is zh-CN with its path kept.
 */
export function manualLanguageOf(rel: string): { lang: ContentLang; file: string } {
  const m = /^manual\/(zh-CN|ja|en)\/(.+)$/.exec(rel);
  if (m) return { lang: m[1] as ContentLang, file: `manual/${m[2]}` };
  return { lang: SOURCE_LANG, file: rel };
}

/** The language of a manual shown for `lang` (first of the fallback chain that has the file). */
export function pickManualLang(available: ReadonlySet<ContentLang>, lang: ContentLang): ContentLang {
  return fallbackChain(lang).find((l) => available.has(l)) ?? SOURCE_LANG;
}

/** Localized names of the 00-overview.md headings that lint C-12 requires (CardIntroPage matches them, 08 §9). */
export const OVERVIEW_HEADINGS: Readonly<Record<'background' | 'experiments' | 'why', Record<ContentLang, string>>> = {
  background: { 'zh-CN': '背景', ja: '背景', en: 'Background' },
  experiments: { 'zh-CN': '对比实验预告', ja: '比較実験の予告', en: 'Comparison experiments' },
  why: { 'zh-CN': '为什么组合在一起', ja: 'なぜ組み合わせるのか', en: 'Why combine them' },
};

/** Generated texts of labs:build / labs:catalog (not part of any content file). */
export const GENERATED_TEXT: Readonly<Record<'defaultVariant' | 'deployStack', Record<ContentLang, string>>> = {
  defaultVariant: { 'zh-CN': '默认', ja: '標準', en: 'Default' },
  deployStack: { 'zh-CN': '部署 {id}', ja: '{id} をデプロイ', en: 'Deploy {id}' },
};

export function generatedText(key: keyof typeof GENERATED_TEXT, lang: ContentLang, vars: Record<string, string> = {}): string {
  return GENERATED_TEXT[key][lang].replace(/\{(\w+)\}/g, (_, k: string) => vars[k] ?? '');
}

/**
 * JSON pointers where `marked` differs from `real` (the fields of an output document that show a fallback). A changed
 * array length or type marks the whole container.
 */
export function diffPointers(real: unknown, marked: unknown, base = ''): string[] {
  if (typeof real === 'string' || typeof marked === 'string') return real === marked ? [] : [base];
  if (Array.isArray(real) && Array.isArray(marked)) {
    if (real.length !== marked.length) return [base];
    return real.flatMap((x, i) => diffPointers(x, marked[i], `${base}/${i}`));
  }
  if (real && marked && typeof real === 'object' && typeof marked === 'object' && !Array.isArray(real) && !Array.isArray(marked)) {
    const keys = new Set([...Object.keys(real), ...Object.keys(marked)]);
    const out: string[] = [];
    for (const k of keys) {
      const p = `${base}/${escapeSeg(k)}`;
      if (!(k in (real as Json)) || !(k in (marked as Json))) out.push(p);
      else out.push(...diffPointers((real as Json)[k], (marked as Json)[k], p));
    }
    return out;
  }
  return JSON.stringify(real) === JSON.stringify(marked) ? [] : [base];
}
