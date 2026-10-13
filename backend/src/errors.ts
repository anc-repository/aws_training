/**
 * Shared error types.
 *
 * - NotImplementedError：适配器 / 路由 / 感知器的“未实现”桩抛出它；HTTP 层映射为 501。
 * - HttpError：路由与服务层可抛出的带状态码错误（统一由 http/app.ts 的错误处理器序列化）。
 * - ConfigValidationError：配置校验失败（退出码 78，EX_CONFIG）。
 */
import type { ModuleId } from '@cloudalbum/contracts';

export const EX_CONFIG = 78;

export class NotImplementedError extends Error {
  readonly code = 'NOT_IMPLEMENTED';
  readonly status = 501;
  constructor(
    readonly component: string,
    readonly member?: string,
    readonly module?: ModuleId,
  ) {
    super(`${component}${member ? `.${member}` : ''} 尚未实现（脚手架桩，由后续实现者填充）`);
    this.name = 'NotImplementedError';
  }
}

export function isNotImplemented(e: unknown): e is NotImplementedError {
  return e instanceof NotImplementedError || (typeof e === 'object' && e !== null && (e as { code?: unknown }).code === 'NOT_IMPLEMENTED');
}

/** 便捷函数：`throw notImplemented('LocalStorage', 'putObject', 'storage')` */
export function notImplemented(component: string, member?: string, module?: ModuleId): NotImplementedError {
  return new NotImplementedError(component, member, module);
}

export class HttpError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message?: string,
    readonly details?: Record<string, unknown>,
    readonly headers?: Record<string, string>,
  ) {
    super(message ?? code);
    this.name = 'HttpError';
  }
}

export class ConfigValidationError extends Error {
  readonly exitCode = EX_CONFIG;
  constructor(readonly report: string) {
    super('配置校验未通过');
    this.name = 'ConfigValidationError';
  }
}
