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
 *                                (+ node_modules/ for linux-arm64 when --runner-node-modules is given: CodeBuild runs scripts/module
 *                                from this package without an install step)
 *   atl-workstation.tar.gz       workstation bootstrap bundle (03 §4.5): atl-ws-install.sh (the installation, run by the user
 *                                data after the bundle is verified), tools, check bundle, repository, optional prebuilt
 *                                node_modules, manifest.json (per-file SHA-256; tools.sessionManagerPlugin = the official
 *                                download URL per machine + pinned SHA-256, build/workstation-tools.json; k6 optional)
 *   atl-cloudshell-kit-<arch>.tar.gz  only when given (--cloudshell-kit <arch>=<file>)
 *   SHA256SUMS                   `<sha256>  <file>` for all of the above (+ `# checks-bundle-digest <hex>`)
 *   release-manifest.json        the manifest embedded into the template (CopyArtifacts)
 *   launch-stack.md              Launch Stack links (build/launch-link.ts)
 *   package-report.json          inputs, digests and warnings of this run (not an asset; read by scripts/verify/preflight.mjs)
 *
 *   npm run package -w @atl/infra -- [--tag v1.0.0] [--out dir] [--app-archive arm64=<file>] [--checks-dir dir]
 *        [--content-dir dir] [--web-dir dir] [--ssm-plugin-version v --ssm-plugin-sha256 <arch>=<hex> …] [--ssm-plugin-rpm file]
 *        [--k6-tarball file] [--workstation-node-modules <dir|tar.gz>] [--runner-node-modules <tar.gz>]
 *        [--cloudshell-kit <arch>=<file>] [--allow-checks-mismatch]
 * An app archive whose .release-manifest.json atlBundleDigest differs from the check bundle is refused (the lab instance
 * would not find the platform's checks). Nothing is uploaded (publish-s3.ts does that); no AWS call is made.
 * scripts/release-docker/build.sh runs the whole chain (Linux builds of both architectures, then this) in Docker.
 */
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { build, type Plugin } from 'esbuild';
import { LAMBDA_FUNCTIONS } from '@atl/shared';
import { writeZip } from '../custom-resources/src/zip.js';
import { collectDir, readTarGz, writeTarGz, type ArchiveEntry } from './archive.js';
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

/** Machine names as `uname -m` prints them on the workstation (the keys of the bundle manifest's per-architecture maps). */
export type Machine = 'aarch64' | 'x86_64';
export const MACHINES: Machine[] = ['aarch64', 'x86_64'];
const HEX64 = /^[0-9a-f]{64}$/;

/** Boot-time download of session-manager-plugin (03 §4.5): official URL per machine and the pinned SHA-256 (null = not pinned). */
export interface SsmPluginSpec {
  version: string;
  urls: Record<Machine, string>;
  sha256: Record<Machine, string | null>;
  /** where the version came from: the pin in build/workstation-tools.json, a command-line override, or PROTOCOL_COMPAT_VERSION */
  versionSource: 'pin' | 'override' | 'protocol-compat';
}

interface WorkstationToolsConfig {
  sessionManagerPlugin: {
    urlTemplate: string;
    platforms: Record<Machine, string>;
    pin: { version: string | null; sha256: Partial<Record<Machine, string | null>>; pinnedAt?: string | null };
  };
}

export const WORKSTATION_TOOLS_FILE = path.join(HERE, 'workstation-tools.json');

export function loadWorkstationTools(file = WORKSTATION_TOOLS_FILE): WorkstationToolsConfig {
  const raw = JSON.parse(fs.readFileSync(file, 'utf8')) as WorkstationToolsConfig;
  const s = raw.sessionManagerPlugin;
  if (!s?.urlTemplate?.startsWith('https://') || !s.urlTemplate.includes('{version}') || !s.urlTemplate.includes('{platform}'))
    throw new Error(`${file}: sessionManagerPlugin.urlTemplate must be an https URL with {version} and {platform}`);
  for (const m of MACHINES) if (!s.platforms?.[m]) throw new Error(`${file}: sessionManagerPlugin.platforms.${m} is missing`);
  return raw;
}

/** PROTOCOL_COMPAT_VERSION of platform/ssm-client (the plugin version the browser protocol layer mirrors, 03 §3.5.1). */
export function protocolCompatVersion(): string | null {
  const file = path.join(PLATFORM_DIR, 'ssm-client', 'src', 'constants.ts');
  if (!fs.existsSync(file)) return null;
  return /PROTOCOL_COMPAT_VERSION\s*=\s*'([0-9.]+)'/.exec(fs.readFileSync(file, 'utf8'))?.[1] ?? null;
}

/**
 * Resolve the plugin download: an explicit `--ssm-plugin-version` (with `--ssm-plugin-sha256 <machine>=<hex>`) wins; else the
 * pin of workstation-tools.json; else PROTOCOL_COMPAT_VERSION without hashes. Hashes belong to exactly one version: a pin is
 * never reused for another version.
 */
export function ssmPluginSpec(
  opts: { version?: string; sha256?: Partial<Record<string, string>> } = {},
  config: WorkstationToolsConfig = loadWorkstationTools(),
  compat: string | null = protocolCompatVersion(),
): SsmPluginSpec {
  const s = config.sessionManagerPlugin;
  const norm = (m: string): Machine | null => (m === 'arm64' || m === 'aarch64' ? 'aarch64' : m === 'x86_64' || m === 'amd64' || m === 'x64' ? 'x86_64' : null);
  let version: string;
  let versionSource: SsmPluginSpec['versionSource'];
  const sha: Record<Machine, string | null> = { aarch64: null, x86_64: null };
  const overrides = Object.entries(opts.sha256 ?? {});
  if (opts.version || overrides.length) {
    version = opts.version ?? s.pin.version ?? compat ?? '';
    versionSource = 'override';
    if (!opts.version && s.pin.version) for (const m of MACHINES) sha[m] = s.pin.sha256?.[m] ?? null;
  } else if (s.pin.version) {
    version = s.pin.version;
    versionSource = 'pin';
    for (const m of MACHINES) sha[m] = s.pin.sha256?.[m] ?? null;
  } else {
    version = compat ?? '';
    versionSource = 'protocol-compat';
  }
  for (const [k, v] of overrides) {
    const m = norm(k);
    if (!m) throw new Error(`--ssm-plugin-sha256: unknown architecture ${k} (arm64 | x86_64)`);
    sha[m] = v ?? null;
  }
  if (!/^\d+(\.\d+){1,3}$/.test(version)) throw new Error(`session-manager-plugin version is unknown or invalid (${version || 'empty'}): pin it in build/workstation-tools.json`);
  for (const m of MACHINES) if (sha[m] !== null && !HEX64.test(sha[m]!)) throw new Error(`session-manager-plugin SHA-256 for ${m} is not 64 lowercase hex digits`);
  const urls = Object.fromEntries(MACHINES.map((m) => [m, s.urlTemplate.replace('{version}', version).replace('{platform}', s.platforms[m])])) as Record<Machine, string>;
  return { version, urls, sha256: sha, versionSource };
}

/** Prebuilt node_modules for the workstation / runner (scripts/release-docker): `<file>.json` sidecar written next to the tarball. */
export interface NodeModulesInfo {
  schema?: string;
  arch?: string;
  node?: string;
  createdAt?: string;
  [k: string]: unknown;
}

export function nodeModulesInfo(tarball: string): NodeModulesInfo | null {
  const side = `${tarball}.json`;
  return fs.existsSync(side) ? (JSON.parse(fs.readFileSync(side, 'utf8')) as NodeModulesInfo) : null;
}

export interface WorkstationInputs {
  checks: ChecksBundle | null;
  /** legacy: a session-manager-plugin rpm bundled into the package instead of the boot-time download */
  ssmPluginRpm?: string;
  ssmPlugin?: SsmPluginSpec | null;
  k6Tarball?: string;
  /** a directory (legacy: copied into cloudalbum-src.tar.gz, symlinks followed) or a node_modules tarball (scripts/release-docker) */
  nodeModulesDir?: string;
  version: string;
}

const WORKSTATION_NODE_MODULES = 'cloudalbum-node_modules.tar.gz';

export async function workstationBundle(inputs: WorkstationInputs): Promise<{ tarball: Buffer; manifest: Record<string, unknown> }> {
  const ws = path.join(PLATFORM_DIR, 'workstation');
  const files: ArchiveEntry[] = [
    { name: 'atl-ws-install.sh', data: fs.readFileSync(path.join(ws, 'bootstrap', 'install.sh')), mode: 0o755 },
    { name: 'atl-install-node-modules.sh', data: fs.readFileSync(path.join(ws, 'bootstrap', 'install-node-modules.sh')), mode: 0o755 },
    { name: 'atl-credentials', data: fs.readFileSync(path.join(ws, 'bin', 'atl-credentials')), mode: 0o755 },
    { name: 'atl-workstation-setup.sh', data: fs.readFileSync(path.join(ws, 'bin', 'atl-workstation-setup.sh')), mode: 0o755 },
    { name: 'atl-lab-proxy', data: fs.readFileSync(path.join(ws, 'bin', 'atl-lab-proxy')), mode: 0o755 },
    { name: 'profile.d-atl.sh', data: fs.readFileSync(path.join(ws, 'bootstrap', 'profile.d-atl.sh')), mode: 0o644 },
    { name: 'atl-agent-call', data: await bundleCli(path.join(ws, 'src', 'cli', 'agent-call.ts')), mode: 0o755 },
    { name: 'atl-write-session-files', data: await bundleCli(path.join(ws, 'src', 'cli', 'write-session-files.ts')), mode: 0o755 },
  ];
  const missing: string[] = [];
  const notes: string[] = [];
  // session-manager-plugin: downloaded at boot from the official URL and verified against the pin (03 §4.5); a bundled rpm
  // (--ssm-plugin-rpm) is still accepted and takes precedence on the workstation
  let ssmTool: Record<string, unknown>;
  if (inputs.ssmPluginRpm && fs.existsSync(inputs.ssmPluginRpm)) {
    const data = fs.readFileSync(inputs.ssmPluginRpm);
    files.push({ name: 'session-manager-plugin.rpm', data, mode: 0o644 });
    ssmTool = { source: 'bundle', file: 'session-manager-plugin.rpm', sha256: sha256(data) };
  } else if (inputs.ssmPlugin) {
    const p = inputs.ssmPlugin;
    ssmTool = { source: 'download', version: p.version, urls: p.urls, sha256: p.sha256, versionSource: p.versionSource };
    const unpinned = MACHINES.filter((m) => !p.sha256[m]);
    if (unpinned.length) notes.push(`session-manager-plugin ${p.version}: no pinned SHA-256 for ${unpinned.join(', ')} (the workstation skips the plugin; scripts/release-docker/pin-ssm-plugin.sh)`);
  } else {
    ssmTool = { source: 'none' };
    notes.push('session-manager-plugin: no download spec and no rpm');
  }
  // k6 is optional (the experiments runner does not use it)
  let k6Tool: Record<string, unknown> = { source: 'none', optional: true };
  if (inputs.k6Tarball && fs.existsSync(inputs.k6Tarball)) {
    const data = fs.readFileSync(inputs.k6Tarball);
    files.push({ name: 'k6-linux-arm64.tar.gz', data, mode: 0o644 });
    k6Tool = { source: 'bundle', file: 'k6-linux-arm64.tar.gz', optional: true, sha256: sha256(data) };
  }
  if (inputs.checks) files.push({ name: 'atl-checks.tar.gz', data: writeTarGz(inputs.checks.entries), mode: 0o644 });
  else missing.push('atl-checks.tar.gz');
  const src = sourceEntries();
  let nodeModules: Record<string, unknown> = { source: 'npm-at-boot' };
  if (inputs.nodeModulesDir && fs.statSync(inputs.nodeModulesDir).isFile()) {
    const data = fs.readFileSync(inputs.nodeModulesDir);
    files.push({ name: WORKSTATION_NODE_MODULES, data, mode: 0o644 });
    nodeModules = { ...(nodeModulesInfo(inputs.nodeModulesDir) ?? {}), source: 'prebuilt', file: WORKSTATION_NODE_MODULES };
  } else if (inputs.nodeModulesDir) {
    src.push(...collectDir(inputs.nodeModulesDir, 'node_modules/'));
    nodeModules = { source: 'in-source' };
  }
  files.push({ name: 'cloudalbum-src.tar.gz', data: writeTarGz(src), mode: 0o644 });
  const manifest = {
    schema: 'atl.workstation-bundle/v1',
    version: inputs.version,
    repoCommit: gitCommit(),
    nodeModules: nodeModules.source !== 'npm-at-boot',
    nodeModulesInfo: nodeModules,
    checksBundleDigest: inputs.checks?.digest ?? null,
    tools: { sessionManagerPlugin: ssmTool, k6: k6Tool },
    files: files.map((f) => ({ name: f.name, sha256: sha256(f.data) })),
    missing,
    notes,
  };
  const tarball = writeTarGz([{ name: 'manifest.json', data: Buffer.from(JSON.stringify(manifest, null, 2) + '\n') }, ...files]);
  return { tarball, manifest };
}

// ---------------------------------------------------------------------------------------------------------------
// Runner node_modules and CloudAlbum release archives

/** ZIP without ZIP64 (custom-resources/src/zip.ts): at most 65,535 entries. */
export const ZIP_MAX_ENTRIES = 65535;

/** Files of no use at run time (type declarations, source maps): dropped from the runner's node_modules. */
const RUNNER_SKIP = /(\.d\.ts|\.d\.mts|\.d\.cts|\.map)$|(^|\/)\.bin\//;

/**
 * node_modules for the runner (CodeBuild ARM_CONTAINER runs scripts/module from cloudalbum-infra.zip, which has no install
 * step): a tarball of regular files only — workspace links dereferenced, no .bin — built by scripts/release-docker on
 * linux-arm64. Returned entries are named node_modules/… .
 */
export function runnerNodeModules(tarball: string): ArchiveEntry[] {
  return readTarGz(fs.readFileSync(tarball))
    .filter((e) => e.name.startsWith('node_modules/') && !RUNNER_SKIP.test(e.name))
    .map((e) => ({ name: e.name, data: e.data, mode: (e.mode ?? 0o644) & 0o111 ? 0o755 : 0o644 }));
}

/** `.release-manifest.json` of a scripts/release archive (`cloudalbum-<ver>-<arch>/.release-manifest.json`). */
export function appArchiveManifest(file: string): Record<string, unknown> | null {
  const hit = readTarGz(fs.readFileSync(file), { stopAt: (n) => /^[^/]+\/\.release-manifest\.json$/.test(n) })[0];
  return hit ? (JSON.parse(hit.data.toString('utf8')) as Record<string, unknown>) : null;
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
  ssmPluginVersion?: string;
  ssmPluginSha256?: Record<string, string>;
  k6Tarball?: string;
  nodeModulesDir?: string;
  runnerNodeModules?: string;
  cloudshellKits: Record<string, string>;
  /** package even when an app archive's atlBundleDigest differs from the check bundle (never for a real release) */
  allowChecksMismatch?: boolean;
}

export function parseOptions(argv: string[]): Options {
  const get = (name: string) => {
    const i = argv.indexOf(name);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  const all = (name: string) => argv.flatMap((a, i) => (a === name && argv[i + 1] ? [argv[i + 1]!] : []));
  const pairs = (name: string) => Object.fromEntries(all(name).map((v) => v.split('=', 2) as [string, string]));
  const tag = get('--tag') ?? releaseTag();
  // `node platform/checks/build.mjs` writes platform/checks/dist/atl/ (platform-checks); 06 PM-04's platform/infra/checks-bundle/dist is the fallback
  const checksDefault = [path.join(PLATFORM_DIR, 'checks', 'dist', 'atl'), path.join(INFRA_DIR, 'checks-bundle', 'dist')].find((d) => fs.existsSync(path.join(d, 'checks'))) ?? path.join(INFRA_DIR, 'checks-bundle', 'dist');
  const shaPairs = pairs('--ssm-plugin-sha256');
  return {
    tag,
    out: get('--out') ?? path.join(INFRA_DIR, 'dist', 'release', tag),
    appArchives: pairs('--app-archive') as Options['appArchives'],
    checksDir: get('--checks-dir') ?? process.env.ATL_CHECKS_BUNDLE_DIR ?? (fs.existsSync(checksDefault) ? checksDefault : undefined),
    contentDir: get('--content-dir'),
    webDir: get('--web-dir') ?? path.join(PLATFORM_DIR, 'web', 'dist'),
    ssmPluginRpm: get('--ssm-plugin-rpm') ?? process.env.ATL_SSM_PLUGIN_RPM,
    ssmPluginVersion: get('--ssm-plugin-version'),
    ...(Object.keys(shaPairs).length ? { ssmPluginSha256: shaPairs } : {}),
    k6Tarball: get('--k6-tarball') ?? process.env.ATL_K6_TARBALL,
    nodeModulesDir: get('--workstation-node-modules'),
    runnerNodeModules: get('--runner-node-modules'),
    cloudshellKits: pairs('--cloudshell-kit'),
    allowChecksMismatch: argv.includes('--allow-checks-mismatch'),
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

export interface PackageResult {
  dir: string;
  files: string[];
  warnings: string[];
  report: Record<string, unknown>;
}

/** Build report next to the release assets (not an asset: not in SHA256SUMS, never published). */
export const PACKAGE_REPORT = 'package-report.json';

export async function packageRelease(opts: Options): Promise<PackageResult> {
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
  const checks = loadChecksBundle(opts.checksDir);
  if (!checks) warnings.push('no check bundle (node platform/checks/build.mjs, or --checks-dir): ATL-RunCheck cannot run on the workstation');
  const appArchives: ArchiveEntry[] = [];
  const appReport: Record<string, unknown>[] = [];
  for (const arch of ['arm64', 'x86_64'] as const) {
    const f = findAppArchive(arch, opts.appArchives[arch]);
    if (f && fs.existsSync(f)) {
      const data = fs.readFileSync(f);
      // the lab instance runs ATL-RunCheck with the platform's digest: the archive must carry the same check bundle
      const m = appArchiveManifest(f);
      const digest = (m?.atlBundleDigest as string | null | undefined) ?? null;
      if (m && m.arch !== arch) throw new Error(`--app-archive ${arch}=${f}: the archive was built for ${String(m.arch)}`);
      if (checks && digest !== checks.digest) {
        const msg = `${path.basename(f)}: atlBundleDigest ${digest ?? 'none'} differs from the check bundle ${checks.digest} (build both with one SOURCE_DATE_EPOCH)`;
        if (!opts.allowChecksMismatch) throw new Error(msg);
        warnings.push(msg);
      }
      files.push({ name: `cloudalbum-app-${arch}.tar.gz`, data });
      // inside the runner source under the scripts/release name (the runner picks cloudalbum-<ver>-<arch>.tgz)
      const base = path.basename(f);
      appArchives.push({ name: /^cloudalbum-.+-(arm64|x86_64)\.tgz$/.test(base) ? base : `cloudalbum-${version}-${arch}.tgz`, data, mode: 0o644 });
      appReport.push({ arch, file: base, sha256: sha256(data), size: data.length, version: m?.version ?? null, atlBundleDigest: digest, build: m?.build ?? null });
    } else warnings.push(`no CloudAlbum release archive for ${arch} (run scripts/release on Linux or pass --app-archive ${arch}=<file>)`);
  }
  const infra = sourceEntries();
  if (checks) infra.push(...checks.entries.map((e) => ({ ...e, name: `atl/${e.name}` })));
  infra.push({ name: 'platform/workflows/runner/dist/atl-runner.mjs', data: await runnerBundle(), mode: 0o644 }, ...appArchives);
  let runnerModules: Record<string, unknown> = { source: 'none' };
  if (opts.runnerNodeModules) {
    const nm = runnerNodeModules(opts.runnerNodeModules);
    if (!nm.length) throw new Error(`--runner-node-modules ${opts.runnerNodeModules}: no node_modules/ entries`);
    const seen = new Set(infra.map((e) => e.name));
    infra.push(...nm.filter((e) => !seen.has(e.name)));
    runnerModules = { ...(nodeModulesInfo(opts.runnerNodeModules) ?? {}), source: 'prebuilt', files: nm.length };
  } else warnings.push('cloudalbum-infra.zip without node_modules: scripts/module cannot run in CodeBuild (pass --runner-node-modules, scripts/release-docker/build.sh)');
  infra.push({ name: 'SHA256SUMS', data: sourceSha256sums(infra), mode: 0o644 });
  if (infra.length > ZIP_MAX_ENTRIES) throw new Error(`cloudalbum-infra.zip would have ${infra.length} entries (ZIP without ZIP64: at most ${ZIP_MAX_ENTRIES})`);
  files.push({ name: 'cloudalbum-infra.zip', data: writeZip(infra) });
  const ssmPlugin = ssmPluginSpec({ version: opts.ssmPluginVersion, sha256: opts.ssmPluginSha256 });
  const compat = protocolCompatVersion();
  if (compat && ssmPlugin.version !== compat) warnings.push(`session-manager-plugin ${ssmPlugin.version} differs from PROTOCOL_COMPAT_VERSION ${compat} (03 §3.5.1)`);
  const ws = await workstationBundle({
    checks,
    ssmPluginRpm: opts.ssmPluginRpm,
    ssmPlugin,
    k6Tarball: opts.k6Tarball,
    nodeModulesDir: opts.nodeModulesDir,
    version,
  });
  for (const m of (ws.manifest.missing as string[]) ?? []) warnings.push(`workstation bundle without ${m}`);
  for (const n of (ws.manifest.notes as string[]) ?? []) warnings.push(`workstation bundle: ${n}`);
  if (!opts.nodeModulesDir) warnings.push('workstation bundle without node_modules: the workstation installs them from the npm registry at boot');
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
  // what went into this release (read by scripts/verify/preflight.mjs; not a release asset, publish-s3 skips it)
  const report = {
    schema: 'atl.package-report/v1',
    tag: opts.tag,
    version,
    repoCommit: gitCommit(),
    createdAt: process.env.SOURCE_DATE_EPOCH ? new Date(Number(process.env.SOURCE_DATE_EPOCH) * 1000).toISOString() : new Date().toISOString(),
    checksBundleDigest: checksDigest || null,
    web: web.placeholder ? 'placeholder' : 'built',
    content: { catalogVersion: content.catalogVersion, placeholder: content.placeholder },
    appArchives: appReport,
    runnerNodeModules: runnerModules,
    infraZipEntries: infra.length,
    workstation: { nodeModules: ws.manifest.nodeModulesInfo, tools: ws.manifest.tools },
    warnings,
  };
  fs.writeFileSync(path.join(opts.out, PACKAGE_REPORT), JSON.stringify(report, null, 2) + '\n');
  return {
    dir: opts.out,
    files: [...files.map((f) => f.name), TEMPLATE_FILE_NAME, 'SHA256SUMS', 'release-manifest.json', 'launch-stack.md', PACKAGE_REPORT],
    warnings,
    report,
  };
}

async function main(): Promise<void> {
  // `--emit-source <file>`: only write the repository subset of the workstation / runner (cloudalbum-src.tar.gz) — the input
  // of the node_modules prebuild (scripts/release-docker, bootstrap/install-node-modules.sh)
  const emit = process.argv.indexOf('--emit-source');
  if (emit >= 0) {
    const file = process.argv[emit + 1];
    if (!file) throw new Error('--emit-source needs a file');
    fs.writeFileSync(file, writeTarGz(sourceEntries()));
    console.log(`source subset → ${file}`);
    return;
  }
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
