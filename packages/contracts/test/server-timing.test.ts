import { describe, expect, it } from 'vitest';
import {
  buildTimingDesc,
  formatServerTiming,
  formatTimingDuration,
  parseServerTiming,
  parseTimingDesc,
  type ServerTimingMetric,
} from '../src/server-timing.js';

describe('formatTimingDuration', () => {
  it.each([
    [48.73, '48.7'],
    [2, '2.0'],
    [0.04, '0.0'],
    [-3, '0.0'],
    [Number.NaN, '0.0'],
    [1234.56, '1234.6'],
  ])('%s → %s', (ms, text) => {
    expect(formatTimingDuration(ms)).toBe(text);
  });
});

describe('formatServerTiming', () => {
  it('puts total first and sorts the rest by duration (the §7.1 example)', () => {
    const header = formatServerTiming([
      { name: 'cache', dur: 1.2, desc: 'redis@elasticache:miss' },
      { name: 'app', dur: 16.4 },
      { name: 'storage', dur: 9.8, desc: 's3:presign' },
      { name: 'total', dur: 48.7 },
      { name: 'database', dur: 21.3, desc: buildTimingDesc('postgres@rds', 3) },
    ]);
    expect(header).toBe(
      'total;dur=48.7, database;dur=21.3;desc="postgres@rds x3", app;dur=16.4, ' +
        'storage;dur=9.8;desc="s3:presign", cache;dur=1.2;desc="redis@elasticache:miss"',
    );
  });

  it('keeps at most 12 entries, merging the overflow into `other`', () => {
    const metrics: ServerTimingMetric[] = [{ name: 'total', dur: 100 }];
    for (let i = 0; i < 15; i += 1) metrics.push({ name: `m${i}`, dur: 15 - i });
    const parsed = parseServerTiming(formatServerTiming(metrics));
    expect(parsed).toHaveLength(12);
    expect(parsed[0]).toEqual({ name: 'total', dur: 100 });
    const other = parsed.at(-1);
    expect(other?.name).toBe('other');
    // m0..m9 kept (15..6), m10..m14 merged: 5+4+3+2+1 = 15
    expect(other?.dur).toBe(15);
  });

  it('escapes quotes and backslashes in desc and sanitises names', () => {
    const header = formatServerTiming([{ name: 'my metric', dur: 1, desc: 'say "hi" \\ bye' }]);
    expect(header).toBe('my-metric;dur=1.0;desc="say \\"hi\\" \\\\ bye"');
    expect(parseServerTiming(header)).toEqual([{ name: 'my-metric', dur: 1, desc: 'say "hi" \\ bye' }]);
  });
});

describe('parseServerTiming', () => {
  it('parses quoted desc containing commas and semicolons', () => {
    expect(parseServerTiming('total;dur=5, cache;desc="a,b;c";dur=1.5')).toEqual([
      { name: 'total', dur: 5 },
      { name: 'cache', dur: 1.5, desc: 'a,b;c' },
    ]);
  });

  it('accepts token desc, ignores bad dur, first parameter wins, skips invalid names', () => {
    expect(parseServerTiming('cdn-cache-hit;desc=HIT;desc=MISS, x;dur=abc, ;dur=1, "bad";dur=2')).toEqual([
      { name: 'cdn-cache-hit', desc: 'HIT' },
      { name: 'x' },
    ]);
  });

  it('handles empty input', () => {
    expect(parseServerTiming('')).toEqual([]);
    expect(parseServerTiming(null)).toEqual([]);
  });

  it('round-trips through format → parse', () => {
    const metrics: ServerTimingMetric[] = [
      { name: 'total', dur: 12.3 },
      { name: 'storage', dur: 4.5, desc: 'local:write' },
      { name: 'app', dur: 7.8 },
    ];
    expect(parseServerTiming(formatServerTiming(metrics))).toEqual([metrics[0], metrics[2], metrics[1]]);
  });
});

describe('parseTimingDesc', () => {
  it('splits the call count suffix', () => {
    expect(parseTimingDesc('postgres@rds x3')).toEqual({ value: 'postgres@rds', count: 3 });
    expect(parseTimingDesc('s3:presign')).toEqual({ value: 's3:presign', count: 1 });
  });
});
