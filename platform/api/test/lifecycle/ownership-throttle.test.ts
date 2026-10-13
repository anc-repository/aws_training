/**
 * OwnershipLookup and the shared CloudTrail token bucket (02 §7.3, §7.12): one token per LookupEvents page (not per
 * query), and a throttled lookup answers THROTTLED with retryAfterSeconds instead of failing the check.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { PortError, type TrailLookupRequest } from '@atl/shared';
import { THROTTLE_RETRY_SECONDS } from '../../src/functions/ownership/ownership.js';
import { LOOKUP_BUCKET } from '../../src/functions/reaper/reclaimer/rate.js';
import { createHarness, type Harness } from './support/harness.js';

let h: Harness;
afterEach(async () => {
  await h?.close();
});

const REGION = 'ap-northeast-1';

async function readySession() {
  const r = await h.start();
  expect((await h.sim.waitFor(r.startArn)).status).toBe('SUCCEEDED');
  return r.sid;
}

describe('OwnershipLookup rate limiting', () => {
  it('takes a bucket token for every page: paging through LookupEvents waits for refills', async () => {
    h = await createHarness();
    const sid = await readySession();
    const pages: TrailLookupRequest[] = [];
    // every query has three pages of unrelated events
    (h.trail as { lookupEvents: (r: TrailLookupRequest) => Promise<unknown> }).lookupEvents = async (r) => {
      pages.push(r);
      const n = r.nextToken ? Number(r.nextToken) : 0;
      return { events: [], ...(n < 2 ? { nextToken: String(n + 1) } : {}) };
    };
    const t0 = h.clock.nowMs();
    const r = await h.reaper<Record<string, unknown>>({ action: 'OwnershipLookup', sessionId: sid, resource: { type: 'AWS::S3::Bucket', id: 'some-bucket', region: REGION }, scope: 'session', maxWaitMinutes: 20 });
    expect(['PENDING', 'THROTTLED']).toContain(r.status);
    expect(pages.length).toBeGreaterThan(3);
    // beyond the burst capacity each page needed a refilled token (1 per second): time advanced accordingly
    const waitedSeconds = (h.clock.nowMs() - t0) / 1000;
    expect(waitedSeconds).toBeGreaterThanOrEqual((pages.length - LOOKUP_BUCKET.capacity) / LOOKUP_BUCKET.refillPerSecond);
  }, 30_000);

  it('an AWS throttle (or an empty bucket) answers THROTTLED with retryAfterSeconds', async () => {
    h = await createHarness();
    const sid = await readySession();
    (h.trail as { lookupEvents: (r: TrailLookupRequest) => Promise<unknown> }).lookupEvents = async () => {
      throw new PortError('Throttled', 'ThrottlingException: Rate exceeded');
    };
    const req = { action: 'OwnershipLookup', sessionId: sid, resource: { type: 'AWS::S3::Bucket', id: 'some-bucket', region: REGION }, scope: 'session' };
    expect(await h.reaper(req)).toEqual({ status: 'THROTTLED', retryAfterSeconds: THROTTLE_RETRY_SECONDS });
    (h.trail as { lookupEvents: (r: TrailLookupRequest) => Promise<unknown> }).lookupEvents = async () => {
      throw Object.assign(new Error('Rate exceeded'), { name: 'ThrottlingException' });
    };
    expect(await h.reaper(req)).toEqual({ status: 'THROTTLED', retryAfterSeconds: THROTTLE_RETRY_SECONDS });
    // other errors still fail
    (h.trail as { lookupEvents: (r: TrailLookupRequest) => Promise<unknown> }).lookupEvents = async () => {
      throw new PortError('AccessDenied', 'AccessDeniedException');
    };
    await expect(h.reaper(req)).rejects.toThrow(/AccessDenied/);
  }, 30_000);
});
