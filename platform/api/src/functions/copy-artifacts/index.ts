/** Lambda entry of atl-copy-artifacts (production wiring only; never imports dev code). */
import { prodDeps } from '../../aws/deps.js';
import { createCopyArtifactsHandler } from './handler.js';

export const handler = createCopyArtifactsHandler(prodDeps);
