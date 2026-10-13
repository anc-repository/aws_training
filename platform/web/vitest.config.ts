import react from '@vitejs/plugin-react';
import { defineProject } from 'vitest/config';
import { workspaceAlias } from '../../vitest.shared';

export default defineProject({
  plugins: [react()],
  resolve: { alias: workspaceAlias },
  test: {
    name: 'atl-web',
    environment: 'jsdom',
    include: ['src/**/*.test.{ts,tsx}'],
    setupFiles: ['./src/test/setup.ts'],
  },
});
