/**
 * @atl/ssm-client — browser protocol layer of the ATL web terminal (docs/platform/03 §3.5).
 * No Node dependencies; the local mock lives in `@atl/ssm-client/mock` (Node only).
 */
export * from './constants.js';
export * from './uuid.js';
export * from './bytes.js';
export * from './codec.js';
export * from './payloads.js';
export * from './handshake.js';
export * from './channel.js';
export * from './streamUrl.js';
export * from './backoff.js';
export * from './socket.js';
export * from './timers.js';
export * from './connection.js';
export * from './xterm.js';
