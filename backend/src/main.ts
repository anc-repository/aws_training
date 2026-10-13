// backend/src/main.ts —— 进程入口的公共处理：配置错误一律退出码 78（EX_CONFIG，systemd RestartPreventExitStatus=78）
import { ConfigValidationError, EX_CONFIG } from './errors.js';

export async function runMain(name: string, fn: () => Promise<void>): Promise<void> {
  try {
    await fn();
  } catch (e) {
    if (e instanceof ConfigValidationError) {
      process.stderr.write(`${e.report}\n`);
      process.stderr.write(`exit ${EX_CONFIG}（${name}：配置校验未通过，请在服务器上运行 cloudalbum check-config）\n`);
      process.exit(EX_CONFIG);
    }
    process.stderr.write(`${name} failed: ${(e as Error)?.stack ?? String(e)}\n`);
    process.exit(1);
  }
}

/** SIGTERM / SIGINT 时只执行一次的优雅停机 */
export function onShutdown(handler: (signal: string) => Promise<void>): void {
  let shuttingDown = false;
  const run = (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    handler(signal).then(
      () => process.exit(0),
      (e: unknown) => {
        process.stderr.write(`shutdown failed: ${(e as Error)?.message ?? String(e)}\n`);
        process.exit(1);
      },
    );
  };
  process.on('SIGTERM', () => run('SIGTERM'));
  process.on('SIGINT', () => run('SIGINT'));
}
