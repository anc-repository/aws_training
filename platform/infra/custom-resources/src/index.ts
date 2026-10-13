/** Lambda entry of atl-custom-resources (production wiring; bundled by build/package.ts as atl-custom-resources/index.mjs). */
import { createAwsPorts } from './aws-ports.js';
import { createCustomResourcesHandler } from './handler.js';
import type { Ports } from './ports.js';

let ports: Ports | null = null;
export const handler = createCustomResourcesHandler(async () => (ports ??= createAwsPorts()));
