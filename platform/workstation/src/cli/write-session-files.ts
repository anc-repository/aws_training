#!/usr/bin/env node
/**
 * atl-write-session-files <context.json | -> [--env <path>] [--json <path>]
 * Used by /opt/atl/bin/atl-workstation-setup.sh after `atl-agent-call GET …/context`. Exit 3 = context rejected
 * (non-retryable, 03 §4.6), 1 = other error.
 */
import fs from 'node:fs';
import { ContextInvalidError, DEFAULT_SESSION_FILE_PATHS, writeSessionFiles } from '../session-files.js';

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i > 0 ? process.argv[i + 1] : undefined;
}

try {
  const src = process.argv[2];
  if (!src) throw new Error('usage: atl-write-session-files <context.json | -> [--env <path>] [--json <path>]');
  const text = src === '-' ? fs.readFileSync(0, 'utf8') : fs.readFileSync(src, 'utf8');
  const ctx = writeSessionFiles(JSON.parse(text), {
    sessionEnv: arg('--env') ?? DEFAULT_SESSION_FILE_PATHS.sessionEnv,
    sessionJson: arg('--json') ?? DEFAULT_SESSION_FILE_PATHS.sessionJson,
  });
  console.log(`session files written for ${ctx.sessionId} (${ctx.envName})`);
} catch (e) {
  console.error(e instanceof Error ? e.message : String(e));
  process.exitCode = e instanceof ContextInvalidError ? 3 : 1;
}
