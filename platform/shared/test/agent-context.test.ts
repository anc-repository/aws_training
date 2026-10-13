import { describe, expect, it } from 'vitest';
import {
  AGENT_CONTEXT_SCHEMA,
  buildAgentContext,
  parseAgentContext,
  parsePlatformTags,
  renderEnvFile,
  toSessionEnv,
  toSessionJson,
  type BuildAgentContextInput,
} from '../src/index.js';

/**
 * The example JSON of 03 §4.6 step 2, with a concrete apiId and the envId of 01 §3.9 (the 03 example envId contains
 * `u` and `i`, which are not Crockford Base32).
 */
const EXAMPLE = {
  schema: 'atl.agent-context/v1',
  generatedAt: '2026-10-13T05:12:30Z',
  sessionId: 's4k7m2q9x1abc',
  sessionState: 'PROVISIONING',
  labId: 'svc-shell-access',
  labKind: 'service',
  variant: 'default',
  envId: '01jc9x3k9cq4m2x8n5b6c0d1e2',
  envName: 'e7k2m9qx',
  region: 'ap-northeast-1',
  drRegion: 'ap-northeast-3',
  agentApiBase: 'https://abcde12345.execute-api.ap-northeast-1.amazonaws.com',
  platformOrigin: 'https://d1234abcd.cloudfront.net',
  cloudalbum: {
    stateUri: 's3://cloudalbum-lab-state-111122223333-ap-northeast-1/e7k2m9qx/state.json',
    lockTable: 'cloudalbum-lab-locks',
    stackTags: {
      'atl:component': 'env',
      'atl:session-id': 's4k7m2q9x1abc',
      'atl:lab-id': 'svc-shell-access',
      'atl:env-id': '01jc9x3k9cq4m2x8n5b6c0d1e2',
      Project: 'CloudAlbum',
    },
    permissionsBoundaryArn: 'arn:aws:iam::111122223333:policy/ATLWorkloadBoundary',
    adminPasswordParam: '/cloudalbum/e7k2m9qx/atl/app-admin-password',
    testUsersParam: null,
    opsReport: 'agent',
    asgMaxSizeLimit: 4,
  },
  ssh: { keyParam: '/cloudalbum/e7k2m9qx/atl/ssh-key', user: 'ec2-user' },
  appEntry: null,
  platformActions: ['iam-revoke-sessions', 'iam-refresh-credentials'],
};

function input(over: Partial<BuildAgentContextInput> = {}): BuildAgentContextInput {
  return {
    session: {
      sid: 's4k7m2q9x1abc',
      state: 'PROVISIONING',
      labId: 'svc-shell-access',
      labKind: 'service',
      variant: 'default',
      startProfileResolved: { name: 'atl/svc-shell-access/default', digest: 'd', variant: 'default' },
      cardFacts: { platformActions: ['iam-revoke-sessions', 'iam-refresh-credentials'], sshFromWorkstation: true, sshUser: null },
    },
    environment: {
      envId: '01jc9x3k9cq4m2x8n5b6c0d1e2',
      envName: 'e7k2m9qx',
      stateUri: 's3://cloudalbum-lab-state-111122223333-ap-northeast-1/e7k2m9qx/state.json',
      platformTags: { 'atl:component': 'env', 'atl:env-id': '01jc9x3k9cq4m2x8n5b6c0d1e2', Project: 'CloudAlbum' },
      endpoints: null,
    },
    platform: {
      region: 'ap-northeast-1',
      drRegion: 'ap-northeast-3',
      agentApiEndpoint: 'https://abcde12345.execute-api.ap-northeast-1.amazonaws.com',
      platformUrl: 'https://d1234abcd.cloudfront.net',
      workloadBoundaryArn: 'arn:aws:iam::111122223333:policy/ATLWorkloadBoundary',
      limits: {
        maxSessionMinutes: 360,
        extension: { minutes: 30, maxCount: 2 },
        maxKeepHours: 24,
        keepHardMaxHours: 72,
        envMaxAgeDays: 7,
        readyIdleMinutes: 60,
        asgMaxSizeLimit: 4,
      },
    },
    now: new Date('2026-10-13T05:12:30Z'),
    ...over,
  };
}

describe('atl.agent-context/v1', () => {
  it('the 03 §4.6 example validates', () => {
    expect(parseAgentContext(EXAMPLE).schema).toBe(AGENT_CONTEXT_SCHEMA);
  });

  it('builds the same context as the documented example', () => {
    const ctx = buildAgentContext(input());
    expect(parseAgentContext(ctx)).toEqual(ctx);
    expect(ctx).toEqual({ ...EXAMPLE, generatedAt: '2026-10-13T05:12:30.000Z' });
  });

  it('nulls instead of omitted fields', () => {
    const ctx = buildAgentContext(
      input({
        session: { ...input().session, cardFacts: { platformActions: [], sshFromWorkstation: false, sshUser: null } },
        platform: { ...input().platform, drRegion: null },
      }),
    );
    expect(ctx.ssh).toBeNull();
    expect(ctx.drRegion).toBeNull();
    expect(ctx.appEntry).toBeNull();
    expect(ctx.cloudalbum.testUsersParam).toBeNull();
  });

  it('appEntry and testUsersParam when present', () => {
    const ctx = buildAgentContext(
      input({
        environment: { ...input().environment, endpoints: { baseUrl: 'https://203.0.113.10', https: { trusted: true } } },
        testUsersSeeded: true,
      }),
    );
    expect(ctx.appEntry).toEqual({ baseUrl: 'https://203.0.113.10', https: { trusted: true } });
    expect(ctx.cloudalbum.testUsersParam).toBe('/cloudalbum/e7k2m9qx/atl/test-users');
  });

  it('rejects unknown schema versions and extra fields', () => {
    expect(() => parseAgentContext({ ...EXAMPLE, schema: 'atl.agent-context/v2' })).toThrow();
    expect(() => parseAgentContext({ ...EXAMPLE, secret: 'x' })).toThrow();
    const { drRegion: _omit, ...missing } = EXAMPLE;
    expect(() => parseAgentContext(missing)).toThrow();
  });

  it('session.env has every 06 PM-26 variable; optional ones only when set', () => {
    const env = toSessionEnv(buildAgentContext(input()));
    expect(Object.keys(env).sort()).toEqual(
      [
        'ATL_SESSION_ID',
        'ATL_LAB_ID',
        'ATL_VARIANT',
        'ATL_ENV_ID',
        'ATL_PLATFORM_ORIGIN',
        'ATL_AGENT_API',
        'AWS_REGION',
        'AWS_DEFAULT_REGION',
        'CLOUDALBUM_PLATFORM_MODE',
        'CLOUDALBUM_ENV',
        'CLOUDALBUM_STATE_URI',
        'CLOUDALBUM_LOCK_TABLE',
        'CLOUDALBUM_PLATFORM_TAGS',
        'CLOUDALBUM_PERMISSIONS_BOUNDARY_ARN',
        'CLOUDALBUM_ADMIN_PASSWORD_PARAM',
        'CLOUDALBUM_OPS_REPORT',
        'CLOUDALBUM_ASG_MAX_SIZE_LIMIT',
        'CLOUDALBUM_DR_REGION',
      ].sort(),
    );
    expect(env.CLOUDALBUM_PLATFORM_MODE).toBe('1');
    expect(env.CLOUDALBUM_OPS_REPORT).toBe('agent');
    expect(parsePlatformTags(env.CLOUDALBUM_PLATFORM_TAGS!)).toEqual(EXAMPLE.cloudalbum.stackTags);
    expect(toSessionEnv(buildAgentContext(input()), { opsReport: 'internal' }).CLOUDALBUM_OPS_REPORT).toBe('internal');
  });

  it('renders a shell-safe env file', () => {
    expect(renderEnvFile({ A: "it's", B: 'x' })).toBe("A='it'\\''s'\nB='x'\n");
    expect(() => renderEnvFile({ A: 'a\nb' })).toThrow();
  });

  it('session.json carries only the non-secret fields of 01 §8.2', () => {
    expect(Object.keys(toSessionJson(buildAgentContext(input()))).sort()).toEqual(
      ['schema', 'agentApiBase', 'sessionId', 'labId', 'envName', 'region', 'cloudalbum'].sort(),
    );
  });
});
