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

// characters of simplified Chinese that Japanese does not use (platform text left untranslated would show them)
const SIMPLIFIED_ONLY = /[这们个为实验证书设认链务读运发应对开启动闭页还给从让说请吗么样过选择钮错误该仅确输账图标签视频访问显术载编辑预览删练习浏览复杂进态网络录记报价费结专题级别资额册续换签产轮询学员]/;

/** The text of one language block, without the parts explicitly marked as zh-CN. */
function block(html: string, lang: string): string {
  const start = html.indexOf(`id="${lang}" lang="${lang}">`);
  const end = html.indexOf('</div>', start);
  return html.slice(start, end).replace(/<span lang="zh-CN">[^<]*<\/span>/g, '');
}

const full = {
  ...report,
  learner: { displayName: '' },
  lab: { ...report.lab, startProfile: { name: 'atl/svc-storage/default', provisions: [{ item: 'iam', kind: 'module', reason: '实验机角色' }] } },
  badge: { title: '照片上云', level: 'verified', status: 'valid', evidenceScore: 0.9 },
  steps: [
    {
      stepId: 'orient',
      title: '确认起点',
      state: 'done',
      checks: [{ checkKey: 'svc-storage/orient/bucket-exists', title: '桶存在', source: 'AWS', trust: 'medium', effective: 'pass', keyAssertions: [], evidenceDigest: 'sha256:e' }],
    },
  ],
  experiments: [
    {
      module: 'storage',
      experiment: 'upload-burst',
      variants: [{ label: 'before', role: 'baseline' }, { label: 'after', role: 'treatment' }],
      pairs: [],
      metrics: [{ id: 'server.requests', label: '源站收到的请求数', unit: 'count', values: { before: 10, after: 2 }, better: 'lower', source: 'server' }],
      charts: [{ kind: 'bars', svg: '<svg aria-label="对比实验指标"><text>源站收到的请求数</text></svg>' }],
    },
  ],
  cost: { quote: null, noteKeys: ['price-list-estimate', 'unpriced-hours-only'], resources: [{ resourceType: 'AWS::S3::Bucket', name: 'b', billing: 'usage', hours: 1.5 }] },
  cleanup: { status: 'needs-review', reclaimed: 2, pendingManual: [{ resourceType: 'AWS::S3::Bucket', id: 'b', severity: 'WARN', reason: '桶里还有对象' }], verify: [] },
  checkHistory: [{ at: '2026-10-14T00:00:00Z', checkKey: 'svc-storage/orient/bucket-exists', result: 'error', errorCode: 'X', trigger: 'wait-poll' }],
} as unknown as Report;

const texts = {
  ja: { title: 'Amazon S3：写真のオブジェクトストレージ', badge: '写真をクラウドへ', steps: { orient: '開始状態を確認する' }, checks: { 'bucket-exists': 'バケットがある' }, provisions: { iam: 'ラボ用インスタンスのロール' }, fallback: [] },
  en: { title: 'Amazon S3: photo object storage', badge: 'Photos in the cloud', steps: { orient: 'Check the starting point' }, checks: { 'bucket-exists': 'The bucket exists' }, provisions: { iam: 'Lab instance role' }, fallback: [] },
};

describe('renderReportHtml: platform texts by code, card texts from the content of each language', () => {
  it('ja / en blocks have no simplified Chinese when the card content is translated', () => {
    const html = renderReportHtml(full, { texts });
    for (const lang of ['ja', 'en']) expect(block(html, lang)).not.toMatch(SIMPLIFIED_ONLY);
    expect(html).toContain('<title>Amazon S3：写真のオブジェクトストレージ · ラボレポート</title>');
    expect(block(html, 'ja')).toContain('開始状態を確認する');
    expect(block(html, 'ja')).toContain('受講者');
    expect(block(html, 'ja')).toContain('要確認');
    expect(block(html, 'ja')).toContain('ポーリング待ち');
    expect(block(html, 'ja')).toContain('チェッカーのエラー');
    expect(block(html, 'ja')).toContain('利用時間（h）');
    expect(block(html, 'ja')).toContain('オリジンが受けたリクエスト数');
    expect(block(html, 'en')).toContain('Requests received by the origin');
    expect(block(html, 'en')).toContain('medium confidence');
    expect(block(html, 'en')).toContain('Photos in the cloud');
    // the zh-CN block keeps the source texts
    expect(block(html, 'zh-CN')).toContain('确认起点');
    expect(block(html, 'zh-CN')).toContain('源站收到的请求数');
    // a recorded value (reason) is marked as zh-CN
    expect(html).toContain('<span lang="zh-CN">桶里还有对象</span>');
  });

  it('without a translation the recorded text is shown with lang="zh-CN" and the “未翻訳 / Not translated” marker', () => {
    const html = renderReportHtml(full, { texts: { ja: { ...texts.ja, steps: {}, fallback: ['/title'] } } });
    expect(block(html, 'ja')).not.toMatch(SIMPLIFIED_ONLY);
    expect(html).toContain('<span lang="zh-CN">确认起点</span> <span class="untr">未翻訳</span>');
    expect(html).toContain('<span lang="zh-CN">Amazon S3：照片对象存储</span> <span class="untr">未翻訳</span>');
    expect(html).toContain('<span lang="zh-CN">确认起点</span> <span class="untr">Not translated</span>');
  });

  it('reads the texts of a localized expanded lab, fallback pointers included', async () => {
    const { reportTextsFromLab } = await import('../src/services/reports/html.js');
    const t = reportTextsFromLab({
      title: 'T',
      badge: { title: 'B' },
      steps: [{ id: 'a', title: 'A' }, { id: 'b', title: '源' }],
      checks: { c: { title: 'C' } },
      startProfile: { provisions: [{ item: 'iam', reason: 'R' }] },
      i18n: { lang: 'ja', fallback: ['/steps/1/title'] },
    });
    expect(t).toEqual({ title: 'T', badge: 'B', steps: { a: 'A', b: '源' }, checks: { c: 'C' }, provisions: { iam: 'R' }, fallback: ['/steps/b'] });
  });
});
