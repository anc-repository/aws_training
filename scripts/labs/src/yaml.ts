/**
 * Safe YAML loading for content (04 §2.2): YAML 1.2 core schema (so `on` / `off` stay strings), no custom tags,
 * at most a handful of aliases, ≤ 256 KB per file. Markdown front matter uses the same loader.
 */
import fs from 'node:fs';
import YAML from 'yaml';

/** 04 §2.2: ≤ 256 KB per YAML file. */
export const MAX_YAML_BYTES = 256 * 1024;

export class ContentFileError extends Error {
  constructor(
    readonly file: string,
    message: string,
  ) {
    super(`${file}: ${message}`);
    this.name = 'ContentFileError';
  }
}

export function parseYamlText(text: string, file = '<inline>'): unknown {
  const doc = YAML.parseDocument(text, { version: '1.2', schema: 'core', customTags: [], uniqueKeys: true, prettyErrors: true });
  if (doc.errors.length) throw new ContentFileError(file, doc.errors.map((e) => e.message).join('; '));
  return doc.toJS({ maxAliasCount: 50 });
}

export function loadYamlFile(file: string): unknown {
  const size = fs.statSync(file).size;
  if (size > MAX_YAML_BYTES) throw new ContentFileError(file, `${size} bytes exceeds ${MAX_YAML_BYTES}`);
  return parseYamlText(fs.readFileSync(file, 'utf8'), file);
}

export interface FrontMatterDoc {
  frontMatter: Record<string, unknown> | null;
  body: string;
  /** 1-based line of the first body line (for messages). */
  bodyLine: number;
}

/** `---\n<yaml>\n---\n<body>`; files without front matter return `frontMatter: null`. */
export function splitFrontMatter(text: string, file = '<inline>'): FrontMatterDoc {
  const src = text.replace(/^\uFEFF/, '').replace(/\r\n/g, '\n');
  if (!src.startsWith('---\n')) return { frontMatter: null, body: src, bodyLine: 1 };
  const end = src.indexOf('\n---', 4);
  if (end < 0) throw new ContentFileError(file, 'unterminated front matter');
  const yamlText = src.slice(4, end);
  const after = src.indexOf('\n', end + 4);
  const body = after < 0 ? '' : src.slice(after + 1);
  const fm = parseYamlText(yamlText, file);
  if (fm !== null && (typeof fm !== 'object' || Array.isArray(fm))) throw new ContentFileError(file, 'front matter must be a mapping');
  return { frontMatter: (fm as Record<string, unknown>) ?? {}, body, bodyLine: yamlText.split('\n').length + 3 };
}

export function stringifyYaml(value: unknown, header?: string): string {
  const body = YAML.stringify(value, { version: '1.2', lineWidth: 0, singleQuote: true });
  return header ? `${header}\n${body}` : body;
}
