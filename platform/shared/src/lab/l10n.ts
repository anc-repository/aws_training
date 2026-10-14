/**
 * Content languages (docs/platform/09-i18n-and-visual.md §2, decisions I1 / I2 / I4). Browser-safe.
 *
 * - Learner-facing text in content files (lab.yaml v2, checks, quiz, tracks, taxonomy) is a `LocalizedText`: either a
 *   plain string (treated as zh-CN, the source language) or `{ zh-CN, ja?, en? }` with zh-CN required.
 * - Resolution follows the fallback chain requested language → en → zh-CN (I2); a value shown in another language than the
 *   requested one is a "fallback" and the UI marks it as not translated.
 * - Language negotiation for the API and the dev server: `?lang=` first, then `Accept-Language`, then the default.
 */

export type ContentLang = 'zh-CN' | 'ja' | 'en';

/** All content languages; zh-CN is the source language (the only required one). */
export const CONTENT_LANGS: readonly ContentLang[] = ['zh-CN', 'ja', 'en'];
export const SOURCE_LANG: ContentLang = 'zh-CN';
/** The languages a build adds next to the source (`dist/content/<v>/<lang>/…`). */
export const TRANSLATED_LANGS: readonly Exclude<ContentLang, 'zh-CN'>[] = ['ja', 'en'];

export type LocalizedObject = { 'zh-CN': string; ja?: string; en?: string };
export type LocalizedText = string | LocalizedObject;

export function isContentLang(v: unknown): v is ContentLang {
  return v === 'zh-CN' || v === 'ja' || v === 'en';
}

/** Requested language → en → zh-CN, without duplicates (I2). */
export function fallbackChain(lang: ContentLang): ContentLang[] {
  const out: ContentLang[] = [lang];
  for (const l of ['en', 'zh-CN'] as const) if (!out.includes(l)) out.push(l);
  return out;
}

const L10N_KEYS = new Set<string>(CONTENT_LANGS);

/** `{ zh-CN, ja?, en? }` with only language keys and string values (zh-CN present). */
export function isLocalizedObject(v: unknown): v is LocalizedObject {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return false;
  const keys = Object.keys(v);
  if (!keys.length || !keys.includes('zh-CN')) return false;
  return keys.every((k) => L10N_KEYS.has(k) && typeof (v as Record<string, unknown>)[k] === 'string');
}

export interface Resolved {
  text: string;
  /** the language the text is actually in */
  lang: ContentLang;
  /** true when `lang` is not the requested language */
  fallback: boolean;
}

/** One `LocalizedText` in `lang` (a plain string is zh-CN). Empty strings count as missing. */
export function resolveText(v: LocalizedText, lang: ContentLang): Resolved {
  if (typeof v === 'string') return { text: v, lang: SOURCE_LANG, fallback: lang !== SOURCE_LANG };
  for (const l of fallbackChain(lang)) {
    const t = v[l];
    if (typeof t === 'string' && t !== '') return { text: t, lang: l, fallback: l !== lang };
  }
  return { text: v['zh-CN'] ?? '', lang: SOURCE_LANG, fallback: lang !== SOURCE_LANG };
}

export interface ResolveOptions {
  /**
   * Called for every value shown in another language than requested, with its JSON pointer in the source document.
   * Plain strings are zh-CN, so for ja / en every plain string is a fallback — except the values `isPlain` says are
   * not text (ids, enums, commands, …); by default only localized objects are reported.
   */
  onFallback?: (pointer: string, r: Resolved) => void;
  /** Also report plain strings at these pointers as fallbacks (text fields that were not localized). */
  isTextPointer?: (pointer: string) => boolean;
  /** Replaces every fallback value (e.g. labs:build marks them to find where they end up in the output). */
  mark?: (text: string, pointer: string) => string;
}

function escapePointer(seg: string): string {
  return seg.replace(/~/g, '~0').replace(/\//g, '~1');
}

/**
 * Deep-resolve every `LocalizedText` object of a document to `lang` (plain strings are kept as they are). Arrays and
 * objects are copied; the input is not modified.
 */
export function resolveLocalized<T>(doc: T, lang: ContentLang, opts: ResolveOptions = {}): T {
  const walk = (v: unknown, ptr: string): unknown => {
    if (isLocalizedObject(v)) {
      const r = resolveText(v, lang);
      if (!r.fallback) return r.text;
      opts.onFallback?.(ptr, r);
      return opts.mark ? opts.mark(r.text, ptr) : r.text;
    }
    if (typeof v === 'string') {
      if (lang === SOURCE_LANG || !opts.isTextPointer?.(ptr)) return v;
      opts.onFallback?.(ptr, { text: v, lang: SOURCE_LANG, fallback: true });
      return opts.mark ? opts.mark(v, ptr) : v;
    }
    if (Array.isArray(v)) return v.map((x, i) => walk(x, `${ptr}/${i}`));
    if (v && typeof v === 'object') {
      const out: Record<string, unknown> = {};
      for (const [k, x] of Object.entries(v as Record<string, unknown>)) out[k] = walk(x, `${ptr}/${escapePointer(k)}`);
      return out;
    }
    return v;
  };
  return walk(doc, '') as T;
}

/** Visit every localized object of a document with its JSON pointer (translation coverage reports). */
export function collectLocalized(doc: unknown, visit: (pointer: string, v: LocalizedObject) => void, ptr = ''): void {
  if (isLocalizedObject(doc)) {
    visit(ptr, doc);
    return;
  }
  if (Array.isArray(doc)) doc.forEach((x, i) => collectLocalized(x, visit, `${ptr}/${i}`));
  else if (doc && typeof doc === 'object') for (const [k, x] of Object.entries(doc as Record<string, unknown>)) collectLocalized(x, visit, `${ptr}/${escapePointer(k)}`);
}

/**
 * Language negotiation (I4): `?lang=` wins, then the first supported entry of `Accept-Language` (by q-value; `ja-JP` →
 * ja, `en-US` → en, `zh`, `zh-CN`, `zh-Hans*` → zh-CN), else `fallback`.
 */
export function negotiateLang(query: string | null | undefined, acceptLanguage: string | null | undefined, fallback: ContentLang = SOURCE_LANG): ContentLang {
  const q = normalizeLang(query ?? '');
  if (q) return q;
  if (acceptLanguage) {
    const ranked = acceptLanguage
      .split(',')
      .map((part, i) => {
        const [tag, ...params] = part.trim().split(';');
        const qp = params.map((p) => p.trim()).find((p) => p.startsWith('q='));
        const weight = qp ? Number(qp.slice(2)) : 1;
        return { tag: (tag ?? '').trim(), weight: Number.isFinite(weight) ? weight : 0, i };
      })
      .filter((x) => x.tag && x.weight > 0)
      .sort((a, b) => b.weight - a.weight || a.i - b.i);
    for (const r of ranked) {
      const l = normalizeLang(r.tag);
      if (l) return l;
    }
  }
  return fallback;
}

/** `ja`, `ja-JP` → ja; `en`, `en-*` → en; `zh`, `zh-CN`, `zh-Hans`, `zh-SG` → zh-CN; anything else → null. */
export function normalizeLang(tag: string): ContentLang | null {
  const t = tag.trim().toLowerCase();
  if (!t) return null;
  if (t === 'ja' || t.startsWith('ja-')) return 'ja';
  if (t === 'en' || t.startsWith('en-')) return 'en';
  if (t === 'zh' || t === 'zh-cn' || t.startsWith('zh-hans') || t === 'zh-sg') return 'zh-CN';
  return null;
}
