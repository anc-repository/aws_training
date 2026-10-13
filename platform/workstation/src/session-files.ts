/**
 * Files written by `ATL-WorkstationSetup` from the agent context (03 §4.6 steps 3 and 4):
 *  - `/etc/atl/session.env` (0644, non-secret, `KEY='value'` lines, 06 PM-26 variables via `toSessionEnv`)
 *  - `~labuser/.atl/session.json` (0600, the 01 §8.2 subset via `toSessionJson`)
 * Idempotent: the files are overwritten, never appended. The context is validated first; an unknown schema or a missing
 * field is the non-retryable wiring failure (exit code 3 in 03 §4.6).
 */
import fs from 'node:fs';
import path from 'node:path';
import { parseAgentContext, renderEnvFile, toSessionEnv, toSessionJson, type AgentContext } from '@atl/shared';

export interface SessionFilePaths {
  sessionEnv: string;
  sessionJson: string;
}

export const DEFAULT_SESSION_FILE_PATHS: SessionFilePaths = {
  sessionEnv: '/etc/atl/session.env',
  sessionJson: '/home/labuser/.atl/session.json',
};

export class ContextInvalidError extends Error {
  readonly exitCode = 3;
  constructor(message: string) {
    super(message);
    this.name = 'ContextInvalidError';
  }
}

export function renderSessionFiles(context: unknown): { ctx: AgentContext; sessionEnv: string; sessionJson: string } {
  let ctx: AgentContext;
  try {
    ctx = parseAgentContext(context);
  } catch (e) {
    throw new ContextInvalidError(`agent context rejected: ${e instanceof Error ? e.message : String(e)}`);
  }
  return {
    ctx,
    sessionEnv: renderEnvFile(toSessionEnv(ctx, { opsReport: 'agent' })),
    sessionJson: JSON.stringify(toSessionJson(ctx), null, 2) + '\n',
  };
}

export function writeSessionFiles(context: unknown, paths: SessionFilePaths = DEFAULT_SESSION_FILE_PATHS): AgentContext {
  const r = renderSessionFiles(context);
  for (const [file, body, mode] of [
    [paths.sessionEnv, r.sessionEnv, 0o644],
    [paths.sessionJson, r.sessionJson, 0o600],
  ] as const) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = `${file}.tmp-${process.pid}`;
    fs.writeFileSync(tmp, body, { mode });
    fs.renameSync(tmp, file);
  }
  return r.ctx;
}
