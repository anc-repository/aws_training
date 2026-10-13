import { defineProject } from 'vitest/config';
import { workspaceAlias } from '../vitest.shared';

export default defineProject({
  resolve: { alias: workspaceAlias },
  test: {
    name: 'experiments',
    environment: 'node',
    include: ['_lib/**/*.test.ts', 'test/**/*.test.ts'],
  },
});
