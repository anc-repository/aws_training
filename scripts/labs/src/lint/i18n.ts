/**
 * Translation rules of `labs:lint` (09-i18n-and-visual.md §2.3, decision I4). Only zh-CN is required: a card without any
 * translation passes; these rules check that what is translated fits the source.
 *
 *   I1 error  a localized object has an empty value (leave the language out instead)
 *   I2 error  a localized object at a field that is not translatable (ids, enums, commands, …)
 *   I3 error  manual/<lang>/<f>.md without manual/<f>.md, a duplicate, or a front matter (step / section) that differs
 *   I4 warn   a translation changes the `{{ … }}` variables, the directives or the number of code blocks of its source
 *   I5 warn   a translated 00-overview.md lacks the translated form of a heading that the zh-CN overview has (C-12)
 *   I6 error  Japanese orthography of the glossary (platform/web/src/i18n/glossary.md): long vowel at the end of loanwords
 *             (ブラウザー, パラメーター, サーバー, ユーザー, フォルダー; メモリ stays as in the AWS console) and a half-width
 *             “ + ” instead of “＋”
 *
 * Coverage (`labs:i18n`) counts translated text fields and manuals per card and language.
 */
import type { CardContent, ContentSet, LintIssue } from '../content.js';
import { CONTENT_LANGS, escapeSeg, misplacedLocalized, OVERVIEW_HEADINGS, placeholdersOf, SOURCE_LANG, textFields, TRANSLATED_LANGS, type ContentLang } from '../l10n.js';
import type { ParsedManual } from '../manual.js';
import type { SchemaName } from '../schemas/index.js';

interface SourceDoc {
  owner: string;
  file: string;
  schema: SchemaName;
  doc: unknown;
}

function sourceDocs(set: ContentSet): SourceDoc[] {
  const out: SourceDoc[] = [];
  for (const c of set.cards) {
    out.push({ owner: c.id, file: 'lab.yaml', schema: c.planned ? 'lab-planned' : 'lab', doc: c.source });
    for (const f of c.checkFiles) out.push({ owner: c.id, file: f.file, schema: 'check', doc: f.source });
    if (c.quizSource !== undefined) out.push({ owner: c.id, file: 'quiz.yaml', schema: 'quiz', doc: c.quizSource });
  }
  for (const f of set.sharedCheckFiles) out.push({ owner: '_shared', file: f.file, schema: 'check', doc: f.source });
  for (const f of set.trackFiles) out.push({ owner: '_tracks', file: f.file, schema: 'track', doc: f.source });
  if (set.taxonomySource !== undefined) out.push({ owner: '_catalog', file: 'taxonomy.yaml', schema: 'taxonomy', doc: set.taxonomySource });
  return out;
}

function emptyValues(doc: unknown): string[] {
  const out: string[] = [];
  const walk = (v: unknown, ptr: string) => {
    if (v && typeof v === 'object' && !Array.isArray(v)) {
      const keys = Object.keys(v);
      if (keys.length && keys.every((k) => (CONTENT_LANGS as readonly string[]).includes(k)) && keys.includes(SOURCE_LANG)) {
        for (const k of keys) if ((v as Record<string, unknown>)[k] === '') out.push(`${ptr}/${k}`);
        return;
      }
      for (const [k, x] of Object.entries(v)) walk(x, `${ptr}/${escapeSeg(k)}`);
    } else if (Array.isArray(v)) v.forEach((x, i) => walk(x, `${ptr}/${i}`));
  };
  walk(doc, '');
  return out;
}

/** Glossary orthography rules for Japanese text (I6); code spans and fenced blocks are not checked. */
export const JA_ORTHOGRAPHY: readonly { re: RegExp; use: string }[] = [
  { re: /ブラウザ(?!ー)/, use: 'ブラウザー' },
  { re: /パラメータ(?!ー)/, use: 'パラメーター' },
  { re: /サーバ(?![ーレ])/, use: 'サーバー' },
  { re: /ユーザ(?!ー)/, use: 'ユーザー' },
  { re: /フォルダ(?!ー)/, use: 'フォルダー' },
  { re: /＋/, use: '“ + ” (half-width, spaces around)' },
];

/** The orthography problems of one Japanese text (outside inline code and fenced code blocks). */
export function jaOrthography(text: string): string[] {
  const prose = text.replace(/```[\s\S]*?```/g, '').replace(/`[^`\n]*`/g, '');
  return JA_ORTHOGRAPHY.filter((r) => r.re.test(prose)).map((r) => `${r.re.source} → ${r.use}`);
}

const same = (a: readonly string[], b: readonly string[]) => a.length === b.length && a.every((x, i) => x === b[i]);

function directiveSignature(m: ParsedManual): string[] {
  return m.directives.filter((d) => d.kind !== 'text').map((d) => `${d.kind}:${d.name}${Object.keys(d.attributes).length ? JSON.stringify(Object.entries(d.attributes).sort()) : ''}`);
}

function lintManualTranslations(card: CardContent, add: (rule: string, message: string, severity?: 'error' | 'warn') => void): void {
  for (const [lang, files] of card.translations) {
    for (const [file, t] of files) {
      const rel = file.replace(/^manual\//, `manual/${lang}/`);
      const zh = card.sourceManuals.get(file);
      if (!zh) {
        add('I3', `${rel} has no source ${file}`);
        continue;
      }
      for (const k of ['step', 'section'] as const) {
        if ((zh.frontMatter?.[k] ?? null) !== (t.frontMatter?.[k] ?? null)) add('I3', `${rel}: front matter ${k} must equal ${file} (${String(zh.frontMatter?.[k] ?? '—')})`);
      }
      if (!same(zh.variables.map((v) => v.expr.trim()).sort(), t.variables.map((v) => v.expr.trim()).sort())) add('I4', `${rel}: {{ … }} variables differ from ${file}`, 'warn');
      if (!same(directiveSignature(zh), directiveSignature(t))) add('I4', `${rel}: directives (::name{…}) differ from ${file}`, 'warn');
      if (zh.code.length !== t.code.length) add('I4', `${rel}: ${t.code.length} code block(s), ${file} has ${zh.code.length}`, 'warn');
      if (lang === 'ja') for (const p of jaOrthography(t.body)) add('I6', `${rel}: ${p}`);
      if (zh.frontMatter?.section === 'overview') {
        const h2zh = zh.headings.filter((h) => h.depth === 2).map((h) => h.text);
        const h2 = t.headings.filter((h) => h.depth === 2).map((h) => h.text);
        for (const names of Object.values(OVERVIEW_HEADINGS)) {
          if (h2zh.some((h) => h.includes(names['zh-CN'])) && !h2.some((h) => h.includes(names[lang]))) add('I5', `${rel}: needs “## ${names[lang]}” (the translation of “## ${names['zh-CN']}”)`, 'warn');
        }
      }
    }
  }
}

export function lintTranslations(set: ContentSet): LintIssue[] {
  const issues: LintIssue[] = [];
  for (const d of sourceDocs(set)) {
    const add = (rule: string, message: string, severity: 'error' | 'warn' = 'error') => issues.push({ card: d.owner, rule, severity, message: `${d.file}: ${message}` });
    for (const p of emptyValues(d.doc)) add('I1', `${p} is empty (leave the language out to fall back)`);
    for (const p of misplacedLocalized(d.doc, d.schema)) add('I2', `${p} is not a translatable field`);
    for (const f of textFields(d.doc, d.schema)) {
      const zh = f.texts['zh-CN'];
      if (zh === undefined) continue;
      for (const l of TRANSLATED_LANGS) {
        const t = f.texts[l];
        if (t !== undefined && !same(placeholdersOf(zh), placeholdersOf(t))) add('I4', `${f.pointer} (${l}): {{ … }} variables differ from zh-CN`, 'warn');
      }
      const ja = f.texts.ja;
      if (ja !== undefined) for (const p of jaOrthography(ja)) add('I6', `${f.pointer} (ja): ${p}`);
    }
  }
  for (const card of set.cards) {
    lintManualTranslations(card, (rule, message, severity = 'error') => issues.push({ card: card.id, rule, severity, message }));
  }
  return issues;
}

export interface Coverage {
  card: string;
  fields: number;
  translated: Record<string, number>;
  manuals: number;
  manualsTranslated: Record<string, number>;
}

/** Translated text fields and manuals per card (the documents of the card: lab.yaml, checks, quiz). */
export function translationCoverage(set: ContentSet): Coverage[] {
  const byOwner = new Map<string, Coverage>();
  const entry = (owner: string) => {
    let c = byOwner.get(owner);
    if (!c) {
      c = { card: owner, fields: 0, translated: Object.fromEntries(TRANSLATED_LANGS.map((l) => [l, 0])), manuals: 0, manualsTranslated: Object.fromEntries(TRANSLATED_LANGS.map((l) => [l, 0])) };
      byOwner.set(owner, c);
    }
    return c;
  };
  for (const d of sourceDocs(set)) {
    const c = entry(d.owner);
    for (const f of textFields(d.doc, d.schema)) {
      c.fields += 1;
      for (const l of TRANSLATED_LANGS) if (f.texts[l] !== undefined) c.translated[l]! += 1;
    }
  }
  for (const card of set.cards) {
    const c = entry(card.id);
    c.manuals = card.sourceManuals.size;
    for (const l of TRANSLATED_LANGS) c.manualsTranslated[l] = [...(card.translations.get(l as ContentLang)?.keys() ?? [])].filter((f) => card.sourceManuals.has(f)).length;
  }
  return [...byOwner.values()];
}
