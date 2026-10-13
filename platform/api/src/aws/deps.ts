/**
 * Production wiring: ports backed by AWS + the DynamoDB document client. Imported only by `functions/<fn>/index.ts`.
 * Must never import anything under `src/dev/` (ESLint rule + test/prod-bundle.test.ts).
 */
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import type { PlatformPorts } from '@atl/shared';
import { memoDeps, type FunctionDeps } from '../runtime/deps.js';
import { loadPlatformEnv, type PlatformEnv } from '../runtime/env.js';
import {
  CloudTrailLookup,
  CodeBuildRunner,
  CognitoAuth,
  EventBridgePublisher,
  EventBridgeScheduler,
  KmsSigner,
  LambdaInvoker,
  S3ObjectStore,
  SfnOrchestrator,
  SsmRunCommand,
  SystemClock,
} from './adapters.js';

export function createProdPorts(env: PlatformEnv): PlatformPorts {
  return {
    clock: new SystemClock(),
    orchestrator: new SfnOrchestrator(env),
    runner: new CodeBuildRunner(env),
    runCommand: new SsmRunCommand(env),
    scheduler: new EventBridgeScheduler(env),
    signer: new KmsSigner(env),
    trail: new CloudTrailLookup(),
    auth: new CognitoAuth(env),
    invoker: new LambdaInvoker(env),
    events: new EventBridgePublisher(env),
    objects: new S3ObjectStore(env),
  };
}

export function createDocumentClient(ddb: DynamoDBClient): DynamoDBDocumentClient {
  return DynamoDBDocumentClient.from(ddb, { marshallOptions: { removeUndefinedValues: true, convertClassInstanceToMap: false } });
}

export async function createProdDeps(env: PlatformEnv = loadPlatformEnv()): Promise<FunctionDeps> {
  if (env.devMode) {
    // The production bundle has no dev runtime; ATL_DEV_MODE is for `npm run platform:dev` only.
    throw new Error('ATL_DEV_MODE=1 is not supported by the production entry points; use platform/api/src/dev/');
  }
  return { ports: createProdPorts(env), db: createDocumentClient(new DynamoDBClient({ region: env.region })), env };
}

export const prodDeps = memoDeps(() => createProdDeps());
