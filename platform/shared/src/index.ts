/**
 * @atl/shared — the platform name table (docs/platform/01-architecture.md §14) as code, plus shared contracts:
 * lab.yaml v2 schema and types, atl.agent-context/v1, and the dev/prod port interfaces.
 * Browser-safe; Node-only helpers are in `@atl/shared/node`.
 */
export * from './ids.js';
export * from './runner.js';
export * from './session-states.js';
export * from './entities.js';
export * from './keys.js';
export * from './tables.js';
export * from './routes.js';
export * from './events.js';
export * from './errors.js';
export * from './workflows.js';
export * from './functions.js';
export * from './scheduler.js';
export * from './roles.js';
export * from './tags.js';
export * from './resources.js';
export * from './agent-context.js';
export * from './encoding.js';
export * from './jcs.js';
export * from './lab/index.js';
export * from './ports/index.js';
