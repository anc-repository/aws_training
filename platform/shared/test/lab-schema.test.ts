import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import YAML from 'yaml';
import { LAB_SCHEMA_V2, validateLab, type LabV2 } from '../src/index.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DOC = path.resolve(HERE, '../../../docs/platform/04-lab-format-checks-reports.md');

function loadFixture(): LabV2 {
  return YAML.parse(fs.readFileSync(path.join(HERE, 'fixtures/svc-cdn.lab.yaml'), 'utf8'), { version: '1.2' }) as LabV2;
}

function clone<T>(v: T): T {
  return JSON.parse(JSON.stringify(v)) as T;
}

describe('lab.yaml v2 JSON Schema (04 §3.3)', () => {
  it.skipIf(!fs.existsSync(DOC))('is a 1:1 transcription of the YAML block in 04 §3.3', () => {
    const md = fs.readFileSync(DOC, 'utf8');
    const start = md.indexOf('### 3.3 JSON Schema');
    const a = md.indexOf('```yaml\n', start) + '```yaml\n'.length;
    const block = md.slice(a, md.indexOf('\n```', a));
    expect(LAB_SCHEMA_V2).toEqual(YAML.parse(block, { version: '1.2' }));
  });

  it('accepts the complete example card of 04 §11.1 (svc-cdn)', () => {
    const r = validateLab(loadFixture());
    expect(r.ok ? [] : r.issues).toEqual([]);
  });

  it('rejects missing required fields', () => {
    const lab = clone(loadFixture()) as Partial<LabV2>;
    delete lab.tracks;
    const r = validateLab(lab);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.issues.some((i) => i.keyword === 'required' && JSON.stringify(i.params).includes('tracks'))).toBe(true);
  });

  it('rejects unknown top-level fields (additionalProperties: false)', () => {
    expect(validateLab({ ...loadFixture(), estimate: 1 }).ok).toBe(false);
  });

  it('applies the kind-dependent rules (service ⇒ svc- id + service/function)', () => {
    const lab = clone(loadFixture());
    lab.id = 'sc-cdn';
    expect(validateLab(lab).ok).toBe(false);
    const lab2 = clone(loadFixture());
    delete lab2.function;
    expect(validateLab(lab2).ok).toBe(false);
  });

  it('enforces value patterns (card id, semver, time grid)', () => {
    expect(validateLab({ ...loadFixture(), id: 'SVC-CDN' }).ok).toBe(false);
    expect(validateLab({ ...loadFixture(), version: '1.0' }).ok).toBe(false);
    expect(validateLab({ ...loadFixture(), timeLimitMinutes: 45 }).ok).toBe(false);
    expect(validateLab({ ...loadFixture(), estimatedMinutes: 50 }).ok).toBe(false);
  });

  it('a preflight-selected start variant requires `when`; `default` is not a variant id', () => {
    const lab = clone(loadFixture());
    lab.startProfile.variants = [
      {
        id: 'acme-off',
        title: 'no ACME',
        select: 'preflight',
        provisions: [{ item: 'iam', kind: 'module', basis: 'credential', reason: 'base credential' }],
        reason: 'fallback',
      },
    ];
    expect(validateLab(lab).ok).toBe(false);
    lab.startProfile.variants[0]!.when = "preflight.tlsAcme == 'off'";
    expect(validateLab(lab).ok).toBe(true);
    lab.startProfile.variants[0]!.id = 'default';
    expect(validateLab(lab).ok).toBe(false);
  });
});
