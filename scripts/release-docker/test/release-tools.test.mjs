// scripts/release-docker/test/release-tools.test.mjs — the release tooling without Docker and without AWS:
//   node --import tsx --test "scripts/release-docker/test/*.test.mjs"
// (tsx loads platform/infra/build/*.ts; `npm run build` first so @atl/shared resolves to its dist).
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import zlib from 'node:zlib';
import { extractUserData, substitute } from '../drill/render-user-data.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'atl-release-'));
const sha = (b) => createHash('sha256').update(b).digest('hex');
const pkg = await import('../../../platform/infra/build/package.ts');
const archive = await import('../../../platform/infra/build/archive.ts');

describe('L0 User Data rendering (drill)', () => {
  const yaml = fs.readFileSync(path.join(ROOT, 'infra', 'modules', 'ec2.yaml'), 'utf8');
  const values = {
    Env: 'drill', 'AWS::Region': 'ap-northeast-1', AppArchiveUrl: 'http://127.0.0.1:8080/a.tgz', AppArchiveSha256: 'f'.repeat(64),
    Eip: '203.0.113.10', AdminEmail: 'admin@example.com', PlatformMode: 'off', 'AWS::StackName': 'cloudalbum-drill-ec2',
  };
  it('extracts the InstanceA stub and substitutes every reference', () => {
    const ud = extractUserData(yaml);
    assert.match(ud, /^#!\/bin\/bash\n/);
    assert.match(ud, /exec bash \/var\/tmp\/l0-bootstrap\.sh all\n$/);
    const out = substitute(ud, values);
    assert.doesNotMatch(out, /\$\{[^}]+\}/);
    assert.match(out, /APP_ARCHIVE_SHA256='f{64}'/);
    assert.equal(extractUserData(yaml, 'InstanceB'), ud, 'both slots use the same stub');
  });
  it('a reference without a value is an error', () => {
    const { Eip: _omit, ...rest } = values;
    assert.throws(() => substitute(extractUserData(yaml), rest), /no value for Eip/);
  });
});

describe('session-manager-plugin pin (build/workstation-tools.json)', () => {
  const config = {
    sessionManagerPlugin: {
      urlTemplate: 'https://s3.amazonaws.com/session-manager-downloads/plugin/{version}/{platform}/session-manager-plugin.rpm',
      platforms: { aarch64: 'linux_arm64', x86_64: 'linux_64bit' },
      pin: { version: null, sha256: { aarch64: null, x86_64: null } },
    },
  };
  it('without a pin: PROTOCOL_COMPAT_VERSION, official URLs, no hashes', () => {
    const s = pkg.ssmPluginSpec({}, config, '1.2.896.0');
    assert.equal(s.version, '1.2.896.0');
    assert.equal(s.versionSource, 'protocol-compat');
    assert.equal(s.urls.aarch64, 'https://s3.amazonaws.com/session-manager-downloads/plugin/1.2.896.0/linux_arm64/session-manager-plugin.rpm');
    assert.equal(s.urls.x86_64, 'https://s3.amazonaws.com/session-manager-downloads/plugin/1.2.896.0/linux_64bit/session-manager-plugin.rpm');
    assert.deepEqual(s.sha256, { aarch64: null, x86_64: null });
  });
  it('a pin carries its own version; hashes are never reused for another version', () => {
    const pinned = structuredClone(config);
    pinned.sessionManagerPlugin.pin = { version: '1.2.889.0', sha256: { aarch64: 'a'.repeat(64), x86_64: 'b'.repeat(64) } };
    const s = pkg.ssmPluginSpec({}, pinned, '1.2.896.0');
    assert.equal(s.version, '1.2.889.0');
    assert.equal(s.sha256.aarch64, 'a'.repeat(64));
    const other = pkg.ssmPluginSpec({ version: '1.2.896.0', sha256: { arm64: 'c'.repeat(64) } }, pinned, '1.2.896.0');
    assert.deepEqual(other.sha256, { aarch64: 'c'.repeat(64), x86_64: null });
    assert.throws(() => pkg.ssmPluginSpec({ sha256: { arm64: 'XYZ' } }, config, '1.2.896.0'), /64 lowercase hex/);
    assert.throws(() => pkg.ssmPluginSpec({ sha256: { sparc: 'a'.repeat(64) } }, config, '1.2.896.0'), /unknown architecture/);
  });
  it('the committed config is valid and the version follows platform/ssm-client', () => {
    const s = pkg.ssmPluginSpec();
    assert.equal(s.version, pkg.protocolCompatVersion() ?? s.version);
    assert.ok(Object.values(s.urls).every((u) => u.startsWith('https://')));
  });
});

describe('archives from system tar and the runner node_modules', () => {
  // GNU tar writes `././@LongLink` (type L) records for names over 100 bytes
  const header = (name, size, type) => {
    const h = Buffer.alloc(512, 0);
    h.write(name, 0, 'utf8');
    h.write('0000644\0', 100); h.write('0000000\0', 108); h.write('0000000\0', 116);
    h.write(size.toString(8).padStart(11, '0') + '\0', 124); h.write('00000000000\0', 136);
    h.fill(' ', 148, 156); h.write(type, 156); h.write('ustar  \0', 257);
    let s = 0; for (const b of h) s += b;
    h.write(s.toString(8).padStart(6, '0') + '\0 ', 148);
    return h;
  };
  const gnuTarGz = (entries) => {
    const parts = [];
    const pad = (n) => Buffer.alloc((512 - (n % 512)) % 512, 0);
    for (const [name, text, type = '0'] of entries) {
      const data = Buffer.from(text);
      if (name.length > 99) { const n = Buffer.from(name + '\0'); parts.push(header('././@LongLink', n.length, 'L'), n, pad(n.length)); }
      parts.push(header(name.slice(0, 99), data.length, type), data, pad(data.length));
    }
    parts.push(Buffer.alloc(1024));
    return zlib.gzipSync(Buffer.concat(parts));
  };
  it('readTarGz follows GNU long names and skips links and directories', () => {
    const long = `node_modules/@aws-sdk/client-cloudformation/dist-cjs/${'x'.repeat(70)}.js`;
    const e = archive.readTarGz(gnuTarGz([['node_modules/', '', '5'], [long, 'L'], ['node_modules/.bin/tsx', '', '2'], ['node_modules/a/index.js', 'A']]));
    assert.deepEqual(e.map((x) => x.name), [long, 'node_modules/a/index.js']);
  });
  it('runner node_modules drop .bin, type declarations and source maps', () => {
    const f = path.join(tmp(), 'nm.tar.gz');
    fs.writeFileSync(f, gnuTarGz([['node_modules/commander/index.js', 'c'], ['node_modules/commander/typings/index.d.ts', 't'],
      ['node_modules/yaml/dist/index.js.map', 'm'], ['node_modules/.bin/x', 'b'], ['other/file', 'o']]));
    assert.deepEqual(pkg.runnerNodeModules(f).map((e) => e.name), ['node_modules/commander/index.js']);
  });
  it('appArchiveManifest reads .release-manifest.json of a scripts/release archive', () => {
    const f = path.join(tmp(), 'cloudalbum-1-arm64.tgz');
    fs.writeFileSync(f, gnuTarGz([['cloudalbum-1-arm64/VERSION', '1\n'], ['cloudalbum-1-arm64/.release-manifest.json', JSON.stringify({ arch: 'arm64', atlBundleDigest: 'd'.repeat(64) })]]));
    assert.equal(pkg.appArchiveManifest(f).atlBundleDigest, 'd'.repeat(64));
  });
});

describe('workstation bundle', () => {
  it('ships the installer, records the plugin download and keeps k6 optional', async () => {
    const nm = path.join(tmp(), 'cloudalbum-node_modules-linux-arm64.tar.gz');
    fs.writeFileSync(nm, zlib.gzipSync(Buffer.alloc(1024)));
    fs.writeFileSync(`${nm}.json`, JSON.stringify({ arch: 'arm64', node: 'v22.0.0', source: 'ignored' }));
    const spec = pkg.ssmPluginSpec({ version: '1.2.896.0', sha256: { aarch64: 'a'.repeat(64) } });
    const { tarball, manifest } = await pkg.workstationBundle({ checks: null, ssmPlugin: spec, nodeModulesDir: nm, version: '0.0.0-test' });
    const names = archive.readTarGz(tarball).map((e) => e.name);
    for (const n of ['manifest.json', 'atl-ws-install.sh', 'atl-install-node-modules.sh', 'cloudalbum-node_modules.tar.gz', 'cloudalbum-src.tar.gz']) assert.ok(names.includes(n), n);
    assert.ok(!names.includes('session-manager-plugin.rpm'));
    assert.equal(manifest.tools.sessionManagerPlugin.source, 'download');
    assert.equal(manifest.tools.sessionManagerPlugin.sha256.aarch64, 'a'.repeat(64));
    assert.deepEqual(manifest.tools.k6, { source: 'none', optional: true });
    assert.equal(manifest.nodeModulesInfo.source, 'prebuilt');
    assert.equal(manifest.nodeModulesInfo.arch, 'arm64');
    assert.deepEqual(manifest.missing, ['atl-checks.tar.gz']);
    const inst = archive.readTarGz(tarball).find((e) => e.name === 'atl-ws-install.sh');
    assert.equal(inst.mode, 0o755);
    assert.equal(manifest.files.find((f) => f.name === 'atl-ws-install.sh').sha256, sha(inst.data));
  });
});

describe('shell scripts', () => {
  const bash = spawnSync('bash', ['--version'], { encoding: 'utf8' });
  const scripts = ['scripts/release', 'scripts/release-docker/build.sh', 'scripts/release-docker/in-container.sh', 'scripts/release-docker/drill.sh',
    'scripts/release-docker/drill/run-drill.sh', 'scripts/release-docker/pin-ssm-plugin.sh', 'platform/workstation/bootstrap/user-data.sh',
    'platform/workstation/bootstrap/install.sh', 'platform/workstation/bootstrap/install-node-modules.sh'];
  it('parse with bash -n and use LF line endings', { skip: bash.status !== 0 && 'bash is not available' }, () => {
    for (const s of scripts) {
      const text = fs.readFileSync(path.join(ROOT, s), 'utf8');
      assert.ok(!text.includes('\r'), `${s} has CR line endings`);
      const r = spawnSync('bash', ['-n', s], { cwd: ROOT, encoding: 'utf8' });
      assert.equal(r.status, 0, `${s}: ${r.stderr}`);
    }
  });
  it('the workstation user data only verifies and hands over to the bundle installer', () => {
    const ud = fs.readFileSync(path.join(ROOT, 'platform/workstation/bootstrap/user-data.sh'), 'utf8');
    assert.match(ud, /sha256sum -c -/);
    assert.match(ud, /bash "\$W\/atl-ws-install\.sh" "\$W"/);
    const install = fs.readFileSync(path.join(ROOT, 'platform/workstation/bootstrap/install.sh'), 'utf8');
    assert.match(install, /not installing an unverified binary/);
    assert.match(install, /--proto "\$proto"/);
    const code = install.split('\n').filter((l) => !/^\s*#/.test(l)).join('\n');
    assert.doesNotMatch(code, /\baws (s3|ssm|sts) /, 'the installer makes no AWS CLI call');
  });
});
