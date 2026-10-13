/**
 * atl-custom-resources (01 §4.5–§4.8, 02 §10.5) with in-memory ports: every CloudFormation request is answered, the
 * uninstall guard hands the response URL to atl-platform-uninstall (or takes the fast path), and UninstallRoleCleanup only
 * removes what does not belong to the stack.
 */
import { generateKeyPairSync } from 'node:crypto';
import { Gsi2, Keys } from '@atl/shared';
import { jwkThumbprint } from '@atl/shared/node';
import { describe, expect, it } from 'vitest';
import { createCustomResourcesHandler } from '../custom-resources/src/handler.js';
import { stackPolicy } from '../custom-resources/src/handlers/stack-guard.js';
import { readZip, writeZip } from '../custom-resources/src/zip.js';
import { cfnEvent, fakePorts } from './support/fake-ports.js';

const TABLE = 'atl-main';
const handlerFor = (ports: ReturnType<typeof fakePorts>['ports']) => createCustomResourcesHandler(async () => ports, { ATL_TABLE: TABLE });
const KEEP = {
  ATLLearnerRole: { Inline: ['ATLLearnerIam', 'ATLAgentApi'], Managed: ['arn:aws:iam::aws:policy/PowerUserAccess', 'arn:aws:iam::111122223333:policy/ATLLearnerGuardrails'] },
  ATLWorkstationRole: { Inline: ['ATLWorkstation'], Managed: ['arn:aws:iam::aws:policy/AmazonSSMManagedInstanceCore'] },
  CloudAlbumAppRole: { Inline: [], Managed: ['arn:aws:iam::aws:policy/AmazonSSMManagedInstanceCore'] },
};

describe('protocol', () => {
  it('answers SUCCESS with data, and FAILED with the error for unknown types', async () => {
    const { ports, state } = fakePorts();
    const h = handlerFor(ports);
    await h(cfnEvent('SchemaMigrator', 'Create', { Table: TABLE, Version: '0.1.0' }));
    expect(state.responses[0]!.body).toMatchObject({ Status: 'SUCCESS', RequestId: 'req-1', LogicalResourceId: 'SchemaMigrator', Data: { SchemaVersion: '1' } });
    await h(cfnEvent('Bogus', 'Create', {}));
    expect(state.responses[1]!.body).toMatchObject({ Status: 'FAILED' });
    expect(String(state.responses[1]!.body.Reason)).toMatch(/unknown custom resource type/);
  });

  it('a Delete during a rollback with no table still succeeds', async () => {
    const { ports, state } = fakePorts();
    ports.table.update = async () => {
      throw Object.assign(new Error('Requested resource not found'), { name: 'ResourceNotFoundException' });
    };
    await handlerFor(ports)(cfnEvent('UninstallGuard', 'Delete', { Table: TABLE, KeepPolicies: KEEP, UninstallStateMachineArn: 'arn:sm' }, 'atl-uninstallguard'));
    expect(state.responses[0]!.body.Status).toBe('SUCCESS');
  });

  it('rejects unknown actions with Atl.NotImplemented', async () => {
    const { ports } = fakePorts();
    await expect(handlerFor(ports)({ action: 'Nope' })).rejects.toMatchObject({ name: 'Atl.NotImplemented' });
  });

  it('zip round trip', () => {
    const z = writeZip([{ name: 'a/b.txt', data: Buffer.from('hello hello hello hello') }, { name: 'c.bin', data: Buffer.from([0, 1, 2]) }]);
    expect(readZip(z).map((e) => [e.name, e.data.toString('hex')])).toEqual([
      ['a/b.txt', Buffer.from('hello hello hello hello').toString('hex')],
      ['c.bin', '000102'],
    ]);
    expect(writeZip([{ name: 'x', data: Buffer.from('1') }]).equals(writeZip([{ name: 'x', data: Buffer.from('1') }]))).toBe(true);
    expect(() => writeZip([{ name: '../evil', data: Buffer.from('') }])).toThrow();
  });
});

describe('BucketEmptier', () => {
  it('deletes every version on Delete, page by page; Create does nothing', async () => {
    const { ports, state } = fakePorts();
    for (let i = 0; i < 5; i++) await ports.s3.putObject('atl-web-x', `k${i}`, 'v1');
    await ports.s3.putObject('atl-web-x', 'k0', 'v2');
    const h = handlerFor(ports);
    await h(cfnEvent('BucketEmptier', 'Create', { Buckets: ['atl-web-x', 'missing'] }));
    expect(state.buckets.get('atl-web-x')!.size).toBe(5);
    await h(cfnEvent('BucketEmptier', 'Delete', { Buckets: ['atl-web-x', 'missing'] }, 'atl-bucketemptier'));
    expect(state.buckets.get('atl-web-x')!.size).toBe(0);
    expect(state.responses.map((r) => r.body.Status)).toEqual(['SUCCESS', 'SUCCESS']);
  });
});

describe('StackGuard', () => {
  it('turns on termination protection and protects the anchors from replacement / deletion', async () => {
    const { ports, state } = fakePorts();
    const protectedIds = ['AtlMainTable', 'CertSigningKey', 'UserPool', 'LabStateBucket', 'LabLockTable'];
    await handlerFor(ports)(cfnEvent('StackGuard', 'Create', { StackId: 'arn:stack', ProtectedResources: protectedIds }));
    expect(state.stack.protection).toBe(true);
    expect(JSON.parse(state.stack.policy!)).toEqual(JSON.parse(stackPolicy(protectedIds)));
    expect(JSON.parse(state.stack.policy!).Statement[1].Resource).toContain('LogicalResourceId/AtlMainTable');
  });
  it('a refused SetStackPolicy keeps termination protection and is recorded instead of failing the install', async () => {
    const { ports, state } = fakePorts();
    ports.stack.setStackPolicy = async () => {
      throw new Error('Stack is in CREATE_IN_PROGRESS state');
    };
    await handlerFor(ports)(cfnEvent('StackGuard', 'Create', { StackId: 'arn:stack', ProtectedResources: ['AtlMainTable'], Table: TABLE }));
    expect(state.stack.protection).toBe(true);
    expect(state.responses[0]!.body).toMatchObject({ Status: 'SUCCESS', Data: { StackPolicy: 'failed' } });
    expect((await ports.table.get(TABLE, Keys.platformConfig()))!.stackGuard).toMatchObject({ stackPolicy: 'failed' });
  });
});

describe('SeedData', () => {
  const props = {
    Table: TABLE, Version: '0.1.0-dev', ReleaseVersion: 'dev', InstallationId: '1a2b3c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5d', Region: 'ap-northeast-1',
    DrRegion: 'ap-northeast-3', PlatformUrl: 'https://d1.cloudfront.net', AgentApiEndpoint: 'https://a1b2c3d4e5.execute-api.ap-northeast-1.amazonaws.com',
    WorkloadBoundaryArn: 'arn:aws:iam::111122223333:policy/ATLWorkloadBoundary', MaxSessionMinutes: '360', ExtensionMinutes: '30', MaxExtensions: '2',
    MaxKeepHours: '24', EnvMaxAgeDays: '7', ReadyIdleMinutes: '60', AsgMaxSizeLimit: '4', AllowedInstanceTypes: 't3.micro,t4g.small',
    WorkstationInstanceType: 't4g.small', MonthlyBudgetAmount: '0', BudgetEnforcement: 'block-start', TerminalRecording: 'off',
    ExternalAccessAnalyzer: 'create', AnalyzerArn: 'arn:aws:access-analyzer:ap-northeast-1:111122223333:analyzer/atl-external-access',
    UserPoolId: 'ap-northeast-1_X', AssistantEmails: 'a@example.com, b@example.com',
  };
  it('writes PlatformConfig on Create and invites assistants', async () => {
    const { ports, state } = fakePorts();
    await handlerFor(ports)(cfnEvent('SeedData', 'Create', props));
    const cfg = (await ports.table.get(TABLE, Keys.platformConfig()))!;
    expect(cfg).toMatchObject({
      type: 'PlatformConfig', mode: 'NORMAL', maintenance: false, region: 'ap-northeast-1', drRegion: 'ap-northeast-3',
      limits: { maxSessionMinutes: 360, extension: { minutes: 30, maxCount: 2 }, keepHardMaxHours: 72, asgMaxSizeLimit: 4 },
      terminal: { recording: 'off', persistence: 'none' }, ownership: { maxWaitMinutes: 20, hardMaxWaitMinutes: 45 },
      allowedInstanceTypes: ['t3.micro', 't4g.small'],
    });
    expect([...state.users.keys()].sort()).toEqual(['ap-northeast-1_X|a@example.com', 'ap-northeast-1_X|b@example.com']);
  });
  it('Update refreshes install-derived fields but keeps settings changed in the platform', async () => {
    const { ports } = fakePorts();
    const h = handlerFor(ports);
    await h(cfnEvent('SeedData', 'Create', props));
    await ports.table.update(TABLE, Keys.platformConfig(), { terminal: { recording: 'off', persistence: 'tmux' }, mode: 'UNINSTALLING' });
    await h(cfnEvent('SeedData', 'Update', { ...props, MaxSessionMinutes: '420', TerminalRecording: 'cloudwatch', Version: '0.2.0' }, 'atl-seeddata'));
    const cfg = (await ports.table.get(TABLE, Keys.platformConfig()))!;
    expect(cfg).toMatchObject({ version: '0.2.0', limits: { maxSessionMinutes: 420 }, terminal: { recording: 'cloudwatch', persistence: 'tmux' }, mode: 'UNINSTALLING' });
  });
});

describe('Preflight / SchemaMigrator', () => {
  it('Preflight records the items without failing', async () => {
    const { ports, state } = fakePorts();
    await handlerFor(ports)(cfnEvent('Preflight', 'Create', { Table: TABLE }));
    const cfg = (await ports.table.get(TABLE, Keys.platformConfig()))!;
    expect((cfg.preflight as { items: unknown[] }).items).toHaveLength(2);
    expect(state.responses[0]!.body).toMatchObject({ Status: 'SUCCESS', Data: { Warnings: '1' } });
  });
});

describe('JwksPublish', () => {
  it('publishes jwks.json with kid = JWK thumbprint and records SigningKey', async () => {
    const { publicKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
    const der = publicKey.export({ format: 'der', type: 'spki' });
    const { ports, state } = fakePorts({ publicKeyDer: new Uint8Array(der) });
    await handlerFor(ports)(cfnEvent('JwksPublish', 'Create', { Table: TABLE, KeyId: 'k-1', WebBucket: 'atl-web-x', DistributionId: 'E1' }));
    const jwk = publicKey.export({ format: 'jwk' }) as { x: string; y: string };
    const kid = jwkThumbprint({ kty: 'EC', crv: 'P-256', x: jwk.x, y: jwk.y });
    const jwks = JSON.parse(state.buckets.get('atl-web-x')!.get('.well-known/atl/jwks.json')!.data.toString());
    expect(jwks.keys).toEqual([{ kty: 'EC', crv: 'P-256', x: jwk.x, y: jwk.y, kid, alg: 'ES256', use: 'sig' }]);
    expect(await ports.table.get(TABLE, Keys.signingKey(kid))).toMatchObject({ type: 'SigningKey', kid, alg: 'ES256' });
    expect(state.invalidations).toEqual([{ distributionId: 'E1', paths: ['/.well-known/atl/*'] }]);
    expect(state.responses[0]!.body).toMatchObject({ Status: 'SUCCESS', Data: { Kid: kid } });
  });
});

describe('WebDeploy', () => {
  it('publishes the SPA (not into protected prefixes), config.json, the content release and the CatalogRelease', async () => {
    const { ports, state } = fakePorts();
    const prefix = 'releases/dev/';
    await ports.s3.putObject('atl-artifacts-x', `${prefix}atl-web.zip`, writeZip([
      { name: 'index.html', data: Buffer.from('<html>') },
      { name: 'assets/app-abc.js', data: Buffer.from('1') },
      { name: 'verify/index.html', data: Buffer.from('<v>') },
      { name: 'public/revocations.jws', data: Buffer.from('must not overwrite') },
      { name: 'config.json', data: Buffer.from('{}') },
    ]));
    await ports.s3.putObject('atl-artifacts-x', `${prefix}atl-content.zip`, writeZip([
      { name: 'manifest.json', data: Buffer.from(JSON.stringify({ catalogVersion: '2026.10.1' })) },
      { name: 'labs/svc-cdn.json', data: Buffer.from('{}') },
      { name: 'private/quiz/svc-cdn.json', data: Buffer.from('{"answers":[]}') },
    ]));
    await ports.s3.putObject('atl-artifacts-x', `${prefix}atl-cloudshell-kit-x86_64.tar.gz`, 'kit');
    await handlerFor(ports)(cfnEvent('WebDeploy', 'Create', {
      ArtifactsBucket: 'atl-artifacts-x', ReleasePrefix: prefix, WebBucket: 'atl-web-x', DistributionId: 'E1', Table: TABLE, Version: '0.1.0',
      Config: { apiBase: '/api/v1', userPoolId: 'p', clientId: 'c' },
    }));
    const web = state.buckets.get('atl-web-x')!;
    expect(web.get('index.html')!.meta).toEqual({ contentType: 'text/html; charset=utf-8', cacheControl: 'no-cache' });
    expect(web.get('assets/app-abc.js')!.meta!.cacheControl).toContain('immutable');
    expect(web.has('public/revocations.jws')).toBe(false);
    expect(JSON.parse(web.get('config.json')!.data.toString())).toEqual({ apiBase: '/api/v1', userPoolId: 'p', clientId: 'c' });
    expect(web.has('content/2026.10.1/labs/svc-cdn.json')).toBe(true);
    expect(web.has('content/2026.10.1/private/quiz/svc-cdn.json')).toBe(false);
    expect(state.buckets.get('atl-artifacts-x')!.has(`${prefix}private/quiz/svc-cdn.json`)).toBe(true);
    expect(web.has('kit/cloudshell/0.1.0/atl-cloudshell-kit-x86_64.tar.gz')).toBe(true);
    expect(await ports.table.get(TABLE, Keys.catalogCurrent())).toMatchObject({ catalogVersion: '2026.10.1' });
    expect(state.invalidations[0]!.paths).toContain('/config.json');
    expect(state.responses[0]!.body).toMatchObject({ Status: 'SUCCESS', Data: { Spa: '3', Content: '2026.10.1', CloudShellKit: '1' } });
  });
});

describe('UninstallGuard and UninstallRoleCleanup (01 §4.8)', () => {
  const guardProps = { Table: TABLE, KeepPolicies: KEEP, UninstallStateMachineArn: 'arn:aws:states:ap-northeast-1:111122223333:stateMachine:atl-platform-uninstall' };
  const seedRoles = (state: ReturnType<typeof fakePorts>['state']) => {
    state.rolePolicies.set('ATLLearnerRole', ['ATLLearnerIam', 'ATLAgentApi', 'ATLRevokedSessions']);
    state.attached.set('ATLLearnerRole', [...KEEP.ATLLearnerRole.Managed]);
    state.rolePolicies.set('ATLWorkstationRole', ['ATLWorkstation']);
    state.attached.set('ATLWorkstationRole', [...KEEP.ATLWorkstationRole.Managed]);
    state.roleTags.set('ATLWorkstationRole', [{ key: 'atl:active-session-id', value: 's4k7m2q9x1abc' }, { key: 'Project', value: 'ATL' }]);
    state.rolePolicies.set('CloudAlbumAppRole', ['AWSRevokeOlderSessions', 'learner-inline']);
    state.attached.set('CloudAlbumAppRole', [...KEEP.CloudAlbumAppRole.Managed, 'arn:aws:iam::111122223333:policy/cloudalbum-e7k2m9qx-storage']);
  };

  it('Create only registers the keep-lists', async () => {
    const { ports, state } = fakePorts();
    await handlerFor(ports)(cfnEvent('UninstallGuard', 'Create', guardProps));
    expect((await ports.table.get(TABLE, Keys.platformConfig()))!.uninstallGuard).toMatchObject({ keep: KEEP });
    expect(state.executions).toEqual([]);
    expect(state.responses[0]!.body.Status).toBe('SUCCESS');
  });

  it('Delete with nothing to reclaim: fast path cleans the roles and answers SUCCESS', async () => {
    const { ports, state } = fakePorts();
    seedRoles(state);
    state.rolePolicies.set('ATLLearnerRole', ['ATLLearnerIam', 'ATLAgentApi']);
    await handlerFor(ports)(cfnEvent('UninstallGuard', 'Delete', guardProps, 'atl-uninstallguard'));
    expect(state.executions).toEqual([]);
    expect(state.rolePolicies.get('CloudAlbumAppRole')).toEqual([]);
    expect(state.attached.get('CloudAlbumAppRole')).toEqual(KEEP.CloudAlbumAppRole.Managed);
    expect(state.roleTags.get('ATLWorkstationRole')).toEqual([{ key: 'Project', value: 'ATL' }]);
    expect((await ports.table.get(TABLE, Keys.platformConfig()))!.mode).toBe('UNINSTALLING');
    expect(state.responses[0]!.body).toMatchObject({ Status: 'SUCCESS', PhysicalResourceId: 'atl-uninstallguard' });
  });

  it('Delete with sessions or revocation entries: starts uninstall-<n> with the response URL and does not answer', async () => {
    const { ports, state } = fakePorts();
    seedRoles(state);
    await ports.table.put(TABLE, { ...Keys.labSession('s4k7m2q9x1abc'), ...Gsi2.labSession({ sid: 's4k7m2q9x1abc', state: 'KEPT', stateEnteredAt: '2026-10-13T00:00:00Z' })! });
    await handlerFor(ports)(cfnEvent('UninstallGuard', 'Delete', guardProps, 'atl-uninstallguard'));
    expect(state.responses).toEqual([]);
    expect(state.executions).toHaveLength(1);
    expect(state.executions[0]).toMatchObject({ name: 'uninstall-1', input: { trigger: 'guard', cfn: { requestId: 'req-1', physicalResourceId: 'atl-uninstallguard' } } });
    expect(state.rolePolicies.get('ATLLearnerRole')).toContain('ATLRevokedSessions');
  });

  it('UninstallRoleCleanup SUCCESS removes everything that does not belong to the stack, then answers CloudFormation', async () => {
    const { ports, state } = fakePorts();
    seedRoles(state);
    await ports.table.put(TABLE, { ...Keys.platformConfig(), type: 'PlatformConfig', mode: 'UNINSTALLING', uninstallGuard: { keep: KEEP } });
    const cb = { responseUrl: 'https://s3.example/presigned', requestId: 'r', stackId: 's', logicalResourceId: 'UninstallGuard', physicalResourceId: 'atl-uninstallguard' };
    const r = (await handlerFor(ports)({ action: 'UninstallRoleCleanup', cfn: cb, outcome: 'SUCCESS' })) as { status: string; actions: string[] };
    expect(r.status).toBe('SUCCESS');
    expect(state.rolePolicies.get('ATLLearnerRole')).toEqual(['ATLLearnerIam', 'ATLAgentApi']);
    expect(state.rolePolicies.get('CloudAlbumAppRole')).toEqual([]);
    expect(state.attached.get('CloudAlbumAppRole')).toEqual(['arn:aws:iam::aws:policy/AmazonSSMManagedInstanceCore']);
    expect(state.responses[0]).toMatchObject({ url: cb.responseUrl, body: { Status: 'SUCCESS', PhysicalResourceId: 'atl-uninstallguard', LogicalResourceId: 'UninstallGuard' } });
  });

  it('UninstallRoleCleanup FAILED only answers; preconditions not met → FAILED and nothing is touched', async () => {
    const { ports, state } = fakePorts();
    seedRoles(state);
    const cb = { responseUrl: 'https://s3.example/presigned', requestId: 'r', stackId: 's', logicalResourceId: 'UninstallGuard', physicalResourceId: 'p' };
    await handlerFor(ports)({ action: 'UninstallRoleCleanup', cfn: cb, outcome: 'FAILED', reason: '2 BLOCKING residues' });
    expect(state.responses[0]!.body).toMatchObject({ Status: 'FAILED', Reason: '2 BLOCKING residues' });
    await ports.table.put(TABLE, { ...Keys.platformConfig(), type: 'PlatformConfig', mode: 'NORMAL' });
    await handlerFor(ports)({ action: 'UninstallRoleCleanup', cfn: cb, outcome: 'SUCCESS' });
    expect(state.responses[1]!.body.Status).toBe('FAILED');
    expect(String(state.responses[1]!.body.Reason)).toMatch(/UNINSTALLING/);
    expect(state.rolePolicies.get('ATLLearnerRole')).toContain('ATLRevokedSessions');
  });
});
