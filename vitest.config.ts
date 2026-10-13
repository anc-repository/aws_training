/**
 * Root Vitest config: one project per workspace (each has its own vitest.config.ts).
 *
 * - `npm test` runs unit tests only.
 * - Tests that need real services (LocalStack / PostgreSQL 16 / Valkey 8 via `npm run test:services:up`)
 *   are named `*.int.test.ts` and run only when CLOUDALBUM_IT=1.
 */
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    passWithNoTests: true,
    // 多个 *.int.test.ts 共用 docker-compose.test.yml 的同一个 PostgreSQL 库（各自 drop schema public 后重建）：
    // CLOUDALBUM_IT=1 时按文件串行执行，避免互相删表。fileParallelism 只在根配置生效（项目级配置会被忽略）。
    fileParallelism: process.env.CLOUDALBUM_IT !== '1',
    projects: [
      'packages/*',
      'backend',
      'frontend',
      'lambdas/*',
      'experiments',
      'scripts/module-cli',
      'platform/shared',
      'platform/api',
      'platform/workflows',
      'platform/infra',
      'platform/workstation',
      'scripts/labs',
    ],
  },
});
