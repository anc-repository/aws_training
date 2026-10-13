/**
 * API flows over the in-memory document client (no Docker needed). The same scenarios run against DynamoDB Local in
 * api-flows.it.test.ts.
 */
import { createApiTestRuntime } from './api-support/api-runtime.js';
import { defineApiScenarios } from './api-support/api-scenarios.js';

defineApiScenarios('in-memory table', (ext) => createApiTestRuntime({ ...(ext ? { ext } : {}) }));
