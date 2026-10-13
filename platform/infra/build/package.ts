/**
 * Package a platform release (01 §4.5) into dist/release/<tag>/ — the GitHub Release asset layout (flat files):
 *   atl-platform.template.json   single-stack template with the embedded SHA-256 manifest of the files below
 *   atl-lambdas.zip              <function>/index.mjs (+ .map) for every function except the inline atl-copy-artifacts
 *   atl-web.zip                  SPA build (platform/web/dist; a placeholder page while the web UI is not built)
 *   atl-content.zip              content release (labs:build output; a placeholder catalog when absent)
 *   cloudalbum-app-<arch>.tar.gz CloudAlbum release archives (scripts/release output; skipped with a warning when absent)
 *   cloudalbum-infra.zip         runner source: infra/, scripts/, modules/, experiments/, guides/, packages/, the runner
 *                                buildspec, the workstation template, the check bundle (atl/checks/<digest>/, atl/bin/atl-check),
 *                                the bundled runner (platform/workflows/runner/dist/atl-runner.mjs), the CloudAlbum release
 *                                archives as scripts/release names them (cloudalbum-<ver>-<arch>.tgz, `bootstrap --release-file`)
 *                                and SHA256SUMS of every file in it (buildspec install: `sha256sum --check --strict`)
 *   atl-workstation.tar.gz       workstation bootstrap bundle (03 §4.5): tools, check bundle, repository, manifest.json
 *   atl-cloudshell-kit-<arch>.tar.gz  only when given (--cloudshell-kit <arch>=<file>)
 *   SHA256SUMS                   `<sha256>  <file>` for all of the above (+ `# checks-bundle-digest <hex>`)
 *   release-manifest.json        the manifest embedded into the template (CopyArtifacts)
 *   launch-stack.md              Launch Stack links (build/launch-link.ts)
 *
 *   npm run package -w @atl/infra -- [--tag v1.0.0] [--out dir] [--app-archive arm64=<file>] [--checks-dir dir]
 *        [--content-dir dir] [--web-dir dir] [--ssm-plugin-rpm file] [--k6-tarball file] [--workstation-node-modules dir]
 *        [--cloudshell-kit <arch>=<file>]
 * Nothing is uploaded (publish-s3.ts does that); no AWS call is made.
 */
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { build, type Plugin } from 'esbuild';
import { LAMBDA_FUNCTIONS } from '@atl/shared';
import { writeZip } from '../custom-resources/src/zip.js';
import { collectDir, writeTarGz, type ArchiveEntry } from './archive.js';
import { launchStackMarkdown } from './launch-link.js';
import { buildTemplate, loadReleaseConfig, platformVersion, releaseTag, TEMPLATE_FILE_NAME, writeTemplate, type ReleaseManifest } from './merge-template.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const INFRA_DIR = path.resolve(HERE, '..');
export const PLATFORM_DIR = path.resolve(INFRA_DIR, '..');
export const REPO_ROOT = path.resolve(PLATFORM_DIR, '..');

export const sha256 = (b: Buffer | string): string => createHash('sha256').update(b).digest('hex');

// ---------------------------------------------------------------------------------------------------------------
// Lambda bundles

const SHARED_SOURCES: Record<string, string> = {
  '@atl/shared': path.join(PLATFORM_DIR, 'shared', 'src', 'index.ts'),
  '@atl/shared/node': path.join(PLATFORM_DIR, 'shared', 'src', 'node.ts'),
};
const sharedSources: Plugin = {
  name: 'atl-shared-sources',
  setup(b) {
    b.onResolve({ filter: /^@atl\/shared(\/node)?$/ }, (args) => ({ path: SHARED_SOURCES[args.path]! }));
  },
};

interface BundleOutput {
  code: Buffer;
  map?: Buffer;
}

function outputsOf(files: { path: string; contents: Uint8Array }[]): BundleOutput {
  const code = files.find((f) => !f.path.endsWith('.map'));
  const map = files.find((f) => f.path.endsWith('.map'));
  if (!code) throw new Error('esbuild produced no output');
  return { code: Buffer.from(code.contents), ...(map ? { map: Buffer.from(map.contents) } : {}) };
}

/** atl-custom-resources is built from platform/infra/custom-resources (install / uninstall code owned by infra). */
export async function bundleCustomResources(): Promise<BundleOutput> {
  const r = await build({
    entryPoints: [path.join(INFRA_DIR, 'custom-resources', 'src', 'index.ts')],
    outfile: path.join(INFRA_DIR, 'dist', 'lambda', 'atl-custom-resources', 'index.mjs'),
    bundle: true,
    platform: 'node',
    target: 'node22',
    format: 'esm',
    sourcemap: true,
    write: false,
    logLevel: 'warning',
    plugins: [sharedSources],
    external: ['@aws-sdk/*'],
    banner: { js: "import { createRequire as __cr } from 'node:module'; const require = __cr(import.meta.url);" },
  });
  return outputsOf(r.outputFiles);
}

/** The other functions come from platform/api/build.mjs (same esbuild settings, dev-code guard included). */
export async function bundleApiFunction(name: string): Promise<BundleOutput> {
  const api = (await import(pathToFileURL(path.join(PLATFORM_DIR, 'api', 'build.mjs')).href)) as {
    bundleFunction(name: string, opts: { write: boolean }): Promise<{ outputFiles: { path: string; contents: Uint8Array }[] }>;
  };
  const r = await api.bundleFunction(name, { write: false });
  return outputsOf(r.outputFiles);
}

export async function lambdasZip(): Promise<Buffer> {
  const entries: ArchiveEntry[] = [];
  for (const name of LAMBDA_FUNCTIONS) {
    if (name === 'atl-copy-artifacts') continue; // inline Code.ZipFile (01 §4.5)
    const out = name === 'atl-custom-resources' ? await bundleCustomResources() : await bundleApiFunction(name);
    entries.push({ name: `${name}/index.mjs`, data: out.code });
    if (out.map) entries.push({ name: `${name}/index.mjs.map`, data: out.map });
  }
  return writeZip(entries);
}

// ---------------------------------------------------------------------------------------------------------------
// Repository files

/** Tracked and untracked-but-not-ignored files under the given roots (deterministic, sorted). */
export function repoFiles(roots: string[]): string[] {
  const out = execFileSync('git', ['ls-files', '-co', '--exclude-standard', '-z', '--', ...roots], { cwd: REPO_ROOT, maxBuffer: 256 * 1024 * 1024 });
  return [...new Set(out.toString('utf8').split('\0').filter(Boolean))]
    .filter((f) => fs.existsSync(path.join(REPO_ROOT, f)) && fs.statSync(path.join(REPO_ROOT, f)).isFile())
    .sort();
}

/** The repository subset needed by scripts/module, experiments and the runner (no node_modules). */
export const SOURCE_ROOTS = [
  'package.json',
  'package-lock.json',
  'tsconfig.json',
  'tsconfig.base.json',
  'infra',
  'scripts',
  'modules',
  'experiments',
  'guides',
  'packages',
  'platform/package.json',
  'platform/VERSION',
  'platform/shared',
  'platform/workflows/runner',
  'platform/workflows/templates',
  'platform/workstation/templates',
];
/** Build outputs (ignored by git) that scripts/module needs to run without tsx. */
export const BUILT_DIRS = ['packages/contracts/dist', 'packages/image-core/dist', 'scripts/module-cli/dist', 'experiments/dist', 'platform/shared/dist'];

const EXEC_FILES = /(^|\/)(scripts\/(module|release|teardown|local-backup\.sh)|[^/]+\.sh)$/;

export function sourceEntries(prefix = ''): ArchiveEntry[] {
  const entries: ArchiveEntry[] = repoFiles(SOURCE_ROOTS).map((f) => ({
    name: prefix + f,
    data: fs.readFileSync(path.join(REPO_ROOT, f)),
    mode: EXEC_FILES.test(f) ? 0o755 : 0o644,
  }));
  for (const d of BUILT_DIRS) entries.push(...collectDir(path.join(REPO_ROOT, d), `${prefix}${d}/`, (r) => r.endsWith('.tsbuildinfo')));
  const seen = new Set<string>();
  return entries.filter((e) => (seen.has(e.name) ? false : (seen.add(e.name), true)));
}

export function gitCommit(): string {
  try {
    return execFileSync('git', ['rev-parse', 'HEAD'], { cwd: REPO_ROOT }).toString().trim();
  } catch {
    return '';
  }
}

// ---------------------------------------------------------------------------------------------------------------
// Check bundle (04 §6.2, 06 PM-04)

export interface ChecksBundle {
  digest: string;
  entries: ArchiveEntry[];
}

/** `<dir>/checks/<digest>/manifest.json` + `<dir>/bin/atl-check`; the directory name must be the manifest digest. */
export function loadChecksBundle(dir: string | undefined): ChecksBundle | null {
  if (!dir || !fs.existsSync(path.join(dir, 'checks'))) return null;
  const digests = fs.readdirSync(path.join(dir, 'checks')).filter((d) => /^[a-f0-9]{64}$/.test(d));
  if (digests.length !== 1) throw new Error(`check bundle ${dir}: expected exactly one checks/<digest>/ directory, found ${digests.length}`);
  const digest = digests[0]!;
  const actual = sha256(fs.readFileSync(path.join(dir, 'checks', digest, 'manifest.json')));
  if (actual !== digest) throw new Error(`check bundle ${dir}: manifest digest ${actual} does not match its directory ${digest}`);
  if (!fs.existsSync(path.join(dir, 'bin', 'atl-check'))) throw new Error(`check bundle ${dir}: bin/atl-check is missing`);
  // bin/atl-check.mjs is the Node port for ATL_DEV_MODE / Windows hosts only (platform-checks): never shipped
  const entries = collectDir(dir)
    .filter((e) => e.name !== 'bin/atl-check.mjs')
    .map((e) => (e.name === 'bin/atl-check' ? { ...e, mode: 0o755 } : e));
  return { digest, entries };
}

// ---------------------------------------------------------------------------------------------------------------
// Workstation bundle (03 §4.5)

async function bundleCli(entry: string): Promise<Buffer> {
  const r = await build({
    entryPoints: [entry],
    outfile: path.join(INFRA_DIR, 'dist', 'workstation', path.basename(entry, '.ts') + '.cjs'),
    bundle: true,
    platform: 'node',
    target: 'node22',
    format: 'cjs',
    write: false,
    logLevel: 'warning',
    plugins: [sharedSources],
    legalComments: 'none',
  });
  const code = outputsOf(r.outputFiles).code.toString('utf8').replace(/^#!.*\n/, '');
  return Buffer.from(`#!/usr/bin/env node\n${code}`);
}

export interface WorkstationInputs {
  checks: ChecksBundle | null;
  ssmPluginRpm?: string;
  k6Tarball?: string;
  nodeModulesDir?: string;
  version: string;
}

export async function workstationBundle(inputs: WorkstationInputs): Promise<{ tarball: Buffer; manifest: Record<string, unknown> }> {
  const ws = path.join(PLATFORM_DIR, 'workstation');
  const files: ArchiveEntry[] = [
    { name: 'atl-credentials', data: fs.readFileSync(path.join(ws, 'bin', 'atl-credentials')), mode: 0o755 },
    { name: 'atl-workstation-setup.sh', data: fs.readFileSync(path.join(ws, 'bin', 'atl-workstation-setup.sh')), mode: 0o755 },
    { name: 'atl-lab-proxy', data: fs.readFileSync(path.join(ws, 'bin', 'atl-lab-proxy')), mode: 0o755 },
    { name: 'profile.d-atl.sh', data: fs.readFileSync(path.join(ws, 'bootstrap', 'profile.d-atl.sh')), mode: 0o644 },
    { name: 'atl-agent-call', data: await bundleCli(path.join(ws, 'src', 'cli', 'agent-call.ts')), mode: 0o755 },
    { name: 'atl-write-session-files', data: await bundleCli(path.join(ws, 'src', 'cli', 'write-session-files.ts')), mode: 0o755 },
  ];
  const missing: string[] = [];
  const optional = (name: string, file: string | undefined) => {
    if (file && fs.existsSync(file)) files.push({ name, data: fs.readFileSync(file), mode: 0o644 });
    else missing.push(name);
  };
  optional('session-manager-plugin.rpm', inputs.ssmPluginRpm);
  optional('k6-linux-arm64.tar.gz', inputs.k6Tarball);
  if (inputs.checks) files.push({ name: 'atl-checks.tar.gz', data: writeTarGz(inputs.checks.entries), mode: 0o644 });
  else missing.push('atl-checks.tar.gz');
  const src = sourceEntries();
  if (inputs.nodeModulesDir) src.push(...collectDir(inputs.nodeModulesDir, 'node_modules/'));
  files.push({ name: 'cloudalbum-src.tar.gz', data: writeTarGz(src), mode: 0o644 });
  const manifest = {
    schema: 'atl.workstation-bundle/v1',
    version: inputs.version,
    repoCommit: gitCommit(),
    nodeModules: !!inputs.nodeModulesDir,
    checksBundleDigest: inputs.checks?.digest ?? null,
    files: files.map((f) => ({ name: f.name, sha256: sha256(f.data) })),
    missing,
  };
  const tarball = writeTarGz([{ name: 'manifest.json', data: Buffer.from(JSON.stringify(manifest, null, 2) + '\n') }, ...files]);
  return { tarball, manifest };
}

// ---------------------------------------------------------------------------------------------------------------
// Web and content

const PLACEHOLDER_INDEX = `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>AWS Training Lab</title><link rel="stylesheet" href="/placeholder.css"></head>
<body><main><h1>AWS Training Lab</h1><p>平台已安装，但本次构建不含网页界面（platform/web 将在后续版本提供）。</p>
<p>The platform is installed; this build does not include the web UI yet.</p></main></body></html>
`;
const PLACEHOLDER_CSS = 'body{font-family:system-ui,sans-serif;margin:3rem;color:#1f2937}main{max-width:40rem}\n';
const PLACEHOLDER_VERIFY = `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>证书验证 · AWS Training Lab</title><link rel="stylesheet" href="/verify/verify.css"></head>
<body><main><h1>证书验证</h1><p>验证页将随网页界面一起发布。公钥：<a href="/.well-known/atl/jwks.json">/.well-known/atl/jwks.json</a></p></main></body></html>
`;

export function webZip(webDir: string | undefined): { zip: Buffer; placeholder: boolean } {
  if (webDir && fs.existsSync(path.join(webDir, 'index.html'))) return { zip: writeZip(collectDir(webDir)), placeholder: false };
  return {
    zip: writeZip([
      { name: 'index.html', data: Buffer.from(PLACEHOLDER_INDEX) },
      { name: 'placeholder.css', data: Buffer.from(PLACEHOLDER_CSS) },
      { name: 'verify/index.html', data: Buffer.from(PLACEHOLDER_VERIFY) },
      { name: 'verify/verify.css', data: Buffer.from(PLACEHOLDER_CSS) },
    ]),
    placeholder: true,
  };
}

/** labs:build writes dist/content/<contentDigest>/ (04 §2.5); the newest one is used unless --content-dir is given. */
export function findContentDir(explicit: string | undefined): string | undefined {
  if (explicit) return explicit;
  const base = path.join(REPO_ROOT, 'dist', 'content');
  if (!fs.existsSync(base)) return undefined;
  const dirs = fs
    .readdirSync(base)
    .map((d) => path.join(base, d))
    .filter((d) => fs.existsSync(path.join(d, 'manifest.json')))
    .sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs);
  return dirs[0];
}

export function contentZip(contentDir: string | undefined, version: string): { zip: Buffer; catalogVersion: string; placeholder: boolean } {
  if (contentDir && fs.existsSync(path.join(contentDir, 'manifest.json'))) {
    const entries = collectDir(contentDir);
    const manifest = JSON.parse(fs.readFileSync(path.join(contentDir, 'manifest.json'), 'utf8')) as { catalogVersion?: string; contentDigest?: string };
    let catalogVersion = manifest.catalogVersion ?? manifest.contentDigest ?? path.basename(contentDir);
    if (!/^[A-Za-z0-9._-]+$/.test(catalogVersion)) catalogVersion = sha256(catalogVersion).slice(0, 16);
    if (!manifest.catalogVersion) {
      const i = entries.findIndex((e) => e.name === 'manifest.json');
      entries[i] = { name: 'manifest.json', data: Buffer.from(JSON.stringify({ ...manifest, catalogVersion }, null, 2) + '\n') };
    }
    return { zip: writeZip(entries), catalogVersion, placeholder: false };
  }
  const catalogVersion = `0.0.0-empty.${version}`;
  const manifest = { catalogVersion, placeholder: true, files: {} };
  return {
    zip: writeZip([
      { name: 'manifest.json', data: Buffer.from(JSON.stringify(manifest, null, 2) + '\n') },
      { name: 'index.json', data: Buffer.from(JSON.stringify({ cards: [], tracks: [] }, null, 2) + '\n') },
    ]),
    catalogVersion,
    placeholder: true,
  };
}

export function findAppArchive(arch: 'arm64' | 'x86_64', explicit: string | undefined): string | undefined {
  if (explicit) return explicit;
  const dir = path.join(REPO_ROOT, 'build', 'release');
  if (!fs.existsSync(dir)) return undefined;
  const files = fs
    .readdirSync(dir)
    .filter((f) => f.startsWith('cloudalbum-') && f.endsWith(`-${arch}.tgz`))
    .map((f) => path.join(dir, f))
    .sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs);
  return files[0];
}

// ---------------------------------------------------------------------------------------------------------------
// SHA256SUMS

export function sha256sums(files: { name: string; data: Buffer }[], checksDigest: string): string {
  const lines = files.map((f) => `${sha256(f.data)}  ${f.name}`);
  if (checksDigest) lines.push(`# checks-bundle-digest ${checksDigest}`);
  return lines.join('\n') + '\n';
}

// ---------------------------------------------------------------------------------------------------------------

interface Options {
  tag: string;
  out: string;
  appArchives: Partial<Record<'arm64' | 'x86_64', string>>;
  checksDir?: string;
  contentDir?: string;
  webDir?: string;
  ssmPluginRpm?: string;
  k6Tarball?: string;
  nodeModulesDir?: string;
  cloudshellKits: Record<string, string>;
}

function parseOptions(argv: string[]): Options {
  const get = (name: string) => {
    const i = argv.indexOf(name);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  const all = (name: string) => argv.flatMap((a, i) => (a === name && argv[i + 1] ? [argv[i + 1]!] : []));
  const pairs = (name: string) => Object.fromEntries(all(name).map((v) => v.split('=', 2) as [string, string]));
  const tag = get('--tag') ?? releaseTag();
  // `node platform/checks/build.mjs` writes platform/checks/dist/atl/ (platform-checks); 06 PM-04's platform/infra/checks-bundle/dist is the fallback
  const checksDefault = [path.join(PLATFORM_DIR, 'checks', 'dist', 'atl'), path.join(INFRA_DIR, 'checks-bundle', 'dist')].find((d) => fs.existsSync(path.join(d, 'checks'))) ?? path.join(INFRA_DIR, 'checks-bundle', 'dist');
  return {
    tag,
    out: get('--out') ?? path.join(INFRA_DIR, 'dist', 'release', tag),
    appArchives: pairs('--app-archive') as Options['appArchives'],
    checksDir: get('--checks-dir') ?? process.env.ATL_CHECKS_BUNDLE_DIR ?? (fs.existsSync(checksDefault) ? checksDefault : undefined),
    contentDir: get('--content-dir'),
    webDir: get('--web-dir') ?? path.join(PLATFORM_DIR, 'web', 'dist'),
    ssmPluginRpm: get('--ssm-plugin-rpm') ?? process.env.ATL_SSM_PLUGIN_RPM,
    k6Tarball: get('--k6-tarball') ?? process.env.ATL_K6_TARBALL,
    nodeModulesDir: get('--workstation-node-modules'),
    cloudshellKits: pairs('--cloudshell-kit'),
  };
}

/** platform/workflows/runner/dist/atl-runner.mjs (runner/build.mjs, esbuild; not written to disk here). */
export async function runnerBundle(): Promise<Buffer> {
  const mod = (await import(pathToFileURL(path.join(PLATFORM_DIR, 'workflows', 'runner', 'build.mjs')).href)) as {
    bundleRunner(o: { write: boolean }): Promise<{ errors: unknown[]; outputFiles?: { path: string; contents: Uint8Array }[] }>;
  };
  const r = await mod.bundleRunner({ write: false });
  const out = (r.outputFiles ?? []).find((f) => f.path.endsWith('atl-runner.mjs'));
  if (r.errors.length || !out) throw new Error('runner bundle failed (platform/workflows/runner/build.mjs)');
  return Buffer.from(out.contents);
}

/** SHA256SUMS of the runner source package itself (every entry; buildspec install phase). */
export function sourceSha256sums(entries: ArchiveEntry[]): Buffer {
  return Buffer.from(
    entries
      .filter((e) => e.name !== 'SHA256SUMS')
      .map((e) => `${sha256(e.data)}  ${e.name}`)
      .join('\n') + '\n',
  );
}

export async function packageRelease(opts: Options): Promise<{ dir: string; files: string[]; warnings: string[] }> {
  const version = platformVersion();
  const warnings: string[] = [];
  fs.rmSync(opts.out, { recursive: true, force: true });
  fs.mkdirSync(opts.out, { recursive: true });
  const files: { name: string; data: Buffer }[] = [];

  files.push({ name: 'atl-lambdas.zip', data: await lambdasZip() });
  const web = webZip(opts.webDir);
  if (web.placeholder) warnings.push('platform/web is not built: atl-web.zip carries a placeholder page');
  files.push({ name: 'atl-web.zip', data: web.zip });
  const content = contentZip(findContentDir(opts.contentDir), version);
  if (content.placeholder) warnings.push('no content release (npm run labs:build): atl-content.zip carries an empty catalog');
  files.push({ name: 'atl-content.zip', data: content.zip });
  const appArchives: ArchiveEntry[] = [];
  for (const arch of ['arm64', 'x86_64'] as const) {
    const f = findAppArchive(arch, opts.appArchives[arch]);
    if (f && fs.existsSync(f)) {
      const data = fs.readFileSync(f);
      files.push({ name: `cloudalbum-app-${arch}.tar.gz`, data });
      // inside the runner source under the scripts/release name (the runner picks cloudalbum-<ver>-<arch>.tgz)
      const base = path.basename(f);
      appArchives.push({ name: /^cloudalbum-.+-(arm64|x86_64)\.tgz$/.test(base) ? base : `cloudalbum-${version}-${arch}.tgz`, data, mode: 0o644 });
    } else warnings.push(`no CloudAlbum release archive for ${arch} (run scripts/release on Linux or pass --app-archive ${arch}=<file>)`);
  }
  const checks = loadChecksBundle(opts.checksDir);
  if (!checks) warnings.push('no check bundle (node platform/checks/build.mjs, or --checks-dir): ATL-RunCheck cannot run on the workstation');
  const infra = sourceEntries();
  if (checks) infra.push(...checks.entries.map((e) => ({ ...e, name: `atl/${e.name}` })));
  infra.push({ name: 'platform/workflows/runner/dist/atl-runner.mjs', data: await runnerBundle(), mode: 0o644 }, ...appArchives);
  infra.push({ name: 'SHA256SUMS', data: sourceSha256sums(infra), mode: 0o644 });
  files.push({ name: 'cloudalbum-infra.zip', data: writeZip(infra) });
  const ws = await workstationBundle({ checks, ssmPluginRpm: opts.ssmPluginRpm, k6Tarball: opts.k6Tarball, nodeModulesDir: opts.nodeModulesDir, version });
  for (const m of (ws.manifest.missing as string[]) ?? []) warnings.push(`workstation bundle without ${m}`);
  if (!opts.nodeModulesDir) warnings.push('workstation bundle without node_modules: the workstation runs npm ci at boot (source build)');
  files.push({ name: 'atl-workstation.tar.gz', data: ws.tarball });
  for (const [arch, file] of Object.entries(opts.cloudshellKits)) files.push({ name: `atl-cloudshell-kit-${arch}.tar.gz`, data: fs.readFileSync(file) });

  const checksDigest = checks?.digest ?? '';
  const manifest: ReleaseManifest = {
    Files: files.map((f) => ({ Name: f.name, Sha256: sha256(f.data), Size: f.data.length })),
    ChecksBundleDigest: checksDigest,
  };
  for (const f of files) fs.writeFileSync(path.join(opts.out, f.name), f.data);
  fs.writeFileSync(path.join(opts.out, 'release-manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
  const template = buildTemplate({ version, manifest });
  writeTemplate(template, path.join(opts.out, TEMPLATE_FILE_NAME));
  writeTemplate(template, path.join(INFRA_DIR, 'dist', TEMPLATE_FILE_NAME));
  const templateData = fs.readFileSync(path.join(opts.out, TEMPLATE_FILE_NAME));
  fs.writeFileSync(path.join(opts.out, 'SHA256SUMS'), sha256sums([...files, { name: TEMPLATE_FILE_NAME, data: templateData }], checksDigest));
  const config = loadReleaseConfig();
  fs.writeFileSync(path.join(opts.out, 'launch-stack.md'), launchStackMarkdown({ tag: opts.tag, config }));
  return { dir: opts.out, files: [...files.map((f) => f.name), TEMPLATE_FILE_NAME, 'SHA256SUMS', 'release-manifest.json', 'launch-stack.md'], warnings };
}

async function main(): Promise<void> {
  const r = await packageRelease(parseOptions(process.argv.slice(2)));
  console.log(`release → ${path.relative(process.cwd(), r.dir)}`);
  for (const f of r.files) {
    const size = fs.statSync(path.join(r.dir, f)).size;
    console.log(`  ${f.padEnd(34)} ${(size / 1024).toFixed(0).padStart(8)} KiB`);
  }
  for (const w of r.warnings) console.warn(`warning: ${w}`);
}

if (process.argv[1] && /package\.(ts|js)$/.test(process.argv[1])) {
  main().catch((e: unknown) => {
    console.error(e instanceof Error ? e.message : String(e));
    process.exitCode = 1;
  });
}
