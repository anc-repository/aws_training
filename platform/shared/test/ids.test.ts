import { describe, expect, it } from 'vitest';
import {
  assertSid,
  cardKindOf,
  CERT_ID_RE,
  envNameFromEnvId,
  isCardId,
  isEnvId,
  isEnvName,
  isSid,
  newCertId,
  newEnvId,
  newSid,
  newUlid,
  parseRunnerRunId,
  parseStartProfileName,
  runnerRunId,
  SID_RE,
  startProfileFile,
  startProfileName,
  ulidTime,
} from '../src/index.js';

describe('sid', () => {
  it('generates s + 12 lowercase Crockford Base32 characters', () => {
    for (let i = 0; i < 500; i++) {
      const sid = newSid();
      expect(sid).toMatch(SID_RE);
      expect(sid).toHaveLength(13);
      expect(sid).not.toMatch(/[ilou]/);
    }
  });

  it('is random enough not to collide in a small sample', () => {
    const set = new Set(Array.from({ length: 2000 }, () => newSid()));
    expect(set.size).toBe(2000);
  });

  it('accepts the documented examples and rejects bad ones', () => {
    for (const ok of ['s4k7m2q9x1abc', 'svrfy00000031', 's000000000000', 'szzzzzzzzzzzz']) expect(isSid(ok)).toBe(true);
    for (const bad of [
      's4k7m2q9x1ab', // 11 chars
      's4k7m2q9x1abcd', // 13 chars
      'S4K7M2Q9X1ABC', // uppercase
      's4k7m2q9x1abi', // i not in Crockford
      's4k7m2q9x1abl',
      's4k7m2q9x1abo',
      's4k7m2q9x1abu',
      't4k7m2q9x1abc',
      '',
      undefined,
      42,
    ]) {
      expect(isSid(bad)).toBe(false);
    }
    expect(() => assertSid('nope')).toThrow(TypeError);
    expect(assertSid('s4k7m2q9x1abc')).toBe('s4k7m2q9x1abc');
  });
});

describe('ULID, envId, envName', () => {
  it('encodes the timestamp and round-trips it', () => {
    const t = Date.UTC(2026, 9, 13, 5, 12, 30, 123);
    const id = newUlid(t);
    expect(id).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/);
    expect(ulidTime(id)).toBe(t);
    expect(ulidTime(id.toLowerCase())).toBe(t);
    // ULIDs sort by time
    expect(newUlid(t + 1).slice(0, 10) > id.slice(0, 10)).toBe(true);
  });

  it('envId is a lowercase ULID and envName = e + last 7 characters', () => {
    const envId = newEnvId();
    expect(isEnvId(envId)).toBe(true);
    expect(isEnvId('01jc9x3k9cq4m2x8n5b6c0d1e2')).toBe(true);
    const name = envNameFromEnvId('01jc9x3k9cq4m2x8n5b6c0d1e2');
    expect(name).toBe('e6c0d1e2');
    expect(isEnvName(name)).toBe(true);
    expect(isEnvName('e7k2m9qx')).toBe(true);
    expect(isEnvName('lab')).toBe(false);
    expect(() => envNameFromEnvId('nope')).toThrow();
  });
});

describe('cards, profiles, certificates, run IDs', () => {
  it('card ids', () => {
    expect(isCardId('svc-cdn')).toBe(true);
    expect(isCardId('sc-static-acceleration')).toBe(true);
    expect(isCardId('lab-01')).toBe(false);
    expect(isCardId('svc-' + 'a'.repeat(25))).toBe(false);
    expect(cardKindOf('svc-ec2')).toBe('service');
    expect(cardKindOf('sc-ha-web')).toBe('scenario');
  });

  it('start profile names always spell out the variant', () => {
    expect(startProfileName('svc-cdn')).toBe('atl/svc-cdn/default');
    expect(startProfileName('sc-ha-web', 'efs')).toBe('atl/sc-ha-web/efs');
    expect(startProfileFile('svc-cdn')).toBe('profiles/atl/svc-cdn/default.env');
    expect(parseStartProfileName('atl/svc-cdn/default')).toEqual({ cardId: 'svc-cdn', variant: 'default' });
    expect(parseStartProfileName('single/cdn')).toBeNull();
  });

  it('certificate ids', () => {
    expect('ATL-7K2M-9Q4X-1ABZ-C3DE').toMatch(CERT_ID_RE);
    for (let i = 0; i < 100; i++) expect(newCertId()).toMatch(CERT_ID_RE);
  });

  it('runner run ids match the documented example and parse back', () => {
    expect(runnerRunId('s4k7m2q9x1abc', 'profile-apply', 1, 0)).toBe('s4k7m2q9x1abc-apply-1-0');
    expect(runnerRunId('s4k7m2q9x1abc', 'base-deploy', 2)).toBe('s4k7m2q9x1abc-base-2');
    expect(runnerRunId('s4k7m2q9x1abc', 'workstation-up', 1)).toBe('s4k7m2q9x1abc-ws-1');
    expect(runnerRunId('s4k7m2q9x1abc', 'extra-stack', 1, 1)).toBe('s4k7m2q9x1abc-xstk-1-1');
    expect(parseRunnerRunId('s4k7m2q9x1abc-apply-1-0')).toEqual({ sid: 's4k7m2q9x1abc', abbrev: 'apply', op: 'profile-apply', n: 1, m: 0 });
    expect(parseRunnerRunId('s4k7m2q9x1abc-destroy-3')).toMatchObject({ op: 'destroy', n: 3, m: null });
    expect(parseRunnerRunId('nope')).toBeNull();
    expect(() => runnerRunId('bad', 'destroy', 1)).toThrow();
  });
});
