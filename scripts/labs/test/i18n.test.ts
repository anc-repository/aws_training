/**
 * Content languages (09-i18n-and-visual.md §2): localized text fields, translated manuals, the translation lint rules
 * I1–I5 and the per-language build output, on a copy of the repository content (temporary directory under .atl-dev/tmp).
 */
import fs from 'node:fs';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildContent } from '../src/build.js';
import { loadContent } from '../src/content.js';
import { diffPointers, isTextPointer, localizeDoc, manualLanguageOf, textPatterns } from '../src/l10n.js';
import { lintTranslations, translationCoverage } from '../src/lint/i18n.js';
import { lintLabs } from '../src/lint/index.js';
import { labsPaths, REPO_ROOT } from '../src/paths.js';
import { validateWith } from '../src/schemas/index.js';
import { parseYamlText, stringifyYaml } from '../src/yaml.js';

const TMP_ROOT = path.join(REPO_ROOT, '.atl-dev', 'tmp');
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- built and edited documents are read loosely in this test
type Doc = Record<string, any>;
let copy = '';
let out = '';

const readJson = (rel: string) => JSON.parse(fs.readFileSync(path.join(out, rel), 'utf8')) as Doc;

function editYaml(file: string, mutate: (doc: Doc) => void): void {
  const doc = parseYamlText(fs.readFileSync(file, 'utf8'), file) as Doc;
  mutate(doc);
  fs.writeFileSync(file, stringifyYaml(doc, ''));
}

const TITLE = { ja: 'Amazon CloudFront：コンテンツ配信とエッジキャッシュ', en: 'Amazon CloudFront: content delivery and edge caching' };

/** The repository's svc-cdn is translated; the tests below start from its zh-CN source and add their own translations. */
function sourceOnly(card: string): void {
  const strip = (v: unknown): unknown => {
    if (Array.isArray(v)) return v.map(strip);
    if (!v || typeof v !== 'object') return v;
    const keys = Object.keys(v);
    if (keys.includes('zh-CN') && keys.every((k) => ['zh-CN', 'ja', 'en'].includes(k))) return (v as Doc)['zh-CN'];
    return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, strip(x)]));
  };
  const files = ['lab.yaml', 'quiz.yaml', ...fs.readdirSync(path.join(card, 'checks')).map((f) => path.join('checks', f))];
  for (const f of files) editYaml(path.join(card, f), (doc) => Object.assign(doc, strip(doc)));
  for (const lang of ['ja', 'en']) fs.rmSync(path.join(card, 'manual', lang), { recursive: true, force: true });
}

beforeAll(async () => {
  fs.mkdirSync(TMP_ROOT, { recursive: true });
  copy = fs.mkdtempSync(path.join(TMP_ROOT, 'labs-i18n-'));
  fs.cpSync(path.join(REPO_ROOT, 'labs'), copy, { recursive: true });
  const card = path.join(copy, 'svc-cdn');
  sourceOnly(card);
  editYaml(path.join(card, 'lab.yaml'), (lab) => {
    lab.title = { 'zh-CN': lab.title, ...TITLE };
    lab.steps[0].title = { 'zh-CN': lab.steps[0].title, en: 'Where we start' };
  });
  editYaml(path.join(card, 'quiz.yaml'), (quiz) => {
    quiz.questions[0].stem = { 'zh-CN': quiz.questions[0].stem, ja: '東京の EC2 にある画像と静的リソースへの世界中からのアクセスが遅い。最適な方法は？' };
  });
  const orient = fs.readFileSync(path.join(card, 'manual', '10-orient.md'), 'utf8');
  fs.mkdirSync(path.join(card, 'manual', 'ja'), { recursive: true });
  fs.writeFileSync(path.join(card, 'manual', 'ja', '10-orient.md'), orient.replace('先确认起点', 'まず出発点を確認します'));
  out = fs.mkdtempSync(path.join(TMP_ROOT, 'labs-i18n-build-'));
  await buildContent(loadContent(labsPaths(copy)), { outDir: out, catalogVersion: '0.0.0-i18n', deriver: 'reference', generatedAt: '2026-01-01T00:00:00.000Z' });
}, 180_000);
afterAll(() => {
  for (const d of [copy, out]) if (d) fs.rmSync(d, { recursive: true, force: true });
});

describe('text fields from the schemas', () => {
  it('finds the translatable fields of every content schema', () => {
    expect(isTextPointer('lab', '/title')).toBe(true);
    expect(isTextPointer('lab', '/steps/3/title')).toBe(true);
    expect(isTextPointer('lab', '/variables/bucketName/label')).toBe(true);
    expect(isTextPointer('lab', '/steps/3/id')).toBe(false);
    expect(isTextPointer('lab', '/tags/0')).toBe(false);
    expect(isTextPointer('check', '/checks/0/title')).toBe(true);
    expect(isTextPointer('check', '/checks/0/spec/observed/options/1/label')).toBe(true);
    expect(isTextPointer('quiz', '/questions/0/options/2/text')).toBe(true);
    expect(isTextPointer('track', '/stages/0/items/1/note')).toBe(true);
    expect(isTextPointer('taxonomy', '/costTier/labels/high')).toBe(true);
    expect(textPatterns('lab').length).toBeGreaterThan(40);
  });

  it('resolves documents per language and marks fallbacks for the build', () => {
    const doc = { title: { 'zh-CN': '标题', en: 'Title' }, summary: '摘要', id: 'svc-x' };
    expect(localizeDoc(doc, 'lab', { lang: 'zh-CN' })).toEqual({ title: '标题', summary: '摘要', id: 'svc-x' });
    expect(localizeDoc(doc, 'lab', { lang: 'en' })).toEqual({ title: 'Title', summary: '摘要', id: 'svc-x' });
    const marked = localizeDoc(doc, 'lab', { lang: 'ja', mark: true });
    expect(diffPointers(localizeDoc(doc, 'lab', { lang: 'ja' }), marked)).toEqual(['/title', '/summary']);
    expect(manualLanguageOf('manual/ja/10-x.md')).toEqual({ lang: 'ja', file: 'manual/10-x.md' });
    expect(manualLanguageOf('manual/10-x.md')).toEqual({ lang: 'zh-CN', file: 'manual/10-x.md' });
    expect(manualLanguageOf('manual/zh-CN/10-x.md')).toEqual({ lang: 'zh-CN', file: 'manual/10-x.md' });
  });

  it('accepts localized objects in every schema and reports malformed ones once', () => {
    expect(validateWith('quiz', { schema: 'atl.quiz/v1', version: '1.0.0', questions: [{ id: 'q1', domain: 'cost', type: 'single', stem: { 'zh-CN': '这是一个足够长的题干吗？', en: 'Is this stem long enough?' }, options: [{ id: 'a', text: '是' }, { id: 'b', text: { 'zh-CN': '否', ja: 'いいえ' } }], answer: ['a'], explain: '因为它超过了十个字符。' }] })).toEqual([]);
    const bad = validateWith('track', { schema: 'atl.track/v2', id: 'x-track', version: '1.0.0', title: { ja: 'タイトル' }, summary: '一条学习路径', stages: [], completion: { allowManual: true, minAutoRatio: 0.5, excludeSelfReported: true }, certificate: { enabled: false, title: 'x' } });
    expect(bad.some((i) => i.path === '/title' && i.message.includes('zh-CN'))).toBe(true);
    expect(bad.some((i) => i.path === '/title' && i.message.includes('must be string'))).toBe(false);
    const long = validateWith('track', { schema: 'atl.track/v2', id: 'x-track', version: '1.0.0', title: '长'.repeat(41), summary: '一条学习路径', stages: [{ id: 's1', title: 'a', items: [{ card: 'svc-cdn', role: 'required' }] }], completion: { allowManual: true, minAutoRatio: 0.5, excludeSelfReported: true }, certificate: { enabled: false, title: 'x' } });
    expect(long.map((i) => i.path)).toEqual(['/title']);
    expect(long[0]!.message).toContain('40');
  });
});

describe('labs:lint with translations', () => {
  it('the localized copy still passes every rule', async () => {
    const { issues } = await lintLabs(labsPaths(copy), { checkCatalog: false });
    expect(issues.filter((i) => i.card === 'svc-cdn')).toEqual([]);
  }, 60_000);

  it('reports the translation rules I1–I5', () => {
    const dir = fs.mkdtempSync(path.join(TMP_ROOT, 'labs-i18n-bad-'));
    try {
      fs.cpSync(copy, dir, { recursive: true });
      const card = path.join(dir, 'svc-cdn');
      editYaml(path.join(card, 'lab.yaml'), (lab) => {
        lab.subtitle = { 'zh-CN': lab.subtitle, en: '' };
        lab.tags[0] = { 'zh-CN': lab.tags[0], ja: 'cdn-ja' };
        lab.summary = { 'zh-CN': `${lab.summary}{{ target.publicIp }}`, en: 'Put CloudFront in front of the album.' };
      });
      fs.mkdirSync(path.join(card, 'manual', 'en'), { recursive: true });
      fs.writeFileSync(path.join(card, 'manual', 'en', '99-orphan.md'), '---\nstep: orient\n---\n\nOrphan.\n');
      fs.writeFileSync(path.join(card, 'manual', 'en', '10-orient.md'), '---\nstep: baseline\n---\n\nNo variables, no directives.\n');
      const overview = fs.readFileSync(path.join(card, 'manual', '00-overview.md'), 'utf8');
      fs.writeFileSync(path.join(card, 'manual', 'en', '00-overview.md'), overview.replace('## 背景', '## Context'));
      const set = loadContent(labsPaths(dir));
      const issues = lintTranslations(set).filter((i) => i.card === 'svc-cdn');
      const rules = (r: string) => issues.filter((i) => i.rule === r);
      expect(rules('I1').map((i) => i.message)).toEqual(['lab.yaml: /subtitle/en is empty (leave the language out to fall back)']);
      expect(rules('I2').map((i) => i.message)).toEqual(['lab.yaml: /tags/0 is not a translatable field']);
      expect(rules('I3').some((i) => i.message.includes('99-orphan.md has no source'))).toBe(true);
      expect(rules('I3').some((i) => i.message.includes('manual/en/10-orient.md: front matter step'))).toBe(true);
      expect(rules('I4').some((i) => i.message.includes('/summary (en)'))).toBe(true);
      expect(rules('I4').some((i) => i.message.includes('manual/en/10-orient.md: {{ … }} variables'))).toBe(true);
      expect(rules('I5').some((i) => i.message.includes('“## Background”'))).toBe(true);
      expect(issues.every((i) => i.severity === (['I4', 'I5'].includes(i.rule) ? 'warn' : 'error'))).toBe(true);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('counts the translated fields and manuals', () => {
    const row = translationCoverage(loadContent(labsPaths(copy))).find((r) => r.card === 'svc-cdn')!;
    expect(row.translated).toMatchObject({ ja: 2, en: 2 });
    expect(row.manualsTranslated).toMatchObject({ ja: 1, en: 0 });
    expect(row.fields).toBeGreaterThan(50);
  });
});

describe('labs:build per language', () => {
  it('keeps the root documents in zh-CN without i18n', () => {
    const lab = readJson('labs/svc-cdn.json');
    expect(lab.title).toBe('Amazon CloudFront：内容分发与边缘缓存');
    expect(lab.i18n).toBeUndefined();
    expect(readJson('manifest.json').languages).toEqual(['zh-CN', 'ja', 'en']);
  });

  it('writes ja / en documents with resolved texts and the fallback pointers', () => {
    const ja = readJson('ja/labs/svc-cdn.json');
    expect(ja.title).toBe(TITLE.ja);
    expect(ja.steps[0].title).toBe('Where we start');
    expect(ja.i18n.lang).toBe('ja');
    expect(ja.i18n.fallback).not.toContain('/title');
    expect(ja.i18n.fallback).toContain('/summary');
    expect(ja.i18n.fallback).toContain('/steps/0/title');
    expect(ja.manuals['manual/10-orient.md'].lang).toBe('ja');
    expect(ja.manuals['manual/10-orient.md'].source).toContain('まず出発点を確認します');
    expect(ja.manuals['manual/20-baseline.md'].lang).toBe('zh-CN');
    const en = readJson('en/labs/svc-cdn.json');
    expect(en.title).toBe(TITLE.en);
    expect(en.i18n.fallback).not.toContain('/steps/0/title');
    expect(en.manuals['manual/10-orient.md'].lang).toBe('zh-CN');
  });

  it('marks each card and track of the index and the intro', () => {
    const index = readJson('ja/catalog/index.json');
    const card = index.cards.find((c: { id: string }) => c.id === 'svc-cdn');
    expect(card.title).toBe(TITLE.ja);
    expect(card.i18n.fallback).not.toContain('/title');
    expect(card.i18n.fallback).toContain('/summary');
    expect(index.tracks.every((t: { i18n?: { lang: string } }) => t.i18n?.lang === 'ja')).toBe(true);
    expect(index.i18n.fallback.some((p: string) => p.startsWith('/taxonomy/'))).toBe(true);
    const intro = readJson('ja/catalog/cards/svc-cdn.json');
    expect(intro.i18n.fallback).toContain('/overview');
    expect(intro.steps[0].title).toBe('Where we start');
  });

  it('writes the quiz bank per language under private/quiz/<lang>/', () => {
    const ja = readJson('private/quiz/ja/svc-cdn.json');
    expect(ja.questions[0].stem).toMatch(/^東京/);
    expect(ja.i18n.fallback).toContain('/questions/0/explain');
    expect(ja.i18n.fallback).not.toContain('/questions/0/stem');
    expect(readJson('private/quiz/svc-cdn.json').questions[0].stem).toMatch(/^全球用户/);
  });
});
