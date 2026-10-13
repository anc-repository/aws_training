/** Lambda entry of atl-custom-resources (production wiring only; never imports dev code). */
import { prodDeps } from '../../aws/deps.js';
import { createCustomResourcesHandler } from './handler.js';

export const handler = createCustomResourcesHandler(prodDeps);
