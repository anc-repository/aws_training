/**
 * npm run gen:registry —— modules/registry.yaml → packages/contracts/src/generated/registry.ts
 *
 * “后端（构建时内联为 JSON）、scripts/module、实验运行器、前端 /lab 都读它”（总纲 §3.4）：
 * 生成的文件经 `@cloudalbum/contracts/registry` 导出，后端与前端都从这里读取，运行时不解析 YAML。
 * 校验失败（不符合 registry.schema.json）时不写文件，退出码 1。
 */
import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { GENERATED_TS, loadRegistry, renderGenerated, validateRegistrySchema, REPO_ROOT } from './lib.js';

const loaded = loadRegistry();
const errors = validateRegistrySchema(loaded.doc);
if (errors.length) {
  console.error(`modules/registry.yaml 不符合 registry.schema.json（${errors.length} 处）：`);
  for (const e of errors) console.error(`  - ${e}`);
  process.exit(1);
}
const content = renderGenerated(loaded);
const current = existsSync(GENERATED_TS) ? readFileSync(GENERATED_TS, 'utf8') : '';
if (current !== content) {
  mkdirSync(path.dirname(GENERATED_TS), { recursive: true });
  writeFileSync(GENERATED_TS, content, 'utf8');
  console.log(`gen:registry → ${path.relative(REPO_ROOT, GENERATED_TS)} (${Object.keys(loaded.doc.modules).length} modules)`);
} else {
  console.log('gen:registry: up to date');
}
