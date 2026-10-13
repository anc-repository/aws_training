/**
 * Release tooling (01 §4.2, §4.5, §4.9): deterministic archives, SHA256SUMS, check bundle validation, placeholders,
 * publish plan (no AWS call), Launch Stack links, the rendered workstation template.
 */
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { readZip } from '../custom-resources/src/zip.js';
import { readTarGz, writeTarGz } from '../build/archive.js';
import { launchStackMarkdown, launchStackUrl } from '../build/launch-link.js';
import { loadReleaseConfig, releaseTag, TEMPLATE_FILE_NAME } from '../build/merge-template.js';
import { contentZip, loadChecksBundle, sha256sums, SOURCE_ROOTS, webZip } from '../build/package.js';
import { publishPlan } from '../build/publish-s3.js';
import { renderWorkstationTemplate, WORKSTATION_TEMPLATE } from '../build/workstation-template.js';

const sha = (b: Buffer | string) => createHash('sha256').update(b).digest('hex');
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'atl-pkg-'));

describe('archives', () => {
  it('tar.gz is deterministic and round-trips names, data and modes', () => {
    const entries = [
      { name: 'bin/atl-agent-call', data: Buffer.from('#!/usr/bin/env node\n'), mode: 0o755 },
      { name: 'manifest.json', data: Buffer.from('{}') },
      { name: `${'d'.repeat(90)}/${'f'.repeat(60)}.txt`, data: Buffer.from('long path') },
    ];
    const a = writeTarGz(entries);
    expect(a.equals(writeTarGz(entries))).toBe(true);
    const back = readTarGz(a);
    expect(back.map((e) => [e.name, e.data.toString(), e.mode])).toEqual(entries.map((e) => [e.name, e.data.toString(), e.mode ?? 0o644]));
  });

  it('SHA256SUMS lines and the check bundle digest comment', () => {
    const text = sha256sums([{ name: 'a.zip', data: Buffer.from('a') }], 'c'.repeat(64));
    expect(text).toBe(`${sha('a')}  a.zip\n# checks-bundle-digest ${'c'.repeat(64)}\n`);
  });
});

describe('inputs', () => {
  it('check bundle: directory name must equal sha256(manifest.json); bin/atl-check required', () => {
    const dir = tmp();
    const manifest = Buffer.from('{"purpose":"atl-checkbundle/v1"}');
    const digest = sha(manifest);
    fs.mkdirSync(path.join(dir, 'checks', digest), { recursive: true });
    fs.writeFileSync(path.join(dir, 'checks', digest, 'manifest.json'), manifest);
    expect(() => loadChecksBundle(dir)).toThrow(/bin\/atl-check/);
    fs.mkdirSync(path.join(dir, 'bin'));
    fs.writeFileSync(path.join(dir, 'bin', 'atl-check'), '#!/bin/bash\n');
    const b = loadChecksBundle(dir)!;
    expect(b.digest).toBe(digest);
    expect(b.entries.find((e) => e.name === 'bin/atl-check')!.mode).toBe(0o755);
    fs.renameSync(path.join(dir, 'checks', digest), path.join(dir, 'checks', 'f'.repeat(64)));
    expect(() => loadChecksBundle(dir)).toThrow(/does not match/);
    expect(loadChecksBundle(undefined)).toBeNull();
  });

  it('placeholders keep a source install working while web and content are not built', () => {
    const web = webZip(undefined);
    expect(web.placeholder).toBe(true);
    expect(readZip(web.zip).map((e) => e.name)).toEqual(['index.html', 'placeholder.css', 'verify/index.html', 'verify/verify.css']);
    const content = contentZip(undefined, '0.1.0');
    expect(content.placeholder).toBe(true);
    const m = JSON.parse(readZip(content.zip).find((e) => e.name === 'manifest.json')!.data.toString());
    expect(m.catalogVersion).toBe(content.catalogVersion);
  });

  it('a content directory without catalogVersion gets one (the contentDigest)', () => {
    const dir = path.join(tmp(), 'abc123');
    fs.mkdirSync(path.join(dir, 'labs'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify({ contentDigest: 'abc123', files: {} }));
    fs.writeFileSync(path.join(dir, 'labs', 'svc-ec2.json'), '{}');
    const c = contentZip(dir, '0.1.0');
    expect(c.catalogVersion).toBe('abc123');
    expect(JSON.parse(readZip(c.zip).find((e) => e.name === 'manifest.json')!.data.toString()).catalogVersion).toBe('abc123');
  });

  it('the runner source includes the buildspec location and the workstation template, never node_modules', () => {
    expect(SOURCE_ROOTS).toEqual(expect.arrayContaining(['platform/workflows/runner', 'platform/workstation/templates', 'infra', 'scripts', 'modules']));
    expect(SOURCE_ROOTS.some((r) => r.includes('node_modules'))).toBe(false);
  });
});

describe('publishing (no AWS call)', () => {
  it('publish plan copies every release file and prints the deploy command for ReleaseVersion=dev', () => {
    const dir = tmp();
    for (const f of ['atl-lambdas.zip', 'SHA256SUMS', TEMPLATE_FILE_NAME, 'release-manifest.json', 'launch-stack.md']) fs.writeFileSync(path.join(dir, f), 'x');
    const plan = publishPlan({ dir, bucket: 'atlv-artifacts-111122223333-apne1', prefix: '/atl/dev/', profile: 'atlv' });
    expect(plan.commands.map((c) => c[4])).toEqual([
      's3://atlv-artifacts-111122223333-apne1/atl/dev/SHA256SUMS',
      's3://atlv-artifacts-111122223333-apne1/atl/dev/atl-lambdas.zip',
      `s3://atlv-artifacts-111122223333-apne1/atl/dev/${TEMPLATE_FILE_NAME}`,
    ]);
    expect(plan.commands[0]).toEqual(expect.arrayContaining(['--profile', 'atlv']));
    expect(plan.deploy).toContain('ArtifactSource=s3 ArtifactBaseUrl=s3://atlv-artifacts-111122223333-apne1/atl/dev ReleaseVersion=dev');
    expect(plan.deploy).toContain('--s3-bucket atlv-artifacts-111122223333-apne1');
    expect(plan.deploy).toContain('CAPABILITY_NAMED_IAM');
    expect(() => publishPlan({ dir, bucket: 'Bad_Bucket', prefix: '' })).toThrow();
  });

  it('Launch Stack links (01 §4.2)', () => {
    const url = launchStackUrl('ap-northeast-1', 'https://b.s3.amazonaws.com/atl/v1.0.0/atl-platform.template.json', 'v1.0.0');
    expect(url).toMatch(/^https:\/\/console\.aws\.amazon\.com\/cloudformation\/home\?region=ap-northeast-1#\/stacks\/quickcreate\?/);
    const q = new URLSearchParams(url.split('quickcreate?')[1]);
    expect(Object.fromEntries(q)).toEqual({
      templateURL: 'https://b.s3.amazonaws.com/atl/v1.0.0/atl-platform.template.json',
      stackName: 'atl',
      param_LearnerEmail: '',
      param_ReleaseVersion: 'v1.0.0',
    });
    const md = launchStackMarkdown({ tag: releaseTag('1.0.0'), config: loadReleaseConfig() });
    for (const r of loadReleaseConfig().verifiedRegions) expect(md).toContain(`region=${r}`);
  });
});

describe('workstation template', () => {
  it('the committed templates/atl-workstation.yaml is current (npm run workstation-template -w @atl/infra)', () => {
    expect(fs.readFileSync(WORKSTATION_TEMPLATE, 'utf8').replace(/\r\n/g, '\n')).toBe(renderWorkstationTemplate());
  });
  it('embeds the user data with only the Fn::Sub references Region, BundleUri, BundleSha256', () => {
    const t = renderWorkstationTemplate();
    const userData = t.slice(t.indexOf('#!/bin/bash'), t.indexOf('- Region:'));
    const refs = [...userData.matchAll(/\$\{([^}]+)\}/g)].map((m) => m[1]);
    expect([...new Set(refs)].sort()).toEqual(['BundleSha256', 'BundleUri', 'Region']);
    expect(t).toContain("Key: 'atl:role', Value: workstation");
    expect(t).toContain('HttpTokens: required');
  });
});
