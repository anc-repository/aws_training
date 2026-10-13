/**
 * atl-copy-artifacts (01 §4.5): downloads from GitHub Releases or s3://<ArtifactBaseUrl>, verifies SHA-256 against the
 * manifest embedded in the template (dev: SHA256SUMS), copies into releases/<ver>/, answers CloudFormation. The test also
 * runs the minified inline code that is embedded into the template.
 */
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import vm from 'node:vm';
import { describe, expect, it } from 'vitest';
import { copyArtifactsInlineCode } from '../build/template-parts.js';

const require = createRequire(import.meta.url);
interface CopyModule {
  run(event: unknown, deps: Deps): Promise<{ id: string; data: Record<string, string> }>;
  parseSums(text: string): { Files: { Name: string; Sha256: string }[]; ChecksBundleDigest: string };
  handler(event: unknown, ctx: unknown, deps: Deps): Promise<void>;
}
interface Deps {
  fetch(url: string, init: unknown): Promise<{ ok: boolean; status: number; arrayBuffer(): Promise<ArrayBuffer> }>;
  s3Get(bucket: string, key: string): Promise<Buffer>;
  s3Put(bucket: string, key: string, body: Buffer): Promise<string | undefined>;
}
const source = require('../custom-resources/copy-artifacts.cjs') as CopyModule;

function loadInline(): CopyModule {
  const module = { exports: {} as CopyModule };
  vm.runInNewContext(copyArtifactsInlineCode(), { module, exports: module.exports, require, Buffer, console, fetch: undefined });
  return module.exports;
}

const sha = (b: Buffer) => createHash('sha256').update(b).digest('hex');
const files: Record<string, Buffer> = {
  'atl-lambdas.zip': Buffer.from('lambdas'),
  'atl-workstation.tar.gz': Buffer.from('workstation'),
  'cloudalbum-infra.zip': Buffer.from('infra'),
};
const manifest = { Files: Object.entries(files).map(([Name, b]) => ({ Name, Sha256: sha(b), Size: b.length })), ChecksBundleDigest: 'c'.repeat(64) };

function event(over: Record<string, unknown> = {}, type = 'Create') {
  return {
    RequestType: type,
    ResponseURL: 'https://cfn-response.example/presigned',
    StackId: 'arn:stack',
    RequestId: 'req',
    LogicalResourceId: 'CopyArtifacts',
    ResourceProperties: {
      ReleaseVersion: 'v0.1.0',
      Source: 'github-release',
      BaseUrl: '',
      GitHubRepository: 'anc-repository/aws_training',
      Bucket: 'atl-artifacts-111122223333-ap-northeast-1',
      Prefix: 'releases/v0.1.0/',
      Manifest: manifest,
      ...over,
    },
  };
}

function deps(served: Record<string, Buffer>) {
  const puts: Record<string, Buffer> = {};
  const responses: Record<string, unknown>[] = [];
  const d: Deps = {
    async fetch(url, init) {
      const i = init as { method?: string; body?: string } | undefined;
      if (i?.method === 'PUT') {
        responses.push(JSON.parse(i.body!));
        return { ok: true, status: 200, arrayBuffer: async () => new ArrayBuffer(0) };
      }
      const name = url.slice(url.lastIndexOf('/') + 1);
      const body = served[name];
      expect(url).toBe(`https://github.com/anc-repository/aws_training/releases/download/v0.1.0/${name}`);
      return body
        ? { ok: true, status: 200, arrayBuffer: async () => body.buffer.slice(body.byteOffset, body.byteOffset + body.byteLength) as ArrayBuffer }
        : { ok: false, status: 404, arrayBuffer: async () => new ArrayBuffer(0) };
    },
    async s3Get(bucket, key) {
      const name = key.slice(key.lastIndexOf('/') + 1);
      expect(bucket).toBe('my-dev-bucket');
      if (!served[name]) throw new Error(`NoSuchKey ${key}`);
      return served[name]!;
    },
    async s3Put(_bucket, key, body) {
      puts[key] = body;
      return `ver-${Object.keys(puts).length}`;
    },
  };
  return { d, puts, responses };
}

describe.each([
  ['source', () => source],
  ['inline (minified, as embedded in the template)', loadInline],
])('copy-artifacts %s', (_label, load) => {
  it('GitHub release: verifies and copies every file, returns the data attributes', async () => {
    const mod = load();
    const { d, puts } = deps(files);
    const r = await mod.run(event(), d);
    expect(Object.keys(puts).sort()).toEqual([...Object.keys(files).map((f) => `releases/v0.1.0/${f}`), 'releases/v0.1.0/SHA256SUMS'].sort());
    expect(r.data.LambdasObjectVersion).toBe('ver-1');
    expect(r.data.WorkstationBundleSha256).toBe(sha(files['atl-workstation.tar.gz']!));
    expect(r.data.ChecksBundleDigest).toBe('c'.repeat(64));
    expect(r.data.ManifestDigest).toMatch(/^[0-9a-f]{64}$/);
  });

  it('a tampered download fails the install (SHA-256 mismatch → FAILED)', async () => {
    const mod = load();
    const { d, responses } = deps({ ...files, 'cloudalbum-infra.zip': Buffer.from('evil') });
    await mod.handler(event(), {}, d);
    expect(responses[0]).toMatchObject({ Status: 'FAILED', LogicalResourceId: 'CopyArtifacts' });
    expect(String(responses[0]!.Reason)).toMatch(/SHA-256 mismatch for cloudalbum-infra.zip/);
  });

  it('ReleaseVersion=dev: trusts SHA256SUMS under ArtifactBaseUrl (01 §4.9)', async () => {
    const mod = load();
    const sums = Object.entries(files).map(([n, b]) => `${sha(b)}  ${n}`).join('\n') + `\n# checks-bundle-digest ${'d'.repeat(64)}\n`;
    const { d, puts } = deps({ ...files, SHA256SUMS: Buffer.from(sums) });
    const r = await mod.run(event({ ReleaseVersion: 'dev', Source: 's3', BaseUrl: 's3://my-dev-bucket/atl/dev', Prefix: 'releases/dev/', Manifest: { Files: [] } }), d);
    expect(puts['releases/dev/SHA256SUMS']!.toString()).toBe(sums);
    expect(r.data.ChecksBundleDigest).toBe('d'.repeat(64));
  });

  it('an empty manifest outside dev fails; Delete does nothing', async () => {
    const mod = load();
    const { d, puts } = deps(files);
    await expect(mod.run(event({ Manifest: { Files: [] } }), d)).rejects.toThrow(/no release manifest/);
    await mod.run({ ...event({}, 'Delete'), PhysicalResourceId: 'x' }, d);
    expect(puts).toEqual({});
  });

  it('parses SHA256SUMS', () => {
    expect(load().parseSums(`${'a'.repeat(64)}  x.zip\n# checks-bundle-digest ${'b'.repeat(64)}\n`)).toEqual({ Files: [{ Name: 'x.zip', Sha256: 'a'.repeat(64) }], ChecksBundleDigest: 'b'.repeat(64) });
  });
});
