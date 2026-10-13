/** Lambda entry of atl-checks (production wiring only; never imports dev code). */
import { prodDeps } from '../../aws/deps.js';
import { createChecksHandler } from './handler.js';

export const handler = createChecksHandler(prodDeps);
