/**
 * @cloudalbum/contracts — shared by backend, frontend, experiments and scripts/module-cli.
 *
 * The registry data itself is exported from the `@cloudalbum/contracts/registry` subpath so that
 * bundles that only need the types/parsers do not pull the whole registry document.
 */
export * from './module-ids.js';
export * from './headers.js';
export * from './path-header.js';
export * from './server-timing.js';
export * from './capabilities.js';
export * from './registry-types.js';
export * from './platform.js';
export * from './capabilities-projection.js';
export * from './canonical-json.js';
