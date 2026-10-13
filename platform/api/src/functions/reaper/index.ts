/** Lambda entry of atl-reaper (production wiring only; never imports dev code). */
import { prodDeps } from '../../aws/deps.js';
import { createReaperHandler } from './handler.js';

export const handler = createReaperHandler(prodDeps);
