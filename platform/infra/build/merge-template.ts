/**
 * Build the single-stack platform template `atl-platform.template.json` (01 §4.4, §4.5, §13):
 *   1. merge `src/NN-*.yaml` (sections merged key by key; duplicates are an error);
 *   2. add the generated resources of build/template-parts.ts (functions, state machines);
 *   3. resolve the build tokens: @@POLICY:<Name>@@ (build/gen-policies.ts), @@SSM_CONTENT:<Name>@@ (ssm/<Name>.yaml),
 *      @@MANIFEST@@ (release SHA-256 manifest from build/package.ts), @@DEPENDS_ON_ALL@@, @@EC2_TRUST@@,
 *      @@ATL_VERIFIED_REGIONS@@, @@ATL_VERSION@@, @@ATL_RELEASE_TAG@@, @@ATL_GITHUB_REPOSITORY@@;
 *   4. refuse leftovers and write dist/atl-platform.template.json.
 *
 *   npm run template -w @atl/infra     (root: npm run platform:build runs it after the Lambda bundles)
 * Without a packaged release (dist/release/<tag>/release-manifest.json) the embedded manifest is empty: such a template only
 * installs with ReleaseVersion=dev + ArtifactSource=s3 (01 §4.9), where CopyArtifacts trusts SHA256SUMS under ArtifactBaseUrl.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse as parseYaml } from 'yaml';
import { parseCfnYaml } from './cfn-yaml.js';
import { compilePolicies } from './gen-policies.js';
import { collectReferences } from './intrinsics.js';
import { ec2TrustPolicy, functionResources, loadDevSubstitutions, stateMachineResources } from './template-parts.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const INFRA_ROOT = path.resolve(HERE, '..');
export const TEMPLATE_FILE_NAME = 'atl-platform.template.json';
const SECTIONS = ['Metadata', 'Parameters', 'Rules', 'Mappings', 'Conditions', 'Transform', 'Resources', 'Outputs'] as const;

export interface MergeResult {
  template: Record<string, unknown>;
  fragments: string[];
}

export function mergeFragments(fragments: { name: string; text: string }[], version: string): MergeResult {
  const template: Record<string, unknown> = {
    AWSTemplateFormatVersion: '2010-09-09',
    Description: `AWS Training Lab (ATL) platform ${version}`,
    Metadata: { AtlPlatformVersion: version },
  };
  for (const f of [...fragments].sort((a, b) => a.name.localeCompare(b.name))) {
    const doc = parseCfnYaml(f.text);
    for (const [k, v] of Object.entries(doc)) {
      if (k === 'AWSTemplateFormatVersion' || k === 'Description') continue;
      if (!(SECTIONS as readonly string[]).includes(k)) throw new Error(`${f.name}: unknown top-level section ${k}`);
      if (v === null || typeof v !== 'object' || Array.isArray(v)) throw new Error(`${f.name}: section ${k} must be a mapping`);
      const target = (template[k] ??= {}) as Record<string, unknown>;
      for (const [name, def] of Object.entries(v as Record<string, unknown>)) {
        if (name in target) throw new Error(`${f.name}: duplicate ${k}.${name}`);
        target[name] = def;
      }
    }
  }
  return { template, fragments: fragments.map((f) => f.name).sort() };
}

// ---------------------------------------------------------------------------------------------------------------
// Release settings and manifest

export interface ReleaseConfig {
  githubRepository: string;
  verifiedRegions: string[];
  ec2TrustSourceAccount: boolean;
  templateBucket: string;
}

export interface ManifestFile {
  Name: string;
  Sha256: string;
  Size: number;
}

/** Embedded in CopyArtifacts (01 §4.5): the files of this release and the check bundle digest (04 §6.2). */
export interface ReleaseManifest {
  Files: ManifestFile[];
  ChecksBundleDigest: string;
}

export const EMPTY_MANIFEST: ReleaseManifest = { Files: [], ChecksBundleDigest: '' };

export function loadReleaseConfig(): ReleaseConfig {
  const raw = JSON.parse(fs.readFileSync(path.join(INFRA_ROOT, 'release.config.json'), 'utf8')) as Partial<ReleaseConfig>;
  if (!raw.githubRepository || !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(raw.githubRepository)) throw new Error('release.config.json: githubRepository must be <owner>/<repo>');
  if (!Array.isArray(raw.verifiedRegions) || !raw.verifiedRegions.length) throw new Error('release.config.json: verifiedRegions must be a non-empty list');
  return {
    githubRepository: raw.githubRepository,
    verifiedRegions: raw.verifiedRegions.map(String),
    ec2TrustSourceAccount: raw.ec2TrustSourceAccount !== false,
    templateBucket: String(raw.templateBucket ?? ''),
  };
}

export function platformVersion(): string {
  return fs.readFileSync(path.join(INFRA_ROOT, '..', 'VERSION'), 'utf8').trim();
}

/** GitHub release tag / ReleaseVersion of a platform version (`v<VERSION>`, 01 §4.2). */
export function releaseTag(version: string = platformVersion()): string {
  return `v${version}`;
}

export function releaseDir(tag: string = releaseTag()): string {
  return path.join(INFRA_ROOT, 'dist', 'release', tag);
}

export function readReleaseManifest(tag: string = releaseTag()): ReleaseManifest | null {
  const file = path.join(releaseDir(tag), 'release-manifest.json');
  return fs.existsSync(file) ? (JSON.parse(fs.readFileSync(file, 'utf8')) as ReleaseManifest) : null;
}

// ---------------------------------------------------------------------------------------------------------------
// Tokens

export function loadSsmContent(name: string): unknown {
  const file = path.join(INFRA_ROOT, 'ssm', `${name}.yaml`);
  return parseYaml(fs.readFileSync(file, 'utf8'), { version: '1.2' });
}

function resolveTokens(node: unknown, ctx: { policies: Record<string, unknown>; replacements: Record<string, unknown>; text: Record<string, string> }): unknown {
  if (typeof node === 'string') {
    const policy = /^@@POLICY:([A-Za-z0-9-]+)@@$/.exec(node);
    if (policy) {
      const doc = ctx.policies[policy[1]!];
      if (!doc) throw new Error(`unknown policy ${policy[1]}`);
      return structuredClone(doc);
    }
    const ssm = /^@@SSM_CONTENT:([A-Za-z0-9-]+)@@$/.exec(node);
    if (ssm) return loadSsmContent(ssm[1]!);
    if (node in ctx.replacements) return structuredClone(ctx.replacements[node]);
    let s = node;
    for (const [token, value] of Object.entries(ctx.text)) s = s.split(token).join(value);
    return s;
  }
  if (Array.isArray(node)) return node.map((n) => resolveTokens(n, ctx));
  if (node && typeof node === 'object') {
    return Object.fromEntries(Object.entries(node as Record<string, unknown>).map(([k, v]) => [k, resolveTokens(v, ctx)]));
  }
  return node;
}

function findLeftovers(node: unknown, at: string, out: string[]): void {
  if (typeof node === 'string') {
    if (node.includes('@@')) out.push(`${at}: ${node.slice(0, 80)}`);
  } else if (Array.isArray(node)) node.forEach((n, i) => findLeftovers(n, `${at}[${i}]`, out));
  else if (node && typeof node === 'object') for (const [k, v] of Object.entries(node)) findLeftovers(v, `${at}.${k}`, out);
}

/**
 * All unconditional resources except the given ones (CloudFormation rejects DependsOn on a resource that is not created),
 * minus those the resource already references (Ref / GetAtt / Sub enforce the dependency anyway).
 */
export function unconditionalResources(resources: Record<string, Record<string, unknown>>, except: string[], self?: string): string[] {
  const referenced = self ? collectReferences(resources[self]!.Properties ?? {}) : new Set<string>();
  return Object.keys(resources)
    .filter((id) => !except.includes(id) && !resources[id]!.Condition && !referenced.has(id))
    .sort();
}

export interface BuildOptions {
  version?: string;
  manifest?: ReleaseManifest;
  config?: ReleaseConfig;
}

export function buildTemplate(opts: BuildOptions = {}): Record<string, unknown> {
  const version = opts.version ?? platformVersion();
  const config = opts.config ?? loadReleaseConfig();
  const manifest = opts.manifest ?? readReleaseManifest(releaseTag(version)) ?? EMPTY_MANIFEST;
  const srcDir = path.join(INFRA_ROOT, 'src');
  const fragments = fs
    .readdirSync(srcDir)
    .filter((f) => /^\d{2}-[a-z0-9-]+\.ya?ml$/.test(f))
    .map((name) => ({ name, text: fs.readFileSync(path.join(srcDir, name), 'utf8') }));
  const { template } = mergeFragments(fragments, version);
  const resources = template.Resources as Record<string, Record<string, unknown>>;
  for (const [id, def] of Object.entries({ ...functionResources(), ...stateMachineResources(loadDevSubstitutions()) })) {
    if (id in resources) throw new Error(`generated resource ${id} collides with a fragment`);
    resources[id] = def as Record<string, unknown>;
  }
  // DependsOn of the two guards (01 §4.6 ordering)
  resources.UninstallGuard!.DependsOn = unconditionalResources(resources, ['UninstallGuard', 'StackGuard'], 'UninstallGuard');
  resources.StackGuard!.DependsOn = unconditionalResources(resources, ['StackGuard'], 'StackGuard');
  (template.Metadata as Record<string, unknown>).AtlReleaseTag = releaseTag(version);
  const resolved = resolveTokens(template, {
    policies: compilePolicies(),
    replacements: {
      '@@MANIFEST@@': manifest,
      '@@EC2_TRUST@@': ec2TrustPolicy(config.ec2TrustSourceAccount),
      '@@ATL_VERIFIED_REGIONS@@': config.verifiedRegions,
    },
    text: {
      '@@ATL_VERSION@@': version,
      '@@ATL_RELEASE_TAG@@': releaseTag(version),
      '@@ATL_GITHUB_REPOSITORY@@': config.githubRepository,
    },
  }) as Record<string, unknown>;
  const leftovers: string[] = [];
  findLeftovers(resolved, 'template', leftovers);
  if (leftovers.length) throw new Error(`unresolved build tokens:\n  ${leftovers.join('\n  ')}`);
  return resolved;
}

export function templateStats(template: Record<string, unknown>): { resources: number; bytes: number } {
  return { resources: Object.keys(template.Resources as object).length, bytes: Buffer.byteLength(JSON.stringify(template)) };
}

export function writeTemplate(template: Record<string, unknown>, file: string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(template, null, 1) + '\n');
}

function main(): void {
  const template = buildTemplate();
  const out = path.join(INFRA_ROOT, 'dist', TEMPLATE_FILE_NAME);
  writeTemplate(template, out);
  const stats = templateStats(template);
  console.log(`template → ${path.relative(process.cwd(), out)} (${stats.resources} resources, ${(stats.bytes / 1024).toFixed(0)} KiB minified)`);
}

if (process.argv[1] && /merge-template\.(ts|js)$/.test(process.argv[1])) main();
