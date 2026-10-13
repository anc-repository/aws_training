import type { AtlOp } from '../runner.js';

/**
 * CodeBuild `atl-runner`. Production: `@aws-sdk/client-codebuild` StartBuild. Dev: a local child process
 * (scripts/module --dry-run, or a local L0 instance).
 */
export interface RunnerBuildRequest {
  op: AtlOp;
  /** `<sid>-<op abbrev>-<n>[-<m>]` (`runnerRunId()`). */
  runId: string;
  sessionId: string;
  envId: string;
  labId: string;
  /** `ATL_ARGS` before base64url encoding (module-op: `{ actionId }`; extra-stack: `{ action, stackIds }`). */
  args?: unknown;
  /** `ATL_PROFILE`, `ATL_APPLY_MODE`, `ATL_REPAIR` (profile-apply only). */
  profile?: string;
  applyMode?: 'fresh' | 'additive';
  repair?: boolean;
  /** `TimeoutInMinutesOverride` (02 §2.5: remaining deploy budget). */
  timeoutMinutes?: number;
}

/** CodeBuild build statuses. */
export type RunnerBuildStatus = 'IN_PROGRESS' | 'SUCCEEDED' | 'FAILED' | 'FAULT' | 'TIMED_OUT' | 'STOPPED';

export interface RunnerBuild {
  buildId: string;
  runId: string;
  op: AtlOp;
  status: RunnerBuildStatus;
  /** Exit code of scripts/module (06 PM-35) when known. */
  exitCode: number | null;
  startTime: string;
  endTime?: string;
  /** `atl-data` key of result.json (`runs/<runId>/result.json`), the only basis of failure classification (02 §4.3). */
  resultKey: string;
}

export interface RunnerPort {
  startBuild(req: RunnerBuildRequest): Promise<RunnerBuild>;
  getBuild(buildId: string): Promise<RunnerBuild>;
  stopBuild(buildId: string): Promise<void>;
}

export function isFinalBuildStatus(s: RunnerBuildStatus): boolean {
  return s !== 'IN_PROGRESS';
}
