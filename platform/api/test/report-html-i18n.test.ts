/**
 * Server-rendered report / share HTML in three languages (09-i18n-and-visual.md §1.8, I1/I5): ja shown by default, en and
 * zh-CN selectable by URL fragment (`:target`, no script), or one language with `lang`.
 */
import { describe, expect, it } from 'vitest';
import { renderReportHtml } from '../src/services/reports/html.js';
import type { Report } from '../src/services/reports/report.js';

const report = {
  revision: 2,
  generatedAt: '2026-10-14T00:00:00.000Z',
  lab: { id: 'svc-storage', title: 'Amazon S3：照片对象存储', version: '1.0.0', variant: 'default', catalogVersion: '0.1.0', contentDigest: 'sha256:c', startProfile: { name: 'local', provisions: [{ item: 'ec2', kind: 'module', reason: '基础' }] } },
  learner: { displayName: 'Learner <b>' },
  timing: { totalMinutes: 42, activeMinutes: 30 },
  outcome: { attemptStatus: 'completed', checks: { auto: 3, manual: 1, failed: 0 }, driftEvents: 0, trustSummary: { high: 3, medium: 1, low: 0 } },
  session: { region: 'ap-northeast-1', accountIdMasked: '********9012', endReason: 'USER_ENDED', environment: { reused: false } },
  steps: [{ title: '确认起点', state: 'done', checks: [{ title: '桶存在', source: 'aws-readonly', effective: 'pass', keyAssertions: [{ ok: true, label: '版本控制', expected: 'Enabled', actual: 'Enabled' }], evidenceDigest: 'sha256:e' }] }],
  experiments: [],
  cost: { notes: [], resources: [] },
  cleanup: { status: 'done', reclaimed: 4, pendingManual: [], verify: [] },
  checkHistory: [],
  integrity: { canonicalization: 'RFC8785', digest: 'sha256:d' },
} as unknown as Report;

describe('renderReportHtml languages', () => {
  it('holds ja / en / zh-CN blocks with Japanese shown by default and fragment links', () => {
    const html = renderReportHtml(report, { share: true, hideManualNotes: true });
    expect(html).toContain('<html lang="ja">');
    expect(html).toContain('<div class="lv lv-default" id="ja" lang="ja">');
    expect(html).toContain('<div class="lv" id="en" lang="en">');
    expect(html).toContain('<div class="lv" id="zh-CN" lang="zh-CN">');
    expect(html).toMatch(/<a href="#en"[^>]*>English<\/a>/);
    expect(html).toContain('AWS の公式認定ではありません');
    expect(html).toContain('It is not an AWS certification.');
    expect(html).toContain('脱敏报告副本');
    expect(html).toContain('完了（すべて自動）');
    expect(html).toContain('Completed (fully automatic)');
    // values from the report stay as recorded and escaped; no scripts
    expect(html).toContain('Learner &lt;b&gt;');
    expect(html).toContain('确认起点');
    expect(html).not.toMatch(/<script/i);
  });

  it('renders a single language when asked', () => {
    const html = renderReportHtml(report, { lang: 'en' });
    expect(html).toContain('<html lang="en">');
    expect(html).toContain('<title>Amazon S3：照片对象存储 · Lab report</title>');
    expect(html).not.toContain('class="lv');
    expect(html).not.toContain('ラボレポート');
  });
});
