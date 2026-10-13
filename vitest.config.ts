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
    projects: [
      'packages/*',
      'backend',
      'frontend',
      'lambdas/*',
      'experiments',
      'scripts/module-cli',
    ],
  },
});
