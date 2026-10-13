/**
 * experiments/_lib/runner.ts —— 实验运行器（总纲 §8.2；Node 实现，不依赖 k6）
 *
 *   npm run exp -- <module> --label before|after [--scenario <id>] [--target <url>] \
 *                  [--vus 10] [--duration 60s] [--repeat 3] [--ab] [--upload] [--force]
 *
 * 步骤：读取 <module>/experiment.json → 抓取管理员视图的 /api/capabilities 并校验 requires[label]（不匹配拒绝运行，
 * --force 时记 forced: true）→ 生成 runId（ULID）并 POST /api/lab/runs → 预热 → 执行场景（请求带 X-Experiment-Run /
 * X-Experiment-Label；--ab 时交替带 X-Compare-Bypass）→ 故障注入 → 拉取 /api/lab/metrics?run= → 写 _results/…json
 * （--upload 时 POST /api/lab/results）。
 *
 * 脚手架桩：由「experiments 实现者」填充（共享的头名称、路径头 / Server-Timing 解析器在 @cloudalbum/contracts）。
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { HEADERS } from '@cloudalbum/contracts';

export const EXPERIMENT_HEADERS = {
  run: HEADERS.experimentRun,
  label: HEADERS.experimentLabel,
  bypass: HEADERS.compareBypass,
} as const;

export async function main(argv: string[] = process.argv.slice(2)): Promise<number> {
  console.error(`experiments runner 尚未实现（脚手架桩）。参数：${argv.join(' ')}`);
  return 2;
}

const invokedDirectly = process.argv[1] !== undefined && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) {
  void main().then((code) => process.exit(code));
}
