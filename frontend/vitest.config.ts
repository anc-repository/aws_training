import react from '@vitejs/plugin-react';
import { defineProject } from 'vitest/config';
import { workspaceAlias } from '../vitest.shared';

export default defineProject({
  plugins: [react()],
  resolve: { alias: workspaceAlias },
  test: {
    name: 'frontend',
    environment: 'jsdom',
    include: ['src/**/*.test.{ts,tsx}', 'test/**/*.test.{ts,tsx}'],
    setupFiles: ['./src/test/setup.ts'],
  },
});
