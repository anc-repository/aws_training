/** Lambda entry of atl-lifecycle (production wiring only; never imports dev code). */
import { prodDeps } from '../../aws/deps.js';
import { createLifecycleHandler } from './handler.js';

export const handler = createLifecycleHandler(prodDeps);
