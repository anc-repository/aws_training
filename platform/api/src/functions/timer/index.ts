/** Lambda entry of atl-timer (production wiring only; never imports dev code). */
import { prodDeps } from '../../aws/deps.js';
import { createTimerHandler } from './handler.js';

export const handler = createTimerHandler(prodDeps);
