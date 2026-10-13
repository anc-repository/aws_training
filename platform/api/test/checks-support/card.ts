/**
 * A compact svc-cdn-like expanded card (atl.card/v1) covering all six check types, before-state `once` checks, a wire
 * step with ownership, platform and lab HTTP checks with corroborations, experiments, a manual check and a final check.
 */
import type { LabV2 } from '@atl/shared';
import type { CardBuild, CheckDecl } from '../../src/functions/checks/types.js';

export const CATALOG = '2026.10.0';
export const LAB_ID = 'svc-cdn';

const lab = {
  schema: 'atl.lab/v2',
  id: LAB_ID,
  kind: 'service',
  service: 'Amazon CloudFront',
  function: '内容分发与边缘缓存',
  version: '1.0.0',
  title: 'Amazon CloudFront：内容分发与边缘缓存',
  summary: 'test card',
  difficulty: 'intermediate',
  estimatedMinutes: 75,
  timeLimitMinutes: 120,
  extensions: { maxCount: 2, minutesEach: 30 },
  retain: { allowed: true, maxHours: 24 },
  services: [
    { id: 'cloudfront', role: 'primary', module: 'cdn' },
    { id: 'iam', role: 'context', module: 'iam' },
  ],
  modules: { target: ['cdn'], start: ['iam'] },
  startProfile: { provisions: [{ item: 'iam', kind: 'module', basis: 'credential', set: { IAM_CREDENTIALS: 'role' }, reason: 'role' }], platform: { preview: { directHttps: 'on' } }, reason: 'r' },
  targetModules: [{ id: 'cdn', driver: 'cloudfront', wireStep: 'enable-cdn' }],
  expectedWarnings: ['DEP-013'],
  variables: { distributionId: { label: '分配 ID', from: 'input', fillFrom: 'stack.cdn.EnvCdnDistributionId', pattern: '^E[A-Z0-9]{8,20}$' } },
  cost: { tier: 'low', basis: [] },
  provision: { class: 'A' },
  steps: [
    { id: 'orient', type: 'observe', title: '起始状态', manual: 'manual/10-orient.md', checks: ['cdn-off', 'entry-direct'] },
    { id: 'enable-cdn', type: 'script', wire: true, title: '启用 CloudFront', manual: 'manual/30.md', wait: { typicalMinutes: 5, maxMinutes: 20 }, checks: ['cap-cdn', 'auth-healthy', 'dist-deployed', 'origin-ok'] },
    { id: 'baseline', type: 'experiment', title: 'before', manual: 'manual/20.md', experiment: { module: 'cdn', id: 'media-load', label: 'before' }, checks: ['exp-before'] },
    { id: 'after', type: 'experiment', title: 'after', manual: 'manual/50.md', experiment: { module: 'cdn', id: 'media-load', label: 'after' }, requires: { steps: ['enable-cdn'] }, checks: ['exp-pair'] },
    { id: 'confirm', type: 'observe', title: '确认', manual: 'manual/60.md', checks: ['confirm-mail'] },
    { id: 'extras', type: 'cli', title: '选做', manual: 'manual/70.md', optional: { reason: 'x' }, checks: [{ ref: 'denied', required: false }, { ref: 'gone', required: false }, { ref: 'edge-spoof', required: false }, { ref: 'origin-lab', required: false }, { ref: 'api-probe', required: false }] },
  ],
  finalChecks: ['no-world-ssh'],
  experiments: [
    {
      module: 'cdn',
      id: 'media-load',
      labels: [
        { id: 'before', role: 'baseline', requires: { cdn: 'direct' } },
        { id: 'after', role: 'treatment', requires: { cdn: 'cloudfront' } },
      ],
      pairs: [['before', 'after']],
      required: true,
      allowSimulatedBaseline: true,
    },
  ],
  badge: { title: '边缘缓存' },
  tracks: ['quick-compare'],
  cleanup: { summary: 's', autoReclaim: true, verify: ['dist-gone'] },
  saa: { domains: ['performance'] },
  tags: ['cdn'],
  certificate: { enabled: true },
} as unknown as LabV2;

const checks: Record<string, CheckDecl> = {
  'cdn-off': {
    id: 'cdn-off',
    title: '起始状态：cdn 未启用',
    type: 'capability',
    module: 'cdn',
    drift: { policy: 'once' },
    assert: [
      { path: '$.driver', op: 'eq', value: 'direct', label: '驱动' },
      { path: '$.status', op: 'eq', value: 'off', label: '状态' },
    ],
  },
  'entry-direct': {
    id: 'entry-direct',
    title: '直连弹性 IP 没有 X-Cache',
    type: 'http-header',
    from: 'platform',
    target: 'public-ip',
    path: '/assets/{{ sample.assetPath }}',
    method: 'HEAD',
    drift: { policy: 'once' },
    assert: [
      { path: '$.status', op: 'eq', value: 200 },
      { path: '$.headers.x-cache', op: 'absent', label: '没有 X-Cache' },
      { path: '$.pathSegments.entry', op: 'eq', value: 'nginx', label: '入口链' },
    ],
  },
  'cap-cdn': {
    id: 'cap-cdn',
    title: 'cdn 为 cloudfront 且正常',
    type: 'capability',
    module: 'cdn',
    drift: { policy: 'must-hold', monitor: true },
    assert: [
      { path: '$.driver', op: 'eq', value: 'cloudfront', label: '驱动' },
      { path: '$', op: 'healthy', label: '状态正常' },
    ],
  },
  'auth-healthy': {
    id: 'auth-healthy',
    title: 'auth 正常（含预期警告）',
    type: 'capability',
    module: 'auth',
    assert: [{ path: '$', op: 'healthy', label: '状态正常' }],
  },
  'dist-deployed': {
    id: 'dist-deployed',
    title: '本次实验创建的分配已部署',
    type: 'aws-readonly',
    service: 'cloudfront',
    action: 'GetDistribution',
    region: 'global',
    params: { Id: '{{ var.distributionId }}' },
    ownership: { resource: '{{$.Distribution.ARN}}', resourceId: '{{$.Distribution.Id}}', createEvents: ['CreateDistribution'], mode: 'session', createdAfter: 'session.readyAt', maxWaitMinutes: 20 },
    wait: { typicalMinutes: 5, maxMinutes: 20 },
    pendingIf: [{ path: '$.Distribution.Status', op: 'eq', value: 'InProgress' }],
    assert: [{ path: '$.Distribution.Status', op: 'eq', value: 'Deployed', label: '状态' }],
    evidence: { redact: ['$..CustomHeaders.Items[*].HeaderValue'] },
    pitfalls: ['not-mine'],
    manualFallback: { observed: { question: 'q' } },
  },
  'origin-ok': {
    id: 'origin-ok',
    title: '实验机本地健康检查 200',
    type: 'local',
    on: 'lab',
    checkId: 'http-probe',
    args: { target: 'self', path: '/api/health/live', method: 'GET' },
    assert: [{ path: '$.responses[0].status', op: 'eq', value: 200, label: '状态码' }],
  },
  'edge-spoof': {
    id: 'edge-spoof',
    title: '经 CloudFront 命中（伪造防护）',
    type: 'http-header',
    from: 'platform',
    target: 'cdn',
    path: '/api/public/now?atlprobe={{ sample.nonce }}',
    repeat: 2,
    intervalMs: 10,
    assert: [
      { path: '$.last.headers.x-cache', op: 'icontains', value: 'hit from cloudfront', label: '第 2 次 X-Cache' },
      { path: '$.last.json.now', op: 'eq', value: '{{$.first.json.now}}', label: '同一份缓存' },
    ],
    corroborate: [
      { id: 'edge-network', via: 'builtin', name: 'ip-in-aws-ranges', args: { service: 'CLOUDFRONT', addresses: ['{{$.first.peer.address}}'] } },
      {
        id: 'origin-clean',
        via: 'local',
        checkId: 'http-probe',
        args: { target: 'self', path: '/api/public/now?atlprobe={{ sample.nonce }}-direct', method: 'GET' },
        assert: [{ path: '$.responses[0].headers.x-cache', op: 'absent', label: '直连响应不带 X-Cache' }],
      },
    ],
    pitfalls: ['spoofed-headers'],
  },
  'origin-lab': {
    id: 'origin-lab',
    title: '从实验机直连本机入口',
    type: 'http-header',
    from: 'lab',
    target: 'self',
    path: '/api/health/live',
    assert: [
      { path: '$.status', op: 'eq', value: 200, label: '状态码' },
      { path: '$.pathSegments.entry', op: 'eq', value: 'nginx', label: '入口链' },
    ],
  },
  'api-probe': {
    id: 'api-probe',
    title: '探测端点两次都回源',
    type: 'http-header',
    from: 'platform',
    target: 'cdn',
    path: '/api/lab/probe/now',
    repeat: 2,
    intervalMs: 10,
    assert: [
      { path: '$.first.status', op: 'eq', value: 200 },
      { path: '$.last.json.now', op: 'neq', value: '{{$.first.json.now}}', label: '两次时间戳不同' },
    ],
  },
  denied: { id: 'denied', title: '白名单外', type: 'aws-readonly', service: 's3', action: 'GetObject', params: { Bucket: 'b', Key: 'k' }, manualFallback: {} },
  gone: { id: 'gone', title: '清理验证', type: 'aws-readonly', service: 'cloudfront', action: 'GetDistribution', region: 'global', params: { Id: 'EGONE0000001' }, expectError: 'NoSuchDistribution', manualFallback: {} },
  'dist-gone': { id: 'dist-gone', title: '分配已删除', type: 'aws-readonly', service: 'cloudfront', action: 'GetDistribution', region: 'global', params: { Id: 'EGONE0000001' }, expectError: 'NoSuchDistribution', manualFallback: {} },
  'exp-before': { id: 'exp-before', title: 'before 有效', type: 'experiment', module: 'cdn', experiment: 'media-load', label: 'before' },
  'exp-pair': { id: 'exp-pair', title: 'before/after 可比', type: 'experiment', module: 'cdn', experiment: 'media-load', pair: ['before', 'after'] },
  'confirm-mail': { id: 'confirm-mail', title: '收到确认邮件', type: 'manual', spec: { observed: { question: '看到了吗' } } },
  'no-world-ssh': {
    id: 'no-world-ssh',
    title: '安全组没有对全网开放 22',
    type: 'aws-readonly',
    service: 'ec2',
    action: 'DescribeSecurityGroups',
    params: { GroupIds: ['{{ target.sgId }}'] },
    assert: [{ path: '$.SecurityGroups[*].IpPermissions[*]', where: { FromPort: 22, 'IpRanges[0].CidrIp': '0.0.0.0/0' }, op: 'len_eq', value: 0, label: '22 未对全网开放' }],
    manualFallback: {},
  },
};

export function testCard(): CardBuild {
  return {
    schema: 'atl.card/v1',
    lab: JSON.parse(JSON.stringify(lab)) as LabV2,
    checks: JSON.parse(JSON.stringify(checks)) as Record<string, CheckDecl>,
    sources: { 'no-world-ssh': '_shared/no-world-ssh' },
    pitfalls: { 'not-mine': { id: 'not-mine', match: [{ errorCode: 'OWNERSHIP_MISMATCH' }] }, 'spoofed-headers': { id: 'spoofed-headers', match: [{ errorCode: 'SPOOF_SUSPECTED' }] } },
    contentDigest: 'sha256:test-content',
    catalogVersion: CATALOG,
  };
}
