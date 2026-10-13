import { describe, expect, it } from 'vitest';
import sample from '../../../public-pages/share/sample-report.json';
import { buildBarsChart, buildLadderChart, deltaText, formatMetricValue, variantClass } from '../experiments/compareModel';
import { maskMiddle, redactDeep, redactText } from './publicRedact';
import { renderShareHtml, SHARE_CSP, shareReportJson, utcStamp, type ShareReport } from './renderShare';

describe('public redactor (08 P08 打码器, §9.2 #33)', () => {
  it('standard: account IDs (incl. ARN), public IPv4, IPv6; private addresses and times untouched', () => {
    expect(redactText('arn:aws:iam::111122223333:role/x')).toBe('arn:aws:iam::••••3333:role/x');
    expect(redactText('bucket atl-web-111122223333-ap-northeast-1')).toBe('bucket atl-web-••••3333-ap-northeast-1');
    expect(redactText('User: arn:aws:sts::111122223333:assumed-role/a is not authorized')).toContain('••••3333');
    expect(redactText('ip 203.0.113.61 and 10.0.1.5 and 192.168.1.1')).toBe('ip 203.0.•.• and 10.0.1.5 and 192.168.1.1');
    expect(redactText('2001:db8:85a3::8a2e:370:7334')).toBe('2001:db8:••••');
    expect(redactText('at 10:42:10 and 1234567890123')).toBe('at 10:42:10 and 1234567890123');
    expect(redactText(null)).toBe('');
  });

  it('share: session ids, env names, CloudFront / ALB / EC2 / API hosts, resource ids, emails', () => {
    const s = (t: string) => redactText(t, 'share');
    expect(s('会话 s4k7m2q9x1abc')).toBe('会话 s4k7••••');
    expect(s('atl-s4k7m2q9x1abc-console')).toBe('atl-s4k7••••-console');
    expect(s('cloudalbum-e7k2m9qx-db')).toBe('cloudalbum-e7k2••••-db');
    expect(s('env e7k2m9qx')).toBe('env e7k2••••');
    expect(s('exceeds the limit')).toBe('exceeds the limit');
    expect(s('d1234abcd.cloudfront.net')).toBe('d123••••.cloudfront.net');
    expect(s('my-alb-1234567.ap-northeast-1.elb.amazonaws.com')).toBe('my-a••••.ap-northeast-1.elb.amazonaws.com');
    expect(s('i-06c2d9e41a7b3f805')).toBe('i-06c••••05');
    expect(s('E2QWABCDEFG7K')).toBe('E2QW••••7K');
    expect(s('mail zhang@example.com')).toBe('mail ‹邮箱›');
    expect(s('ec2-203-0-113-10.ap-northeast-1.compute.amazonaws.com')).toBe('ec2-‹地址›.amazonaws.com');
    expect(maskMiddle('abc', 4, 2)).toBe('abc'.slice(0, 2) + '••••');
  });

  it('redactDeep walks objects and arrays and keeps svg fields for the renderer to drop', () => {
    const v = redactDeep({ a: ['111122223333'], b: { svg: '111122223333' }, n: 1 }, 'share');
    expect(v).toEqual({ a: ['••••3333'], b: { svg: '111122223333' }, n: 1 });
  });
});

describe('compare model (08 P06 DeltaCell / charts)', () => {
  it('delta text: noise band, direction, ms wording, zero', () => {
    expect(deltaText(100, 105, 'count')).toBe('差异不明显');
    expect(deltaText(182, 41, 'ms', '首字节时间 p50（毫秒）')).toBe('▼ 下降 · 更快');
    expect(deltaText(41, 182, 'ms')).toBe('▲ 上升 · 更慢');
    expect(deltaText(7, 0, 'count')).toBe('▼ 变为 0');
    expect(deltaText(null, 3, 'count')).toBe('—');
    expect(formatMetricValue(0.923, 'ratio')).toBe('92.3%');
    expect(formatMetricValue(undefined, 'count')).toBe('—');
  });

  it('variant colours by role: baseline grey, treatment teal, others third colour', () => {
    const v = [
      { label: 'memory', role: 'baseline' as const },
      { label: 'selfhost', role: 'treatment' as const },
      { label: 'after', role: 'treatment' as const },
    ];
    expect(variantClass(v, 'memory')).toBe('b');
    expect(variantClass(v, 'selfhost')).toBe('a');
    expect(variantClass(v, 'after')).toBe('t3');
  });

  it('bars and ladder geometry only from recorded values', () => {
    const metrics = (sample as ShareReport).experiments![0]!.metrics!.map((m) => ({ id: m.id!, label: m.label!, unit: m.unit!, better: 'lower' as const, values: m.values! }));
    const variants = [{ label: 'before', role: 'baseline' as const }, { label: 'after', role: 'treatment' as const }];
    const bars = buildBarsChart(metrics, variants)!;
    expect(bars.groups).toHaveLength(4);
    expect(bars.groups[3]!.bars).toHaveLength(1);
    expect(bars.desc).toContain('CDN 命中率：before —，after 92%');
    const ladder = buildLadderChart(metrics, variants)!;
    expect(ladder.xTicks.map((t) => t.text)).toEqual(['p50', 'p95']);
    expect(ladder.series).toHaveLength(2);
    expect(buildBarsChart([], variants)).toBeNull();
    expect(buildLadderChart(metrics.slice(0, 1), variants)).toBeNull();
  });
});

describe('share copy renderer (08 P08-S; 04 §9.5)', () => {
  const html = renderShareHtml(sample as ShareReport, { publishedAt: '2026-10-13T11:00:00Z', expiresAt: '2026-11-12T11:00:00Z' });

  it('is a static document: strict CSP, no scripts, no external resources, noindex', () => {
    expect(html.startsWith('<!doctype html>')).toBe(true);
    expect(html).toContain(`content="${SHARE_CSP.replace(/'/g, '&#39;')}"`);
    expect(html).not.toMatch(/<script/i);
    expect(html).not.toMatch(/\s(src|href)=/i);
    expect(html).not.toMatch(/\son[a-z]+=/i);
    expect(html).toContain('noindex, nofollow');
    expect(html).toContain('这是由自托管 ATL 实验平台生成的脱敏报告副本，不是 AWS 官方认证。');
    expect(html).toContain('平台卸载后此链接失效 · 生成于 2026-10-13 11:00 UTC · 有效期至 2026-11-12 11:00 UTC');
  });

  it('forces redaction and hides manual notes and e-mail', () => {
    expect(html).not.toContain('111122223333');
    expect(html).not.toContain('203.0.113.61');
    expect(html).not.toContain('d1234abcd.cloudfront.net');
    expect(html).not.toContain('s4k7m2q9x1abc');
    expect(html).not.toContain('e7k2m9qx');
    expect(html).not.toContain('zhang@example.com');
    expect(html).not.toContain('不该出现在副本里的备注');
    expect(html).toContain('••••3333');
    expect(html).toContain('d123••••.cloudfront.net');
    expect(html).toContain('atl-s4k7••••-console');
  });

  it('renders summary, steps, experiments (regenerated SVG, not the report svg) and cleanup', () => {
    expect(html).toContain('svc-cdn · Amazon CloudFront：内容分发与边缘缓存');
    expect(html).toContain('已完成（全自动）');
    expect(html).toContain('徽章“边缘缓存” · 已核验');
    expect(html).toContain('共 1 小时 31 分，有交互 1 小时 12 分 · 延长 1 次');
    expect(html).toContain('观察直连源站');
    expect(html).toContain('归属在会话结束后确认');
    expect(html).toContain('▼ 下降 · 更快');
    expect(html).toContain('role="img"');
    expect(html).not.toContain('alert(1)');
    expect(html).toContain('已释放 · 已回收 23 项');
    expect(utcStamp('bad')).toBe('—');
  });

  it('escapes hostile strings', () => {
    const evil = renderShareHtml({ lab: { id: '<img src=x onerror=alert(1)>', title: '"><script>' } }, { publishedAt: '2026-10-13T11:00:00Z', expiresAt: null });
    expect(evil).not.toContain('<img');
    expect(evil).not.toMatch(/<script>/);
    expect(evil).toContain('不过期');
  });

  it('report.json beside the copy: redacted, no manual notes, no report svg, marked as a redacted copy', () => {
    const j = JSON.parse(shareReportJson(sample as ShareReport)) as Record<string, unknown> & { steps: { checks: { manual?: { note: string } }[] }[]; experiments: Record<string, unknown>[] };
    const text = JSON.stringify(j);
    expect(j.redactedCopy).toBe(true);
    expect(text).not.toContain('111122223333');
    expect(text).not.toContain('s4k7m2q9x1abc');
    expect(text).not.toContain('不该出现在副本里的备注');
    expect(j.steps[1]!.checks[0]!.manual!.note).toBe('');
    expect(j.experiments[0]!.charts).toBeUndefined();
  });
});
