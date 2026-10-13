import { describe, expect, it, vi } from 'vitest';
import { announce, MERGE_WINDOW_MS, subscribeAnnouncements } from './announce';
import { formatClock, formatCountdown, formatDate, formatRemainingCoarse, formatSpan } from './format';
import { isMaskedAccountId, maskAccountId, redact } from './redact';
import { lsGet, lsSet, ssGet, ssSet } from './storage';
import { uuidV4 } from './uuid';

describe('format (08 §1.6)', () => {
  it.each([
    [(1 * 3600 + 42 * 60 + 10) * 1000, '1:42:10'],
    [(42 * 60 + 10) * 1000, '42:10'],
    [42_000, '0:42'],
    [-5_000, '0:00'],
  ])('countdown %i → %s', (ms, s) => expect(formatCountdown(ms)).toBe(s));

  it('elapsed spans never use the colon format', () => {
    expect(formatSpan(91 * 60_000)).toBe('1 小时 31 分');
    expect(formatSpan(58 * 60_000)).toBe('58 分');
    expect(formatSpan(120 * 60_000)).toBe('2 小时');
    expect(formatRemainingCoarse(36 * 60_000)).toBe('剩余约 36 分钟');
  });

  it('dates: current year `M/D HH:MM`, other years `YYYY-MM-DD`', () => {
    const now = new Date(2026, 9, 14, 12, 0).getTime();
    expect(formatDate(new Date(2026, 9, 13, 10, 42), now)).toBe('10/13 10:42');
    expect(formatDate(new Date(2025, 0, 2, 10, 42), now)).toBe('2025-01-02');
    expect(formatClock(new Date(2026, 9, 13, 9, 5))).toBe('09:05');
  });
});

describe('redact (08 P08 打码器, §3.5)', () => {
  it('masks 12-digit account ids anywhere in a string, keeping the last 4 digits', () => {
    expect(redact('arn:aws:iam::111122223333:role/x')).toBe('arn:aws:iam::••••3333:role/x');
    expect(redact('bucket-111122223333-logs')).toBe('bucket-••••3333-logs');
    expect(maskAccountId('111122223333')).toBe('••••3333');
    expect(isMaskedAccountId('••••3333')).toBe(true);
  });

  it('masks public IPv4 / IPv6 but not private addresses or clock times', () => {
    expect(redact('ip 54.12.34.56')).toBe('ip 54.12.•.•');
    expect(redact('ip 10.0.1.2')).toBe('ip 10.0.1.2');
    expect(redact('at 10:42:10')).toBe('at 10:42:10');
    expect(redact('2406:da14:1:2::5')).toContain('2406:da14:••••');
  });
});

describe('storage wrappers (P13 #29)', () => {
  it('round-trips JSON and returns the fallback when storage throws', () => {
    lsSet('atl.test.v1', { a: 1 });
    expect(lsGet('atl.test.v1', null)).toEqual({ a: 1 });
    ssSet('atl.test.v1', 'x');
    expect(ssGet('atl.test.v1', '')).toBe('x');
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('denied');
    });
    expect(lsGet('atl.test.v1', 'fallback')).toBe('fallback');
  });
});

describe('uuid / announce', () => {
  it('generates RFC 4122 v4 ids', () => {
    expect(uuidV4()).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  });

  it('merges announcements of the same topic within 3 seconds', () => {
    vi.useFakeTimers();
    const got: string[] = [];
    const off = subscribeAnnouncements((a) => got.push(a.text));
    announce('本步检测完成：1 项通过', { topic: 'step-1' });
    announce('本步检测完成：2 项通过', { topic: 'step-1' });
    announce('已复制');
    expect(got).toEqual(['已复制']);
    vi.advanceTimersByTime(MERGE_WINDOW_MS);
    expect(got).toEqual(['已复制', '本步检测完成：2 项通过']);
    off();
  });
});
