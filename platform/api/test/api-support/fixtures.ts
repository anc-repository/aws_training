/**
 * A small expanded card (lab.yaml v2 as the content release stores it, 04 §2.5) and its catalog index / quiz bank,
 * used by the API tests. Values follow 04 §3 / 05 §8; no prices anywhere.
 */
export const CATALOG_VERSION = '2026.10.0';
export const LAB_ID = 'svc-queue';

export function fixtureLab(): Record<string, unknown> {
  return {
    schema: 'atl.lab/v2',
    id: LAB_ID,
    kind: 'service',
    service: 'Amazon SQS',
    function: '异步任务队列与死信队列',
    version: '1.0.0',
    status: 'beta',
    title: 'Amazon SQS：异步任务队列与死信队列',
    summary: '把缩略图生成从同步改为队列驱动，观察削峰与死信队列。',
    difficulty: 'beginner',
    estimatedMinutes: 60,
    timeLimitMinutes: 90,
    extensions: { maxCount: 2, minutesEach: 30 },
    retain: { allowed: true, maxHours: 12 },
    services: [{ id: 'sqs', role: 'primary', module: 'queue' }],
    modules: { target: ['queue'], start: ['iam'] },
    prerequisites: { learnerInputs: [] },
    startProfile: {
      provisions: [
        { item: 'iam', kind: 'module', basis: 'credential', set: { IAM_CREDENTIALS: 'role' }, reason: 'C3' },
        { item: 'gps-sample-photos', kind: 'seed', reason: '对比实验需要样本照片' },
      ],
      platform: { preview: { directHttps: 'on' } },
      variants: [{ id: 'fifo', title: 'FIFO 队列', select: 'learner', provisions: [], reason: '对比 FIFO' }],
      reason: '起始档位只含 iam',
    },
    startProfileDigests: { default: 'sha256:aaaa', fifo: 'sha256:bbbb' },
    targetModules: [{ id: 'queue', driver: 'sqs', fromDriver: 'memory', wireStep: 'wire' }],
    workstation: { required: false, sshFromWorkstation: false },
    platform: { consoleLinks: ['sqs.queues'] },
    variables: { queueName: { label: '队列名', from: 'input', pattern: '^[a-z0-9-]{3,40}$' } },
    cost: {
      tier: 'low',
      basis: [{ ref: 'start-profile' }, { ref: 'workstation' }, { key: 'sqs-requests', pricingKey: 'sqs.requests', billing: 'usage', quantity: 1, assumedUsagePerHour: 1000, source: 'target' }],
    },
    provision: { class: 'A' },
    steps: [
      { id: 'observe-sync', type: 'observe', title: '观察同步处理', manual: 'manual/10.md', checks: [] },
      { id: 'wire', type: 'script', title: '接入 SQS', manual: 'manual/20.md', wire: true, checks: ['queue-cap'] },
      { id: 'dlq', type: 'console', title: '配置死信队列', manual: 'manual/30.md', optional: true, checks: ['dlq-ok'] },
    ],
    checks: { 'queue-cap': { type: 'capability' }, 'dlq-ok': { type: 'manual' } },
    experiments: [{ module: 'queue', id: 'burst', labels: ['before', 'after'], required: true }],
    quiz: { file: 'quiz.yaml', draw: 2 },
    badge: { title: '削峰填谷' },
    tracks: ['saa-main'],
    cleanup: { summary: '平台回收全部资源', autoReclaim: true },
    saa: { domains: ['resilient'] },
    tags: [],
    platformOps: [{ id: 'queue-purge', op: 'enable', module: 'queue', title: '清空队列' }],
  };
}

export function fixtureIndex(): Record<string, unknown> {
  return {
    schema: 'atl.catalog-index/v2',
    catalogVersion: CATALOG_VERSION,
    contentDigest: 'sha256:test',
    cards: [
      { id: LAB_ID, kind: 'service', version: '1.0.0', status: 'beta', title: 'Amazon SQS：异步任务队列与死信队列', startProfiles: [{ name: 'atl/svc-queue/default', variant: 'default', planDigest: 'sha256:aaaa' }], reuseFrom: [] },
      { id: 'sc-decoupling', kind: 'scenario', version: '1.0.0', status: 'beta', title: '削峰与重试' },
    ],
    tracks: [
      {
        id: 'saa-main',
        title: 'SAA 主线',
        stages: [{ id: 's1', title: '队列', items: [{ card: LAB_ID, role: 'required' }, { group: 'g1', title: '综合', pick: 1, cards: ['sc-decoupling'] }] }],
        completion: { minAutoRatio: 0.7 },
        certificate: { enabled: true, title: 'SAA 主线' },
      },
    ],
    serviceMap: [{ id: 'sqs', module: 'queue', category: 'D', serviceCard: LAB_ID, creditedBy: ['sc-decoupling'], appearsIn: [] }],
  };
}

export function fixtureQuiz(): Record<string, unknown> {
  return {
    schema: 'atl.quiz/v1',
    version: '1.0.0',
    questions: [
      { id: 'q1', domain: 'resilient', type: 'single', services: ['sqs'], stem: '死信队列的作用？', options: [{ id: 'a', text: '隔离失败消息' }, { id: 'b', text: '加速消费' }], answer: ['a'], explain: '…', relatesTo: 'dlq' },
      { id: 'q2', domain: 'performance', type: 'multi', services: ['sqs'], stem: '削峰依赖？', options: [{ id: 'a', text: '缓冲' }, { id: 'b', text: '异步' }, { id: 'c', text: '同步' }], answer: ['a', 'b'], explain: '…' },
    ],
  };
}

/** Experiment result as the workstation runner uploads it (04 §7.3), without `integrity` (added by the test). */
export function experimentResult(sid: string, runId: string, label = 'before'): Record<string, unknown> {
  return {
    schema: 'atl.experiment-result/v1',
    baseSchema: 'cloudalbum.result/v1',
    runId,
    sessionId: sid,
    labId: LAB_ID,
    module: 'queue',
    experiment: 'burst',
    label,
    variant: { label, role: label === 'before' ? 'baseline' : 'treatment', cardVariant: 'default' },
    forced: false,
    ab: false,
    startedAt: '2026-10-14T01:30:00Z',
    finishedAt: '2026-10-14T01:31:00Z',
    client: { requests: 40, errors: 0, latencyMs: { p50: 12, p95: 40 } },
    environment: { profile: 'atl/svc-queue/default', instanceType: 't4g.small', drivers: { queue: 'memory' } },
  };
}
