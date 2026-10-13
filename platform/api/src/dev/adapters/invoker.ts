/**
 * In-process `lambda:InvokeFunction`: a table of the function handlers built with the dev deps. Async invocations run on
 * the next tick; their errors are recorded (Lambda would retry twice and then drop or send to a DLQ).
 */
import { PortError, type InvokerPort, type LambdaFunctionName } from '@atl/shared';

export type InProcessFunction = (payload: unknown) => Promise<unknown>;

export class InProcessInvoker implements InvokerPort {
  private readonly table = new Map<LambdaFunctionName, InProcessFunction>();
  readonly asyncErrors: { fn: LambdaFunctionName; error: string }[] = [];
  readonly log: { fn: LambdaFunctionName; mode: 'sync' | 'async'; payload: unknown }[] = [];

  register(fn: LambdaFunctionName, handler: InProcessFunction): void {
    this.table.set(fn, handler);
  }

  private get(fn: LambdaFunctionName): InProcessFunction {
    const h = this.table.get(fn);
    if (!h) throw new PortError('NotFound', `function not registered in the dev runtime: ${fn}`);
    return h;
  }

  async invoke<T = unknown>(fn: LambdaFunctionName, payload: unknown): Promise<T> {
    this.log.push({ fn, mode: 'sync', payload });
    // round-trip through JSON like the Lambda API does
    return (await this.get(fn)(JSON.parse(JSON.stringify(payload ?? null)))) as T;
  }

  async invokeAsync(fn: LambdaFunctionName, payload: unknown): Promise<void> {
    const h = this.get(fn);
    this.log.push({ fn, mode: 'async', payload });
    const copy = JSON.parse(JSON.stringify(payload ?? null)) as unknown;
    setImmediate(() => {
      h(copy).catch((e: unknown) => this.asyncErrors.push({ fn, error: e instanceof Error ? `${e.name}: ${e.message}` : String(e) }));
    });
  }
}
