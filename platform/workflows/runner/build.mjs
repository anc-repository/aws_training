// Bundles the runner (src/runner/main.ts) into runner/dist/atl-runner.mjs, which the release packaging puts into
// cloudalbum-infra.zip next to buildspec.yml. Node 22, ESM, no AWS SDK (the runner calls the AWS CLI of the image).
import { build } from 'esbuild';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));

export async function bundleRunner({ write = true } = {}) {
  return build({
    entryPoints: [path.join(HERE, '..', 'src', 'runner', 'main.ts')],
    outfile: path.join(HERE, 'dist', 'atl-runner.mjs'),
    bundle: true,
    platform: 'node',
    target: 'node22',
    format: 'esm',
    sourcemap: false,
    write,
    metafile: true,
    logLevel: 'warning',
    plugins: [
      {
        name: 'atl-shared-sources',
        setup(b) {
          b.onResolve({ filter: /^@atl\/shared$/ }, () => ({ path: path.join(HERE, '..', '..', 'shared', 'src', 'index.ts') }));
        },
      },
    ],
    banner: { js: "import { createRequire as __cr } from 'node:module'; const require = __cr(import.meta.url);" },
  });
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  await bundleRunner();
  console.log('bundled platform/workflows/runner/dist/atl-runner.mjs');
}
