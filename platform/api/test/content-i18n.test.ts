/**
 * Content languages in the API (09-i18n-and-visual.md §2, decision I4): `?lang=` / `Accept-Language` select the
 * translated catalog URLs, tracks and quiz texts of a release that has them (manifest `languages`), with a fallback to
 * the zh-CN root documents.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { WebKeys } from '@atl/shared';
import { clearContentCache } from '../src/services/catalog/store.js';
import { body, createApiTestRuntime, ev, LEARNER, OBSERVER, type ApiTestRuntime } from './api-support/api-runtime.js';
import { CATALOG_VERSION, fixtureIndex, fixtureQuiz, LAB_ID } from './api-support/fixtures.js';

let rt: ApiTestRuntime;
const prefix = WebKeys.content(CATALOG_VERSION);

async function publishLanguages(): Promise<void> {
  const web = rt.deps.env.buckets.web;
  await rt.objects.put(web, `${prefix}manifest.json`, JSON.stringify({ schema: 'atl.content-manifest/v1', catalogVersion: CATALOG_VERSION, languages: ['zh-CN', 'ja', 'en'] }));
  const ja = fixtureIndex() as { tracks: { title: string }[] };
  ja.tracks[0]!.title = 'SAA メインパス';
  await rt.objects.put(web, `${prefix}ja/catalog/index.json`, JSON.stringify({ ...ja, i18n: { lang: 'ja', fallback: [] } }));
  const quiz = fixtureQuiz() as { questions: { stem: string }[] };
  quiz.questions[0]!.stem = 'デッドレターキューの役割は？';
  await rt.objects.put(rt.deps.env.buckets.artifacts, `releases/${CATALOG_VERSION}/private/quiz/ja/${LAB_ID}.json`, JSON.stringify({ ...quiz, i18n: { lang: 'ja', fallback: ['/questions/1/stem'] } }));
  clearContentCache();
}

beforeEach(async () => {
  clearContentCache();
  rt = await createApiTestRuntime();
});

describe('GET /catalog by language', () => {
  it('keeps the root URLs for a release without translations', async () => {
    const r = body(await rt.api(ev('GET', '/api/v1/catalog', { token: OBSERVER, headers: { 'accept-language': 'ja-JP,ja;q=0.9' } })));
    expect(r).toMatchObject({ indexUrl: `/content/${CATALOG_VERSION}/catalog/index.json`, contentLang: 'zh-CN', languages: ['zh-CN'] });
  });

  it('points to <lang>/ when the release has the language (?lang= wins over Accept-Language)', async () => {
    await publishLanguages();
    const ja = await rt.api(ev('GET', '/api/v1/catalog', { token: OBSERVER, headers: { 'accept-language': 'ja-JP,ja;q=0.9,en;q=0.8' } }));
    expect(body(ja)).toMatchObject({
      contentLang: 'ja',
      languages: ['zh-CN', 'ja', 'en'],
      indexUrl: `/content/${CATALOG_VERSION}/ja/catalog/index.json`,
      cardIntroUrlTemplate: `/content/${CATALOG_VERSION}/ja/catalog/cards/{labId}.json`,
      labUrlTemplate: `/content/${CATALOG_VERSION}/ja/labs/{labId}.json`,
    });
    expect(ja.headers?.etag).toBe(`"${CATALOG_VERSION}-ja"`);
    const en = body(await rt.api(ev('GET', '/api/v1/catalog?lang=en', { token: OBSERVER, headers: { 'accept-language': 'ja' } })));
    expect(en).toMatchObject({ contentLang: 'en', indexUrl: `/content/${CATALOG_VERSION}/en/catalog/index.json` });
    const zh = await rt.api(ev('GET', '/api/v1/catalog', { token: OBSERVER, headers: { 'accept-language': 'zh-CN' } }));
    expect(body(zh)).toMatchObject({ contentLang: 'zh-CN', indexUrl: `/content/${CATALOG_VERSION}/catalog/index.json` });
    expect(zh.headers?.etag).toBe(`"${CATALOG_VERSION}"`);
  });
});

describe('tracks and quiz texts by language', () => {
  it('reads the translated index for tracks, the root one otherwise', async () => {
    await publishLanguages();
    const ja = body<{ items: { title: string }[] }>(await rt.api(ev('GET', '/api/v1/tracks', { token: OBSERVER, headers: { 'accept-language': 'ja' } })));
    expect(ja.items[0]!.title).toBe('SAA メインパス');
    const en = body<{ items: { title: string }[] }>(await rt.api(ev('GET', '/api/v1/tracks?lang=en', { token: OBSERVER })));
    expect(en.items[0]!.title).toBe('SAA 主线');
    const track = body<{ track: { title: string } }>(await rt.api(ev('GET', '/api/v1/tracks/saa-main', { token: OBSERVER, query: { lang: 'ja' } })));
    expect(track.track.title).toBe('SAA メインパス');
  });

  it('draws quiz questions from the translated bank and lists the untranslated ones', async () => {
    await publishLanguages();
    const r = await rt.api(ev('POST', `/api/v1/labs/${LAB_ID}/quiz-attempts`, { token: LEARNER, headers: { 'accept-language': 'ja' }, body: {} }));
    expect(r.statusCode, r.body).toBe(201);
    const a = body<{ attemptId: string; i18n: { lang: string; untranslated: string[] }; questions: { id: string; stem: string }[] }>(r);
    expect(a.i18n.lang).toBe('ja');
    for (const q of a.questions) expect(q.stem).toBe(q.id === 'q1' ? 'デッドレターキューの役割は？' : '削峰依赖？');
    expect(a.i18n.untranslated).toEqual(a.questions.some((q) => q.id === 'q2') ? ['q2'] : []);
    await rt.api(ev('PUT', `/api/v1/quiz-attempts/${a.attemptId}/answers`, { token: LEARNER, body: { answers: { q1: ['a'], q2: ['a', 'b'] } } }));
    const graded = body<{ score: number }>(await rt.api(ev('POST', `/api/v1/quiz-attempts/${a.attemptId}/submit`, { token: LEARNER, headers: { 'accept-language': 'en' }, body: {} })));
    expect(graded.score).toBe(100);
  });
});
