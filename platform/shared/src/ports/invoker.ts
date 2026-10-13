import type { LambdaFunctionName } from '../functions.js';

/** Function-to-function calls (`lambda:InvokeFunction`). Production: `@aws-sdk/client-lambda`. Dev: in-process handler table. */
export interface InvokerPort {
  /** Synchronous (RequestResponse); rejects when the function throws. */
  invoke<T = unknown>(fn: LambdaFunctionName, payload: unknown): Promise<T>;
  /** Asynchronous (Event); resolves when the call has been accepted. */
  invokeAsync(fn: LambdaFunctionName, payload: unknown): Promise<void>;
}
