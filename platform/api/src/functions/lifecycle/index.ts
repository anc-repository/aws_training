/** Lambda entry of atl-lifecycle (production wiring only; never imports dev code). */
import { prodDeps } from '../../aws/deps.js';
import { awsClouds } from './cloud/aws.js';
import { setProductionClouds } from './cloud/registry.js';
import { createLifecycleHandler } from './handler.js';

setProductionClouds(awsClouds);

export const handler = createLifecycleHandler(prodDeps);
