/** Lambda entry of atl-reaper (production wiring only; never imports dev code). */
import { prodDeps } from '../../aws/deps.js';
import { awsClouds } from '../lifecycle/cloud/aws.js';
import { setProductionClouds } from '../lifecycle/cloud/registry.js';
import { createReaperHandler } from './handler.js';

setProductionClouds(awsClouds);

export const handler = createReaperHandler(prodDeps);
