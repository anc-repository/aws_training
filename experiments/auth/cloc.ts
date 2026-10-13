/**
 * auth/cloc —— 自写代码量（02#auth 第 5 节步骤 2；离线，不需要目标服务）。
 *
 *   npm run exp -- auth --label before --scenario cloc
 *
 * 统计仓库中 `backend/src/adapters/auth/local.ts` + `local/`（本地账号：注册、验证、哈希、TOTP、密钥、密码策略）与
 * `cognito.ts` + `cognito/`（适配器）的代码行（去掉空行与纯注释行），等价于 cloc 的 code 列（近似）。
 */
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { defineScenario } from '../_lib/scenario.js';
import { repoRoot } from '../_lib/util.js';

export function countCode(text: string): { code: number; comment: number; blank: number } {
  let code = 0;
  let comment = 0;
  let blank = 0;
  let inBlock = false;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) {
      blank += 1;
      continue;
    }
    if (inBlock) {
      comment += 1;
      if (line.includes('*/')) inBlock = false;
      continue;
    }
    if (line.startsWith('//')) {
      comment += 1;
      continue;
    }
    if (line.startsWith('/*')) {
      comment += 1;
      if (!line.includes('*/')) inBlock = true;
      continue;
    }
    code += 1;
  }
  return { code, comment, blank };
}

function filesOf(p: string): string[] {
  if (!existsSync(p)) return [];
  if (statSync(p).isFile()) return /\.(ts|tsx|js)$/.test(p) ? [p] : [];
  return readdirSync(p).flatMap((n) => filesOf(path.join(p, n)));
}

export default defineScenario({
  warmupWithRun: false,
  async run(ctx) {
    const base = path.join(repoRoot(), 'backend', 'src', 'adapters', 'auth');
    const groups = {
      local: [path.join(base, 'local.ts'), path.join(base, 'local')],
      cognito: [path.join(base, 'cognito.ts'), path.join(base, 'cognito')],
    };
    for (const [name, paths] of Object.entries(groups)) {
      const files = paths.flatMap(filesOf);
      const sum = { files: files.length, code: 0, comment: 0, blank: 0 };
      for (const f of files) {
        const c = countCode(readFileSync(f, 'utf8'));
        sum.code += c.code;
        sum.comment += c.comment;
        sum.blank += c.blank;
      }
      ctx.finding(name, { ...sum, paths: files.map((f) => path.relative(repoRoot(), f).replace(/\\/g, '/')) });
      ctx.log(`${name.padEnd(8)} ${String(sum.files).padStart(3)} 个文件  ${String(sum.code).padStart(6)} 行代码`);
    }
  },
});
