/** Lambda entry of atl-certs (production wiring only; never imports dev code). */
import { prodDeps } from '../../aws/deps.js';
import { createCertsHandler } from './handler.js';

export const handler = createCertsHandler(prodDeps);
