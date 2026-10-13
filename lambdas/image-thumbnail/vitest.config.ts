import { defineProject } from 'vitest/config';
import { workspaceAlias } from '../../vitest.shared';

export default defineProject({
  resolve: { alias: workspaceAlias },
  test: {
    name: 'lambda-image-thumbnail',
    environment: 'node',
    include: ['test/**/*.test.ts'],
  },
});
