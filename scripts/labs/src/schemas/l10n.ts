/**
 * Localized text in content files (09-i18n-and-visual.md §2, decision I4): a learner-facing string may be written as
 * `{ zh-CN, ja?, en? }`. Every schema keeps the original string schema (length limits apply to zh-CN, because lint
 * validates the document again after resolving it to zh-CN) and accepts the object form through `$defs.l10n`, the same
 * definition as 04 §3.3.
 */
export const L10N_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['zh-CN'],
  properties: {
    'zh-CN': { type: 'string', minLength: 1 },
    ja: { type: 'string', minLength: 1 },
    en: { type: 'string', minLength: 1 },
  },
} as const;

/** `{ anyOf: [<string schema>, { $ref: '#/$defs/l10n' }] }` — the schema using it must define `$defs.l10n`. */
export function l10n<const T extends Record<string, unknown>>(s: T) {
  return { anyOf: [s, { $ref: '#/$defs/l10n' }] } as const;
}
