// esbuild bundles of the platform Lambda functions: nodejs22.x, arm64, ESM → dist-lambda/<function>/index.mjs
// (handler = index.handler). @aws-sdk/* is provided by the Lambda runtime and stays external (same convention as
// lambdas/image-thumbnail). Fails if a production bundle pulls in dev code (src/dev/**) or the simulator (@atl/workflows).
import { build } from 'esbuild';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));

/** Lambda name → source directory under src/functions (01 §13). */
export const FUNCTIONS = {
  'atl-api': 'api',
  'atl-public': 'public',
  'atl-agent': 'agent',
  'atl-checks': 'checks',
  'atl-lifecycle': 'lifecycle',
  'atl-timer': 'timer',
  'atl-reaper': 'reaper',
  'atl-certs': 'certs',
  'atl-pricing': 'pricing',
  'atl-custom-resources': 'custom-resources',
  'atl-copy-artifacts': 'copy-artifacts',
  'atl-tagger': 'tagger',
};

/** Workspace packages are bundled from their TypeScript sources (no prior tsc build needed). */
const WORKSPACE_SOURCES = {
  '@atl/shared': path.join(HERE, '../shared/src/index.ts'),
  '@atl/shared/node': path.join(HERE, '../shared/src/node.ts'),
};
const workspaceSources = {
  name: 'atl-workspace-sources',
  setup(b) {
    b.onResolve({ filter: /^@atl\/shared(\/node)?$/ }, (args) => ({ path: WORKSPACE_SOURCES[args.path] }));
  },
};

/** Inputs that must never reach a production bundle. */
export function forbiddenInputs(metafile) {
  return Object.keys(metafile.inputs).filter((p) => /(^|[\\/])src[\\/]dev[\\/]/.test(p) || /platform[\\/]workflows[\\/]/.test(p));
}

export async function bundleFunction(name, { write = true } = {}) {
  const dir = FUNCTIONS[name];
  const r = await build({
    entryPoints: [path.join(HERE, 'src', 'functions', dir, 'index.ts')],
    outfile: path.join(HERE, 'dist-lambda', name, 'index.mjs'),
    bundle: true,
    platform: 'node',
    target: 'node22',
    format: 'esm',
    sourcemap: true,
    minify: false,
    write,
    metafile: true,
    logLevel: 'warning',
    plugins: [workspaceSources],
    external: ['@aws-sdk/*'],
    banner: { js: "import { createRequire as __cr } from 'node:module'; const require = __cr(import.meta.url);" },
  });
  const bad = forbiddenInputs(r.metafile);
  if (bad.length) throw new Error(`${name}: production bundle includes dev code: ${bad.join(', ')}`);
  return r;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  fs.rmSync(path.join(HERE, 'dist-lambda'), { recursive: true, force: true });
  for (const name of Object.keys(FUNCTIONS)) {
    await bundleFunction(name);
    console.log(`bundled ${name} → platform/api/dist-lambda/${name}/index.mjs`);
  }
}
