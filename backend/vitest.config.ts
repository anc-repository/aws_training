import { defineProject } from 'vitest/config';
import { workspaceAlias } from '../vitest.shared';

const integration = process.env.CLOUDALBUM_IT === '1';

export default defineProject({
  resolve: { alias: workspaceAlias },
  test: {
    name: 'backend',
    environment: 'node',
    include: ['test/**/*.test.ts'],
    // *.int.test.ts need Docker services (docker-compose.test.yml); opt in with CLOUDALBUM_IT=1
    exclude: integration ? ['**/node_modules/**'] : ['**/node_modules/**', 'test/**/*.int.test.ts'],
    testTimeout: integration ? 60_000 : 15_000,
    pool: 'forks',
  },
});
