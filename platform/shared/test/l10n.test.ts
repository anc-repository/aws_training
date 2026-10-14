import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import YAML from 'yaml';
import { collectLocalized, fallbackChain, isLocalizedObject, negotiateLang, resolveLocalized, resolveText, validateLab, type LabV2Source } from '../src/index.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));

function fixture(): LabV2Source {
  return YAML.parse(fs.readFileSync(path.join(HERE, 'fixtures/svc-cdn.lab.yaml'), 'utf8'), { version: '1.2' }) as LabV2Source;
}

describe('LocalizedText (09 §2, I4)', () => {
  it('falls back requested → en → zh-CN', () => {
    expect(fallbackChain('ja')).toEqual(['ja', 'en', 'zh-CN']);
    expect(fallbackChain('en')).toEqual(['en', 'zh-CN']);
    expect(fallbackChain('zh-CN')).toEqual(['zh-CN', 'en']);
    const v = { 'zh-CN': '标题', en: 'Title' };
    expect(resolveText(v, 'ja')).toEqual({ text: 'Title', lang: 'en', fallback: true });
    expect(resolveText(v, 'en')).toEqual({ text: 'Title', lang: 'en', fallback: false });
    expect(resolveText({ 'zh-CN': '标题', ja: '' }, 'ja')).toEqual({ text: '标题', lang: 'zh-CN', fallback: true });
    expect(resolveText('纯文本', 'zh-CN')).toEqual({ text: '纯文本', lang: 'zh-CN', fallback: false });
    expect(resolveText('纯文本', 'ja').fallback).toBe(true);
  });

  it('recognises only {zh-CN, ja?, en?} objects with string values', () => {
    expect(isLocalizedObject({ 'zh-CN': 'a', ja: 'b' })).toBe(true);
    expect(isLocalizedObject({ ja: 'b' })).toBe(false);
    expect(isLocalizedObject({ 'zh-CN': 'a', fr: 'b' })).toBe(false);
    expect(isLocalizedObject({ 'zh-CN': 1 })).toBe(false);
    expect(isLocalizedObject(['a'])).toBe(false);
  });

  it('resolves a whole document and reports fallbacks by JSON pointer', () => {
    const doc = { title: { 'zh-CN': '标题', ja: 'タイトル' }, steps: [{ id: 'a/b', title: { 'zh-CN': '步骤' } }], note: '说明' };
    const seen: string[] = [];
    const out = resolveLocalized(doc, 'ja', { onFallback: (p) => seen.push(p), isTextPointer: (p) => p === '/note' });
    expect(out).toEqual({ title: 'タイトル', steps: [{ id: 'a/b', title: '步骤' }], note: '说明' });
    expect(seen).toEqual(['/steps/0/title', '/note']);
    expect(doc.title).toEqual({ 'zh-CN': '标题', ja: 'タイトル' });
    const ptrs: string[] = [];
    collectLocalized({ 'a/b': { 'zh-CN': 'x' } }, (p) => ptrs.push(p));
    expect(ptrs).toEqual(['/a~1b']);
  });

  it('negotiates ?lang= first, then Accept-Language by q-value', () => {
    expect(negotiateLang('ja', 'en')).toBe('ja');
    expect(negotiateLang('fr', 'en-US,en;q=0.9')).toBe('en');
    expect(negotiateLang(null, 'fr-FR, ja-JP;q=0.8, en;q=0.9')).toBe('en');
    expect(negotiateLang(null, 'zh-Hans-CN')).toBe('zh-CN');
    expect(negotiateLang(null, 'zh-TW, fr')).toBe('zh-CN');
    expect(negotiateLang(undefined, undefined, 'ja')).toBe('ja');
    expect(negotiateLang('', 'en;q=0')).toBe('zh-CN');
  });
});

describe('lab.yaml v2 schema with localized text', () => {
  it('accepts localized objects next to plain strings', () => {
    const lab = fixture();
    lab.title = { 'zh-CN': lab.title as string, ja: 'CDN で配信', en: 'Deliver with a CDN' };
    lab.steps[0]!.title = { 'zh-CN': lab.steps[0]!.title as string, en: 'First step' };
    const r = validateLab(lab);
    expect(r.ok ? [] : r.issues).toEqual([]);
  });

  it('rejects localized objects without zh-CN, with unknown languages or empty strings', () => {
    for (const title of [{ ja: 'タイトル' }, { 'zh-CN': '标题', fr: 'Titre' }, { 'zh-CN': '标题', en: '' }]) {
      const lab = fixture();
      (lab as unknown as Record<string, unknown>).title = title;
      expect(validateLab(lab).ok).toBe(false);
    }
  });

  it('keeps the zh-CN length limits on the resolved card', () => {
    const lab = fixture();
    lab.title = { 'zh-CN': '长'.repeat(49), en: 'Long' };
    expect(validateLab(lab).ok).toBe(true);
    expect(validateLab(resolveLocalized(lab, 'zh-CN')).ok).toBe(false);
  });
});
