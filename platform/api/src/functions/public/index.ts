/** Lambda entry of atl-public (production wiring only; never imports dev code). */
import { prodDeps } from '../../aws/deps.js';
import { createPublicHandler } from './handler.js';

export const handler = createPublicHandler(prodDeps);
