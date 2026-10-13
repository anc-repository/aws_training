/**
 * Shared Vitest settings: workspace packages resolve to their TypeScript sources, so `npm test`
 * does not need a prior `npm run build`.
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const REPO_ROOT = path.dirname(fileURLToPath(import.meta.url));

export const workspaceAlias = [
  { find: /^@cloudalbum\/contracts\/registry$/, replacement: path.join(REPO_ROOT, 'packages/contracts/src/generated/registry.ts') },
  { find: /^@cloudalbum\/contracts$/, replacement: path.join(REPO_ROOT, 'packages/contracts/src/index.ts') },
  { find: /^@cloudalbum\/image-core$/, replacement: path.join(REPO_ROOT, 'packages/image-core/src/index.ts') },
  // ATL platform workspaces (platform/*, scripts/labs)
  { find: /^@atl\/shared\/node$/, replacement: path.join(REPO_ROOT, 'platform/shared/src/node.ts') },
  { find: /^@atl\/shared$/, replacement: path.join(REPO_ROOT, 'platform/shared/src/index.ts') },
  { find: /^@atl\/workflows$/, replacement: path.join(REPO_ROOT, 'platform/workflows/src/index.ts') },
];
