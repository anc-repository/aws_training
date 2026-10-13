// Args schema of every checkId (04 §6.4). `build.mjs` writes each one to schemas/<checkId>.args.json in the bundle; the
// runner validates every item against it before loading the check module (third gate after SSM and the launcher).
const host = { type: 'string', pattern: '^(?=.{1,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\\.)+[a-z][a-z0-9-]{0,62}$' };
const hostLabel = { type: 'string', pattern: '^(?=.{1,253}$)[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)*$' };
const runId = { type: 'string', pattern: '^[0-9A-HJKMNP-TV-Z]{26}$' };
const duration = (maxMinutes) => ({ type: 'string', pattern: '^[0-9]{1,4}[smh]$', maxMinutes });
const httpTarget = { enum: ['self', 'origin-private', 'cdn-origin', 'cdn', 'cdn-alias', 'tls-domain', 'public-dns', 'public-ip', 'alb', 'apigw', 's3-object', 'app-entry'] };
const httpPath = { type: 'string', pattern: '^/[A-Za-z0-9._~!$&\'()*+,;=:@%/?-]{0,1023}$' };
const moduleId = { type: 'string', pattern: '^[a-z][a-z0-9-]{1,31}$' };
const none = { type: 'object', additionalProperties: false, properties: {} };

export const ARGS_SCHEMAS = {
  'imds-get': {
    type: 'object',
    additionalProperties: false,
    required: ['path'],
    properties: { path: { type: 'string', maxLength: 80 }, checkV1Rejected: { type: 'boolean' } },
  },
  'systemd-unit': { type: 'object', additionalProperties: false, required: ['unit'], properties: { unit: { type: 'string', maxLength: 48 } } },
  'port-listen': {
    type: 'object',
    additionalProperties: false,
    required: ['port'],
    properties: { port: { type: 'integer', minimum: 1, maximum: 65535 }, proto: { enum: ['tcp'] } },
  },
  'disk-usage': { type: 'object', additionalProperties: false, required: ['mount'], properties: { mount: { type: 'string', maxLength: 64 } } },
  'file-stat': { type: 'object', additionalProperties: false, required: ['path'], properties: { path: { type: 'string', maxLength: 160 } } },
  'env-key': {
    type: 'object',
    additionalProperties: false,
    required: ['module', 'key'],
    properties: { module: moduleId, key: { type: 'string', pattern: '^[A-Z][A-Z0-9_]{1,63}$' } },
  },
  'dns-resolve': { type: 'object', additionalProperties: false, required: ['host'], properties: { host } },
  'tls-handshake': {
    type: 'object',
    additionalProperties: false,
    required: ['target'],
    properties: { target: httpTarget, host, port: { type: 'integer', minimum: 1, maximum: 65535 }, servername: host },
  },
  'http-probe': {
    type: 'object',
    additionalProperties: false,
    required: ['target', 'path'],
    properties: {
      target: httpTarget,
      path: httpPath,
      method: { enum: ['GET', 'HEAD'] },
      headers: { type: 'object', additionalProperties: { type: 'string', maxLength: 128 } },
      repeat: { type: 'integer', minimum: 1, maximum: 5 },
      intervalMs: { type: 'integer', minimum: 0, maximum: 5000 },
      stripQuery: { type: 'boolean' },
      host,
      hostHeader: hostLabel,
      scheme: { enum: ['http', 'https'] },
      port: { type: 'integer', minimum: 1, maximum: 65535 },
      nonce: { type: 'string', pattern: '^[A-Za-z0-9_-]{8,64}$' },
    },
  },
  'path-seen': {
    type: 'object',
    additionalProperties: false,
    required: ['segment', 'pattern', 'window'],
    properties: {
      segment: { type: 'string', pattern: '^[a-z][a-z0-9-]{0,31}$' },
      pattern: { type: 'string', minLength: 1, maxLength: 128 },
      window: duration(1440),
      minCount: { type: 'integer', minimum: 1, maximum: 100000 },
      distinct: { type: 'boolean' },
      excludeProbe: { const: true },
    },
  },
  'capability-snapshot': {
    type: 'object',
    additionalProperties: false,
    properties: {
      modules: { type: 'array', maxItems: 40, items: moduleId },
      view: { enum: ['public', 'admin'] },
      fields: { type: 'array', maxItems: 40, items: { type: 'string', pattern: '^[A-Za-z0-9_.*\\[\\]-]{1,96}$' } },
    },
  },
  'nginx-log-summary': {
    type: 'object',
    additionalProperties: false,
    properties: {
      window: duration(30),
      groupBy: { enum: ['entry', 'via-cloudfront', 'via-alb'] },
      nonce: { type: 'string', pattern: '^[A-Za-z0-9_-]{8,64}$' },
      cfIds: { type: 'array', maxItems: 5, items: { type: 'string', pattern: '^[A-Za-z0-9_=-]{8,128}$' } },
      path: { type: 'string', pattern: '^/[A-Za-z0-9._~/-]{0,255}$' },
    },
  },
  'net-bytes': { type: 'object', additionalProperties: false, properties: { window: duration(10) } },
  'app-stat': {
    type: 'object',
    additionalProperties: false,
    required: ['stat'],
    properties: {
      stat: {
        enum: [
          'photos.count',
          'users.count',
          'albums.count',
          'jobs.pending',
          'jobs.failed',
          'biz.jobs_lost',
          'biz.photo_time_to_ready_p95',
          'queue.dlq_depth',
          'outbox.count',
          'notifications.count',
          'security.findings',
          'cache.hit_ratio_1m',
          'lab.seed.photos',
        ],
      },
      runId,
    },
  },
  'leaked-keys': none,
  'aws-cred-source': none,
  'sshd-state': none,
  'module-state': { type: 'object', additionalProperties: false, properties: { module: moduleId } },
  'lab-metrics-run': {
    type: 'object',
    additionalProperties: false,
    required: ['runId'],
    properties: { runId, padSec: { type: 'integer', minimum: 0, maximum: 120 } },
  },
  'probe-token': {
    type: 'object',
    additionalProperties: false,
    properties: { ttlSec: { type: 'integer', minimum: 1, maximum: 60 }, count: { type: 'integer', minimum: 1, maximum: 5 } },
  },
  'tool-versions': none,
  'base.ready': none,
  'caps.profile': {
    type: 'object',
    additionalProperties: false,
    required: ['expect'],
    properties: {
      expect: { type: 'object', additionalProperties: { type: 'string', pattern: '^([a-z0-9][a-z0-9-]{0,31}|[*])$' } },
      expectedWarnings: { type: 'array', maxItems: 20, items: { type: 'string', pattern: '^[A-Z]{2,8}-[0-9]{3}$' } },
    },
  },
  'ws.ready': none,
  'atl.channel': none,
};

/** Old names kept for one minor version (04 §6.4). */
export const ALIASES = {
  'atl.capabilities': 'capability-snapshot',
  'atl.lab-metrics': 'lab-metrics-run',
  'cloudalbum-probe-token': 'probe-token',
};

/** Durations carry their own ceiling (`maxMinutes`, an ATL keyword enforced by lib/validate.mjs). */
export function durationWithin(s, maxMinutes) {
  const m = /^(\d{1,4})([smh])$/.exec(s ?? '');
  if (!m) return false;
  const minutes = Number(m[1]) / (m[2] === 's' ? 60 : m[2] === 'm' ? 1 : 1 / 60);
  return minutes > 0 && minutes <= maxMinutes;
}
