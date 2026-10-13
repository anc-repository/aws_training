/**
 * Starts the local mock Session Manager (dev mode):
 *
 *   npx tsx platform/ssm-client/src/mock/cli.ts [--port 8790] [--host 127.0.0.1] [--mode shell|echo]
 *       [--handshake session-type|none|kms] [--idle-minutes 20] [--max-minutes 0] [--quiet]
 *
 * Prints one JSON line `{"event":"listening",…}` and then one log line per StartSession / ResumeSession / Terminate.
 */
import { startMockSsmServer } from './server.js';
import type { MockHandshakeMode, MockShellMode } from './service.js';

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

function num(name: string, fallback: number): number {
  const v = arg(name);
  const n = v === undefined ? fallback : Number(v);
  if (!Number.isFinite(n) || n < 0) throw new Error(`--${name} must be a non-negative number`);
  return n;
}

const mode = (arg('mode') ?? 'shell') as MockShellMode;
const handshake = (arg('handshake') ?? 'session-type') as MockHandshakeMode;
if (!['shell', 'echo'].includes(mode)) throw new Error('--mode must be shell or echo');
if (!['session-type', 'none', 'kms'].includes(handshake)) throw new Error('--handshake must be session-type, none or kms');
const quiet = process.argv.includes('--quiet');

const server = await startMockSsmServer({
  host: arg('host') ?? '127.0.0.1',
  port: num('port', 8790),
  mode,
  handshake,
  idleTimeoutMs: num('idle-minutes', 20) * 60_000,
  maxDurationMs: num('max-minutes', 0) * 60_000,
  log: quiet ? undefined : (line) => process.stdout.write(`[ssm-mock] ${line}\n`),
});

process.stdout.write(`${JSON.stringify({ event: 'listening', httpOrigin: server.httpOrigin, wsOrigin: server.wsOrigin, mode, handshake })}\n`);

const stop = (): void => {
  void server.close().then(() => process.exit(0));
};
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
