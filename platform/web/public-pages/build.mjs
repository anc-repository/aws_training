#!/usr/bin/env node
// 公开静态入口的独立构建（08 §0、§2.2、§6.11；04 §9.5、§10.6）。与 SPA 分开打包，产物不进 platform/web/dist（atl-web.zip），
// 以免 WebDeploy 覆盖 atl-certs 发布的页面（见 docs/implementation-notes.md platform-web-results）。
//
//   node platform/web/public-pages/build.mjs                       → public-pages/dist/
//     verify/index.html  verify/verify.js  verify/verify.css      P09-V（与 atl-certs 发布的 verify/ 同一布局，另加同源样式表）
//     share/render-share.mjs                                       P08-S 渲染器（ESM，atl-certs 可在 Node 中 import）
//     share/sample/index.html  share/sample/report.json            用 share/sample-report.json 渲染的示例副本
//   node platform/web/public-pages/build.mjs --share <report.json> --out <dir> [--published-at <ISO>] [--expires-at <ISO|none>]
//     → <dir>/index.html + <dir>/report.json（与 atl-certs 写入 share/<shareId>/ 的两个对象相同）
//
// 只用仓库已有的 vite（不联网、不部署）。
import { copyFile, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { build } from 'vite';

const here = path.dirname(fileURLToPath(import.meta.url));
const webRoot = path.resolve(here, '..');
const outDir = path.join(here, 'dist');

function arg(name) {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

const alias = [{ find: /^@atl\/shared$/, replacement: path.join(webRoot, '../shared/src/index.ts') }];

async function bundle(entry, dir, fileName, format) {
  await build({
    configFile: false,
    root: webRoot,
    logLevel: 'warn',
    resolve: { alias },
    build: {
      outDir: dir,
      emptyOutDir: false,
      copyPublicDir: false,
      minify: format === 'iife',
      sourcemap: false,
      target: 'es2020',
      lib: { entry: path.join(webRoot, entry), formats: [format], name: 'AtlPublic', fileName: () => fileName },
      rollupOptions: { output: { inlineDynamicImports: true } },
    },
  });
}

async function checkStatic() {
  const html = await readFile(path.join(here, 'verify/index.html'), 'utf8');
  const css = await readFile(path.join(here, 'verify/verify.css'), 'utf8');
  const problems = [];
  if (/<style/i.test(html) || /\sstyle=/i.test(html)) problems.push('verify/index.html must not use inline styles (CSP atl-web-verify has no style-src)');
  if (/<script(?![^>]*\ssrc=)/i.test(html)) problems.push('verify/index.html must not contain inline scripts');
  if (/@import|url\(/i.test(css)) problems.push('verify/verify.css must not load external resources');
  if (problems.length) throw new Error(problems.join('\n'));
}

async function renderShare(rendererUrl, reportPath, dir, publishedAt, expiresAt) {
  const { renderShareHtml, shareReportJson } = await import(rendererUrl);
  const report = JSON.parse(await readFile(reportPath, 'utf8'));
  await mkdir(dir, { recursive: true });
  await writeFile(path.join(dir, 'index.html'), renderShareHtml(report, { publishedAt, expiresAt }));
  await writeFile(path.join(dir, 'report.json'), shareReportJson(report));
}

async function main() {
  await checkStatic();
  await rm(outDir, { recursive: true, force: true });
  const verifyDir = path.join(outDir, 'verify');
  const shareDir = path.join(outDir, 'share');
  await mkdir(verifyDir, { recursive: true });
  await bundle('src/pages/verify/verifyEntry.ts', verifyDir, 'verify.js', 'iife');
  await copyFile(path.join(here, 'verify/index.html'), path.join(verifyDir, 'index.html'));
  await copyFile(path.join(here, 'verify/verify.css'), path.join(verifyDir, 'verify.css'));
  await bundle('src/pages/share/renderShare.ts', shareDir, 'render-share.mjs', 'es');
  const rendererUrl = pathToFileURL(path.join(shareDir, 'render-share.mjs')).href;
  const now = new Date().toISOString();
  await renderShare(rendererUrl, path.join(here, 'share/sample-report.json'), path.join(shareDir, 'sample'), now, new Date(Date.parse(now) + 30 * 86_400_000).toISOString());

  const reportArg = arg('--share');
  if (reportArg) {
    const out = arg('--out');
    if (!out) throw new Error('--share needs --out <dir>');
    const exp = arg('--expires-at');
    await renderShare(rendererUrl, path.resolve(reportArg), path.resolve(out), arg('--published-at') ?? now, !exp || exp === 'none' ? null : exp);
    console.log(`share copy → ${path.resolve(out)}`);
  }
  for (const f of ['verify/index.html', 'verify/verify.js', 'verify/verify.css', 'share/render-share.mjs', 'share/sample/index.html', 'share/sample/report.json']) {
    const s = await stat(path.join(outDir, f));
    console.log(`${f.padEnd(28)} ${String(s.size).padStart(8)} B`);
  }
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
