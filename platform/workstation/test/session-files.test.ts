import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { ContextInvalidError, renderSessionFiles, writeSessionFiles } from '../src/index.js';

const CTX = {
  schema: 'atl.agent-context/v1',
  generatedAt: '2026-10-13T05:12:30Z',
  sessionId: 's4k7m2q9x1abc',
  sessionState: 'PROVISIONING',
  labId: 'svc-ec2',
  labKind: 'service',
  variant: 'default',
  envId: '01jc9x3k9cq4m2x8n5b6c0d1e2',
  envName: 'e6c0d1e2',
  region: 'ap-northeast-1',
  drRegion: null,
  agentApiBase: 'https://abcde12345.execute-api.ap-northeast-1.amazonaws.com',
  platformOrigin: 'https://d1234abcd.cloudfront.net',
  cloudalbum: {
    stateUri: 's3://cloudalbum-lab-state-111122223333-ap-northeast-1/e6c0d1e2/state.json',
    lockTable: 'cloudalbum-lab-locks',
    stackTags: { 'atl:component': 'env', 'atl:session-id': 's4k7m2q9x1abc', 'atl:lab-id': 'svc-ec2', 'atl:env-id': '01jc9x3k9cq4m2x8n5b6c0d1e2', Project: 'CloudAlbum' },
    permissionsBoundaryArn: 'arn:aws:iam::111122223333:policy/ATLWorkloadBoundary',
    adminPasswordParam: '/cloudalbum/e6c0d1e2/atl/app-admin-password',
    testUsersParam: null,
    opsReport: 'agent',
    asgMaxSizeLimit: 4,
  },
  ssh: null,
  appEntry: null,
  platformActions: [],
};

// temp files stay on the repo drive (.atl-dev is git-ignored)
const TMP_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../.atl-dev/tmp');
let dir = '';
afterEach(() => {
  if (dir) fs.rmSync(dir, { recursive: true, force: true });
});

describe('workstation session files (03 §4.6)', () => {
  it('renders session.env and session.json', () => {
    const r = renderSessionFiles(CTX);
    expect(r.sessionEnv).toContain("ATL_SESSION_ID='s4k7m2q9x1abc'\n");
    expect(r.sessionEnv).toContain("CLOUDALBUM_OPS_REPORT='agent'\n");
    expect(r.sessionEnv).toContain("CLOUDALBUM_PLATFORM_MODE='1'\n");
    expect(r.sessionEnv).not.toContain('CLOUDALBUM_DR_REGION');
    expect(JSON.parse(r.sessionJson)).toEqual({
      schema: 'atl.agent-context/v1',
      agentApiBase: CTX.agentApiBase,
      sessionId: CTX.sessionId,
      labId: 'svc-ec2',
      envName: 'e6c0d1e2',
      region: 'ap-northeast-1',
      cloudalbum: { adminPasswordParam: '/cloudalbum/e6c0d1e2/atl/app-admin-password' },
    });
  });

  it('writes both files idempotently', () => {
    fs.mkdirSync(TMP_ROOT, { recursive: true });
    dir = fs.mkdtempSync(path.join(TMP_ROOT, 'ws-'));
    const paths = { sessionEnv: path.join(dir, 'etc', 'session.env'), sessionJson: path.join(dir, 'home', '.atl', 'session.json') };
    writeSessionFiles(CTX, paths);
    const first = fs.readFileSync(paths.sessionEnv, 'utf8');
    writeSessionFiles(CTX, paths);
    expect(fs.readFileSync(paths.sessionEnv, 'utf8')).toBe(first);
    expect(fs.existsSync(paths.sessionJson)).toBe(true);
  });

  it('rejects an unknown schema with the non-retryable exit code 3', () => {
    try {
      renderSessionFiles({ ...CTX, schema: 'atl.agent-context/v9' });
      expect.unreachable();
    } catch (e) {
      expect(e).toBeInstanceOf(ContextInvalidError);
      expect((e as ContextInvalidError).exitCode).toBe(3);
    }
  });
});
