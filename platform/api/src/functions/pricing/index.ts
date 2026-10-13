/** Lambda entry of atl-pricing (production wiring only; never imports dev code). */
import { prodDeps } from '../../aws/deps.js';
import { createPricingHandler } from './handler.js';

export const handler = createPricingHandler(prodDeps);
