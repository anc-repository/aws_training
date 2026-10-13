import fs from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { VirtualClock, type AslDefinition } from '@atl/workflows';
import { ExecutionNames } from '@atl/shared';
import { devToken } from '../src/dev/adapters/auth.js';
import { loadDevConfig } from '../src/dev/config.js';
import { createDevRuntime, type DevRuntime } from '../src/dev/runtime.js';
import { handleDevRequest } from '../src/dev/server.js';
import { ACTIONS as LIFECYCLE_ACTIONS } from '../src/functions/lifecycle/handler.js';
import { NO_DB, tmpDir } from './helpers.js';

const SID = 's4k7m2q9x1abc';
const ENV_ID = '01jc9x3k9cq4m2x8n5b6c0d1e2';

/** A tiny start-like workflow: lifecycle action → runner build (.sync) → choice. */
const DEMO: AslDefinition = {
  QueryLanguage: 'JSONPath',
  StartAt: 'Lock',
  States: {
    Lock: {
      Type: 'Task',
      Resource: 'arn:aws:states:::lambda:invoke',
      Parameters: { FunctionName: '${LifecycleFn}', Payload: { action: 'DemoLock', 'sessionId.$': '$.sessionId' } },
      ResultSelector: { 'envId.$': '$.Payload.envId' },
      ResultPath: '$.lock',
      Retry: [{ ErrorEquals: ['Atl.Retryable'], IntervalSeconds: 2, MaxAttempts: 3, BackoffRate: 2 }],
      Next: 'BaseDeploy',
    },
    BaseDeploy: {
      Type: 'Task',
      Resource: 'arn:aws:states:::codebuild:startBuild.sync',
      Parameters: {
        ProjectName: '${RunnerProject}',
        EnvironmentVariablesOverride: [
          { Name: 'ATL_OP', Type: 'PLAINTEXT', Value: 'base-deploy' },
          { Name: 'ATL_RUN_ID', Type: 'PLAINTEXT', 'Value.$': "States.Format('{}-base-1', $.sessionId)" },
          { Name: 'ATL_SESSION_ID', Type: 'PLAINTEXT', 'Value.$': '$.sessionId' },
          { Name: 'ATL_ENV_ID', Type: 'PLAINTEXT', 'Value.$': '$.lock.envId' },
          { Name: 'ATL_LAB_ID', Type: 'PLAINTEXT', Value: 'svc-ec2' },
        ],
      },
      ResultSelector: { 'status.$': '$.Build.BuildStatus', 'resultKey.$': '$.Build.ResultKey' },
      ResultPath: '$.base',
      Next: 'Ok',
    },
    Ok: { Type: 'Choice', Choices: [{ Variable: '$.base.status', StringEquals: 'SUCCEEDED', Next: 'Done' }], Default: 'Bad' },
    Done: { Type: 'Succeed' },
    Bad: { Type: 'Fail', Error: 'Atl.BaseDeployFailed' },
  },
};

let rt: DevRuntime;
let dataDir: string;
let attempts = 0;

beforeAll(async () => {
  dataDir = tmpDir('rt-');
  LIFECYCLE_ACTIONS.DemoLock = async () => {
    attempts++;
    if (attempts === 1) throw Object.assign(new Error('transient'), { name: 'Atl.Retryable' });
    return { envId: ENV_ID };
  };
  rt = await createDevRuntime(loadDevConfig({ ATL_DEV_DATA_DIR: dataDir, ATL_DEV_RUNNER_NOOP_SECONDS: '60' }), {
    clock: new VirtualClock(Date.UTC(2026, 9, 13, 5, 0, 0)),
    db: NO_DB,
    definitions: { 'atl-session-start': DEMO, 'atl-session-end': { StartAt: 'X', States: { X: { Type: 'Fail', Error: 'Atl.NotImplemented' } } } },
  });
});

afterAll(async () => {
  delete LIFECYCLE_ACTIONS.DemoLock;
  await rt?.close();
  fs.rmSync(dataDir, { recursive: true, force: true });
});

describe('ATL_DEV_MODE runtime', () => {
  it('runs a workflow through the in-process simulator, lambda table and dev runner', async () => {
    const { executionArn } = await rt.orchestrator.startExecution({ stateMachine: 'atl-session-start', name: ExecutionNames.start(SID), input: { sessionId: SID } });
    const d = await rt.orchestrator.sim.waitFor(executionArn);
    expect(d.status).toBe('SUCCEEDED');
    expect(attempts).toBe(2); // first attempt failed with Atl.Retryable and was retried
    expect(d.output).toMatchObject({ lock: { envId: ENV_ID }, base: { status: 'SUCCEEDED', resultKey: `runs/${SID}-base-1/result.json` } });
    const result = await rt.objects.get(rt.env.buckets.data, `runs/${SID}-base-1/result.json`);
    expect(JSON.parse(new TextDecoder().decode(result!))).toMatchObject({ ok: true, op: 'base-deploy', envId: ENV_ID });
    expect(rt.runner.list()).toHaveLength(1);
    // the same execution name cannot be reused (02 §2.7)
    await expect(rt.orchestrator.startExecution({ stateMachine: 'atl-session-start', name: ExecutionNames.start(SID), input: { sessionId: SID } })).rejects.toMatchObject({
      code: 'ExecutionAlreadyExists',
    });
  });

  it('injected faults surface as task errors (fault injection)', async () => {
    rt.orchestrator.sim.injectFault({ state: 'BaseDeploy', error: 'States.TaskFailed', cause: 'injected' });
    const sid = 's000000000001';
    const { executionArn } = await rt.orchestrator.startExecution({ stateMachine: 'atl-session-start', name: ExecutionNames.start(sid), input: { sessionId: sid } });
    const d = await rt.orchestrator.sim.waitFor(executionArn);
    expect(d.status).toBe('FAILED');
    expect(d.error).toBe('States.TaskFailed');
  });

  it('functions without an implemented action fail with Atl.NotImplemented', async () => {
    await expect(rt.invoker.invoke('atl-timer', { kind: 'NO_SUCH_KIND' })).rejects.toMatchObject({ name: 'Atl.NotImplemented' });
    const d = await rt.orchestrator.sim.run('atl-session-end', ExecutionNames.endFirst(SID), { sessionId: SID });
    expect(d.error).toBe('Atl.NotImplemented');
  });

  it('the dev HTTP server serves /api/v1 through the function table with dev tokens', async () => {
    const server = http.createServer((req, res) => void handleDevRequest(rt, req, res));
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    try {
      const time = await fetch(`${base}/api/v1/time`, { headers: { authorization: `Bearer ${devToken('learner', 'u1')}` } });
      expect(time.status).toBe(200);
      expect(Date.parse(((await time.json()) as { serverNow: string }).serverNow)).toBeGreaterThanOrEqual(Date.UTC(2026, 9, 13, 5, 0, 0));
      expect((await fetch(`${base}/api/v1/time`)).status).toBe(401);
      expect((await fetch(`${base}/api/v1/public/health`)).status).toBe(200);
      const ctx = await fetch(`${base}/api/v1/agent/sessions/${SID}/context`, {
        headers: { 'x-atl-dev-caller': `arn:aws:sts::000000000000:assumed-role/ATLLearnerRole/atl-${SID}-ws` },
      });
      // served by the API's agent handler (no longer the scaffold's 501); this runtime has no DynamoDB, so it cannot answer 200
      expect(ctx.status).not.toBe(501);
      expect(ctx.status).not.toBe(404);
      const state = (await (await fetch(`${base}/__dev/state`)).json()) as { executions: unknown[]; builds: unknown[] };
      expect(state.executions.length).toBeGreaterThan(0);
      const inj = await fetch(`${base}/__dev/trail/events`, { method: 'POST', body: JSON.stringify([]) });
      expect(await inj.json()).toEqual({ injected: 0 });
    } finally {
      await new Promise((r) => server.close(r));
    }
  });
});
