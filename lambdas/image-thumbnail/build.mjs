// esbuild 打包：nodejs22.x arm64，ESM 输出 dist/index.mjs（Lambda handler = index.handler）。
// sharp 是原生模块，不打进 bundle：部署包需要在 dist/ 下单独安装 linux-arm64 版本
//   npm install --prefix dist --os=linux --cpu=arm64 sharp
// （由 image-processing 模块实现者在 scripts/module 的 package 步骤中完成；本机不需要 AWS 凭证）。
import { build } from 'esbuild';

await build({
  entryPoints: ['src/handler.ts'],
  outfile: 'dist/index.mjs',
  bundle: true,
  platform: 'node',
  target: 'node22',
  format: 'esm',
  sourcemap: true,
  minify: false,
  external: ['sharp', '@aws-sdk/*'],
  banner: { js: "import { createRequire as __cr } from 'node:module'; const require = __cr(import.meta.url);" },
});
console.log('built lambdas/image-thumbnail → dist/index.mjs');
