/** Lambda entry of atl-agent (production wiring only; never imports dev code). */
import { prodDeps } from '../../aws/deps.js';
import { createAgentHandler } from './handler.js';

export const handler = createAgentHandler(prodDeps);
