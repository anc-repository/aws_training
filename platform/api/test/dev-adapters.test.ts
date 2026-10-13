import { createPublicKey, verify as nodeVerify } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { VirtualClock } from '@atl/workflows';
import { bytesToBase64Url, canonicalJson, ScheduleNames, type InvokerPort, type TimerPayload } from '@atl/shared';
import { jwkThumbprint } from '@atl/shared/node';
import { DevAuth, devToken } from '../src/dev/adapters/auth.js';
import { ScaledClock } from '../src/dev/adapters/clock.js';
import { DevEnvRegistry } from '../src/dev/adapters/envs.js';
import { FsObjectStore } from '../src/dev/adapters/object-store.js';
import { LocalRunCommand } from '../src/dev/adapters/run-command.js';
import { LocalProcessRunner } from '../src/dev/adapters/runner.js';
import { InProcessScheduler } from '../src/dev/adapters/scheduler.js';
import { LocalEcdsaSigner } from '../src/dev/adapters/signer.js';
import { FakeTrailLookup } from '../src/dev/adapters/trail.js';
import { REPO_ROOT, tmpDir } from './helpers.js';

const dirs: string[] = [];
const tmp = (p: string) => {
  const d = tmpDir(p);
  dirs.push(d);
  return d;
};
afterAll(() => dirs.forEach((d) => fs.rmSync(d, { recursive: true, force: true })));

const flush = () => new Promise((r) => setImmediate(r));

describe('ScaledClock (ATL_DEV_TIME_SCALE)', () => {
  it('runs faster than wall time and scales timers', async () => {
    const c = new ScaledClock(1000, Date.UTC(2026, 0, 1));
    const t0 = c.nowMs();
    const real0 = Date.now();
    await c.sleep(5_000); // 5 platform seconds = 5 real ms
    expect(Date.now() - real0).toBeLessThan(1000);
    expect(c.nowMs() - t0).toBeGreaterThanOrEqual(4_000);
    c.skip(60_000);
    expect(c.nowMs() - t0).toBeGreaterThanOrEqual(64_000);
  });

  it('skip() fires the timers it passes and re-arms the others for their remaining platform time', async () => {
    const c = new ScaledClock(1, Date.UTC(2026, 0, 1));
    const fired: string[] = [];
    c.setTimer(10 * 60_000, () => fired.push('a'));
    c.setTimer(60 * 60_000, () => fired.push('b'));
    c.setTimer(5 * 60_000, () => fired.push('x')).cancel();
    c.skip(30 * 60_000);
    await new Promise((r) => setTimeout(r, 20));
    expect(fired).toEqual(['a']);
    expect(c.pendingTimers()).toBe(1);
    c.skip(30 * 60_000);
    await new Promise((r) => setTimeout(r, 20));
    expect(fired).toEqual(['a', 'b']);
  });
});

describe('InProcessScheduler', () => {
  function setup() {
    const clock = new VirtualClock(Date.UTC(2026, 9, 13, 5, 0, 0));
    const calls: TimerPayload[] = [];
    const invoker: Pick<InvokerPort, 'invoke'> = { invoke: async <T>(_fn: string, p: unknown) => (calls.push(p as TimerPayload), undefined as T) };
    return { clock, calls, s: new InProcessScheduler(clock, invoker) };
  }

  it('fires one-time schedules at their time, deletes them, and treats a duplicate name as ConflictException', async () => {
    const { clock, calls, s } = setup();
    const sid = 's4k7m2q9x1abc';
    const at = new Date(clock.nowMs() + 15 * 60_000);
    expect(await s.createOneTime({ name: ScheduleNames.warn15(sid, 1), group: 'atl-sessions', at, payload: { kind: 'WARN_15', sessionId: sid, deadlineVersion: 1 } })).toEqual({ created: true });
    expect(await s.createOneTime({ name: ScheduleNames.warn15(sid, 1), group: 'atl-sessions', at, payload: { kind: 'WARN_15', sessionId: sid, deadlineVersion: 1 } })).toEqual({ created: false });
    expect((await s.get(ScheduleNames.warn15(sid, 1), 'atl-sessions'))?.at).toBe(at.toISOString());
    clock.advance(15 * 60_000);
    await flush();
    expect(calls).toEqual([{ kind: 'WARN_15', sessionId: sid, deadlineVersion: 1 }]);
    expect(await s.get(ScheduleNames.warn15(sid, 1), 'atl-sessions')).toBeNull(); // ActionAfterCompletion: DELETE
  });

  it('delete cancels; the sweeper runs every 5 minutes while enabled', async () => {
    const { clock, calls, s } = setup();
    await s.createOneTime({ name: 'x', group: 'atl-sessions', at: new Date(clock.nowMs() + 60_000), payload: { kind: 'SWEEP' } });
    await s.delete('x', 'atl-sessions');
    await s.delete('missing', 'atl-sessions');
    await s.setSweeperEnabled(true);
    expect((await s.get('atl-sweeper', 'atl-system'))?.state).toBe('ENABLED');
    for (let i = 0; i < 2; i++) {
      clock.advance(5 * 60_000);
      await flush();
      await flush();
    }
    await s.setSweeperEnabled(false);
    expect(calls.filter((c) => c.kind === 'SWEEP').length).toBeGreaterThanOrEqual(2);
    expect((await s.get('atl-sweeper', 'atl-system'))?.state).toBe('DISABLED');
  });
});

describe('LocalEcdsaSigner (KMS replacement)', () => {
  it('produces ES256 JWS signatures that verify with the public JWK', async () => {
    const keyDir = tmp('keys-');
    const signer = new LocalEcdsaSigner(keyDir);
    const { jwk } = await signer.getPublicKey('dev-signing-key');
    const kid = jwkThumbprint(jwk);
    const header = { alg: 'ES256', typ: 'atl-cert+jws', kid };
    const signingInput = `${bytesToBase64Url(new TextEncoder().encode(JSON.stringify(header)))}.${bytesToBase64Url(new TextEncoder().encode(canonicalJson({ v: 1, b: 2, a: 'x' })))}`;
    const { signature } = await signer.sign({ keyId: 'dev-signing-key', message: new TextEncoder().encode(signingInput) });
    expect(signature).toHaveLength(64);
    const pub = createPublicKey({ key: { ...jwk }, format: 'jwk' });
    expect(nodeVerify('sha256', Buffer.from(signingInput), { key: pub, dsaEncoding: 'ieee-p1363' }, Buffer.from(signature))).toBe(true);
    // the key persists across instances
    const again = await new LocalEcdsaSigner(keyDir).getPublicKey('dev-signing-key');
    expect(again.jwk).toEqual(jwk);
  });
});

describe('FakeTrailLookup', () => {
  it('filters by attribute, region and time; honours the delivery delay', async () => {
    const clock = new VirtualClock(Date.UTC(2026, 9, 13, 5, 0, 0));
    const t = new FakeTrailLookup(clock, 300);
    const ev = (id: string, minutesAgo: number, extra: object = {}) => ({
      eventId: id,
      eventName: 'CreateDistribution',
      eventTime: new Date(clock.nowMs() - minutesAgo * 60_000).toISOString(),
      eventSource: 'cloudfront.amazonaws.com',
      region: 'us-east-1',
      username: 'atl-s4k7m2q9x1abc-console',
      resources: [{ resourceType: 'AWS::CloudFront::Distribution', resourceName: `E${id}` }],
      ...extra,
    });
    t.inject(ev('1', 10), ev('2', 1), ev('3', 20, { region: 'ap-northeast-1' }));
    const q = (key: 'Username' | 'ResourceName', value: string) =>
      t.lookupEvents({ region: 'us-east-1', attribute: { key, value }, startTime: new Date(clock.nowMs() - 3600_000), endTime: clock.now() });
    expect((await q('Username', 'atl-s4k7m2q9x1abc-console')).events.map((e) => e.eventId)).toEqual(['1']); // '2' not delivered yet
    expect((await q('ResourceName', 'E2')).events).toEqual([]);
    clock.advance(5 * 60_000);
    expect((await q('ResourceName', 'E2')).events.map((e) => e.eventId)).toEqual(['2']);
  });
});

describe('DevAuth', () => {
  it('accepts dev.<group>.<sub>[.<authTime>]', async () => {
    const clock = new VirtualClock();
    const a = new DevAuth(clock);
    expect(await a.verifyAccessToken(devToken('learner', 'u1'))).toMatchObject({ sub: 'u1', groups: ['learner'], authTime: clock.nowMs() / 1000 });
    expect((await a.verifyAccessToken(devToken('assistant', 'ta', 1760000000))).authTime).toBe(1760000000);
    await expect(a.verifyAccessToken('eyJhbGciOi...')).rejects.toMatchObject({ code: 'UNAUTHENTICATED' });
    await expect(a.verifyAccessToken('dev.admin.u1')).rejects.toMatchObject({ code: 'UNAUTHENTICATED' });
  });
});

describe('FsObjectStore', () => {
  it('stores objects per bucket and refuses keys that escape the bucket', async () => {
    const s = new FsObjectStore(tmp('buckets-'));
    await s.put('atl-data-000000000000-ap-northeast-1', 'runs/r1/result.json', '{"ok":true}');
    expect(new TextDecoder().decode((await s.get('atl-data-000000000000-ap-northeast-1', 'runs/r1/result.json'))!)).toBe('{"ok":true}');
    expect(await s.list('atl-data-000000000000-ap-northeast-1', 'runs/')).toEqual(['runs/r1/result.json']);
    expect(await s.get('atl-data-000000000000-ap-northeast-1', 'missing')).toBeNull();
    await expect(s.put('atl-data-000000000000-ap-northeast-1', '../../escape', 'x')).rejects.toMatchObject({ code: 'InvalidInput' });
  });
});

describe('LocalProcessRunner (noop mode)', () => {
  it('runs a build on the dev clock and writes result.json / progress.jsonl', async () => {
    const clock = new VirtualClock();
    const data = tmp('runner-');
    const objects = new FsObjectStore(path.join(data, 'buckets'));
    const envs = new DevEnvRegistry(path.join(data, 'envs'));
    const r = new LocalProcessRunner({ clock, mode: 'noop', noopSeconds: 30, repoRoot: REPO_ROOT, dataDir: data, objects, dataBucket: 'atl-data-x', envs });
    const b = await r.startBuild({ op: 'base-deploy', runId: 's4k7m2q9x1abc-base-1', sessionId: 's4k7m2q9x1abc', envId: '01jc9x3k9cq4m2x8n5b6c0d1e2', labId: 'svc-ec2' });
    expect(b.status).toBe('IN_PROGRESS');
    for (let i = 0; i < 20 && (await r.getBuild(b.buildId)).status === 'IN_PROGRESS'; i++) await flush();
    const done = await r.getBuild(b.buildId);
    expect(done).toMatchObject({ status: 'SUCCEEDED', exitCode: 0, resultKey: 'runs/s4k7m2q9x1abc-base-1/result.json' });
    const result = JSON.parse(new TextDecoder().decode((await objects.get('atl-data-x', done.resultKey))!)) as Record<string, unknown>;
    expect(result).toMatchObject({ ok: true, op: 'base-deploy', mode: 'noop' });
    expect(envs.get('01jc9x3k9cq4m2x8n5b6c0d1e2')?.instances.lab).toBe('i-dev-e6c0d1e2-lab');
    expect(new TextDecoder().decode((await objects.get('atl-data-x', 'runs/s4k7m2q9x1abc-base-1/progress.jsonl'))!).trim().split('\n')).toHaveLength(2);
  });
});

describe('LocalRunCommand', () => {
  const PARAMS = {
    CheckId: 'base.ready',
    ArgsB64: 'e30',
    RunToken: 'abcdefghijklmnopqrstuv',
    SessionId: 's4k7m2q9x1abc',
    BundleDigest: 'a'.repeat(64),
    TimeoutSec: '20',
  };

  it('enforces the ATL-RunCheck allowedPatterns', async () => {
    const rc = new LocalRunCommand({ clock: new VirtualClock(), envs: new DevEnvRegistry(tmp('envs-')), checkRunner: null, repoRoot: REPO_ROOT });
    await expect(rc.sendCommand({ documentName: 'ATL-RunCheck', instanceIds: ['i-1'], parameters: { ...PARAMS, CheckId: 'rm -rf /' } })).rejects.toMatchObject({
      code: 'InvalidInput',
    });
    await expect(rc.sendCommand({ documentName: 'ATL-RunCheck', instanceIds: ['i-1'], parameters: { ...PARAMS, Extra: 'x' } })).rejects.toMatchObject({ code: 'InvalidInput' });
  });

  it('runs the check runner as a local process with SSM_<name> variables', async () => {
    const dir = tmp('runner-');
    const script = path.join(dir, 'runner.mjs');
    fs.writeFileSync(
      script,
      "const r = { checkId: process.env.SSM_CheckId, runToken: process.env.SSM_RunToken, base: process.env.ATL_DEV_APP_BASE_URL ?? null };\n" +
        "console.log('ATL-RESULT-V1 ' + Buffer.from(JSON.stringify(r)).toString('base64url'));\n",
    );
    const envs = new DevEnvRegistry(path.join(dir, 'envs'));
    const rec = envs.upsert('01jc9x3k9cq4m2x8n5b6c0d1e2', { baseUrl: 'http://127.0.0.1:3999' });
    const rc = new LocalRunCommand({ clock: new VirtualClock(), envs, checkRunner: script, repoRoot: REPO_ROOT });
    const { commandId } = await rc.sendCommand({ documentName: 'ATL-RunCheck', instanceIds: [rec.instances.lab], parameters: PARAMS });
    let inv = await rc.getInvocation(commandId, rec.instances.lab);
    for (let i = 0; i < 200 && inv.status === 'InProgress'; i++) {
      await new Promise((r) => setTimeout(r, 25));
      inv = await rc.getInvocation(commandId, rec.instances.lab);
    }
    expect(inv.status).toBe('Success');
    const line = inv.stdout.trim();
    expect(line.startsWith('ATL-RESULT-V1 ')).toBe(true);
    expect(JSON.parse(Buffer.from(line.slice(14), 'base64url').toString())).toEqual({ checkId: 'base.ready', runToken: PARAMS.RunToken, base: 'http://127.0.0.1:3999' });
    // workstation wiring is simulated; unknown invocations are NotFound
    const ws = await rc.sendCommand({ documentName: 'ATL-WorkstationSetup', instanceIds: [rec.instances.workstation], parameters: {} });
    await flush();
    expect((await rc.getInvocation(ws.commandId, rec.instances.workstation)).status).toBe('Success');
    await expect(rc.getInvocation('nope', 'i-1')).rejects.toMatchObject({ code: 'NotFound' });
  });
});
