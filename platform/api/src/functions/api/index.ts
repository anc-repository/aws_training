/** Lambda entry of atl-api (production wiring only; never imports dev code). */
import { prodDeps } from '../../aws/deps.js';
import { createApiHandler } from './handler.js';

export const handler = createApiHandler(prodDeps);
