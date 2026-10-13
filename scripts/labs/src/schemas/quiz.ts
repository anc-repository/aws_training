/** `labs/<card>/quiz.yaml` (`atl.quiz/v1`, 04 §3.2.11). Answer validity (ids, single = 1 answer, draw) is lint A17. */
export const QUIZ_SCHEMA = {
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  $id: 'urn:atl:schema:quiz:v1',
  title: 'ATL quiz.yaml (04 §3.2.11)',
  type: 'object',
  additionalProperties: false,
  required: ['schema', 'version', 'questions'],
  properties: {
    schema: { const: 'atl.quiz/v1' },
    version: { type: 'string', pattern: '^(0|[1-9][0-9]*)\\.(0|[1-9][0-9]*)\\.(0|[1-9][0-9]*)$' },
    include: {
      type: 'array',
      items: { type: 'object', additionalProperties: false, required: ['ref'], properties: { ref: { type: 'string', pattern: '^guide:' } } },
    },
    maxAttemptsPerDay: { type: 'integer', minimum: 1, maximum: 50 },
    timeLimitMinutes: { type: 'integer', minimum: 1, maximum: 120 },
    questions: {
      type: 'array',
      minItems: 1,
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['id', 'domain', 'type', 'stem', 'options', 'answer', 'explain'],
        properties: {
          id: { type: 'string', pattern: '^[a-z][a-z0-9-]{1,31}$' },
          domain: { enum: ['secure', 'resilient', 'performance', 'cost'] },
          type: { enum: ['single', 'multi'] },
          kind: { enum: ['concept', 'scenario'] },
          services: { type: 'array', uniqueItems: true, items: { type: 'string', pattern: '^[a-z][a-z0-9-]{1,31}$' } },
          stem: { type: 'string', minLength: 10, maxLength: 1200 },
          options: {
            type: 'array',
            minItems: 2,
            maxItems: 6,
            items: {
              type: 'object',
              additionalProperties: false,
              required: ['id', 'text'],
              properties: { id: { type: 'string', pattern: '^[a-f]$' }, text: { type: 'string', minLength: 1, maxLength: 300 } },
            },
          },
          answer: { type: 'array', minItems: 1, uniqueItems: true, items: { type: 'string', pattern: '^[a-f]$' } },
          explain: { type: 'string', minLength: 10, maxLength: 1200 },
          relatesTo: { type: 'string', pattern: '^[a-z][a-z0-9-]{1,39}$' },
          difficulty: { enum: [1, 2, 3] },
          tags: { type: 'array', items: { type: 'string' } },
        },
      },
    },
  },
} as const;
