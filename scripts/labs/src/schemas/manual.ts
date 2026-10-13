/** Front matter of `labs/<card>/manual/*.md` (04 §4.2): a step file names its step, other files name a section. */
export const MANUAL_FRONTMATTER_SCHEMA = {
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  $id: 'urn:atl:schema:manual-frontmatter:v1',
  title: 'ATL manual front matter (04 §4.2)',
  oneOf: [
    {
      type: 'object',
      additionalProperties: false,
      required: ['step'],
      properties: { step: { type: 'string', pattern: '^[a-z][a-z0-9-]{1,39}$' } },
    },
    {
      type: 'object',
      additionalProperties: false,
      required: ['section'],
      properties: { section: { enum: ['overview', 'wrap-up', 'cleanup'] } },
    },
  ],
} as const;
