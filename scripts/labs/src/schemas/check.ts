/**
 * `labs/<card>/checks/*.yaml` and `labs/_shared/checks/*.yaml` (04 §5.1, §5.3, §5.4): JSON Schema of the normative
 * TypeScript in 04 §5.1 (`checks: CheckDecl[]`, plus the file-level `pitfalls:` of 04 §11.3, ui-design §5.3 structure).
 * Written to `labs/_schema/check.schema.json` by `labs:schema`. Cross-field rules (whitelists, once/must-hold, references)
 * are lint rules A7–A10 in `lint/card.ts`.
 */
import { L10N_SCHEMA, l10n } from './l10n.js';

const assertion = {
  type: 'object',
  additionalProperties: false,
  required: ['path', 'op'],
  properties: {
    path: { type: 'string', minLength: 1, maxLength: 200 },
    where: { type: 'object' },
    op: {
      enum: ['eq', 'neq', 'in', 'nin', 'exists', 'absent', 'contains', 'icontains', 'startsWith', 'endsWith', 'matches', 'gt', 'gte', 'lt', 'lte',
        'len_eq', 'len_gte', 'len_lte', 'every', 'some', 'healthy'],
    },
    value: {},
    label: l10n({ type: 'string', maxLength: 60 }),
    severity: { enum: ['error', 'warn'] },
  },
} as const;

const manualSpec = {
  type: 'object',
  additionalProperties: false,
  properties: {
    where: { type: 'object' },
    confirm: l10n({ type: 'string', maxLength: 300 }),
    observed: {
      type: 'object',
      additionalProperties: false,
      required: ['question'],
      properties: {
        question: l10n({ type: 'string', maxLength: 200 }),
        options: {
          type: 'array',
          minItems: 2,
          items: {
            type: 'object',
            additionalProperties: false,
            required: ['value', 'label'],
            properties: {
              value: { type: 'string' },
              label: l10n({ type: 'string', maxLength: 80 }),
              expected: { type: 'boolean' },
              fixHint: l10n({ type: 'string', maxLength: 200 }),
            },
          },
        },
      },
    },
    input: { type: 'object' },
    evidence: {
      type: 'object',
      additionalProperties: false,
      properties: {
        command: { $ref: '#/$defs/runCommand' },
        parse: { const: 'json' },
        assert: { type: 'array', items: { $ref: '#/$defs/assertion' } },
      },
    },
  },
} as const;

export const CHECK_SCHEMA = {
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  $id: 'urn:atl:schema:checks:v1',
  title: 'ATL checks file (04 §5.1)',
  type: 'object',
  additionalProperties: false,
  required: ['checks'],
  properties: {
    checks: { type: 'array', items: { $ref: '#/$defs/check' } },
    pitfalls: { type: 'array', items: { $ref: '#/$defs/pitfall' } },
  },
  $defs: {
    l10n: L10N_SCHEMA,
    checkId: { type: 'string', pattern: '^[a-z][a-z0-9-]{1,47}$' },
    assertion,
    runCommand: {
      type: 'object',
      additionalProperties: false,
      required: ['run', 'runsOn'],
      properties: { run: { type: 'string', maxLength: 400 }, runsOn: { enum: ['workstation', 'lab'] } },
    },
    manualSpec,
    drift: {
      type: 'object',
      additionalProperties: false,
      required: ['policy'],
      properties: { policy: { enum: ['must-hold', 'once'] }, monitor: { type: 'boolean' } },
    },
    corroboration: {
      type: 'object',
      required: ['id', 'via'],
      properties: {
        id: { $ref: '#/$defs/checkId' },
        via: { enum: ['local', 'aws-readonly', 'builtin'] },
        required: { type: 'boolean' },
        checkId: { type: 'string' },
        on: { enum: ['lab', 'workstation'] },
        args: { type: 'object' },
        service: { type: 'string' },
        action: { type: 'string' },
        region: { enum: ['app', 'us-east-1', 'global', 'dr-region'] },
        params: { type: 'object' },
        name: { enum: ['ip-in-aws-ranges', 'tls-san', 'fresh-nonce'] },
        assert: { type: 'array', items: { $ref: '#/$defs/assertion' } },
      },
      additionalProperties: false,
      allOf: [
        { if: { properties: { via: { const: 'local' } } }, then: { required: ['checkId', 'assert'] } },
        { if: { properties: { via: { const: 'aws-readonly' } } }, then: { required: ['service', 'action', 'params', 'assert'] } },
        { if: { properties: { via: { const: 'builtin' } } }, then: { required: ['name', 'args'] } },
      ],
    },
    ownership: {
      type: 'object',
      additionalProperties: false,
      required: ['resource', 'mode'],
      properties: {
        resource: { type: 'string', maxLength: 300 },
        resourceId: { type: 'string', maxLength: 200 },
        createEvents: { type: 'array', items: { type: 'string', pattern: '^[A-Z][A-Za-z0-9]{2,63}$' } },
        mode: { enum: ['session', 'session-or-start'] },
        createdAfter: { enum: ['session.readyAt', 'step.startedAt'] },
        maxWaitMinutes: { type: 'integer', minimum: 1, maximum: 45 },
      },
    },
    check: {
      type: 'object',
      additionalProperties: false,
      required: ['id', 'title', 'type'],
      properties: {
        id: { $ref: '#/$defs/checkId' },
        extends: { type: 'string', pattern: '^guide:' },
        title: l10n({ type: 'string', minLength: 4, maxLength: 80 }),
        type: { enum: ['local', 'capability', 'http-header', 'aws-readonly', 'experiment', 'manual'] },
        required: { type: 'boolean' },
        when: { type: 'string', maxLength: 200 },
        dependsOn: { type: 'array', uniqueItems: true, items: { $ref: '#/$defs/checkId' } },
        timeoutMs: { type: 'integer', minimum: 1000, maximum: 90000 },
        retry: {
          type: 'object',
          additionalProperties: false,
          required: ['max', 'backoffMs'],
          properties: { max: { type: 'integer', minimum: 0, maximum: 5 }, backoffMs: { type: 'array', items: { type: 'integer', minimum: 0 } } },
        },
        wait: {
          type: 'object',
          additionalProperties: false,
          required: ['typicalMinutes', 'maxMinutes'],
          properties: { typicalMinutes: { type: 'integer', minimum: 1 }, maxMinutes: { type: 'integer', minimum: 1, maximum: 60 } },
        },
        pendingIf: { type: 'array', items: { $ref: '#/$defs/assertion' } },
        anyOf: { type: 'array', minItems: 1, items: { type: 'array', minItems: 1, items: { $ref: '#/$defs/assertion' } } },
        ttl: { type: 'string', pattern: '^[0-9]{1,4}[smh]$' },
        drift: { $ref: '#/$defs/drift' },
        corroborate: { type: 'array', items: { $ref: '#/$defs/corroboration' } },
        evidence: {
          type: 'object',
          additionalProperties: false,
          properties: { keep: { type: 'array', items: { type: 'string' } }, redact: { type: 'array', items: { type: 'string' } } },
        },
        explain: l10n({ type: 'string', maxLength: 400 }),
        reproduce: { $ref: '#/$defs/runCommand' },
        pitfalls: { type: 'array', items: { type: 'string', pattern: '^[a-z][a-z0-9-]{1,47}$' } },
        saaDomain: { enum: ['secure', 'resilient', 'performance', 'cost'] },
        // local
        on: { enum: ['lab', 'workstation'] },
        instances: { enum: ['one', 'all'] },
        checkId: { type: 'string', pattern: '^[a-z][a-z0-9-]{1,31}(\\.[a-z][a-z0-9-]{1,31})?$' },
        args: { type: 'object' },
        assert: { type: 'array', items: { $ref: '#/$defs/assertion' } },
        // capability / experiment
        module: { type: 'string', pattern: '^[a-z][a-z0-9-]{1,23}$' },
        view: { enum: ['public', 'admin'] },
        expectedWarnings: { type: 'array', uniqueItems: true, items: { type: 'string', pattern: '^[A-Z]{2,5}-[0-9]{3}$' } },
        // http-header
        from: { enum: ['platform', 'lab', 'browser'] },
        target: {
          enum: ['cdn', 'cdn-alias', 'public-ip', 'public-dns', 'alb', 'apigw', 'app-entry', 'tls-domain', 's3-object', 'self', 'origin-private', 'cdn-origin'],
        },
        path: { type: 'string', pattern: '^/' },
        method: { enum: ['GET', 'HEAD'] },
        headers: {
          type: 'object',
          additionalProperties: false,
          properties: {
            Accept: { type: 'string' },
            'Accept-Encoding': { type: 'string' },
            'X-Compare-Bypass': { type: 'string' },
            Authorization: { const: 'Bearer probe' },
            Cookie: { const: 'ca_probe=1' },
          },
        },
        repeat: { type: 'integer', minimum: 1, maximum: 5 },
        intervalMs: { type: 'integer', minimum: 0, maximum: 5000 },
        stripQuery: { type: 'boolean' },
        // aws-readonly
        service: { type: 'string', pattern: '^[a-z0-9-]+$' },
        action: { type: 'string', pattern: '^[A-Z][A-Za-z0-9]+$' },
        region: { enum: ['app', 'us-east-1', 'global', 'dr-region'] },
        params: { type: 'object' },
        paginate: {
          type: 'object',
          additionalProperties: false,
          required: ['maxPages'],
          properties: { maxPages: { type: 'integer', minimum: 1, maximum: 5 } },
        },
        ownership: { $ref: '#/$defs/ownership' },
        expectError: { type: 'string', pattern: '^[A-Za-z][A-Za-z0-9.]+$' },
        manualFallback: { $ref: '#/$defs/manualSpec' },
        // experiment
        experiment: { type: 'string', pattern: '^[a-z][a-z0-9-]{1,31}$' },
        label: { type: 'string', pattern: '^[a-z][a-z0-9-]{0,23}$' },
        pair: {
          oneOf: [
            { const: 'any' },
            { type: 'array', minItems: 2, maxItems: 2, items: { type: 'string', pattern: '^[a-z][a-z0-9-]{0,23}$' } },
          ],
        },
        accept: { type: 'array', uniqueItems: true, items: { enum: ['valid', 'simulated'] } },
        // manual
        spec: { $ref: '#/$defs/manualSpec' },
      },
      allOf: [
        { if: { properties: { type: { const: 'local' } } }, then: { required: ['checkId', 'assert'] } },
        { if: { properties: { type: { const: 'capability' } } }, then: { required: ['module', 'assert'] } },
        { if: { properties: { type: { const: 'http-header' } } }, then: { required: ['from', 'target', 'path', 'assert'] } },
        { if: { properties: { type: { const: 'aws-readonly' } } }, then: { required: ['service', 'action', 'params', 'manualFallback'] } },
        {
          if: { properties: { type: { const: 'experiment' } } },
          then: { required: ['module', 'experiment'], oneOf: [{ required: ['label'] }, { required: ['pair'] }] },
        },
        { if: { properties: { type: { const: 'manual' } } }, then: { required: ['spec'] } },
      ],
    },
    pitfall: {
      type: 'object',
      additionalProperties: false,
      required: ['id', 'cause', 'fix'],
      properties: {
        id: { type: 'string', pattern: '^[a-z][a-z0-9-]{1,47}$' },
        title: l10n({ type: 'string', maxLength: 80 }),
        symptom: l10n({ type: 'string', maxLength: 200 }),
        match: {
          type: 'array',
          minItems: 1,
          items: {
            type: 'object',
            additionalProperties: false,
            properties: {
              checkId: { $ref: '#/$defs/checkId' },
              result: { enum: ['pass', 'fail', 'pending', 'error', 'unavailable', 'skipped', 'not_run'] },
              errorCode: { type: 'string', pattern: '^[A-Z][A-Z_]+$' },
              assertionLabel: { type: 'string' },
            },
          },
        },
        cause: l10n({ type: 'string', maxLength: 300 }),
        fix: l10n({ type: 'string', maxLength: 300 }),
      },
    },
  },
} as const;
