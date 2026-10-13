import { describe, expect, it } from 'vitest';
import { isPortError } from '@atl/shared';
import { StepFunctionsSimulator, VirtualClock, type AslDefinition, type SimulatorOptions } from '../src/index.js';

function sim(definitions: Record<string, AslDefinition>, over: Partial<SimulatorOptions> = {}) {
  const clock = new VirtualClock();
  const calls: { fn: string; payload: unknown; attempt: number }[] = [];
  const handlers: Record<string, (payload: never, attempt: number) => unknown> = {};
  const s = new StepFunctionsSimulator({
    clock,
    definitions,
    random: () => 1,
    substitutions: { LifecycleFn: 'atl-lifecycle' },
    invokeLambda: async (fn, payload, inv) => {
      calls.push({ fn, payload, attempt: inv.attempt });
      const action = (payload as { action?: string } | null)?.action ?? fn;
      const h = handlers[action];
      if (!h) throw Object.assign(new Error(`no handler ${action}`), { name: 'Atl.NoHandler' });
      return h(payload as never, inv.attempt);
    },
    ...over,
  });
  return { s, clock, calls, handlers };
}

const lambda = (action: string, extra: Record<string, unknown> = {}) => ({
  Type: 'Task' as const,
  Resource: 'arn:aws:states:::lambda:invoke',
  Parameters: { FunctionName: '${LifecycleFn}', Payload: { action, 'sessionId.$': '$.sessionId' } },
  ...extra,
});

describe('StepFunctionsSimulator', () => {
  it('runs Task → Choice → Pass with Parameters, ResultSelector, ResultPath, OutputPath and DefinitionSubstitutions', async () => {
    const { s, handlers, calls } = sim({
      m: {
        StartAt: 'Lock',
        States: {
          Lock: lambda('AcquireLock', {
            ResultSelector: { 'envId.$': '$.Payload.envId', 'fresh.$': '$.Payload.fresh' },
            ResultPath: '$.lock',
            Next: 'IsFresh',
          }),
          IsFresh: {
            Type: 'Choice',
            Choices: [{ Variable: '$.lock.fresh', BooleanEquals: true, Next: 'Fresh' }],
            Default: 'Reuse',
          },
          Fresh: {
            Type: 'Pass',
            Parameters: { 'name.$': "States.Format('env-{}-{}', $.lock.envId, $.n)", 'next.$': 'States.MathAdd($.n, 1)', 'exec.$': '$$.Execution.Name' },
            ResultPath: '$.out',
            OutputPath: '$.out',
            End: true,
          },
          Reuse: { Type: 'Fail', Error: 'Atl.Reuse' },
        },
      },
    });
    handlers.AcquireLock = () => ({ envId: 'E1', fresh: true, extra: 'dropped' });
    const d = await s.run('m', 'start-s4k7m2q9x1abc', { sessionId: 's4k7m2q9x1abc', n: 2 });
    expect(d.status).toBe('SUCCEEDED');
    expect(d.output).toEqual({ name: 'env-E1-2', next: 3, exec: 'start-s4k7m2q9x1abc' });
    expect(calls).toEqual([{ fn: 'atl-lifecycle', payload: { action: 'AcquireLock', sessionId: 's4k7m2q9x1abc' }, attempt: 0 }]);
  });

  it('retries with backoff on matching errors, then succeeds (fault injection)', async () => {
    const { s, handlers, clock } = sim(
      {
        m: {
          StartAt: 'T',
          States: {
            T: lambda('Work', {
              Retry: [{ ErrorEquals: ['Lambda.ServiceException'], IntervalSeconds: 2, MaxAttempts: 5, BackoffRate: 2 }],
              End: true,
            }),
          },
        },
      },
      { faults: [{ state: 'T', error: 'Lambda.ServiceException', times: 2 }] },
    );
    handlers.Work = (_p, attempt) => ({ attempt });
    const t0 = clock.nowMs();
    const d = await s.run('m', 'e1', { sessionId: 's4k7m2q9x1abc' });
    expect(d.status).toBe('SUCCEEDED');
    expect(d.output).toMatchObject({ Payload: { attempt: 2 } });
    expect(clock.nowMs() - t0).toBe((2 + 4) * 1000); // 2 s, then 4 s (random() = 1 → no jitter reduction)
    expect(s.history.filter((h) => h.type === 'FaultInjected')).toHaveLength(2);
  });

  it('Catch routes errors with ResultPath; States.ALL does not catch States.Runtime', async () => {
    const { s, handlers } = sim({
      m: {
        StartAt: 'T',
        States: {
          T: lambda('Lock', {
            Catch: [{ ErrorEquals: ['Atl.LockBusy'], ResultPath: '$.error', Next: 'Failed' }],
            Next: 'Bad',
          }),
          Bad: { Type: 'Pass', Parameters: { 'x.$': '$.missing' }, End: true },
          Failed: { Type: 'Pass', End: true },
        },
      },
      r: {
        StartAt: 'Bad',
        States: {
          Bad: lambda('Ok', { ResultSelector: { 'x.$': '$.Payload.missing' }, Catch: [{ ErrorEquals: ['States.ALL'], Next: 'C' }], End: true }),
          C: { Type: 'Succeed' },
        },
      },
    });
    handlers.Lock = () => {
      throw Object.assign(new Error('lock is held'), { name: 'Atl.LockBusy' });
    };
    handlers.Ok = () => ({});
    const d = await s.run('m', 'e1', { sessionId: 's4k7m2q9x1abc' });
    expect(d.status).toBe('SUCCEEDED');
    expect(d.output).toEqual({ sessionId: 's4k7m2q9x1abc', error: { Error: 'Atl.LockBusy', Cause: 'lock is held' } });

    const r = await s.run('r', 'e2', { sessionId: 's4k7m2q9x1abc' });
    expect(r.status).toBe('FAILED');
    expect(r.error).toBe('States.Runtime');
  });

  it('task TimeoutSeconds raises States.Timeout; execution TimeoutSeconds → TIMED_OUT', async () => {
    const { s, clock, handlers } = sim({
      t: {
        StartAt: 'T',
        States: { T: lambda('Slow', { TimeoutSeconds: 5, Catch: [{ ErrorEquals: ['States.Timeout'], Next: 'Late' }], End: true }), Late: { Type: 'Succeed' } },
      },
      x: { StartAt: 'W', TimeoutSeconds: 60, States: { W: { Type: 'Wait', Seconds: 3600, End: true } } },
    });
    handlers.Slow = async () => {
      await clock.sleep(10_000);
      return 'done';
    };
    const t = await s.run('t', 'e1', { sessionId: 's4k7m2q9x1abc' });
    expect(t.status).toBe('SUCCEEDED');
    expect(s.history.some((h) => h.type === 'CatchMatched' && (h.detail as { error: string }).error === 'States.Timeout')).toBe(true);
    const x = await s.run('x', 'e2', {});
    expect(x.status).toBe('TIMED_OUT');
  });

  it('Parallel and Map produce arrays; Map exposes $$.Map.Item', async () => {
    const { s } = sim({
      m: {
        StartAt: 'P',
        States: {
          P: {
            Type: 'Parallel',
            Branches: [
              { StartAt: 'A', States: { A: { Type: 'Pass', Result: 'a', End: true } } },
              { StartAt: 'B', States: { B: { Type: 'Pass', Result: 'b', End: true } } },
            ],
            ResultPath: '$.par',
            Next: 'M',
          },
          M: {
            Type: 'Map',
            ItemsPath: '$.items',
            ItemSelector: { 'v.$': '$$.Map.Item.Value', 'i.$': '$$.Map.Item.Index' },
            ItemProcessor: { StartAt: 'Q', States: { Q: { Type: 'Pass', End: true } } },
            ResultPath: '$.map',
            End: true,
          },
        },
      },
    });
    const d = await s.run('m', 'e1', { items: ['x', 'y'] });
    expect(d.output).toEqual({ items: ['x', 'y'], par: ['a', 'b'], map: [{ v: 'x', i: 0 }, { v: 'y', i: 1 }] });
  });

  it('Wait advances the (virtual) clock; Choice comparators and IsPresent', async () => {
    const { s, clock } = sim({
      m: {
        StartAt: 'W',
        States: {
          W: { Type: 'Wait', SecondsPath: '$.wait', Next: 'C' },
          C: {
            Type: 'Choice',
            Choices: [
              { And: [{ Variable: '$.opt', IsPresent: true }, { Variable: '$.opt', StringMatches: 'log-*' }], Next: 'Opt' },
              { Variable: '$.n', NumericGreaterThanEqualsPath: '$.limit', Next: 'Big' },
            ],
            Default: 'Small',
          },
          Opt: { Type: 'Pass', Result: 'opt', End: true },
          Big: { Type: 'Pass', Result: 'big', End: true },
          Small: { Type: 'Pass', Result: 'small', End: true },
        },
      },
    });
    const t0 = clock.nowMs();
    expect((await s.run('m', 'a', { wait: 90, n: 5, limit: 3 })).output).toBe('big');
    expect(clock.nowMs() - t0).toBe(90_000);
    expect((await s.run('m', 'b', { wait: 0, n: 1, limit: 3 })).output).toBe('small');
    expect((await s.run('m', 'c', { wait: 0, n: 1, limit: 3, opt: 'log-x' })).output).toBe('opt');
  });

  it('execution names follow the ExecutionAlreadyExists rules of 02 §2.7', async () => {
    const { s } = sim({ m: { StartAt: 'W', States: { W: { Type: 'Wait', Seconds: 10, End: true } } } });
    const a = s.startExecution('m', 'end-s4k7m2q9x1abc-1', { x: 1 });
    expect(s.startExecution('m', 'end-s4k7m2q9x1abc-1', { x: 1 }).executionArn).toBe(a.executionArn); // same input while running
    expect(() => s.startExecution('m', 'end-s4k7m2q9x1abc-1', { x: 2 })).toThrow(/already exists/);
    await s.waitFor(a.executionArn);
    try {
      s.startExecution('m', 'end-s4k7m2q9x1abc-1', { x: 1 }); // finished → never reusable
      expect.unreachable();
    } catch (e) {
      expect(isPortError(e, 'ExecutionAlreadyExists')).toBe(true);
    }
  });

  it('startExecution.sync:2 runs a child to completion; stop aborts a running execution', async () => {
    const { s } = sim({
      parent: {
        StartAt: 'Child',
        States: {
          Child: {
            Type: 'Task',
            Resource: 'arn:aws:states:::states:startExecution.sync:2',
            Parameters: {
              StateMachineArn: 'arn:aws:states:ap-northeast-1:000000000000:stateMachine:child',
              'Name.$': "States.Format('reclaim-{}-primary-1', $.envId)",
              Input: { 'envId.$': '$.envId' },
            },
            ResultSelector: { 'out.$': '$.Output' },
            End: true,
          },
        },
      },
      child: { StartAt: 'C', States: { C: { Type: 'Pass', Parameters: { 'done.$': '$.envId' }, End: true } } },
      long: { StartAt: 'W', States: { W: { Type: 'Wait', Seconds: 1000, End: true } } },
    });
    const d = await s.run('parent', 'p1', { envId: 'E1' });
    expect(d.output).toEqual({ out: { done: 'E1' } });
    expect(s.describeExecution(s.executionArn('child', 'reclaim-E1-primary-1')).status).toBe('SUCCEEDED');

    const l = s.startExecution('long', 'l1', {});
    s.stopExecution(l.executionArn, { cause: 'test' });
    expect((await s.waitFor(l.executionArn)).status).toBe('ABORTED');
  });

  it('codebuild startBuild.sync uses the build backend; failed builds raise States.TaskFailed', async () => {
    const builds: unknown[] = [];
    const { s } = sim(
      {
        m: {
          StartAt: 'Build',
          States: {
            Build: {
              Type: 'Task',
              Resource: 'arn:aws:states:::codebuild:startBuild.sync',
              Parameters: { ProjectName: 'atl-runner', EnvironmentVariablesOverride: [{ Name: 'ATL_OP', Type: 'PLAINTEXT', 'Value.$': '$.op' }] },
              Catch: [{ ErrorEquals: ['States.TaskFailed'], ResultPath: '$.error', Next: 'Failed' }],
              End: true,
            },
            Failed: { Type: 'Fail', Error: 'Atl.RunnerFailed' },
          },
        },
      },
      {
        runBuild: async (params) => {
          builds.push(params);
          const op = (params.EnvironmentVariablesOverride as { Value: string }[])[0]!.Value;
          return { status: op === 'destroy' ? 'FAILED' : 'SUCCEEDED', build: { id: `atl-runner:${op}` } };
        },
      },
    );
    expect((await s.run('m', 'b1', { op: 'base-deploy' })).output).toEqual({ Build: { id: 'atl-runner:base-deploy' } });
    const f = await s.run('m', 'b2', { op: 'destroy' });
    expect(f.status).toBe('FAILED');
    expect(f.error).toBe('Atl.RunnerFailed');
    expect(builds).toHaveLength(2);
  });
});
