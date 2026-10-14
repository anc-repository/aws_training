#!/usr/bin/env node
/**
 * `npm run i18n:sync`（09 §1.5）：按 zh-CN 词典（src/i18n/zh-CN/<ns>.ts）生成 / 更新 ja、en 的骨架（src/i18n/<lang>/<ns>.ts）
 * 与三个合并文件（zh-CN.ts、ja.ts、en.ts）。
 *
 * - 已有的译文原样保留；新增的键写成空字符串（= 未翻译，运行时按回退链显示）；zh-CN 中已删除的键从 ja / en 中删除；
 * - 每个叶子的行尾注释是 zh-CN 原文，方便翻译与审校；
 * - `core` 命名空间展开到顶层（app、nav、errors、…），其他命名空间以文件名为键。
 * 用 tsx 运行（导入 TypeScript 词典）：`tsx platform/web/src/i18n/tools/sync.mjs [--check]`；`--check` 只报告是否需要更新。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const I18N = path.resolve(HERE, '..');
const LANGS = ['ja', 'en'];
const LANG_LABEL = { ja: 'ja（日本語）', en: 'en（English）' };

const IDENT = /^[A-Za-z_$][\w$]*$/;
const q = (s) => `'${String(s).replace(/\\/g, '\\\\').replace(/'/g, "\\'").replace(/\n/g, '\\n')}'`;
const key = (k) => (IDENT.test(k) ? k : q(k));
const comment = (s) => String(s).replace(/\r?\n/g, ' ⏎ ');

export function namespaces() {
  return fs
    .readdirSync(path.join(I18N, 'zh-CN'))
    .filter((f) => f.endsWith('.ts'))
    .map((f) => f.slice(0, -3))
    .sort((a, b) => (a === 'core' ? -1 : b === 'core' ? 1 : a < b ? -1 : 1));
}

async function load(file) {
  if (!fs.existsSync(file)) return undefined;
  const mod = await import(`${pathToFileURL(file).href}?t=${Date.now()}`);
  return mod.default;
}

/** 按 zh 的结构写出 `value`（取已有译文，否则空字符串）。 */
function render(zh, existing, indent) {
  const pad = '  '.repeat(indent);
  if (Array.isArray(zh)) {
    const lines = zh.map((z, i) => {
      const e = Array.isArray(existing) ? existing[i] : undefined;
      if (z && typeof z === 'object') return `${pad}  ${render(z, e, indent + 1)},`;
      return `${pad}  ${q(typeof e === 'string' ? e : '')}, // ${comment(z)}`;
    });
    return `[\n${lines.join('\n')}\n${pad}]`;
  }
  const lines = Object.entries(zh).map(([k, z]) => {
    const e = existing && typeof existing === 'object' ? existing[k] : undefined;
    if (z && typeof z === 'object') return `${pad}  ${key(k)}: ${render(z, e, indent + 1)},`;
    return `${pad}  ${key(k)}: ${q(typeof e === 'string' ? e : '')}, // ${comment(z)}`;
  });
  return `{\n${lines.join('\n')}\n${pad}}`;
}

function nsFile(lang, ns, zh, existing) {
  return `/**
 * ${LANG_LABEL[lang]}：${ns === 'core' ? '框架与全局文案' : `命名空间 ${ns}`}。由 \`npm run i18n:sync\` 按 zh-CN 词典维护结构：
 * 只填写引号内的译文（空字符串 = 未翻译，运行时按 ${lang} → en → zh-CN 回退）；行尾注释是 zh-CN 原文。
 * 术语与风格见 ../glossary.md（不翻译 AWS 服务名、CLI 命令、代码、资源名、API 路径、环境变量）。
 */
import type { Dict } from '../dict';
import type zh from '../zh-CN/${ns}';

export default ${render(zh, existing, 0)} satisfies Dict<typeof zh>;
`;
}

function aggregate(lang, list) {
  const name = lang === 'zh-CN' ? 'zhCN' : lang;
  const imports = list.map((ns) => `import ${ns === 'core' ? 'core' : ns} from './${lang}/${ns}';`).join('\n');
  const body = list.map((ns) => (ns === 'core' ? '  ...core,' : `  ${ns},`)).join('\n');
  if (lang === 'zh-CN') {
    return `/**
 * zh-CN 词典（源语言，09 §1.2）：各命名空间在 \`zh-CN/<ns>.ts\`，这里合并成一个对象（由 \`npm run i18n:sync\` 生成）。
 * ja / en 词典的键必须与这里完全一致（\`npm run i18n:check\`）；新增命名空间或键后运行 \`npm run i18n:sync\`。
 * 组件不直接引用本对象，而是引用当前语言的 \`msg\`（runtime.ts）。
 */
${imports}

export const zhCN = {
${body}
};

export type Messages = typeof zhCN;
`;
  }
  return `/**
 * ${LANG_LABEL[lang]} 词典（由 \`npm run i18n:sync\` 生成；译文写在 \`${lang}/<ns>.ts\`）。
 */
import type { Dict } from './dict';
import type { Messages } from './zh-CN';
${imports}

export const ${name}: Dict<Messages> = {
${body}
};
`;
}

export async function sync({ check = false } = {}) {
  const list = namespaces();
  const changed = [];
  const write = (file, text) => {
    const cur = fs.existsSync(file) ? fs.readFileSync(file, 'utf8').replace(/\r\n/g, '\n') : null;
    if (cur === text) return;
    changed.push(path.relative(process.cwd(), file));
    if (!check) {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, text);
    }
  };
  for (const ns of list) {
    const zh = await load(path.join(I18N, 'zh-CN', `${ns}.ts`));
    for (const lang of LANGS) {
      const file = path.join(I18N, lang, `${ns}.ts`);
      write(file, nsFile(lang, ns, zh, await load(file)));
    }
  }
  for (const lang of LANGS) {
    const dir = path.join(I18N, lang);
    for (const f of fs.existsSync(dir) ? fs.readdirSync(dir) : []) {
      if (f.endsWith('.ts') && !list.includes(f.slice(0, -3))) {
        changed.push(`${path.relative(process.cwd(), path.join(dir, f))} (removed)`);
        if (!check) fs.rmSync(path.join(dir, f));
      }
    }
  }
  write(path.join(I18N, 'zh-CN.ts'), aggregate('zh-CN', list));
  for (const lang of LANGS) write(path.join(I18N, `${lang}.ts`), aggregate(lang, list));
  return changed;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  const check = process.argv.includes('--check');
  sync({ check }).then(
    (changed) => {
      for (const c of changed) console.log(`${check ? 'stale' : 'wrote'} ${c}`);
      console.error(`i18n:sync: ${changed.length} file(s) ${check ? 'need an update' : 'updated'}`);
      process.exitCode = check && changed.length ? 1 : 0;
    },
    (e) => {
      console.error(e instanceof Error ? (e.stack ?? e.message) : String(e));
      process.exitCode = 2;
    },
  );
}
