/** `labs/_catalog/taxonomy.yaml` (05 §8.2). Uniqueness and registry coverage are catalog rule C-1. */
import { L10N_SCHEMA, l10n } from './l10n.js';
const id = { type: 'string', pattern: '^[a-z][a-z0-9-]{1,31}$' } as const;

export const TAXONOMY_SCHEMA = {
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  $id: 'urn:atl:schema:taxonomy:v1',
  title: 'ATL catalog taxonomy (05 §8.2)',
  type: 'object',
  additionalProperties: false,
  required: ['schema', 'version', 'categories', 'services', 'domains', 'durationBuckets', 'costTier', 'provisionSpeed', 'provisionClasses'],
  $defs: { l10n: L10N_SCHEMA },
  properties: {
    schema: { const: 'atl.taxonomy/v1' },
    version: { type: 'string', pattern: '^(0|[1-9][0-9]*)\\.(0|[1-9][0-9]*)\\.(0|[1-9][0-9]*)$' },
    categories: {
      type: 'array',
      minItems: 1,
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['id', 'label', 'token', 'symbol'],
        properties: {
          id: { enum: ['base', 'A', 'B', 'C', 'D', 'E', 'F'] },
          label: l10n({ type: 'string', maxLength: 20 }),
          token: { type: 'string', pattern: '^--cat-[a-z]+$' },
          symbol: { enum: ['square', 'triangle', 'diamond', 'circle', 'hexagon', 'plus', 'bars'] },
        },
      },
    },
    services: {
      type: 'array',
      minItems: 1,
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['id', 'abbr', 'name', 'iamPrefix'],
        properties: {
          id,
          abbr: { type: 'string', minLength: 1, maxLength: 4 },
          name: l10n({ type: 'string', maxLength: 60 }),
          short: l10n({ type: 'string', maxLength: 30 }),
          function: l10n({ type: 'string', maxLength: 20 }),
          category: { enum: ['base', 'A', 'B', 'C', 'D', 'E', 'F'] },
          module: { type: 'string', pattern: '^[a-z][a-z0-9-]{1,23}$' },
          iamPrefix: { type: 'string', pattern: '^[a-z0-9-]+$' },
          featureOf: id,
          consoleHome: { type: 'string', pattern: '^[a-z0-9]+\\.[A-Za-z0-9]+$' },
        },
      },
    },
    domains: {
      type: 'array',
      minItems: 4,
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['id', 'label', 'weight', 'track'],
        properties: {
          id: { enum: ['secure', 'resilient', 'performance', 'cost'] },
          label: l10n({ type: 'string' }),
          weight: { type: 'number', minimum: 0, maximum: 100 },
          track: id,
        },
      },
    },
    durationBuckets: {
      type: 'array',
      minItems: 1,
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['id', 'label'],
        properties: { id: { enum: ['short', 'medium', 'long'] }, label: l10n({ type: 'string' }), maxMinutes: { type: 'integer', minimum: 1 } },
      },
    },
    costTier: {
      type: 'object',
      additionalProperties: false,
      required: ['highUnits', 'weights', 'accountScopedKeys', 'labels'],
      properties: {
        highUnits: { type: 'integer', minimum: 1 },
        weights: { type: 'object', additionalProperties: { type: 'number', minimum: 0 } },
        accountScopedKeys: { type: 'array', items: { type: 'string' } },
        labels: { type: 'object', additionalProperties: false, required: ['low', 'medium', 'high'], properties: { low: l10n({ type: 'string' }), medium: l10n({ type: 'string' }), high: l10n({ type: 'string' }) } },
      },
    },
    provisionSpeed: { type: 'object', additionalProperties: { enum: ['base', 'fast', 'medium', 'slow'] } },
    provisionClassRules: {
      type: 'object',
      additionalProperties: false,
      properties: {
        heavy: { type: 'array', items: { type: 'string' } },
        replacement: { type: 'array', items: { type: 'string' } },
      },
    },
    provisionClasses: {
      type: 'array',
      minItems: 4,
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['id', 'label', 'hint'],
        properties: { id: { enum: ['A', 'B', 'C', 'D'] }, label: l10n({ type: 'string' }), hint: l10n({ type: 'string' }) },
      },
    },
    seeds: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['id', 'title'],
        properties: { id, title: l10n({ type: 'string', maxLength: 60 }) },
      },
    },
  },
} as const;
