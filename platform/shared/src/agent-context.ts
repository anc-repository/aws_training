/**
 * Session context `atl.agent-context/v1` — 01 §8.2 (field table), 03 §4.6, 06 PM-26.
 *
 * Single source for both writers: `atl-agent` returns `buildAgentContext(...)` from `GET /agent/sessions/{sid}/context`,
 * the workstation (`ATL-WorkstationSetup`) writes `/etc/atl/session.env` with `toSessionEnv(ctx)`, and the runner buildspec
 * derives its build environment from the same builder with `opsReport: 'internal'` — never concatenated separately.
 * Missing values are `null`, never omitted.
 */
import { z } from 'zod';
import type { EnvironmentItem, LabSessionItem, PlatformConfigItem } from './entities.js';
import { DEFAULT_VARIANT } from './ids.js';
import { SsmParams } from './resources.js';
import { LAB_LOCKS_TABLE } from './tables.js';
import { formatPlatformTags, TAG_KEYS } from './tags.js';
import { SESSION_STATES } from './session-states.js';

export const AGENT_CONTEXT_SCHEMA = 'atl.agent-context/v1';

const nullableString = z.string().min(1).nullable();

export const agentContextSchema = z
  .object({
    schema: z.literal(AGENT_CONTEXT_SCHEMA),
    generatedAt: z.iso.datetime(),
    sessionId: z.string().regex(/^s[0-9a-hjkmnp-tv-z]{12}$/),
    sessionState: z.enum(SESSION_STATES),
    labId: z.string().regex(/^(svc|sc)-[a-z0-9]+(-[a-z0-9]+)*$/),
    labKind: z.enum(['service', 'scenario']),
    variant: z.string().min(1),
    envId: z.string().regex(/^[0-7][0-9a-hjkmnp-tv-z]{25}$/),
    envName: z.string().regex(/^e[0-9a-z]{7}$/),
    region: z.string().min(1),
    drRegion: nullableString,
    agentApiBase: z.string().url(),
    platformOrigin: z.string().url(),
    cloudalbum: z
      .object({
        stateUri: z.string().startsWith('s3://'),
        lockTable: z.string().min(1),
        stackTags: z.record(z.string(), z.string()),
        permissionsBoundaryArn: z.string().startsWith('arn:'),
        adminPasswordParam: z.string().startsWith('/cloudalbum/'),
        testUsersParam: nullableString,
        opsReport: z.literal('agent'),
        asgMaxSizeLimit: z.number().int().nonnegative(),
      })
      .strict(),
    ssh: z.object({ keyParam: z.string().min(1), user: z.string().min(1) }).strict().nullable(),
    appEntry: z
      .object({ baseUrl: z.string().url(), https: z.object({ trusted: z.boolean() }).strict() })
      .strict()
      .nullable(),
    platformActions: z.array(z.string()),
  })
  .strict();

export type AgentContext = z.infer<typeof agentContextSchema>;

export interface BuildAgentContextInput {
  session: Pick<LabSessionItem, 'sid' | 'state' | 'labId' | 'labKind' | 'variant' | 'startProfileResolved' | 'cardFacts'>;
  environment: Pick<EnvironmentItem, 'envId' | 'envName' | 'stateUri' | 'platformTags' | 'endpoints'>;
  platform: Pick<PlatformConfigItem, 'region' | 'drRegion' | 'agentApiEndpoint' | 'platformUrl' | 'workloadBoundaryArn' | 'limits'>;
  /**
   * The start profile contains the seed `cognito-test-users` (06 PM-44). 01 does not say where atl-agent reads this from
   * without the content package; the caller passes it (platform-scaffold note).
   */
  testUsersSeeded?: boolean;
  now?: Date;
}

/** Assemble the context from LabSession + Environment + PlatformConfig (computed per request, never cached). */
export function buildAgentContext(input: BuildAgentContextInput): AgentContext {
  const { session, environment, platform } = input;
  const variant = session.startProfileResolved?.variant ?? session.variant ?? DEFAULT_VARIANT;
  const endpoints = environment.endpoints ?? null;
  const ctx: AgentContext = {
    schema: AGENT_CONTEXT_SCHEMA,
    generatedAt: (input.now ?? new Date()).toISOString(),
    sessionId: session.sid,
    sessionState: session.state,
    labId: session.labId,
    labKind: session.labKind,
    variant,
    envId: environment.envId,
    envName: environment.envName,
    region: platform.region,
    drRegion: platform.drRegion ?? null,
    agentApiBase: platform.agentApiEndpoint,
    platformOrigin: platform.platformUrl,
    cloudalbum: {
      stateUri: environment.stateUri,
      lockTable: LAB_LOCKS_TABLE,
      stackTags: {
        ...environment.platformTags,
        [TAG_KEYS.sessionId]: session.sid,
        [TAG_KEYS.labId]: session.labId,
      },
      permissionsBoundaryArn: platform.workloadBoundaryArn,
      adminPasswordParam: SsmParams.appAdminPassword(environment.envName),
      testUsersParam: input.testUsersSeeded ? SsmParams.testUsers(environment.envName) : null,
      opsReport: 'agent',
      asgMaxSizeLimit: platform.limits.asgMaxSizeLimit,
    },
    ssh: session.cardFacts.sshFromWorkstation
      ? { keyParam: SsmParams.sshKey(environment.envName), user: session.cardFacts.sshUser ?? 'ec2-user' }
      : null,
    appEntry:
      endpoints && typeof endpoints.baseUrl === 'string' && endpoints.baseUrl
        ? { baseUrl: endpoints.baseUrl, https: { trusted: !!endpoints.https?.trusted } }
        : null,
    platformActions: [...session.cardFacts.platformActions],
  };
  return ctx;
}

export function parseAgentContext(value: unknown): AgentContext {
  return agentContextSchema.parse(value);
}

/**
 * Variables of `/etc/atl/session.env` (03 §4.6 step 3, 06 PM-26), in a stable order. `opsReport` is `agent` on the
 * workstation and `internal` on the runner (06 PM-35). `CLOUDALBUM_PLATFORM_MODE=1` is a constant (not in the context).
 */
export function toSessionEnv(ctx: AgentContext, opts: { opsReport?: 'agent' | 'internal' } = {}): Record<string, string> {
  const env: Record<string, string> = {
    ATL_SESSION_ID: ctx.sessionId,
    ATL_LAB_ID: ctx.labId,
    ATL_VARIANT: ctx.variant,
    ATL_ENV_ID: ctx.envId,
    ATL_PLATFORM_ORIGIN: ctx.platformOrigin,
    ATL_AGENT_API: ctx.agentApiBase,
    AWS_REGION: ctx.region,
    AWS_DEFAULT_REGION: ctx.region,
    CLOUDALBUM_PLATFORM_MODE: '1',
    CLOUDALBUM_ENV: ctx.envName,
    CLOUDALBUM_STATE_URI: ctx.cloudalbum.stateUri,
    CLOUDALBUM_LOCK_TABLE: ctx.cloudalbum.lockTable,
    CLOUDALBUM_PLATFORM_TAGS: formatPlatformTags(ctx.cloudalbum.stackTags),
    CLOUDALBUM_PERMISSIONS_BOUNDARY_ARN: ctx.cloudalbum.permissionsBoundaryArn,
    CLOUDALBUM_ADMIN_PASSWORD_PARAM: ctx.cloudalbum.adminPasswordParam,
    CLOUDALBUM_OPS_REPORT: opts.opsReport ?? ctx.cloudalbum.opsReport,
    CLOUDALBUM_ASG_MAX_SIZE_LIMIT: String(ctx.cloudalbum.asgMaxSizeLimit),
  };
  if (ctx.cloudalbum.testUsersParam) env.CLOUDALBUM_TEST_USERS_PARAM = ctx.cloudalbum.testUsersParam;
  if (ctx.drRegion) env.CLOUDALBUM_DR_REGION = ctx.drRegion;
  return env;
}

/** Render `KEY=value` lines (values are single-quoted for POSIX shells; `'` is escaped). */
export function renderEnvFile(env: Record<string, string>): string {
  const lines = Object.entries(env).map(([k, v]) => {
    if (!/^[A-Z][A-Z0-9_]*$/.test(k)) throw new TypeError(`invalid env name: ${k}`);
    if (/[\n\r\0]/.test(v)) throw new TypeError(`env value of ${k} contains a newline or NUL`);
    return `${k}='${v.replace(/'/g, `'\\''`)}'`;
  });
  return lines.join('\n') + '\n';
}

/**
 * `~/.atl/session.json` (0600): only these fields (01 §8.2 last paragraph; 03 §4.6 step 4 lists a subset — 01 wins).
 * No secrets.
 */
export function toSessionJson(ctx: AgentContext): {
  schema: string;
  agentApiBase: string;
  sessionId: string;
  labId: string;
  envName: string;
  region: string;
  cloudalbum: { adminPasswordParam: string };
} {
  return {
    schema: ctx.schema,
    agentApiBase: ctx.agentApiBase,
    sessionId: ctx.sessionId,
    labId: ctx.labId,
    envName: ctx.envName,
    region: ctx.region,
    cloudalbum: { adminPasswordParam: ctx.cloudalbum.adminPasswordParam },
  };
}
