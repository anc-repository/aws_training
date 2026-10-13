/**
 * labs:build into a temporary directory (reference deriver): products, determinism, check expansion across cards.
 */
import fs from 'node:fs';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildContent, type BuildResult } from '../src/build.js';
import { expandChecks, expandPitfalls } from '../src/checks.js';
import { loadContent } from '../src/content.js';
import { labsPaths, REPO_ROOT } from '../src/paths.js';

const TMP_ROOT = path.join(REPO_ROOT, '.atl-dev', 'tmp');
let out1 = '';
let out2 = '';
let r1: BuildResult;
let r2: BuildResult;

const readJson = (dir: string, rel: string) => JSON.parse(fs.readFileSync(path.join(dir, rel), 'utf8')) as Record<string, unknown>;

beforeAll(async () => {
  fs.mkdirSync(TMP_ROOT, { recursive: true });
  out1 = fs.mkdtempSync(path.join(TMP_ROOT, 'labs-build-'));
  out2 = fs.mkdtempSync(path.join(TMP_ROOT, 'labs-build-'));
  const opts = { catalogVersion: '0.0.0-test', deriver: 'reference' as const, generatedAt: '2026-01-01T00:00:00.000Z' };
  r1 = await buildContent(loadContent(labsPaths()), { ...opts, outDir: out1 });
  r2 = await buildContent(loadContent(labsPaths()), { ...opts, outDir: out2 });
}, 120_000);
afterAll(() => {
  for (const d of [out1, out2]) fs.rmSync(d, { recursive: true, force: true });
});

describe('labs:build', () => {
  it('writes the catalog, card, lab, track, profile and private quiz products with a manifest', () => {
    expect(r1.issues.filter((i) => i.severity === 'error')).toEqual([]);
    const index = readJson(out1, 'catalog/index.json') as { schema: string; cards: { id: string; status: string }[] };
    expect(index.schema).toBe('atl.catalog-index/v2');
    expect(index.cards).toHaveLength(56);
    expect(index.cards.filter((c) => c.status === 'planned')).toHaveLength(46);
    for (const id of ['svc-cdn', 'svc-ec2', 'sc-static-acceleration']) {
      expect(fs.existsSync(path.join(out1, 'labs', `${id}.json`))).toBe(true);
      expect(fs.existsSync(path.join(out1, 'catalog', 'cards', `${id}.json`))).toBe(true);
      expect(fs.existsSync(path.join(out1, 'private', 'quiz', `${id}.json`))).toBe(true);
    }
    expect(fs.existsSync(path.join(out1, 'profiles', 'atl', 'svc-queue', 'default.env'))).toBe(true);
    expect(fs.existsSync(path.join(out1, 'tracks', 'saa-main.json'))).toBe(true);
    const manifest = readJson(out1, 'manifest.json') as { catalogVersion: string; contentDigest: string; files: Record<string, string> };
    expect(manifest.catalogVersion).toBe('0.0.0-test');
    expect(manifest.contentDigest).toBe(r1.contentDigest);
    expect(Object.keys(manifest.files).length).toBe(r1.files - 1);
  });

  it('is deterministic', () => {
    expect(r2.contentDigest).toBe(r1.contentDigest);
  });

  it('the expanded lab carries checks, sources, hashes, pitfalls and parsed manuals', () => {
    const lab = readJson(out1, 'labs/svc-queue.json') as {
      checks: Record<string, { type: string }>; checkSources: Record<string, string>; checkHashes: Record<string, string>;
      pitfalls: Record<string, unknown>; manuals: Record<string, { ast: { schema: string } }>; startProfileDigests: Record<string, string>;
    };
    expect(lab.checks['queue-wired']?.type).toBe('capability');
    expect(lab.checks['no-world-ssh']).toBeDefined();
    expect(lab.checkSources['no-world-ssh']).toBe('_shared/no-world-ssh');
    expect(lab.checkHashes['queue-wired']).toMatch(/^sha256:/);
    expect(lab.pitfalls['poison-too-early']).toBeDefined();
    expect(lab.manuals['manual/30-enable-sqs.md']?.ast.schema).toBe('atl.mdast/v1');
    expect(lab.startProfileDigests.default).toMatch(/^sha256:/);
    // the quiz answers never ship in the public lab document
    expect(JSON.stringify(lab)).not.toContain('"answer"');
  });
});

describe('check references across cards', () => {
  it('a foreign check brings its dependencies and pitfalls from its source card', () => {
    const set = loadContent(labsPaths());
    const card = set.byId.get('sc-static-acceleration')!;
    const ex = expandChecks(set, card);
    expect(ex.unresolved).toEqual([]);
    expect(ex.sources['edge-cache-observed']).toBe('svc-cdn/edge-cache-observed');
    expect(ex.sources['distribution-deployed']).toBe('svc-cdn/distribution-deployed');
    expect(ex.checks['media-behavior-oac']).toBeDefined();
    const pitfalls = expandPitfalls(set, card);
    expect(pitfalls['still-deploying']).toBeDefined();
  });
});
