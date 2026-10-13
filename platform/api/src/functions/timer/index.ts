/** Lambda entry of atl-timer (production wiring only; never imports dev code). */
import { prodDeps } from '../../aws/deps.js';
import { awsClouds } from '../lifecycle/cloud/aws.js';
import { setProductionClouds } from '../lifecycle/cloud/registry.js';
import { createTimerHandler } from './handler.js';

setProductionClouds(awsClouds);

export const handler = createTimerHandler(prodDeps);
