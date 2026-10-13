/**
 * Function environment (set by the platform template, 01 §4; the infra implementer keeps these names).
 * Only non-secret configuration; everything else is read from `PlatformConfig` in `atl-main`.
 */
import { ATL_MAIN_TABLE, BucketNames, EVENT_BUS, LAB_LOCKS_TABLE, RUNNER_PROJECT } from '@atl/shared';

export interface PlatformEnv {
  region: string;
  accountId: string;
  tableName: string;
  locksTableName: string;
  buckets: { web: string; data: string; artifacts: string; labState: string };
  eventBusName: string;
  runnerProject: string;
  /** `arn:aws:states:<region>:<acct>:stateMachine:` */
  stateMachineArnPrefix: string;
  userPoolId: string | null;
  webClientId: string | null;
  /** KMS key id (not alias) of the current certificate signing key. */
  signingKeyId: string | null;
  /** EventBridge Scheduler: execution role, `atl-timer` ARN and DLQ ARN. */
  schedulerRoleArn: string | null;
  timerFunctionArn: string | null;
  timerDlqArn: string | null;
  /** `ATL_DEV_MODE=1` → the dev runtime is used (never set in the template). */
  devMode: boolean;
}

/** Environment variable names (the template sets them on every function). */
export const PLATFORM_ENV_VARS = {
  accountId: 'ATL_ACCOUNT_ID',
  tableName: 'ATL_TABLE',
  locksTableName: 'ATL_LOCKS_TABLE',
  webBucket: 'ATL_WEB_BUCKET',
  dataBucket: 'ATL_DATA_BUCKET',
  artifactsBucket: 'ATL_ARTIFACTS_BUCKET',
  labStateBucket: 'ATL_LAB_STATE_BUCKET',
  userPoolId: 'ATL_USER_POOL_ID',
  webClientId: 'ATL_WEB_CLIENT_ID',
  signingKeyId: 'ATL_SIGNING_KEY_ID',
  schedulerRoleArn: 'ATL_SCHEDULER_ROLE_ARN',
  timerFunctionArn: 'ATL_TIMER_FUNCTION_ARN',
  timerDlqArn: 'ATL_TIMER_DLQ_ARN',
  devMode: 'ATL_DEV_MODE',
} as const;

export function loadPlatformEnv(env: NodeJS.ProcessEnv = process.env): PlatformEnv {
  const region = env.AWS_REGION ?? env.AWS_DEFAULT_REGION ?? 'ap-northeast-1';
  const accountId = env[PLATFORM_ENV_VARS.accountId] ?? '000000000000';
  const v = (k: string) => (env[k] && env[k]!.length > 0 ? env[k]! : null);
  return {
    region,
    accountId,
    tableName: v(PLATFORM_ENV_VARS.tableName) ?? ATL_MAIN_TABLE,
    locksTableName: v(PLATFORM_ENV_VARS.locksTableName) ?? LAB_LOCKS_TABLE,
    buckets: {
      web: v(PLATFORM_ENV_VARS.webBucket) ?? BucketNames.web(accountId, region),
      data: v(PLATFORM_ENV_VARS.dataBucket) ?? BucketNames.data(accountId, region),
      artifacts: v(PLATFORM_ENV_VARS.artifactsBucket) ?? BucketNames.artifacts(accountId, region),
      labState: v(PLATFORM_ENV_VARS.labStateBucket) ?? BucketNames.labState(accountId, region),
    },
    eventBusName: EVENT_BUS,
    runnerProject: RUNNER_PROJECT,
    stateMachineArnPrefix: `arn:aws:states:${region}:${accountId}:stateMachine:`,
    userPoolId: v(PLATFORM_ENV_VARS.userPoolId),
    webClientId: v(PLATFORM_ENV_VARS.webClientId),
    signingKeyId: v(PLATFORM_ENV_VARS.signingKeyId),
    schedulerRoleArn: v(PLATFORM_ENV_VARS.schedulerRoleArn),
    timerFunctionArn: v(PLATFORM_ENV_VARS.timerFunctionArn),
    timerDlqArn: v(PLATFORM_ENV_VARS.timerDlqArn),
    devMode: env[PLATFORM_ENV_VARS.devMode] === '1',
  };
}
