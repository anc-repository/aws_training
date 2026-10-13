import { defineProject } from 'vitest/config';
import { workspaceAlias } from '../../vitest.shared';

export default defineProject({
  resolve: { alias: workspaceAlias },
  test: {
    name: 'atl-infra',
    include: ['test/**/*.test.ts'],
    environment: 'node',
  },
});
