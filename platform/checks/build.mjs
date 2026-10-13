#!/usr/bin/env node
// Build the ATL check bundle (04 §6.2, §6.3; 06 PM-04):
//
//   node platform/checks/build.mjs [--out <dir>] [--created-at <ISO>]
//
// writes <out>/atl/checks/<bundleDigest>/{manifest.json, runner.mjs, args-schemas.mjs, lib/*, checks/*, schemas/*},
// <out>/atl/bin/atl-check (the bash launcher installed at /opt/atl/bin/atl-check), <out>/atl/bin/atl-check.mjs (Node
// launcher for ATL_DEV_MODE and tests) and <out>/bundle.json { bundleDigest, version, createdAt, checks }.
// bundleDigest = SHA-256 of manifest.json (= the directory name). `scripts/release` copies <out>/atl/ into the CloudAlbum
// release archive (`atl/checks/<digest>/`, `atl/bin/atl-check`) and records the digest in .release-manifest.json
// (atlBundleDigest); the platform release registers the same digest. Default <out> is platform/checks/dist.
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SRC = path.join(HERE, 'src');

function sha256(buf) {
  return createHash('sha256').update(buf).digest('hex');
}

function listFiles(dir, rel = '') {
  const out = [];
  for (const e of fs.readdirSync(path.join(dir, rel), { withFileTypes: true })) {
    const r = rel ? `${rel}/${e.name}` : e.name;
    if (e.isDirectory()) out.push(...listFiles(dir, r));
    else if (e.name.endsWith('.mjs')) out.push(r);
  }
  return out.sort();
}

export function bundleVersion() {
  return fs.readFileSync(path.join(HERE, 'VERSION'), 'utf8').trim();
}

/** Build the bundle into `outDir`; returns { bundleDigest, dir, manifest }. Deterministic for a fixed `createdAt`. */
export async function buildBundle({ outDir = path.join(HERE, 'dist'), createdAt = process.env.SOURCE_DATE_EPOCH ? new Date(Number(process.env.SOURCE_DATE_EPOCH) * 1000).toISOString() : new Date().toISOString(), clean = true } = {}) {
  const { ARGS_SCHEMAS, ALIASES } = await import(pathToFileURL(path.join(SRC, 'args-schemas.mjs')).href);
  const sources = listFiles(SRC);
  const checkIds = sources.filter((f) => f.startsWith('checks/')).map((f) => f.slice('checks/'.length, -'.mjs'.length)).sort();
  const missingSchemas = checkIds.filter((id) => !ARGS_SCHEMAS[id]);
  const orphanSchemas = Object.keys(ARGS_SCHEMAS).filter((id) => !checkIds.includes(id));
  if (missingSchemas.length || orphanSchemas.length) throw new Error(`check modules and args schemas differ: missing ${missingSchemas} orphan ${orphanSchemas}`);
  for (const [alias, target] of Object.entries(ALIASES)) if (!checkIds.includes(target)) throw new Error(`alias ${alias} → unknown ${target}`);

  const files = new Map();
  for (const rel of sources) files.set(rel, fs.readFileSync(path.join(SRC, rel)));
  for (const id of checkIds) files.set(`schemas/${id}.args.json`, Buffer.from(`${JSON.stringify(ARGS_SCHEMAS[id], null, 2)}\n`));

  const manifest = {
    purpose: 'atl-checkbundle/v1',
    version: bundleVersion(),
    createdAt,
    files: Object.fromEntries([...files.entries()].sort(([a], [b]) => (a < b ? -1 : 1)).map(([rel, buf]) => [rel, `sha256:${sha256(buf)}`])),
    checks: checkIds,
    aliases: ALIASES,
  };
  const manifestBytes = Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`);
  const bundleDigest = sha256(manifestBytes);

  const atl = path.join(outDir, 'atl');
  if (clean) fs.rmSync(atl, { recursive: true, force: true });
  const dir = path.join(atl, 'checks', bundleDigest);
  for (const [rel, buf] of files) {
    fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
    fs.writeFileSync(path.join(dir, rel), buf);
  }
  fs.writeFileSync(path.join(dir, 'manifest.json'), manifestBytes);
  fs.mkdirSync(path.join(atl, 'bin'), { recursive: true });
  fs.copyFileSync(path.join(HERE, 'bin', 'atl-check'), path.join(atl, 'bin', 'atl-check'));
  fs.chmodSync(path.join(atl, 'bin', 'atl-check'), 0o755);
  fs.copyFileSync(path.join(HERE, 'bin', 'atl-check.mjs'), path.join(atl, 'bin', 'atl-check.mjs'));
  const info = { bundleDigest, version: manifest.version, createdAt, checks: checkIds, launcher: 'atl/bin/atl-check', devLauncher: 'atl/bin/atl-check.mjs' };
  fs.writeFileSync(path.join(outDir, 'bundle.json'), `${JSON.stringify(info, null, 2)}\n`);
  return { bundleDigest, dir, manifest };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const arg = (name) => {
    const i = process.argv.indexOf(name);
    return i > 0 ? process.argv[i + 1] : undefined;
  };
  const out = arg('--out');
  const createdAt = arg('--created-at');
  const r = await buildBundle({ ...(out ? { outDir: path.resolve(out) } : {}), ...(createdAt ? { createdAt } : {}) });
  process.stdout.write(`${JSON.stringify({ bundleDigest: r.bundleDigest, version: r.manifest.version, dir: r.dir, checks: r.manifest.checks.length })}\n`);
}
