/**
 * Integration wiring (docs/implementation-notes.md “platform-integration”): the production HTTP handlers are the API's
 * route tables, the lifecycle accepts the template's `ExecutionFailed` envelope, the dev health-gate waiver only waives
 * dev-host gaps, the dev reclaim account notifies deletions, planned cards are never startable.
 */
import { describe, expect, it } from 'vitest';
import { VirtualClock } from '@atl/workflows';
import { devHealthGateWaiver, createFunctionTable } from '../src/dev/runtime.js';
import { DevReclaimCloud } from '../src/orchestrator-dev/index.js';
import { normalizeLifecycleEvent } from '../src/functions/lifecycle/handler.js';
import { apiRouteHandlers, agentRouteHandlers, publicRouteHandlers } from '../src/routes/index.js';
import { ROUTE_HANDLERS as PUBLIC_HANDLERS } from '../src/functions/public/handler.js';
import { isPlannedCard, plannedBlocker, throwBlocker } from '../src/services/sessions/guards.js';
import { DOWNSTREAM_ACTIONS } from '../src/routes/extensions.js';
import { httpEvent, NO_DB } from './helpers.js';
import { loadPlatformEnv } from '../src/runtime/env.js';
import type { FunctionDeps } from '../src/runtime/deps.js';
import type { PlatformPorts } from '@atl/shared';
import { DevAuth } from '../src/dev/adapters/auth.js';

describe('production HTTP handlers = the API route tables', () => {
  it('atl-api / atl-agent serve their routes (no scaffold 501 for implemented routes); atl-public is the certs-owned table', async () => {
    const clock = new VirtualClock(Date.UTC(2026, 9, 14, 1, 0, 0));
    const deps: FunctionDeps = { ports: { clock, auth: new DevAuth(clock) } as unknown as PlatformPorts, db: NO_DB, env: loadPlatformEnv({ AWS_REGION: 'ap-northeast-1', ATL_DEV_MODE: '1' }) };
    const table = createFunctionTable(async () => deps);
    const time = (await table['atl-api'](httpEvent('GET', '/api/v1/time', { headers: { authorization: 'Bearer dev.learner.u1' } }))) as { statusCode: number };
    expect(time.statusCode).toBe(200);
    expect(Object.keys(apiRouteHandlers())).toEqual(expect.arrayContaining(['createSession', 'getCatalog', 'issueCertificate', 'getOfflineBundle']));
    expect(Object.keys(agentRouteHandlers())).toEqual(expect.arrayContaining(['agentGetContext', 'agentRegisterExperimentRun', 'internalRunEvents']));
    expect(publicRouteHandlers()).toBe(PUBLIC_HANDLERS);
    expect(DOWNSTREAM_ACTIONS).toMatchObject({ lifecycle: { resolveCleanup: 'ResolveCleanup' } });
  });
});

describe('atl-lifecycle event envelopes', () => {
  it('maps the template rule payload {action: ExecutionFailed, event} and the raw event to HandleExecutionFailure', () => {
    const detail = { executionArn: 'arn:aws:states:ap-northeast-1:000000000000:execution:atl-session-start:start-s0123456789ab', status: 'FAILED' };
    expect(normalizeLifecycleEvent({ action: 'ExecutionFailed', event: { 'detail-type': 'Step Functions Execution Status Change', detail } })).toEqual({ action: 'HandleExecutionFailure', detail });
    expect(normalizeLifecycleEvent({ 'detail-type': 'Step Functions Execution Status Change', detail })).toEqual({ action: 'HandleExecutionFailure', detail });
    expect(normalizeLifecycleEvent({ Records: [{ Sns: { Message: 'budget 80%' } }] })).toEqual({ action: 'BudgetAlert', message: 'budget 80%' });
  });
});

describe('dev health-gate waiver (local-l0)', () => {
  const hostGaps = {
    status: 'FAIL',
    report: {
      'base.ready': { ok: false, observed: { services: { api: 'active', worker: 'unknown', nginx: 'unknown' }, dataVolumeMounted: false, platformEnvPresent: true, probeTokenPresent: true } },
      'caps.profile': { ok: false, diffs: [{ module: 'iam', driver: 'none', status: 'off' }] },
      'ws.ready': { ok: true },
    },
  };

  it('waives only dev-host gaps and lists them', () => {
    const r = devHealthGateWaiver(hostGaps) as { status: string; report: { devWaived: string[] } };
    expect(r.status).toBe('PASS');
    expect(r.report.devWaived).toHaveLength(2);
  });

  it('never waives an unhealthy module, a stopped api or a missing platform.env / probe secret', () => {
    const errorModule = { ...hostGaps, report: { ...hostGaps.report, 'caps.profile': { ok: false, diffs: [{ module: 'iam', driver: 'role', status: 'error' }] } } };
    expect((devHealthGateWaiver(errorModule) as { status: string }).status).toBe('FAIL');
    const noEnv = { ...hostGaps, report: { ...hostGaps.report, 'base.ready': { ok: false, observed: { ...hostGaps.report['base.ready'].observed, platformEnvPresent: false } } } };
    expect((devHealthGateWaiver(noEnv) as { status: string }).status).toBe('FAIL');
    const apiDown = { ...hostGaps, report: { ...hostGaps.report, 'base.ready': { ok: false, observed: { ...hostGaps.report['base.ready'].observed, services: { api: 'inactive' } } } } };
    expect((devHealthGateWaiver(apiDown) as { status: string }).status).toBe('FAIL');
    const wsDown = { ...hostGaps, report: { ...hostGaps.report, 'ws.ready': { ok: false } } };
    expect((devHealthGateWaiver(wsDown) as { status: string }).status).toBe('FAIL');
    expect(devHealthGateWaiver({ status: 'NOT_READY' })).toEqual({ status: 'NOT_READY' });
  });
});

describe('dev reclaim account', () => {
  it('reports every removed resource (stack deletion and reclaimer deletes) to its listeners', async () => {
    const acct = new DevReclaimCloud();
    const removed: string[] = [];
    acct.onDeleted((r) => removed.push(`${r.type}:${r.id}`));
    acct.addStack({ name: 'cloudalbum-eabcdefg-ec2', region: 'ap-northeast-1', status: 'CREATE_COMPLETE', tags: {} }, [{ type: 'AWS::EC2::Instance', id: 'i-dev-eabcdefg-lab', logicalId: 'Instance' }]);
    acct.addResource({ type: 'AWS::RDS::DBInstance', region: 'ap-northeast-1', id: 'db-1', tags: { 'atl:env-id': 'x' } });
    acct.deleteStack('ap-northeast-1', 'cloudalbum-eabcdefg-ec2');
    await acct.delete({ type: 'AWS::RDS::DBInstance', region: 'ap-northeast-1', id: 'db-1' } as never, { roleSessionName: 'atl-s0123456789ab-reap-1', ownsSharedObjects: false, policyArns: [] } as never);
    expect(removed).toEqual(['AWS::EC2::Instance:i-dev-eabcdefg-lab', 'AWS::CloudFormation::Stack:cloudalbum-eabcdefg-ec2', 'AWS::RDS::DBInstance:db-1']);
    // RDS ARNs map back to the instance (one ledger item per resource, whichever source found it)
    expect((await acct.taggedResources({ region: 'ap-northeast-1', key: 'atl:env-id', value: 'x' })).length).toBe(0);
  });
});

describe('planned cards (05: catalog placeholders)', () => {
  it('are recognised and refused with reason LAB_PLANNED on a registered error code', () => {
    expect(isPlannedCard({ status: 'planned' })).toBe(true);
    expect(isPlannedCard({ status: 'beta' })).toBe(false);
    expect(() => throwBlocker(plannedBlocker('svc-cost'))).toThrow(expect.objectContaining({ code: 'VALIDATION_FAILED' }));
  });
});
