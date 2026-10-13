/**
 * Parse CloudFormation YAML with short intrinsic tags (`!Ref`, `!Sub`, `!GetAtt`, …) into the JSON form
 * (`{ "Ref": … }`, `{ "Fn::Sub": … }`), so fragments can be merged and emitted as a JSON template.
 */
import YAML, { type ScalarTag, type CollectionTag } from 'yaml';

const FN_TAGS = [
  'Base64',
  'Cidr',
  'FindInMap',
  'GetAZs',
  'ImportValue',
  'Join',
  'Select',
  'Split',
  'Sub',
  'Transform',
  'And',
  'Equals',
  'If',
  'Not',
  'Or',
  'Length',
  'ToJsonString',
  // rule-specific functions (Rules section)
  'Contains',
  'EachMemberEquals',
  'EachMemberIn',
  'RefAll',
  'ValueOf',
  'ValueOfAll',
] as const;

function scalarTag(tag: string, toJson: (v: string) => unknown): ScalarTag {
  return { tag, resolve: (str: string) => toJson(str) } as ScalarTag;
}

function seqTag(tag: string, key: string): CollectionTag {
  return {
    tag,
    collection: 'seq',
    resolve: (seq: { toJSON(): unknown }) => ({ [key]: seq.toJSON() }),
  } as unknown as CollectionTag;
}

function mapTag(tag: string, key: string): CollectionTag {
  return {
    tag,
    collection: 'map',
    resolve: (map: { toJSON(): unknown }) => ({ [key]: map.toJSON() }),
  } as unknown as CollectionTag;
}

export const CFN_TAGS: (ScalarTag | CollectionTag)[] = [
  scalarTag('!Ref', (v) => ({ Ref: v })),
  scalarTag('!Condition', (v) => ({ Condition: v })),
  scalarTag('!GetAtt', (v) => {
    const i = v.indexOf('.');
    return { 'Fn::GetAtt': i < 0 ? [v] : [v.slice(0, i), v.slice(i + 1)] };
  }),
  seqTag('!GetAtt', 'Fn::GetAtt'),
  ...FN_TAGS.flatMap((n) => [scalarTag(`!${n}`, (v) => ({ [`Fn::${n}`]: v })), seqTag(`!${n}`, `Fn::${n}`), mapTag(`!${n}`, `Fn::${n}`)]),
];

export function parseCfnYaml(text: string): Record<string, unknown> {
  const doc = YAML.parse(text, { customTags: CFN_TAGS, version: '1.2' }) as unknown;
  if (doc === null || doc === undefined) return {};
  if (typeof doc !== 'object' || Array.isArray(doc)) throw new Error('a template fragment must be a mapping');
  return doc as Record<string, unknown>;
}
