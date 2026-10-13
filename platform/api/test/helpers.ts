import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import type { HttpEvent } from '../src/http/types.js';

export const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');

/** Temp dirs on the repo drive (.atl-dev is git-ignored). */
export function tmpDir(prefix: string): string {
  const root = path.join(REPO_ROOT, '.atl-dev', 'tmp');
  fs.mkdirSync(root, { recursive: true });
  return fs.mkdtempSync(path.join(root, prefix));
}

/** Document client stub for tests that never touch DynamoDB. */
export const NO_DB = new Proxy(
  {},
  {
    get() {
      throw new Error('this test must not use DynamoDB');
    },
  },
) as unknown as DynamoDBDocumentClient;

export function httpEvent(method: string, rawPath: string, opts: { headers?: Record<string, string>; body?: unknown; caller?: string } = {}): HttpEvent {
  return {
    version: '2.0',
    rawPath,
    headers: opts.headers ?? {},
    ...(opts.body === undefined ? {} : { body: JSON.stringify(opts.body) }),
    requestContext: {
      requestId: 'req-1',
      http: { method },
      ...(opts.caller ? { authorizer: { iam: { userArn: opts.caller } } } : {}),
    },
  };
}
