/** Lambda entry of atl-tagger (production wiring only; never imports dev code). */
import { prodDeps } from '../../aws/deps.js';
import { createTaggerHandler } from './handler.js';

export const handler = createTaggerHandler(prodDeps);
