import { defineProject } from 'vitest/config';

export default defineProject({
  test: {
    name: 'image-core',
    include: ['test/**/*.test.ts'],
    environment: 'node',
  },
});
