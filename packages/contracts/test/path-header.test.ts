import { describe, expect, it } from 'vitest';
import type { ModuleId } from '../src/module-ids.js';
import {
  PATH_HEADER_MAX_BYTES,
  formatPathHeader,
  formatPathValue,
  parsePathHeader,
  parsePathValue,
  pathSignature,
  sanitizePathValue,
} from '../src/path-header.js';

describe('formatPathValue / parsePathValue', () => {
  it.each([
    [{ driver: 'redis', hostClass: 'elasticache', outcome: 'hit' }, 'redis@elasticache:hit'],
    [{ driver: 'postgres', hostClass: 'rds' }, 'postgres@rds'],
    [{ driver: 's3', outcome: 'presign' }, 's3:presign'],
    [{ driver: 'sqlite' }, 'sqlite'],
    [{ driver: 'ssm', outcome: 'v12' }, 'ssm:v12'],
    [{ driver: 'redis', hostClass: 'elasticache', outcome: 'error-bypass' }, 'redis@elasticache:error-bypass'],
  ])('round-trips %j', (value, text) => {
    expect(formatPathValue(value)).toBe(text);
    expect(parsePathValue(text)).toEqual(value);
  });

  it('treats outcome-only shorthand (cache=hit) as an outcome', () => {
    expect(parsePathValue('hit')).toEqual({ outcome: 'hit' });
    expect(parsePathValue('error-bypass')).toEqual({ outcome: 'error-bypass' });
    // a driver that happens to equal a non-shorthand word stays a driver
    expect(parsePathValue('none')).toEqual({ driver: 'none' });
  });

  it('normalises case and illegal characters', () => {
    expect(formatPathValue({ driver: 'Redis', hostClass: 'Elasti Cache', outcome: 'HIT' })).toBe('redis@elasti-cache:hit');
    expect(sanitizePathValue('CloudFront>WAF>Nginx')).toBe('cloudfront>waf>nginx');
  });
});

describe('formatPathHeader', () => {
  it('orders entry, inst, az, modules (first-call order), bypass — matching the §7.2 example', () => {
    const header = formatPathHeader({
      entry: 'cloudfront>alb>nginx',
      inst: 'i-0abc12de34f567890',
      az: 'ap-northeast-1c',
      modules: [
        ['tls', 'acm@cloudfront'],
        ['auth', 'cognito:sdk'],
        ['database', 'postgres@rds'],
        ['cache', 'redis@elasticache:miss'],
        ['storage', 's3:presign'],
      ],
    });
    expect(header).toBe(
      'entry=cloudfront>alb>nginx;inst=i-0abc12de34f567890;az=ap-northeast-1c;tls=acm@cloudfront;' +
        'auth=cognito:sdk;database=postgres@rds;cache=redis@elasticache:miss;storage=s3:presign',
    );
  });

  it('drops non-module keys and duplicate modules, keeps the first value', () => {
    const header = formatPathHeader({
      entry: 'nginx',
      modules: [
        ['storage', 'local:sign'],
        // @ts-expect-error — not a module id; must be ignored (no `upload` / `iam`-style ad-hoc segments)
        ['upload', 'x'],
        ['storage', 'local:write'],
      ],
    });
    expect(header).toBe('entry=nginx;storage=local:sign');
  });

  it('appends bypass keys', () => {
    expect(formatPathHeader({ entry: 'nginx', modules: [['cache', 'memory:bypass']], bypass: ['cache', 'replica'] })).toBe(
      'entry=nginx;cache=memory:bypass;bypass=cache,replica',
    );
  });

  it('truncates to 512 bytes by dropping trailing module segments and adding more=N', () => {
    const modules: Array<[ModuleId, string]> = [];
    const ids = ['storage', 'auth', 'cache', 'queue', 'image-processing', 'tagging', 'social-store', 'notification',
      'email', 'database', 'kms', 'config', 'tracing', 'analytics', 'identity-pool', 'workflow'] as const;
    for (const id of ids) modules.push([id, `driver-with-a-rather-long-name@host-class-name:outcome-${id}`]);
    const header = formatPathHeader({ entry: 'cloudfront>waf>alb>nginx', inst: 'i-0abc12de34f567890', az: 'ap-northeast-1c', modules });
    expect(Buffer.byteLength(header)).toBeLessThanOrEqual(PATH_HEADER_MAX_BYTES);
    const parsed = parsePathHeader(header);
    expect(parsed.more).toBeGreaterThan(0);
    expect(parsed.modules.length + (parsed.more ?? 0)).toBe(ids.length);
    expect(parsed.entry).toBe('cloudfront>waf>alb>nginx');
    expect(parsed.modules[0]?.module).toBe('storage');
  });
});

describe('parsePathHeader', () => {
  it('parses all segment kinds', () => {
    const p = parsePathHeader(
      'entry=nginx;inst=i-0abc;az=ap-northeast-1a;cache=redis@elasticache:hit;storage=local:accel;bypass=cache,cdn;more=2',
    );
    expect(p.entry).toBe('nginx');
    expect(p.inst).toBe('i-0abc');
    expect(p.az).toBe('ap-northeast-1a');
    expect(p.bypass).toEqual(['cache', 'cdn']);
    expect(p.more).toBe(2);
    expect(p.modules).toEqual([
      { module: 'cache', raw: 'redis@elasticache:hit', driver: 'redis', hostClass: 'elasticache', outcome: 'hit' },
      { module: 'storage', raw: 'local:accel', driver: 'local', outcome: 'accel' },
    ]);
    expect(p.unknown).toEqual([]);
  });

  it('is tolerant: empty input, blanks, unknown keys, case', () => {
    expect(parsePathHeader(undefined)).toEqual({ bypass: [], modules: [], unknown: [] });
    const p = parsePathHeader(' ENTRY=Nginx ;; Cache=HIT ; upload=x ; garbage ');
    expect(p.entry).toBe('nginx');
    expect(p.modules).toEqual([{ module: 'cache', raw: 'hit', outcome: 'hit' }]);
    expect(p.unknown).toEqual([{ key: 'upload', value: 'x' }, { key: 'garbage', value: '' }]);
  });

  it('pathSignature removes inst / az', () => {
    expect(pathSignature('entry=nginx;inst=i-1;az=ap-northeast-1a;database=sqlite;cache=none')).toBe(
      'entry=nginx;database=sqlite;cache=none',
    );
  });
});
