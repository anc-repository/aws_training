import { defineProject } from 'vitest/config';
import { workspaceAlias } from '../../vitest.shared';

export default defineProject({
  resolve: { alias: workspaceAlias },
  test: {
    name: 'module-cli',
    environment: 'node',
    include: ['test/**/*.test.ts', 'src/**/*.test.ts'],
  },
});
