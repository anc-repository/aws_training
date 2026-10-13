/**
 * npm run registry:check —— modules/registry.yaml 的 CI 校验（规则见 checks.ts）。失败时退出码 1。
 */
import { checkRegistry } from './checks.js';

const report = checkRegistry();
for (const w of report.warnings) console.log(`  [WARN ] ${w}`);
for (const e of report.errors) console.error(`  [ERROR] ${e}`);
if (report.errors.length) {
  console.error(`registry:check FAILED：${report.errors.length} 个错误，${report.warnings.length} 个警告`);
  process.exit(1);
}
console.log(`registry:check OK：${report.stats.modules} 个模块，rules.ts ${report.stats.rules} 条规则，` +
  `registry 中 ${report.stats.registryRuleRefs} 处规则引用；${report.warnings.length} 个警告`);
