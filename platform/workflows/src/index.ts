/**
 * @atl/workflows — ASL tooling and the in-process Step Functions simulator used by ATL_DEV_MODE=1.
 * The deployed definitions are the JSON files in `platform/workflows/statemachines/`.
 */
export * from './asl/types.js';
export * from './asl/validate.js';
export * from './asl/load.js';
export * from './simulator/errors.js';
export * from './simulator/jsonpath.js';
export { evalIntrinsic, isIntrinsic } from './simulator/intrinsics.js';
export * from './simulator/engine.js';
export * from './simulator/virtual-clock.js';
// the runner's session-independent managed session policy (the platform template creates it)
export { RUNNER_SESSION_STATIC_POLICY, staticRunnerStatements } from './runner/policy.js';
