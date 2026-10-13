/**
 * Port interfaces between platform logic and AWS. Production implementations live in `platform/api/src/aws/`
 * (01 §13), dev implementations in `platform/api/src/dev/` (ATL_DEV_MODE=1). Production code receives a `PlatformPorts`
 * and never imports dev code (enforced by ESLint and by platform/api/test/prod-bundle.test.ts).
 */
import type { AuthPort } from './auth.js';
import type { ClockPort } from './clock.js';
import type { EventPublisherPort } from './events.js';
import type { InvokerPort } from './invoker.js';
import type { ObjectStorePort } from './object-store.js';
import type { OrchestratorPort } from './orchestrator.js';
import type { RunCommandPort } from './run-command.js';
import type { RunnerPort } from './runner.js';
import type { SchedulerPort } from './scheduler.js';
import type { SignerPort } from './signer.js';
import type { TrailLookupPort } from './trail-lookup.js';

export * from './errors.js';
export * from './clock.js';
export * from './orchestrator.js';
export * from './runner.js';
export * from './run-command.js';
export * from './scheduler.js';
export * from './signer.js';
export * from './trail-lookup.js';
export * from './auth.js';
export * from './invoker.js';
export * from './events.js';
export * from './object-store.js';

export interface PlatformPorts {
  clock: ClockPort;
  orchestrator: OrchestratorPort;
  runner: RunnerPort;
  runCommand: RunCommandPort;
  scheduler: SchedulerPort;
  signer: SignerPort;
  trail: TrailLookupPort;
  auth: AuthPort;
  invoker: InvokerPort;
  events: EventPublisherPort;
  objects: ObjectStorePort;
}

export const PORT_NAMES = [
  'clock',
  'orchestrator',
  'runner',
  'runCommand',
  'scheduler',
  'signer',
  'trail',
  'auth',
  'invoker',
  'events',
  'objects',
] as const satisfies readonly (keyof PlatformPorts)[];
