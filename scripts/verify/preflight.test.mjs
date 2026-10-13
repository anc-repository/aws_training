// scripts/verify/preflight.test.mjs — node --test scripts/verify (no AWS call: the AWS CLI path used here does not exist,
// and --online is exercised only through its allowlist).
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';
import zlib from 'node:zlib';
import {
  assertReadOnly, checkArtifacts, checkEnvironment, credentialSource, parseIni, parseSums, readTarGz, readZip, Report,
} from './preflight.mjs';

const sha = (b) => createHash('sha256').update(b).digest('hex');
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'atl-preflight-'));

// --- tiny writers for synthetic artifacts (ustar with GNU long names; ZIP stored) ---------------------------------------
function tarHeader(name, size, type = '0', mode = 0o644) {
  const h = Buffer.alloc(512, 0);
  h.write(name.slice(0, 100), 0, 'utf8');
  h.write(mode.toString(8).padStart(7, '0') + '\0', 100, 'ascii');
  h.write('0000000\0', 108, 'ascii');
  h.write('0000000\0', 116, 'ascii');
  h.write(size.toString(8).padStart(11, '0') + '\0', 124, 'ascii');
  h.write('00000000000\0', 136, 'ascii');
  h.fill(' ', 148, 156);
  h.write(type, 156, 'ascii');
  h.write('ustar  \0', 257, 'ascii'); // GNU magic
  let sum = 0;
  for (const b of h) sum += b;
  h.write(sum.toString(8).padStart(6, '0') + '\0 ', 148, 'ascii');
  return h;
}
function tarGz(entries) {
  const parts = [];
  const pad = (n) => Buffer.alloc((512 - (n % 512)) % 512, 0);
  for (const { name, data } of entries) {
    if (Buffer.byteLength(name) > 99) {
      const n = Buffer.from(name + '\0');
      parts.push(tarHeader('././@LongLink', n.length, 'L'), n, pad(n.length));
    }
    parts.push(tarHeader(name, data.length), data, pad(data.length));
  }
  parts.push(Buffer.alloc(1024, 0));
  return zlib.gzipSync(Buffer.concat(parts));
}
function zip(entries) {
  const locals = [];
  const central = [];
  let off = 0;
  for (const { name, data, mode = 0o644 } of entries) {
    const n = Buffer.from(name);
    const l = Buffer.alloc(30);
    l.writeUInt32LE(0x04034b50, 0); l.writeUInt16LE(20, 4); l.writeUInt32LE(data.length, 18); l.writeUInt32LE(data.length, 22); l.writeUInt16LE(n.length, 26);
    const c = Buffer.alloc(46);
    c.writeUInt32LE(0x02014b50, 0); c.writeUInt16LE(0x0314, 4); c.writeUInt16LE(20, 6); c.writeUInt32LE(data.length, 20); c.writeUInt32LE(data.length, 24);
    c.writeUInt16LE(n.length, 28); c.writeUInt32LE(((mode | 0o100000) << 16) >>> 0, 38); c.writeUInt32LE(off, 42);
    locals.push(l, n, data);
    central.push(c, n);
    off += 30 + n.length + data.length;
  }
  const cd = Buffer.concat(central);
  const e = Buffer.alloc(22);
  e.writeUInt32LE(0x06054b50, 0); e.writeUInt16LE(entries.length, 8); e.writeUInt16LE(entries.length, 10); e.writeUInt32LE(cd.length, 12); e.writeUInt32LE(off, 16);
  return Buffer.concat([...locals, cd, e]);
}
const B = (s) => Buffer.from(typeof s === 'string' ? s : JSON.stringify(s));

/** A release directory shaped like build/package.ts output. */
function syntheticRelease({ appDigest, pinned = true } = {}) {
  const dir = tmp();
  const digest = 'a'.repeat(64);
  const natives = (m) => [
    { path: 'node_modules/better-sqlite3/build/Release/better_sqlite3.node', machine: m },
    { path: `node_modules/@img/sharp-linux-${m === 'aarch64' ? 'arm64' : 'x64'}/lib/sharp.node`, machine: m },
    { path: `node_modules/@node-rs/argon2-linux-${m === 'aarch64' ? 'arm64' : 'x64'}-gnu/argon2.node`, machine: m },
  ];
  const app = (arch, m) => tarGz([
    { name: `cloudalbum-1.0.0-${arch}/VERSION`, data: B('1.0.0\n') },
    { name: `cloudalbum-1.0.0-${arch}/.release-manifest.json`, data: B({ arch, version: '1.0.0', atlBundleDigest: appDigest ?? digest, nativeModules: natives(m), build: { node: 'v22.0.0' } }) },
  ]);
  const files = {
    'atl-web.zip': zip([{ name: 'index.html', data: B('<!doctype html><title>ATL</title>') }]),
    'atl-content.zip': zip([{ name: 'manifest.json', data: B({ catalogVersion: 'c1' }) }]),
    'cloudalbum-app-arm64.tar.gz': app('arm64', 'aarch64'),
    'cloudalbum-app-x86_64.tar.gz': app('x86_64', 'x86_64'),
  };
  const inner = [
    { name: 'scripts/module', data: B('#!/bin/bash\n'), mode: 0o755 },
    ...['scripts/module-cli/dist/index.js', 'platform/workflows/runner/buildspec.yml', 'platform/workflows/runner/dist/atl-runner.mjs',
      'platform/workstation/templates/atl-workstation.yaml', 'infra/userdata/l0-bootstrap.sh', `atl/checks/${digest}/manifest.json`,
      'cloudalbum-1.0.0-arm64.tgz', 'cloudalbum-1.0.0-x86_64.tgz', 'node_modules/commander/package.json', 'node_modules/yaml/package.json',
      'node_modules/@aws-sdk/client-cloudformation/package.json', 'node_modules/@cloudalbum/contracts/package.json',
      'node_modules/@node-rs/argon2-linux-arm64-gnu/argon2.linux-arm64-gnu.node'].map((name) => ({ name, data: B(name) })),
  ];
  inner.push({ name: 'SHA256SUMS', data: B(inner.map((e) => `${sha(e.data)}  ${e.name}`).join('\n') + '\n') });
  files['cloudalbum-infra.zip'] = zip(inner);
  const wsFiles = ['atl-ws-install.sh', 'atl-workstation-setup.sh', 'atl-agent-call', 'cloudalbum-src.tar.gz', 'atl-checks.tar.gz', 'cloudalbum-node_modules.tar.gz']
    .map((name) => ({ name, data: B(`content of ${name}`) }));
  const wsManifest = {
    files: wsFiles.map((f) => ({ name: f.name, sha256: sha(f.data) })), checksBundleDigest: digest,
    tools: { sessionManagerPlugin: { source: 'download', version: '1.2.896.0', sha256: { aarch64: pinned ? 'b'.repeat(64) : null, x86_64: null } }, k6: { source: 'none', optional: true } },
    nodeModulesInfo: { source: 'prebuilt', arch: 'arm64', node: 'v22.0.0' },
  };
  files['atl-workstation.tar.gz'] = tarGz([{ name: 'manifest.json', data: B(wsManifest) }, ...wsFiles]);
  const manifest = { Files: Object.entries(files).map(([Name, d]) => ({ Name, Sha256: sha(d), Size: d.length })), ChecksBundleDigest: digest };
  files['atl-platform.template.json'] = B({ Resources: { CopyArtifacts: { Properties: { Manifest: manifest } } } });
  for (const [n, d] of Object.entries(files)) fs.writeFileSync(path.join(dir, n), d);
  fs.writeFileSync(path.join(dir, 'SHA256SUMS'), Object.entries(files).map(([n, d]) => `${sha(d)}  ${n}`).join('\n') + `\n# checks-bundle-digest ${digest}\n`);
  fs.writeFileSync(path.join(dir, 'release-manifest.json'), JSON.stringify(manifest));
  return dir;
}
const statusOf = (rep, id) => rep.results.find((r) => r.id === id)?.status;

describe('artifacts', () => {
  it('a consistent release passes every artifact check', () => {
    const rep = new Report();
    checkArtifacts(rep, syntheticRelease());
    const fails = rep.results.filter((r) => r.status === 'fail');
    assert.deepEqual(fails, []);
    for (const id of ['sha256sums', 'template-manifest', 'checks-digest', 'app-arm64', 'app-x86_64', 'infra-zip', 'runner-node-modules', 'workstation', 'ssm-plugin', 'ws-node-modules', 'web', 'content']) {
      assert.equal(statusOf(rep, id), 'pass', id);
    }
  });
  it('a modified file fails SHA256SUMS and the embedded manifest', () => {
    const dir = syntheticRelease();
    fs.appendFileSync(path.join(dir, 'atl-web.zip'), 'x');
    const rep = new Report();
    checkArtifacts(rep, dir);
    assert.equal(statusOf(rep, 'sha256sums'), 'fail');
    assert.equal(statusOf(rep, 'template-manifest'), 'fail');
  });
  it('an app archive with another check bundle fails (the lab instance would not find the checks)', () => {
    const rep = new Report();
    checkArtifacts(rep, syntheticRelease({ appDigest: 'c'.repeat(64) }));
    assert.equal(statusOf(rep, 'app-arm64'), 'fail');
    assert.match(rep.results.find((r) => r.id === 'app-arm64').detail, /atlBundleDigest/);
  });
  it('an unpinned session-manager-plugin is a warning with the pin command', () => {
    const rep = new Report();
    checkArtifacts(rep, syntheticRelease({ pinned: false }));
    const r = rep.results.find((x) => x.id === 'ssm-plugin');
    assert.equal(r.status, 'warn');
    assert.match(r.hint, /pin-ssm-plugin\.sh 1\.2\.896\.0/);
  });
  it('no release directory is a failure with the build command', () => {
    const rep = new Report();
    checkArtifacts(rep, path.join(tmp(), 'nothing'));
    assert.equal(statusOf(rep, 'release-dir'), 'fail');
  });
});

describe('readers', () => {
  it('tar.gz with GNU long names, ZIP stored entries, SHA256SUMS comments', () => {
    const long = `${'d'.repeat(80)}/${'f'.repeat(60)}.json`;
    const t = readTarGz(tarGz([{ name: 'a.txt', data: B('A') }, { name: long, data: B('L') }]));
    assert.deepEqual(t.map((e) => [e.name, e.data.toString()]), [['a.txt', 'A'], [long, 'L']]);
    assert.equal(readTarGz(tarGz([{ name: 'x/y', data: B('1') }, { name: 'x/.release-manifest.json', data: B('2') }]), { stopAt: (n) => n.endsWith('.release-manifest.json') })[0].data.toString(), '2');
    const z = readZip(zip([{ name: 'bin/run', data: B('#!'), mode: 0o755 }]));
    assert.equal(z[0].mode, 0o755);
    const s = parseSums(`${'0'.repeat(64)}  a.zip\n# checks-bundle-digest ${'1'.repeat(64)}\n`);
    assert.equal(s.files[0].name, 'a.zip');
    assert.equal(s.comments['checks-bundle-digest'], '1'.repeat(64));
  });
});

describe('environment (local only)', () => {
  it('credentials: environment, IAM Identity Center, role, keys, none', () => {
    const config = parseIni('[default]\nregion = ap-northeast-1\n[profile sso]\nsso_session = corp\nregion = ap-northeast-1\n[profile role]\nrole_arn = arn:aws:iam::111122223333:role/Admin\nsource_profile = sso\n[sso-session corp]\nsso_start_url = https://example.awsapps.com/start\n');
    const credentials = parseIni('[keys]\naws_access_key_id = AKIAEXAMPLE\naws_secret_access_key = x\n');
    assert.equal(credentialSource({ env: { AWS_ACCESS_KEY_ID: 'a', AWS_SECRET_ACCESS_KEY: 'b' }, profile: 'default', config, credentials }).kind, 'environment');
    assert.equal(credentialSource({ env: {}, profile: 'sso', config, credentials }).kind, 'sso');
    assert.equal(credentialSource({ env: {}, profile: 'role', config, credentials }).kind, 'assume-role');
    assert.equal(credentialSource({ env: {}, profile: 'keys', config, credentials }).kind, 'shared-credentials');
    assert.equal(credentialSource({ env: {}, profile: 'default', config, credentials }).kind, 'none');
  });
  it('without an AWS CLI and without credentials the failures say what to do', () => {
    const home = tmp();
    const rep = new Report();
    const ctx = checkEnvironment(rep, { env: { PATH: '' }, home, awsBin: path.join(home, 'no-such-aws') });
    assert.equal(statusOf(rep, 'aws-cli'), 'fail');
    const cred = rep.results.find((r) => r.id === 'credentials');
    assert.equal(cred.status, 'fail');
    assert.match(cred.hint, /aws configure sso/);
    assert.equal(statusOf(rep, 'region'), 'fail');
    assert.equal(ctx.credentialKind, 'none');
  });
  it('the region comes from the profile and is compared with the verified regions', () => {
    const home = tmp();
    fs.mkdirSync(path.join(home, '.aws'));
    fs.writeFileSync(path.join(home, '.aws', 'config'), '[profile atl]\nsso_session = s\nregion = us-west-2\n');
    const rep = new Report();
    checkEnvironment(rep, { env: { PATH: '' }, home, profile: 'atl', awsBin: path.join(home, 'no-such-aws') });
    assert.equal(statusOf(rep, 'credentials'), 'pass');
    assert.equal(statusOf(rep, 'region'), 'warn');
  });
  it('--online may only run read-only operations', () => {
    for (const ok of [['sts', 'get-caller-identity'], ['ec2', 'describe-vpcs'], ['cloudformation', 'describe-stacks']]) assertReadOnly(ok);
    for (const bad of [['cloudformation', 'create-stack'], ['cloudformation', 'deploy'], ['ec2', 'run-instances'], ['s3', 'cp'], ['iam', 'create-role'], ['sts', 'assume-role']]) {
      assert.throws(() => assertReadOnly(bad), /refusing/);
    }
  });
});
