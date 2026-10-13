/**
 * `labs/_pricing/dimensions.yaml` (04 §3.4): pricingKey → Price List query conditions. Never prices.
 * Extension (documented in implementation-notes platform-content): `base`, `workstation` and `modules` list the billable
 * items that the `ref: start-profile | workstation | target-modules` cost entries expand to, until the registry carries
 * `platform.billing.pricingKeys` (06 PM-34).
 */
const billItem = {
  type: 'object',
  additionalProperties: false,
  required: ['key', 'pricingKey', 'billing', 'quantity'],
  properties: {
    key: { type: 'string', pattern: '^[a-z][a-z0-9-]{1,31}$' },
    pricingKey: { type: 'string', pattern: '^[a-z0-9-]+(\\.[a-z0-9-]+)+$' },
    billing: { enum: ['hourly', 'monthly', 'usage', 'one-time'] },
    quantity: { type: 'number', exclusiveMinimum: 0 },
    unit: { type: 'string', maxLength: 16 },
    assumedUsagePerHour: { type: 'number', minimum: 0 },
    note: { type: 'string', maxLength: 200 },
    /** quantity multiplier by a stack parameter or env value of the module (e.g. RDS MultiAz=true → 2 instances). */
    scaleBy: {
      type: 'object',
      additionalProperties: false,
      required: ['key', 'values'],
      properties: { key: { type: 'string' }, values: { type: 'object', additionalProperties: { type: 'number', minimum: 0 } }, default: { type: 'number', minimum: 0 } },
    },
  },
} as const;

export const PRICING_SCHEMA = {
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  $id: 'urn:atl:schema:pricing-dimensions:v1',
  title: 'ATL pricing dimensions (04 §3.4)',
  type: 'object',
  additionalProperties: false,
  required: ['schema', 'dimensions'],
  properties: {
    schema: { const: 'atl.pricing-dimensions/v1' },
    dimensions: {
      type: 'object',
      propertyNames: { pattern: '^[a-z0-9-]+(\\.[a-z0-9-]+)+$' },
      additionalProperties: {
        type: 'object',
        additionalProperties: false,
        required: ['serviceCode', 'filters', 'unit'],
        properties: {
          serviceCode: { type: 'string', pattern: '^[A-Za-z0-9]+$' },
          filters: { type: 'object', additionalProperties: { type: 'string' } },
          unit: { type: 'string', maxLength: 24 },
          freeTierNote: { type: 'boolean' },
          note: { type: 'string', maxLength: 200 },
        },
      },
    },
    base: { type: 'array', items: billItem },
    workstation: { type: 'array', items: billItem },
    modules: { type: 'object', propertyNames: { pattern: '^[a-z][a-z0-9-]{1,23}$' }, additionalProperties: { type: 'array', items: billItem } },
  },
} as const;
