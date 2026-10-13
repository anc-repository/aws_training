/**
 * Load the deployed ASL files (`platform/workflows/statemachines/<name>.asl.json`, 01 §13).
 * Used by the dev orchestrator and by tests; the infra template build embeds the same files.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { aslFileName, STATE_MACHINES, type StateMachineName } from '@atl/shared';
import type { AslDefinition } from './types.js';

/** `platform/workflows/statemachines/` (works from src/ under tsx/vitest and from dist/ after tsc). */
export const STATEMACHINES_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../statemachines');

export function aslPath(name: StateMachineName, dir: string = STATEMACHINES_DIR): string {
  return path.join(dir, aslFileName(name));
}

export function loadStateMachine(name: StateMachineName, dir: string = STATEMACHINES_DIR): AslDefinition {
  return JSON.parse(fs.readFileSync(aslPath(name, dir), 'utf8')) as AslDefinition;
}

export function loadAllStateMachines(dir: string = STATEMACHINES_DIR): Record<StateMachineName, AslDefinition> {
  return Object.fromEntries(STATE_MACHINES.map((n) => [n, loadStateMachine(n, dir)])) as Record<StateMachineName, AslDefinition>;
}

/**
 * DefinitionSubstitutions used by the platform template for the ASL files (`${LifecycleFn}` etc.). In dev they resolve to
 * the plain function / project names that the in-process invoker understands. The workflows implementer adds keys here
 * when the ASL files use new placeholders (and the infra template passes the same keys).
 */
export const DEV_SUBSTITUTIONS: Readonly<Record<string, string>> = {
  ApiFn: 'atl-api',
  AgentFn: 'atl-agent',
  ChecksFn: 'atl-checks',
  LifecycleFn: 'atl-lifecycle',
  TimerFn: 'atl-timer',
  ReaperFn: 'atl-reaper',
  CertsFn: 'atl-certs',
  PricingFn: 'atl-pricing',
  CustomResourcesFn: 'atl-custom-resources',
  RunnerProject: 'atl-runner',
  SessionStartArn: 'arn:aws:states:ap-northeast-1:000000000000:stateMachine:atl-session-start',
  SessionEndArn: 'arn:aws:states:ap-northeast-1:000000000000:stateMachine:atl-session-end',
  ReclaimArn: 'arn:aws:states:ap-northeast-1:000000000000:stateMachine:atl-reclaim',
  ReclaimRescanArn: 'arn:aws:states:ap-northeast-1:000000000000:stateMachine:atl-reclaim-rescan',
  ModuleOpArn: 'arn:aws:states:ap-northeast-1:000000000000:stateMachine:atl-module-op',
  PlatformUninstallArn: 'arn:aws:states:ap-northeast-1:000000000000:stateMachine:atl-platform-uninstall',
};
