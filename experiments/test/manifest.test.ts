import { existsSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { REGISTRY_DOCUMENT } from '@cloudalbum/contracts/registry';
import type { ModuleId } from '@cloudalbum/contracts';
import { describe, expect, it } from 'vitest';
import { listModules, loadManifest, ManifestError, normalizeManifest, resolveParams, selectExperiment, validateLabel } from '../_lib/manifest.js';
import { validateExperimentManifest } from '../_lib/schema.js';
import type { ExperimentDef } from '../_lib/types.js';
import { experimentsRoot } from '../_lib/util.js';

const MVP: ModuleId[] = ['iam', 'storage', 'cdn', 'auth', 'queue', 'image-processing', 'cache', 'database'];
const root = experimentsRoot();

describe('experiment manifests', () => {
  it('exist for all 8 MVP modules', () => {
    expect(listModules(root)).toEqual([...MVP].sort());
  });

  for (const module of MVP) {
    describe(module, () => {
      const manifest = loadManifest(module, root);
      const registryIds = REGISTRY_DOCUMENT.modules[module].lab.experiments ?? [];

      it('validates against experiment.schema.json and uses registry experiment ids', () => {
        expect(manifest.module).toBe(module);
        for (const e of manifest.experiments) expect(registryIds, `${module}/${e.id} 不在 registry lab.experiments 中`).toContain(e.id);
        // 每个 registry 实验都有条目（自动化或手工）
        expect(manifest.experiments.map((e) => e.id).sort()).toEqual([...registryIds].sort());
      });

      it('references existing scripts, fault scripts and valid labels', async () => {
        for (const e of manifest.experiments) {
          if (e.scenario.tool === 'manual') continue;
          const file = path.join(root, module, e.scenario.script!);
          expect(existsSync(file), file).toBe(true);
          if (e.scenario.tool === 'node') {
            const mod = (await import(pathToFileURL(file).href)) as { default?: { run?: unknown } };
            expect(typeof mod.default?.run, `${file} 默认导出 defineScenario`).toBe('function');
          }
          for (const f of e.faults ?? []) {
            if (f.script) expect(existsSync(path.join(root, module, f.script)), f.script).toBe(true);
            for (const l of f.onlyFor ?? []) expect(Object.keys(e.requires ?? {}), `${e.id} faults.onlyFor ${l}`).toContain(l);
          }
          for (const label of Object.keys(e.requires ?? {})) expect(() => validateLabel(e, label)).not.toThrow();
          if (e.pair) for (const l of e.pair) expect(Object.keys(e.requires ?? {})).toContain(l.split(':')[0]);
          if (e.ab) expect(REGISTRY_DOCUMENT.modules[module].bypass ?? [], `${module} 的 bypass 键`).toContain(e.ab.bypass);
          for (const [k, spec] of Object.entries(e.params ?? {})) expect(spec.default, `${e.id}.params.${k}.default`).toBeDefined();
        }
      });
    });
  }

  it('accepts the single-experiment example of modular-design.md §8.2', () => {
    const example = {
      module: 'queue', id: 'upload-burst', title: '上传突发：sync / memory / sqs 的接口延迟与任务可靠性', kind: 'before-after',
      requires: {
        l0: { 'queue.driver': 'sync', 'image-processing.driver': 'inline' },
        before: { 'queue.driver': 'memory', 'image-processing.driver': 'worker' },
        after: { 'queue.driver': 'sqs', 'image-processing.driver': 'worker', 'queue.status': ['ok', 'degraded'] },
      },
      scenario: { tool: 'k6', script: 'upload-burst.k6.js', vus: 10, duration: '60s', warmup: '10s' },
      metrics: ['client.http_req_duration{route:/api/photos/complete}.p95', 'server.route./api/photos/complete.p95', 'biz.jobs_lost'],
      faults: [{ at: '30s', script: 'faults/kill-worker.sh', onlyFor: ['after'] }],
      expect: [{ metric: 'biz.jobs_lost', direction: 'zero', note: 'SQS 在 worker 被杀后重新投递' }],
      cleanup: 'DELETE /api/lab/runs/{runId}/photos',
    };
    expect(validateExperimentManifest(example)).toEqual({ ok: true, errors: [] });
    expect(normalizeManifest(example).experiments).toHaveLength(1);
    expect(validateExperimentManifest({ ...example, kind: 'nope' }).ok).toBe(false);
    expect(validateExperimentManifest({ ...example, requires: { BAD: {} } }).ok).toBe(false);
  });

  it('selects experiments, validates labels and params', () => {
    const m = loadManifest('queue', root);
    expect(selectExperiment(m).id).toBe('upload-burst');
    expect(() => selectExperiment(m, 'nope')).toThrow(ManifestError);
    const e = selectExperiment(m, 'upload-burst');
    expect(() => validateLabel(e, 'after')).not.toThrow();
    expect(() => validateLabel(e, 'Bad')).toThrow(/不合法/);
    expect(() => validateLabel(e, 'selfhost')).toThrow(/不支持标签/);
    expect(resolveParams(e, {})).toMatchObject({ count: 200, drainTimeoutSec: 600 });
    expect(resolveParams(e, { count: '5' }).count).toBe(5);
    expect(() => resolveParams(e, { count: '0' })).toThrow(/下限/);
    expect(() => resolveParams(e, { nope: '1' })).toThrow(/不接受参数/);
    const cache = selectExperiment(loadManifest('cache', root), 'feed-read');
    expect(() => resolveParams(cache, { scope: 'everyone' })).toThrow(/允许范围/);
    expect(() => loadManifest('not-a-module', root)).toThrow(ManifestError);
  });

  it('declares the experiments named in the task (registry ids)', () => {
    const ids = (m: ModuleId) => loadManifest(m, root).experiments.filter((e: ExperimentDef) => e.scenario.tool !== 'manual').map((e) => e.id);
    expect(ids('storage')).toContain('upload-burst');
    expect(ids('cdn')).toContain('ttfb');
    expect(ids('cache')).toContain('feed-read');
    expect(ids('queue')).toContain('upload-burst');
    expect(loadManifest('queue', root).experiments[0]!.faults!.map((f) => f.script)).toContain('faults/kill-worker.sh');
    expect(ids('image-processing')).toEqual(expect.arrayContaining(['upload-burst', 'neighbor']));
    expect(ids('auth')).toEqual(expect.arrayContaining(['login-storm', 'token-claims']));
    expect(ids('database')).toContain('mixed-rw');
    expect(ids('iam')).toContain('whoami');
  });
});
