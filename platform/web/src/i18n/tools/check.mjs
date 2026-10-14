#!/usr/bin/env node
/**
 * `npm run i18n:check`（09 §1.5，决定 I2 的 CI 检查）：ja 与 en 词典是否覆盖 zh-CN 的全部键、有没有多余的键、占位符
 * （`{name}` 与复数变量）是否一致，以及 ja / en 的骨架是否与 zh-CN 同步（`npm run i18n:sync --check`）。
 *
 *   --allow-empty   空字符串（尚未翻译）只计数、不算失败（翻译进行中的阶段用）
 *   --json          机器可读的结果
 * 另外检查 ja 词典的表记（glossary.md 的日语表记规则：ブラウザー、パラメーター 等的长音，半角“ + ”而不是全角“＋”），
 * 与 `labs:lint` 的 I6 规则相同。
 * 退出码：0 通过；1 有问题。用 tsx 运行（导入 TypeScript 词典）。
 */
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { sync } from './sync.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const I18N = path.resolve(HERE, '..');
const imp = (f) => import(pathToFileURL(path.join(I18N, f)).href);

/** 日语表记规则（与 scripts/labs/src/lint/i18n.ts 的 JA_ORTHOGRAPHY 相同）。 */
const JA_ORTHOGRAPHY = [
  [/ブラウザ(?!ー)/, 'ブラウザー'],
  [/パラメータ(?!ー)/, 'パラメーター'],
  [/サーバ(?![ーレ])/, 'サーバー'],
  [/ユーザ(?!ー)/, 'ユーザー'],
  [/フォルダ(?!ー)/, 'フォルダー'],
  [/＋/, '半角“ + ”'],
];

/** ja 词典里违反表记规则的键。 */
export function orthographyIssues(dict, path = []) {
  const out = [];
  for (const [k, v] of Object.entries(dict ?? {})) {
    if (typeof v === 'string') {
      for (const [re, use] of JA_ORTHOGRAPHY) if (re.test(v)) out.push({ key: [...path, k].join('.'), detail: `${re.source} → ${use}` });
    } else if (v && typeof v === 'object') out.push(...orthographyIssues(v, [...path, k]));
  }
  return out;
}

async function main() {
  const allowEmpty = process.argv.includes('--allow-empty');
  const asJson = process.argv.includes('--json');
  const [{ zhCN }, { ja }, { en }, { compareDicts, coverage }] = await Promise.all([imp('zh-CN.ts'), imp('ja.ts'), imp('en.ts'), imp('dict.ts')]);
  const stale = await sync({ check: true });
  const result = {};
  let failed = stale.length > 0;
  const ortho = orthographyIssues(ja);
  if (ortho.length) failed = true;
  for (const [lang, dict] of [['ja', ja], ['en', en]]) {
    const issues = compareDicts(zhCN, dict);
    const blocking = issues.filter((i) => i.kind !== 'empty' || !allowEmpty);
    if (blocking.length) failed = true;
    result[lang] = { coverage: coverage(zhCN, dict), issues };
  }
  if (asJson) {
    process.stdout.write(`${JSON.stringify({ ok: !failed, stale, ...result }, null, 2)}\n`);
  } else {
    for (const s of stale) console.log(`✗ skeleton out of date: ${s} (run npm run i18n:sync)`);
    for (const o of ortho) console.log(`✗ ja orthography: ${o.key} — ${o.detail}`);
    for (const lang of ['ja', 'en']) {
      const { coverage: c, issues } = result[lang];
      const byKind = (k) => issues.filter((i) => i.kind === k);
      for (const k of ['missing', 'extra', 'placeholders', 'type']) for (const i of byKind(k)) console.log(`✗ ${lang} ${k}: ${i.key}${i.detail ? ` — ${i.detail}` : ''}`);
      const empty = byKind('empty');
      if (empty.length && !allowEmpty) for (const i of empty.slice(0, 50)) console.log(`✗ ${lang} untranslated: ${i.key}`);
      if (empty.length > 50 && !allowEmpty) console.log(`  … ${empty.length - 50} more untranslated ${lang} key(s)`);
      console.error(`i18n:check ${lang}: ${c.translated}/${c.total} translated, ${empty.length} untranslated, ${issues.length - empty.length} structural issue(s)`);
    }
  }
  return failed ? 1 : 0;
}

main().then(
  (code) => {
    process.exitCode = code;
  },
  (e) => {
    console.error(e instanceof Error ? (e.stack ?? e.message) : String(e));
    process.exitCode = 2;
  },
);
