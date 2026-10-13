#!/usr/bin/env node
// scripts/verify/preflight.mjs — read-only checks before a real deployment (01 §4.1, §4.5, §4.9; 07 V0 / V5-1).
//
//   node scripts/verify/preflight.mjs [--release-dir <dir>] [--profile <name>] [--region <region>]
//        [--artifacts-only] [--cfn-lint] [--online] [--strict] [--json]
//
// Local environment (skipped with --artifacts-only): Node.js, `aws --version` (AWS CLI v2), the CLI config / credentials
// files, where credentials would come from for the profile (inspected locally; no secret is printed), the default region and
// whether it is a verified region (platform/infra/release.config.json), cfn-lint, and whether the release was built from the
// current commit.
// Artifacts (--release-dir, default: the newest dist/release/v*/ with a SHA256SUMS): every SHA256SUMS line, the manifest
// embedded in the template (CopyArtifacts) against the files, the check bundle digest across the platform release and every
// CloudAlbum archive (.release-manifest.json atlBundleDigest), the native modules of each archive for its architecture,
// cloudalbum-infra.zip's own SHA256SUMS and what the runner needs inside it, the workstation bundle (per-file SHA-256,
// session-manager-plugin download pin, k6 optional, node_modules), placeholder web / content packages.
//
// AWS: nothing is called unless --online is given; then only read-only calls run (sts get-caller-identity, ec2 describe-vpcs
// for the default VPC, cloudformation describe-stacks for an existing `atl` stack), through an allowlist that refuses any
// other operation. --cfn-lint runs cfn-lint on the release template (local). Exit code: 0 no failure (warnings allowed;
// --strict turns warnings into failures), 1 failures, 2 usage.
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import zlib from 'node:zlib';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = path.resolve(HERE, '..', '..');

// ---------------------------------------------------------------------------------------------------------------------
// small helpers (exported for the tests)

export const sha256 = (buf) => createHash('sha256').update(buf).digest('hex');

/** Regular files of a .tar.gz (ustar, GNU long names, pax `path`); `stopAt(name)` returns the first match only. */
export function readTarGz(buf, { stopAt } = {}) {
  const tar = zlib.gunzipSync(buf);
  const out = [];
  const str = (b) => b.toString('utf8').replace(/\0.*$/s, '');
  let p = 0;
  let longName;
  let paxPath;
  while (p + 512 <= tar.length) {
    const h = tar.subarray(p, p + 512);
    if (h.every((b) => b === 0)) break;
    const magic = h.subarray(257, 263).toString('ascii');
    const prefix = magic === 'ustar\0' ? str(h.subarray(345, 500)) : '';
    const sizeField = h.subarray(124, 136);
    const size = sizeField[0] & 0x80 ? Number(sizeField.subarray(4).readBigUInt64BE(0)) : parseInt(str(sizeField).trim() || '0', 8);
    const mode = parseInt(str(h.subarray(100, 108)).trim() || '0', 8);
    const type = String.fromCharCode(h[156]);
    const base = str(h.subarray(0, 100));
    p += 512;
    const data = tar.subarray(p, p + size);
    p += Math.ceil(size / 512) * 512;
    if (type === 'L') { longName = str(Buffer.from(data)); continue; }
    if (type === 'x') { for (const m of data.toString('utf8').matchAll(/^\d+ path=(.*)$/gm)) paxPath = m[1]; continue; }
    if (type === 'g' || type === 'K') continue;
    const name = (paxPath ?? longName ?? (prefix ? `${prefix}/${base}` : base)).replace(/^\.\//, '');
    longName = undefined;
    paxPath = undefined;
    if (type !== '0' && type !== '\0' && type !== '7') continue;
    if (stopAt) { if (stopAt(name)) return [{ name, data: Buffer.from(data), mode }]; continue; }
    out.push({ name, data: Buffer.from(data), mode });
  }
  return out;
}

/** Entries of a ZIP (stored / deflated, no ZIP64): [{ name, data, mode }]. */
export function readZip(buf) {
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 65557); i--) if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  if (eocd < 0) throw new Error('not a ZIP file (no end of central directory)');
  const count = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16);
  const out = [];
  for (let n = 0; n < count; n++) {
    if (buf.readUInt32LE(p) !== 0x02014b50) throw new Error('corrupt ZIP central directory');
    const method = buf.readUInt16LE(p + 10);
    const csize = buf.readUInt32LE(p + 20);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    const attrs = buf.readUInt32LE(p + 38);
    const local = buf.readUInt32LE(p + 42);
    const name = buf.subarray(p + 46, p + 46 + nameLen).toString('utf8');
    p += 46 + nameLen + extraLen + commentLen;
    const lStart = local + 30 + buf.readUInt16LE(local + 26) + buf.readUInt16LE(local + 28);
    const raw = buf.subarray(lStart, lStart + csize);
    if (name.endsWith('/')) continue;
    const data = method === 0 ? Buffer.from(raw) : method === 8 ? zlib.inflateRawSync(raw) : null;
    if (!data) throw new Error(`${name}: unsupported ZIP method ${method}`);
    out.push({ name, data, mode: (attrs >>> 16) & 0o777 });
  }
  return out;
}

/** `<sha256>  <name>` lines (comments `# key value` collected separately). */
export function parseSums(text) {
  const files = [];
  const comments = {};
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim()) continue;
    const c = /^#\s*(\S+)\s+(.*)$/.exec(line);
    if (c) { comments[c[1]] = c[2].trim(); continue; }
    const m = /^([0-9a-f]{64}) [ *](.+)$/.exec(line);
    if (m) files.push({ sha256: m[1], name: m[2] });
    else files.push({ invalid: line });
  }
  return { files, comments };
}

/** Minimal INI reader for ~/.aws/config and ~/.aws/credentials (section → key → value). */
export function parseIni(text) {
  const out = {};
  let cur = null;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.replace(/^\s+/, '');
    if (!line || line.startsWith('#') || line.startsWith(';')) continue;
    const s = /^\[([^\]]+)\]/.exec(line);
    if (s) { cur = s[1].trim(); out[cur] ??= {}; continue; }
    const kv = /^([^=]+?)\s*=\s*(.*)$/.exec(line);
    if (kv && cur !== null && !/^\s/.test(raw)) out[cur][kv[1].trim().toLowerCase()] = kv[2].trim();
  }
  return out;
}

/** Where credentials for `profile` would come from, judged from the environment and the files only (nothing is called). */
export function credentialSource({ env, profile, config, credentials }) {
  if (env.AWS_ACCESS_KEY_ID && env.AWS_SECRET_ACCESS_KEY) return { kind: 'environment', detail: 'AWS_ACCESS_KEY_ID / AWS_SECRET_ACCESS_KEY' };
  if (env.AWS_WEB_IDENTITY_TOKEN_FILE && env.AWS_ROLE_ARN) return { kind: 'web-identity', detail: 'AWS_WEB_IDENTITY_TOKEN_FILE' };
  if (env.AWS_CONTAINER_CREDENTIALS_FULL_URI || env.AWS_CONTAINER_CREDENTIALS_RELATIVE_URI) return { kind: 'container', detail: 'container credentials endpoint' };
  const cfg = config[profile === 'default' ? 'default' : `profile ${profile}`] ?? (profile === 'default' ? undefined : config[profile]);
  const cred = credentials[profile];
  if (cfg?.sso_session || cfg?.sso_start_url) return { kind: 'sso', detail: `IAM Identity Center (sso_session ${cfg.sso_session ?? cfg.sso_start_url})` };
  if (cfg?.credential_process) return { kind: 'process', detail: 'credential_process' };
  if (cfg?.role_arn && (cfg.source_profile || cfg.credential_source)) return { kind: 'assume-role', detail: `role ${cfg.role_arn} via ${cfg.source_profile ? `profile ${cfg.source_profile}` : cfg.credential_source}` };
  if (cred?.aws_access_key_id) return { kind: 'shared-credentials', detail: 'aws_access_key_id in the credentials file' };
  if (cfg?.aws_access_key_id) return { kind: 'config-keys', detail: 'aws_access_key_id in the config file' };
  if (cfg?.login_session) return { kind: 'console-login', detail: 'aws login session' };
  return { kind: 'none', detail: '' };
}

/** Read-only AWS CLI operations --online may run; anything else is refused before a process starts. */
export const READ_ONLY_AWS = new Set(['sts get-caller-identity', 'ec2 describe-vpcs', 'cloudformation describe-stacks']);

export function assertReadOnly(args) {
  const op = `${args[0] ?? ''} ${args[1] ?? ''}`;
  if (!READ_ONLY_AWS.has(op)) throw new Error(`preflight: refusing AWS CLI operation "${op}" (only ${[...READ_ONLY_AWS].join(', ')})`);
}

function run(cmd, args, opts = {}) {
  const r = spawnSync(cmd, args, { encoding: 'utf8', timeout: opts.timeout ?? 30000, env: opts.env ?? process.env, shell: false, windowsHide: true });
  // ENOENT: not installed; EINVAL: a .cmd shim Node refuses to start without a shell — both mean "not usable here"
  if (r.error && ['ENOENT', 'EINVAL', 'EACCES'].includes(r.error.code)) return { missing: true, code: null, stdout: '', stderr: '' };
  return { missing: false, code: r.status, stdout: (r.stdout ?? '').trim(), stderr: (r.stderr ?? '').trim(), error: r.error };
}

/** On Windows the AWS CLI and a pip-installed cfn-lint are .exe files; no shell is ever used. */
function runTool(name, args, opts) {
  let r = run(name, args, opts);
  if (r.missing && process.platform === 'win32' && !name.endsWith('.exe')) r = run(`${name}.exe`, args, opts);
  return r;
}

// ---------------------------------------------------------------------------------------------------------------------
// result collection

export class Report {
  constructor() { this.results = []; }
  add(group, id, status, detail, hint) { this.results.push({ group, id, status, detail, ...(hint ? { hint } : {}) }); }
  pass(g, id, d) { this.add(g, id, 'pass', d); }
  warn(g, id, d, h) { this.add(g, id, 'warn', d, h); }
  fail(g, id, d, h) { this.add(g, id, 'fail', d, h); }
  skip(g, id, d) { this.add(g, id, 'skip', d); }
  info(g, id, d) { this.add(g, id, 'info', d); }
  count(s) { return this.results.filter((r) => r.status === s).length; }
}

// ---------------------------------------------------------------------------------------------------------------------
// local environment

function releaseConfig() {
  try { return JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'platform', 'infra', 'release.config.json'), 'utf8')); } catch { return null; }
}

export function checkEnvironment(rep, opts) {
  const G = 'environment';
  const env = opts.env ?? process.env;
  const [maj, min] = process.versions.node.split('.').map(Number);
  if (maj > 22 || (maj === 22 && min >= 12)) rep.pass(G, 'node', `Node.js ${process.version}`);
  else rep.fail(G, 'node', `Node.js ${process.version}`, 'the repository needs Node.js >= 22.12 (package.json engines)');

  const aws = runTool(opts.awsBin ?? 'aws', ['--version'], { env });
  let awsOk = false;
  if (aws.missing) rep.fail(G, 'aws-cli', 'aws is not on PATH', 'install AWS CLI v2 (https://docs.aws.amazon.com/cli/latest/userguide/getting-started-install.html)');
  else {
    const line = (aws.stdout || aws.stderr).split(/\r?\n/)[0] ?? '';
    const v = /aws-cli\/(\d+)\.(\d+)\.(\d+)/.exec(line);
    if (!v) rep.warn(G, 'aws-cli', `unrecognised \`aws --version\` output: ${line.slice(0, 120)}`);
    else if (Number(v[1]) < 2) rep.fail(G, 'aws-cli', line, 'AWS CLI v1 is not supported: install AWS CLI v2');
    else { rep.pass(G, 'aws-cli', line); awsOk = true; }
  }

  const home = opts.home ?? os.homedir();
  const configFile = env.AWS_CONFIG_FILE || path.join(home, '.aws', 'config');
  const credFile = env.AWS_SHARED_CREDENTIALS_FILE || path.join(home, '.aws', 'credentials');
  const read = (f) => (fs.existsSync(f) ? fs.readFileSync(f, 'utf8') : null);
  const configText = read(configFile);
  const credText = read(credFile);
  const config = configText ? parseIni(configText) : {};
  const credentials = credText ? parseIni(credText) : {};
  const profile = opts.profile || env.AWS_PROFILE || env.AWS_DEFAULT_PROFILE || 'default';
  const profiles = [...new Set([...Object.keys(config).map((k) => k.replace(/^profile\s+/, '')).filter((k) => !k.startsWith('sso-session ')), ...Object.keys(credentials)])];
  if (configText !== null) rep.pass(G, 'aws-config-file', `${configFile} (profiles: ${profiles.join(', ') || 'none'})`);
  else rep.warn(G, 'aws-config-file', `${configFile} does not exist`, 'aws configure sso --profile <name> (or aws configure) creates it');
  if (credText !== null) rep.info(G, 'aws-credentials-file', `${credFile} exists`);
  else rep.info(G, 'aws-credentials-file', `${credFile} does not exist (not needed with IAM Identity Center)`);

  const src = credentialSource({ env, profile, config, credentials });
  if (src.kind === 'none') {
    rep.fail(G, 'credentials', `no credentials configured for profile "${profile}"`,
      `没有找到凭证：用 \`aws configure sso --profile ${profile === 'default' ? 'atl-admin' : profile}\` 配置 IAM Identity Center（推荐），` +
      `登录过期时 \`aws sso login --profile <name>\`；然后 AWS_PROFILE=<name> 或 --profile <name> 再运行本检查。` +
      'No credentials: configure a profile (IAM Identity Center recommended), then re-run with --profile. Never paste access keys into scripts or chats (01 §4.9).');
  } else if (src.kind === 'shared-credentials' || src.kind === 'config-keys' || src.kind === 'environment') {
    rep.warn(G, 'credentials', `profile "${profile}": ${src.kind} (${src.detail})`, 'long-term access keys work, but IAM Identity Center / role profiles are preferred (01 §4.9); never share them');
  } else rep.pass(G, 'credentials', `profile "${profile}": ${src.kind} (${src.detail}) — validity is only known online (--online)`);

  const cfg = config[profile === 'default' ? 'default' : `profile ${profile}`] ?? {};
  const region = opts.region || env.AWS_REGION || env.AWS_DEFAULT_REGION || cfg.region || '';
  const verified = releaseConfig()?.verifiedRegions ?? [];
  if (!region) rep.fail(G, 'region', `no default region for profile "${profile}"`, `aws configure set region ${verified[0] ?? 'ap-northeast-1'} --profile ${profile}, or AWS_REGION / --region`);
  else if (verified.length && !verified.includes(region)) rep.warn(G, 'region', `${region} is not a verified region (${verified.join(', ')})`, 'the template Rule VerifiedRegion rejects it (01 §4.2)');
  else rep.pass(G, 'region', `${region}${verified.includes(region) ? ' (verified)' : ''}`);

  const lintBin = env.ATL_CFN_LINT || 'cfn-lint';
  const lint = runTool(lintBin, ['--version'], { env });
  if (lint.missing) rep.warn(G, 'cfn-lint', `${lintBin} not found`, 'pip install cfn-lint (or ATL_CFN_LINT=<path>); npm run cfn-lint -w @atl/infra uses it');
  else if (lint.code !== 0) rep.warn(G, 'cfn-lint', `${lintBin} --version exited ${lint.code}: ${(lint.stderr || lint.stdout).split(/\r?\n/)[0]}`);
  else rep.pass(G, 'cfn-lint', (lint.stdout || lint.stderr).split(/\r?\n/)[0]);

  const head = run('git', ['-C', REPO_ROOT, 'rev-parse', 'HEAD']);
  if (head.code === 0) {
    const dirty = run('git', ['-C', REPO_ROOT, 'status', '--porcelain', '--untracked-files=no']);
    rep.info(G, 'git', `HEAD ${head.stdout.slice(0, 12)}${dirty.stdout ? ' (uncommitted changes in the working tree)' : ''}`);
  }
  return { profile, region, awsOk, credentialKind: src.kind, head: head.code === 0 ? head.stdout : null };
}

export function checkOnline(rep, opts, ctx) {
  const G = 'aws (read-only)';
  if (!ctx.awsOk) { rep.skip(G, 'online', 'AWS CLI v2 is not available'); return; }
  if (ctx.credentialKind === 'none') { rep.skip(G, 'online', 'no credentials configured (see above)'); return; }
  const base = [...(opts.profile ? ['--profile', opts.profile] : []), ...(ctx.region ? ['--region', ctx.region] : []), '--output', 'json'];
  const call = (args) => {
    assertReadOnly(args);
    return runTool(opts.awsBin ?? 'aws', [...args, ...base], { timeout: 60000, env: { ...process.env, AWS_PAGER: '' } });
  };
  const who = call(['sts', 'get-caller-identity']);
  if (who.code !== 0) {
    const expired = /expired|Token has expired|sso/i.test(who.stderr);
    rep.fail(G, 'identity', who.stderr.split(/\r?\n/).slice(-1)[0] || 'sts get-caller-identity failed',
      expired ? `the SSO session expired: aws sso login --profile ${ctx.profile}` : 'check the profile, the network and the clock');
    return;
  }
  const id = JSON.parse(who.stdout);
  rep.pass(G, 'identity', `${id.Arn} (account ${id.Account})`);
  if (/:root$/.test(id.Arn)) rep.warn(G, 'identity-root', 'the root user is in use', 'use an IAM Identity Center user or an administrator role (01 §4.1)');
  const vpcs = call(['ec2', 'describe-vpcs', '--filters', 'Name=isDefault,Values=true']);
  if (vpcs.code !== 0) rep.warn(G, 'default-vpc', vpcs.stderr.split(/\r?\n/).slice(-1)[0] || 'describe-vpcs failed');
  else if (JSON.parse(vpcs.stdout).Vpcs?.length) rep.pass(G, 'default-vpc', `default VPC ${JSON.parse(vpcs.stdout).Vpcs[0].VpcId}`);
  else rep.fail(G, 'default-vpc', `no default VPC in ${ctx.region}`, 'aws ec2 create-default-vpc (the learner runs it; the platform never creates it, 01 §4.1)');
  const stack = call(['cloudformation', 'describe-stacks', '--stack-name', 'atl']);
  if (stack.code === 0) {
    const s = JSON.parse(stack.stdout).Stacks?.[0];
    rep.warn(G, 'existing-stack', `stack atl exists (${s?.StackStatus})`, 'an install is an update of this stack (01 §4.7): review a change set first');
  } else if (/does not exist/.test(stack.stderr)) rep.pass(G, 'existing-stack', 'no stack named atl');
  else rep.warn(G, 'existing-stack', stack.stderr.split(/\r?\n/).slice(-1)[0] || 'describe-stacks failed');
}

// ---------------------------------------------------------------------------------------------------------------------
// artifacts

export function findReleaseDir(root = REPO_ROOT) {
  const bases = [path.join(root, 'dist', 'release'), path.join(root, 'platform', 'infra', 'dist', 'release')];
  const dirs = bases.flatMap((b) => (fs.existsSync(b) ? fs.readdirSync(b).map((d) => path.join(b, d)) : []))
    .filter((d) => fs.existsSync(path.join(d, 'SHA256SUMS')))
    .sort((a, b) => fs.statSync(path.join(b, 'SHA256SUMS')).mtimeMs - fs.statSync(path.join(a, 'SHA256SUMS')).mtimeMs);
  return dirs[0] ?? null;
}

const NOT_ASSETS = new Set(['SHA256SUMS', 'release-manifest.json', 'launch-stack.md', 'package-report.json']);
const ELF_FOR = { arm64: 'aarch64', x86_64: 'x86_64' };

export function checkArtifacts(rep, dir, opts = {}) {
  const G = 'artifacts';
  if (!dir || !fs.existsSync(path.join(dir, 'SHA256SUMS'))) {
    rep.fail(G, 'release-dir', `no packaged release ${dir ? `in ${dir}` : 'found (dist/release/v*/)'}`, 'bash scripts/release-docker/build.sh (or npm run platform:package -- --out <dir>)');
    return;
  }
  rep.info(G, 'release-dir', dir);
  const sums = parseSums(fs.readFileSync(path.join(dir, 'SHA256SUMS'), 'utf8'));
  const bad = [];
  const assets = new Map();
  for (const f of sums.files) {
    if (f.invalid) { bad.push(`invalid line: ${f.invalid.slice(0, 80)}`); continue; }
    const p = path.join(dir, f.name);
    if (!fs.existsSync(p)) { bad.push(`${f.name}: missing`); continue; }
    const data = fs.readFileSync(p);
    assets.set(f.name, data);
    if (sha256(data) !== f.sha256) bad.push(`${f.name}: SHA-256 mismatch`);
  }
  const unlisted = fs.readdirSync(dir).filter((f) => !NOT_ASSETS.has(f) && !assets.has(f) && fs.statSync(path.join(dir, f)).isFile());
  if (bad.length) rep.fail(G, 'sha256sums', bad.join('; '));
  else rep.pass(G, 'sha256sums', `${sums.files.length} files match SHA256SUMS`);
  if (unlisted.length) rep.warn(G, 'unlisted', `files not in SHA256SUMS: ${unlisted.join(', ')}`, 'publish-s3 would upload them without a digest');

  const report = fs.existsSync(path.join(dir, 'package-report.json')) ? JSON.parse(fs.readFileSync(path.join(dir, 'package-report.json'), 'utf8')) : null;
  if (report && opts.head && report.repoCommit && report.repoCommit !== opts.head) rep.warn(G, 'commit', `release built from ${report.repoCommit.slice(0, 12)}, working tree is at ${opts.head.slice(0, 12)}`);
  else if (report?.repoCommit) rep.info(G, 'commit', `built from ${report.repoCommit.slice(0, 12)} at ${report.createdAt}`);

  // the manifest embedded in the template must describe exactly these files (CopyArtifacts verifies it at install time)
  const templateName = 'atl-platform.template.json';
  const checksDigest = sums.comments['checks-bundle-digest'] ?? '';
  if (!assets.has(templateName)) rep.fail(G, 'template', `${templateName} is not in SHA256SUMS`);
  else {
    const t = JSON.parse(assets.get(templateName).toString('utf8'));
    const embedded = t.Resources?.CopyArtifacts?.Properties?.Manifest;
    const errs = [];
    if (!embedded?.Files?.length) errs.push('no embedded manifest (CopyArtifacts.Manifest)');
    for (const f of embedded?.Files ?? []) {
      const data = assets.get(f.Name);
      if (!data) errs.push(`${f.Name}: not in the release`);
      else if (sha256(data) !== f.Sha256 || data.length !== f.Size) errs.push(`${f.Name}: differs from the embedded manifest`);
    }
    for (const name of assets.keys()) if (name !== templateName && !(embedded?.Files ?? []).some((f) => f.Name === name)) errs.push(`${name}: not in the embedded manifest`);
    if ((embedded?.ChecksBundleDigest ?? '') !== checksDigest) errs.push('ChecksBundleDigest differs from SHA256SUMS');
    if (errs.length) rep.fail(G, 'template-manifest', errs.join('; '));
    else rep.pass(G, 'template-manifest', `embedded manifest matches ${embedded.Files.length} files; template ${(assets.get(templateName).length / 1024).toFixed(0)} KiB`);
    if (assets.get(templateName).length > 51200) rep.info(G, 'template-size', 'template > 51,200 bytes: `aws cloudformation deploy` needs --s3-bucket; Launch Stack reads it from S3 (01 §4.2, §4.9)');
  }
  if (/^[0-9a-f]{64}$/.test(checksDigest)) rep.pass(G, 'checks-digest', `check bundle ${checksDigest}`);
  else rep.fail(G, 'checks-digest', 'SHA256SUMS has no `# checks-bundle-digest`', 'the platform release must carry the ATL check bundle');

  // CloudAlbum release archives
  for (const arch of ['arm64', 'x86_64']) {
    const name = `cloudalbum-app-${arch}.tar.gz`;
    const data = assets.get(name);
    if (!data) { rep.fail(G, `app-${arch}`, `${name} is missing`, 'scripts/release-docker/build.sh builds both architectures'); continue; }
    let manifest = null;
    try {
      const hit = readTarGz(data, { stopAt: (n) => /^[^/]+\/\.release-manifest\.json$/.test(n) })[0];
      manifest = hit ? JSON.parse(hit.data.toString('utf8')) : null;
    } catch (e) { rep.fail(G, `app-${arch}`, `${name}: ${e.message}`); continue; }
    if (!manifest) { rep.fail(G, `app-${arch}`, `${name}: no .release-manifest.json`); continue; }
    const errs = [];
    if (manifest.arch !== arch) errs.push(`built for ${manifest.arch}`);
    if (manifest.atlBundleDigest !== checksDigest) errs.push(`atlBundleDigest ${manifest.atlBundleDigest ?? 'none'} ≠ ${checksDigest || 'none'}`);
    const natives = manifest.nativeModules ?? [];
    for (const [mod, re] of [['better-sqlite3', /better-sqlite3\/build\/Release\//], ['sharp', /@img\/sharp-linux-/], ['@node-rs/argon2', /@node-rs\/argon2-linux-/]]) {
      const hits = natives.filter((n) => re.test(n.path));
      if (!hits.length) errs.push(`${mod}: no native binary recorded`);
      else if (!hits.every((h) => h.machine === ELF_FOR[arch])) errs.push(`${mod}: ${hits.map((h) => h.machine).join(', ')}`);
    }
    if (errs.length) rep.fail(G, `app-${arch}`, `${name} (${manifest.version}): ${errs.join('; ')}`);
    else rep.pass(G, `app-${arch}`, `${name}: CloudAlbum ${manifest.version}, ${natives.length} native modules for ${ELF_FOR[arch]}, node ${manifest.build?.node ?? '?'}${manifest.build?.sourceDirty ? ' (dirty source)' : ''}`);
    if (manifest.ssmAgentMinVersion == null) rep.info(G, `app-${arch}-ssm-agent`, `${name}: ssmAgentMinVersion not set (filled in after 07 PM-06; SSM_AGENT_MIN_VERSION=<v> scripts/release)`);
  }

  // runner source package
  const infraZip = assets.get('cloudalbum-infra.zip');
  if (!infraZip) rep.fail(G, 'infra-zip', 'cloudalbum-infra.zip is missing');
  else {
    const entries = readZip(infraZip);
    const byName = new Map(entries.map((e) => [e.name, e]));
    const inner = byName.get('SHA256SUMS');
    const errs = [];
    if (!inner) errs.push('no SHA256SUMS inside');
    else {
      const s = parseSums(inner.data.toString('utf8'));
      let n = 0;
      for (const f of s.files) {
        if (f.invalid) { errs.push(`invalid line ${f.invalid.slice(0, 60)}`); continue; }
        const e = byName.get(f.name);
        if (!e) errs.push(`${f.name}: missing`);
        else if (sha256(e.data) !== f.sha256) errs.push(`${f.name}: SHA-256 mismatch`);
        n++;
      }
      if (n !== entries.length - 1) errs.push(`SHA256SUMS lists ${n} of ${entries.length - 1} entries`);
    }
    for (const need of ['scripts/module', 'scripts/module-cli/dist/index.js', 'platform/workflows/runner/buildspec.yml', 'platform/workflows/runner/dist/atl-runner.mjs', 'platform/workstation/templates/atl-workstation.yaml', 'infra/userdata/l0-bootstrap.sh']) {
      if (!byName.has(need)) errs.push(`${need} missing`);
    }
    if (byName.get('scripts/module') && !(byName.get('scripts/module').mode & 0o100)) errs.push('scripts/module is not executable');
    for (const arch of ['arm64', 'x86_64']) if (!entries.some((e) => new RegExp(`^cloudalbum-.+-${arch}\\.tgz$`).test(e.name))) errs.push(`no cloudalbum-<ver>-${arch}.tgz`);
    if (checksDigest && !byName.has(`atl/checks/${checksDigest}/manifest.json`)) errs.push('check bundle missing');
    if (errs.length) rep.fail(G, 'infra-zip', `cloudalbum-infra.zip: ${errs.slice(0, 8).join('; ')}${errs.length > 8 ? ` (+${errs.length - 8})` : ''}`);
    else rep.pass(G, 'infra-zip', `cloudalbum-infra.zip: ${entries.length} entries, inner SHA256SUMS verified`);
    const nm = ['commander', 'yaml', '@aws-sdk/client-cloudformation', '@cloudalbum/contracts'].filter((m) => !byName.has(`node_modules/${m}/package.json`));
    const argon = entries.some((e) => /^node_modules\/@node-rs\/argon2-linux-arm64-gnu\/.+\.node$/.test(e.name));
    if (nm.length || !argon) rep.fail(G, 'runner-node-modules', `cloudalbum-infra.zip lacks ${[...nm, ...(argon ? [] : ['@node-rs/argon2-linux-arm64-gnu'])].join(', ')}`, 'CodeBuild (ARM_CONTAINER) runs scripts/module without an install step: build with scripts/release-docker/build.sh');
    else rep.pass(G, 'runner-node-modules', 'node_modules for linux-arm64 (scripts/module in CodeBuild)');
  }

  // workstation bundle
  const wsTar = assets.get('atl-workstation.tar.gz');
  if (!wsTar) rep.fail(G, 'workstation', 'atl-workstation.tar.gz is missing');
  else {
    const entries = readTarGz(wsTar);
    const byName = new Map(entries.map((e) => [e.name, e]));
    const m = byName.get('manifest.json') ? JSON.parse(byName.get('manifest.json').data.toString('utf8')) : null;
    const errs = [];
    if (!m) errs.push('no manifest.json');
    for (const f of m?.files ?? []) {
      const e = byName.get(f.name);
      if (!e) errs.push(`${f.name}: missing`);
      else if (sha256(e.data) !== f.sha256) errs.push(`${f.name}: SHA-256 mismatch`);
    }
    for (const need of ['atl-ws-install.sh', 'atl-workstation-setup.sh', 'atl-agent-call', 'cloudalbum-src.tar.gz', 'atl-checks.tar.gz']) if (!byName.has(need)) errs.push(`${need} missing`);
    if (m && checksDigest && m.checksBundleDigest !== checksDigest) errs.push(`checksBundleDigest ${m.checksBundleDigest} ≠ ${checksDigest}`);
    if (errs.length) rep.fail(G, 'workstation', `atl-workstation.tar.gz: ${errs.join('; ')}`);
    else rep.pass(G, 'workstation', `atl-workstation.tar.gz: ${m.files.length} files verified`);
    const plugin = m?.tools?.sessionManagerPlugin ?? {};
    if (plugin.source === 'bundle') rep.pass(G, 'ssm-plugin', 'session-manager-plugin rpm bundled');
    else if (plugin.source === 'download') {
      const pinned = Object.entries(plugin.sha256 ?? {}).filter(([, v]) => /^[0-9a-f]{64}$/.test(v ?? ''));
      if (pinned.some(([k]) => k === 'aarch64')) rep.pass(G, 'ssm-plugin', `session-manager-plugin ${plugin.version}: download pinned for ${pinned.map(([k]) => k).join(', ')}`);
      else rep.warn(G, 'ssm-plugin', `session-manager-plugin ${plugin.version}: SHA-256 not pinned — the workstation skips the plugin (aws ssm start-session unavailable)`,
        `bash scripts/release-docker/pin-ssm-plugin.sh ${plugin.version}, then repackage`);
    } else rep.warn(G, 'ssm-plugin', 'no session-manager-plugin source in the workstation bundle');
    rep.info(G, 'k6', m?.tools?.k6?.source === 'bundle' ? 'k6 bundled' : 'k6 not bundled (optional: npm run exp uses the Node load generator)');
    const nmInfo = m?.nodeModulesInfo ?? {};
    if (nmInfo.source === 'prebuilt' && (nmInfo.arch === 'arm64' || nmInfo.arch === 'aarch64')) rep.pass(G, 'ws-node-modules', `prebuilt node_modules for linux-arm64 (node ${nmInfo.node ?? '?'})`);
    else if (nmInfo.source === 'prebuilt') rep.warn(G, 'ws-node-modules', `prebuilt node_modules for ${nmInfo.arch}: the arm64 workstation installs them from npm at boot`);
    else rep.warn(G, 'ws-node-modules', 'no prebuilt node_modules: the workstation installs them from the npm registry at boot (needs internet; slower ws.ready)');
  }

  // web / content packages
  const web = assets.get('atl-web.zip');
  if (web) {
    const idx = readZip(web).find((e) => e.name === 'index.html');
    if (!idx) rep.fail(G, 'web', 'atl-web.zip has no index.html');
    else if (/本次构建不含网页界面|does not include the web UI/.test(idx.data.toString('utf8'))) rep.warn(G, 'web', 'atl-web.zip is the placeholder page', 'npm run build:web before packaging');
    else rep.pass(G, 'web', 'atl-web.zip carries the SPA build');
  }
  const content = assets.get('atl-content.zip');
  if (content) {
    const man = readZip(content).find((e) => e.name === 'manifest.json');
    const cm = man ? JSON.parse(man.data.toString('utf8')) : null;
    if (!cm) rep.fail(G, 'content', 'atl-content.zip has no manifest.json');
    else if (cm.placeholder) rep.warn(G, 'content', 'atl-content.zip is an empty placeholder catalog', 'npm run labs:build before packaging');
    else rep.pass(G, 'content', `atl-content.zip catalog ${cm.catalogVersion}`);
  }
  for (const w of report?.warnings ?? []) rep.info(G, 'package-warning', w);
}

export function checkCfnLint(rep, dir, env = process.env) {
  const G = 'artifacts';
  const t = dir && path.join(dir, 'atl-platform.template.json');
  if (!t || !fs.existsSync(t)) { rep.skip(G, 'cfn-lint-template', 'no release template'); return; }
  const r = runTool(env.ATL_CFN_LINT || 'cfn-lint', ['--format', 'parseable', t], { timeout: 600000, env });
  if (r.missing) { rep.skip(G, 'cfn-lint-template', 'cfn-lint is not installed'); return; }
  const lines = r.stdout.split(/\r?\n/).filter(Boolean);
  const errors = lines.filter((l) => /:E\d{4}:/.test(l));
  if (errors.length) rep.fail(G, 'cfn-lint-template', `${errors.length} error(s): ${errors.slice(0, 3).join(' | ')}`);
  else rep.pass(G, 'cfn-lint-template', `0 errors${lines.length ? `, ${lines.length} warning(s)/info` : ''}`);
}

// ---------------------------------------------------------------------------------------------------------------------

export function parseArgs(argv) {
  const o = { releaseDir: undefined, profile: undefined, region: undefined, artifactsOnly: false, cfnLint: false, online: false, strict: false, json: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const val = () => { const v = argv[++i]; if (v === undefined || v.startsWith('--')) throw new Error(`${a} needs a value`); return v; };
    if (a === '--release-dir') o.releaseDir = path.resolve(val());
    else if (a === '--profile') o.profile = val();
    else if (a === '--region') o.region = val();
    else if (a === '--artifacts-only') o.artifactsOnly = true;
    else if (a === '--cfn-lint') o.cfnLint = true;
    else if (a === '--online') o.online = true;
    else if (a === '--strict') o.strict = true;
    else if (a === '--json') o.json = true;
    else if (a === '--help' || a === '-h') o.help = true;
    else throw new Error(`unknown option ${a}`);
  }
  return o;
}

export function preflight(opts) {
  const rep = new Report();
  let ctx = { head: null };
  if (!opts.artifactsOnly) {
    ctx = checkEnvironment(rep, opts);
    if (opts.online) checkOnline(rep, opts, ctx);
    else rep.skip('aws (read-only)', 'online', 'no AWS call made (add --online for sts get-caller-identity, the default VPC and an existing atl stack)');
  }
  const dir = opts.releaseDir ?? findReleaseDir();
  checkArtifacts(rep, dir, { head: ctx.head });
  if (opts.cfnLint) checkCfnLint(rep, dir);
  const failures = rep.count('fail') + (opts.strict ? rep.count('warn') : 0);
  return { rep, failures, dir };
}

function print(rep) {
  const mark = { pass: 'PASS', warn: 'WARN', fail: 'FAIL', skip: 'SKIP', info: 'INFO' };
  let group = '';
  for (const r of rep.results) {
    if (r.group !== group) { group = r.group; console.log(`\n[${group}]`); }
    console.log(`  ${mark[r.status]}  ${r.id.padEnd(22)} ${r.detail}`);
    if (r.hint && r.status !== 'pass') console.log(`        → ${r.hint}`);
  }
  console.log(`\n${rep.count('pass')} pass, ${rep.count('warn')} warn, ${rep.count('fail')} fail, ${rep.count('skip')} skip`);
}

function main() {
  let opts;
  try { opts = parseArgs(process.argv.slice(2)); } catch (e) { console.error(`preflight: ${e.message}`); process.exit(2); }
  if (opts.help) { console.log(fs.readFileSync(fileURLToPath(import.meta.url), 'utf8').split('\n').slice(1, 22).map((l) => l.replace(/^\/\/ ?/, '')).join('\n')); return; }
  const { rep, failures, dir } = preflight(opts);
  if (opts.json) console.log(JSON.stringify({ releaseDir: dir, failures, results: rep.results }, null, 2));
  else print(rep);
  process.exitCode = failures ? 1 : 0;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
