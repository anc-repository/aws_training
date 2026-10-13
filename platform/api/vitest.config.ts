import { defineProject } from 'vitest/config';
import { workspaceAlias } from '../../vitest.shared';

// *.int.test.ts need DynamoDB Local (npm run platform:db:up); opt in with ATL_IT=1
const integration = process.env.ATL_IT === '1';

export default defineProject({
  resolve: { alias: workspaceAlias },
  test: {
    name: 'atl-api',
    environment: 'node',
    include: ['test/**/*.test.ts'],
    exclude: integration ? ['**/node_modules/**'] : ['**/node_modules/**', 'test/**/*.int.test.ts'],
    testTimeout: integration ? 60_000 : 20_000,
  },
});
