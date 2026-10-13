/**
 * Manual files (04 §4.2–§4.5): front matter, the Markdown subset with generic directives (remark-directive syntax) and
 * `{{ ns.path | filter }}` variables.
 *
 * The parser is deliberately small (no Markdown dependency in this round): it produces a simplified mdast
 * (`atl.mdast/v1`: root → heading / paragraph / code / list / blockquote / table / thematicBreak / containerDirective /
 * leafDirective; inline text / inlineCode / strong / emphasis / link / image / variable / textDirective) that the web
 * renders node by node (04 §4.5, no innerHTML), and collects what lint needs (directives, code blocks, variables, links,
 * images, raw HTML). The build also ships the Markdown source next to the AST, so the next round may switch the web to
 * remark without a content change.
 */
import { splitFrontMatter } from './yaml.js';

export type Attrs = Record<string, string | true>;

export interface InlineNode {
  type: 'text' | 'inlineCode' | 'strong' | 'emphasis' | 'link' | 'image' | 'variable' | 'textDirective';
  value?: string;
  url?: string;
  alt?: string;
  name?: string;
  label?: string;
  attributes?: Attrs;
  children?: InlineNode[];
}

export interface BlockNode {
  type: 'heading' | 'paragraph' | 'code' | 'list' | 'listItem' | 'blockquote' | 'table' | 'thematicBreak' | 'containerDirective' | 'leafDirective';
  depth?: number;
  ordered?: boolean;
  start?: number;
  lang?: string | null;
  meta?: string | null;
  attributes?: Attrs;
  value?: string;
  name?: string;
  label?: string;
  rows?: InlineNode[][][];
  children?: (BlockNode | InlineNode)[];
}

export interface ManualRoot {
  type: 'root';
  schema: 'atl.mdast/v1';
  children: BlockNode[];
}

export interface DirectiveUse {
  kind: 'container' | 'leaf' | 'text';
  name: string;
  label?: string;
  attributes: Attrs;
  line: number;
}

export interface CodeUse {
  lang: string | null;
  attributes: Attrs;
  value: string;
  line: number;
}

export interface ParsedManual {
  file: string;
  frontMatter: Record<string, unknown> | null;
  body: string;
  ast: ManualRoot;
  directives: DirectiveUse[];
  code: CodeUse[];
  /** `{{ … }}` expressions outside code blocks with vars=false (and outside escaped `\{{`). */
  variables: { expr: string; line: number }[];
  links: { url: string; line: number }[];
  images: { src: string; line: number }[];
  headings: { depth: number; text: string; line: number }[];
  rawHtml: { snippet: string; line: number }[];
  errors: { message: string; line: number }[];
}

// ---------------------------------------------------------------------------------------------------------------
// attributes

/** `{key=value key2="a b" flag}` → attributes (`#id` and `.class` are not used by content and are rejected by lint). */
export function parseAttrs(src: string): Attrs {
  const out: Attrs = {};
  const re = /([A-Za-z_][A-Za-z0-9_.:-]*)(?:=("([^"]*)"|'([^']*)'|([^\s"'}]+)))?/g;
  for (let m = re.exec(src); m; m = re.exec(src)) {
    const key = m[1]!;
    if (m[2] === undefined) out[key] = true;
    else out[key] = m[3] ?? m[4] ?? m[5] ?? '';
  }
  return out;
}

/** Splits `name[label]{attrs}` (the part after the colons). */
function parseDirectiveHead(s: string): { name: string; label?: string; attrs: Attrs; rest: string } | null {
  const m = /^([a-z][a-z0-9-]*)(\[([^\]]*)\])?/.exec(s);
  if (!m) return null;
  let i = m[0].length;
  let attrs: Attrs = {};
  if (s[i] === '{') {
    // scan to the matching brace, skipping quoted values (which may contain {{ variables }})
    let j = i + 1;
    let quote: string | null = null;
    for (; j < s.length; j++) {
      const ch = s[j]!;
      if (quote) {
        if (ch === quote) quote = null;
      } else if (ch === '"' || ch === "'") quote = ch;
      else if (ch === '}') break;
    }
    if (j >= s.length) return null;
    attrs = parseAttrs(s.slice(i + 1, j));
    i = j + 1;
  }
  return { name: m[1]!, ...(m[3] !== undefined ? { label: m[3] } : {}), attrs, rest: s.slice(i) };
}

// ---------------------------------------------------------------------------------------------------------------
// inline

export function parseInline(text: string, ctx?: { line: number; out: ParsedManual }): InlineNode[] {
  const nodes: InlineNode[] = [];
  let buf = '';
  const flush = () => {
    if (buf) nodes.push({ type: 'text', value: buf });
    buf = '';
  };
  let i = 0;
  while (i < text.length) {
    const rest = text.slice(i);
    let m: RegExpExecArray | null;
    if (rest.startsWith('\\{{')) {
      buf += '{{';
      i += 3;
      continue;
    }
    if ((m = /^`([^`]+)`/.exec(rest))) {
      flush();
      nodes.push({ type: 'inlineCode', value: m[1]! });
      if (ctx) for (const v of m[1]!.matchAll(/\{\{\s*([^}]+?)\s*\}\}/g)) ctx.out.variables.push({ expr: v[1]!, line: ctx.line });
      i += m[0].length;
      continue;
    }
    if ((m = /^\{\{\s*([^}]+?)\s*\}\}/.exec(rest))) {
      flush();
      nodes.push({ type: 'variable', value: m[1]! });
      if (ctx) ctx.out.variables.push({ expr: m[1]!, line: ctx.line });
      i += m[0].length;
      continue;
    }
    if ((m = /^!\[([^\]]*)\]\(([^)\s]+)\)/.exec(rest))) {
      flush();
      nodes.push({ type: 'image', alt: m[1]!, url: m[2]! });
      if (ctx) ctx.out.images.push({ src: m[2]!, line: ctx.line });
      i += m[0].length;
      continue;
    }
    if ((m = /^\[([^\]]+)\]\(([^)\s]+)\)/.exec(rest))) {
      flush();
      nodes.push({ type: 'link', url: m[2]!, children: parseInline(m[1]!, ctx) });
      if (ctx) ctx.out.links.push({ url: m[2]!, line: ctx.line });
      i += m[0].length;
      continue;
    }
    if ((m = /^\*\*([^*]+)\*\*/.exec(rest))) {
      flush();
      nodes.push({ type: 'strong', children: parseInline(m[1]!, ctx) });
      i += m[0].length;
      continue;
    }
    if ((m = /^\*([^*\s][^*]*)\*/.exec(rest))) {
      flush();
      nodes.push({ type: 'emphasis', children: parseInline(m[1]!, ctx) });
      i += m[0].length;
      continue;
    }
    // text directive :name[label]{attrs} — only at a word boundary and with a label or attributes
    if (rest[0] === ':' && (i === 0 || /[\s(（]/.test(text[i - 1]!))) {
      const head = parseDirectiveHead(rest.slice(1));
      if (head && (head.label !== undefined || Object.keys(head.attrs).length)) {
        flush();
        nodes.push({ type: 'textDirective', name: head.name, ...(head.label !== undefined ? { label: head.label } : {}), attributes: head.attrs });
        if (ctx) ctx.out.directives.push({ kind: 'text', name: head.name, ...(head.label !== undefined ? { label: head.label } : {}), attributes: head.attrs, line: ctx.line });
        i += 1 + (rest.length - 1 - head.rest.length);
        continue;
      }
    }
    if (ctx && rest[0] === '<' && /^<\/?[A-Za-z][A-Za-z0-9-]*(\s[^>]*)?>/.test(rest)) {
      ctx.out.rawHtml.push({ snippet: rest.slice(0, 40), line: ctx.line });
    }
    buf += text[i];
    i += 1;
  }
  flush();
  return nodes;
}

function inlineText(nodes: readonly InlineNode[]): string {
  return nodes.map((n) => (n.value ?? '') + (n.children ? inlineText(n.children) : '') + (n.label ?? '')).join('');
}

// ---------------------------------------------------------------------------------------------------------------
// blocks

interface Line {
  text: string;
  no: number;
}

const FENCE = /^(\s*)(`{3,}|~{3,})(.*)$/;
const LIST_ITEM = /^(\s*)([-*+]|\d{1,3}[.)])\s+(.*)$/;

function indentOf(s: string): number {
  return s.length - s.trimStart().length;
}

function parseBlocks(lines: Line[], out: ParsedManual): BlockNode[] {
  const nodes: BlockNode[] = [];
  let i = 0;
  while (i < lines.length) {
    const { text, no } = lines[i]!;
    const trimmed = text.trim();
    if (trimmed === '') {
      i += 1;
      continue;
    }
    // fenced code
    const fence = FENCE.exec(text);
    if (fence) {
      const marker = fence[2]!;
      const info = fence[3]!.trim();
      const body: string[] = [];
      let j = i + 1;
      for (; j < lines.length; j++) {
        if (lines[j]!.text.trim().startsWith(marker)) break;
        body.push(lines[j]!.text.slice(Math.min(indentOf(lines[j]!.text), fence[1]!.length)));
      }
      if (j >= lines.length) out.errors.push({ message: 'unterminated code fence', line: no });
      const langM = /^([A-Za-z0-9_+-]+)?\s*(\{([^}]*)\})?\s*(.*)$/.exec(info);
      const lang = langM?.[1] ?? null;
      const attrs = langM?.[3] !== undefined ? parseAttrs(langM[3]) : {};
      const value = body.join('\n');
      nodes.push({ type: 'code', lang, meta: langM?.[2] ?? null, attributes: attrs, value });
      out.code.push({ lang, attributes: attrs, value, line: no });
      if (attrs.vars !== 'false') for (const v of value.matchAll(/(?<!\\)\{\{\s*([^}]+?)\s*\}\}/g)) out.variables.push({ expr: v[1]!, line: no });
      i = j + 1;
      continue;
    }
    // container directive :::name … :::
    const cont = /^(\s*)(:{3,})([a-z].*)$/.exec(text);
    if (cont && cont[3]) {
      const colons = cont[2]!;
      const head = parseDirectiveHead(cont[3].trim());
      if (!head || head.rest.trim() !== '') {
        out.errors.push({ message: `malformed directive ${trimmed}`, line: no });
        i += 1;
        continue;
      }
      const inner: Line[] = [];
      let depth = 0;
      let j = i + 1;
      for (; j < lines.length; j++) {
        const t = lines[j]!.text.trim();
        const open = /^(:{3,})[a-z]/.exec(t);
        if (open && open[1]!.length === colons.length) depth += 1;
        if (t === colons) {
          if (depth === 0) break;
          depth -= 1;
        }
        inner.push(lines[j]!);
      }
      if (j >= lines.length) out.errors.push({ message: `unterminated container directive :::${head.name}`, line: no });
      out.directives.push({ kind: 'container', name: head.name, ...(head.label !== undefined ? { label: head.label } : {}), attributes: head.attrs, line: no });
      nodes.push({
        type: 'containerDirective',
        name: head.name,
        ...(head.label !== undefined ? { label: head.label } : {}),
        attributes: head.attrs,
        children: parseBlocks(inner, out),
      });
      i = j + 1;
      continue;
    }
    // leaf directive ::name[label]{attrs}
    const leaf = /^\s*::([a-z].*)$/.exec(text);
    if (leaf && !text.trim().startsWith(':::')) {
      const head = parseDirectiveHead(leaf[1]!.trim());
      if (head && head.rest.trim() === '') {
        out.directives.push({ kind: 'leaf', name: head.name, ...(head.label !== undefined ? { label: head.label } : {}), attributes: head.attrs, line: no });
        for (const v of `${head.label ?? ''} ${Object.values(head.attrs).join(' ')}`.matchAll(/\{\{\s*([^}]+?)\s*\}\}/g)) out.variables.push({ expr: v[1]!, line: no });
        nodes.push({ type: 'leafDirective', name: head.name, ...(head.label !== undefined ? { label: head.label } : {}), attributes: head.attrs });
        i += 1;
        continue;
      }
    }
    // heading
    const h = /^(#{1,6})\s+(.*)$/.exec(trimmed);
    if (h && indentOf(text) < 4) {
      const children = parseInline(h[2]!, { line: no, out });
      nodes.push({ type: 'heading', depth: h[1]!.length, children });
      out.headings.push({ depth: h[1]!.length, text: inlineText(children).trim(), line: no });
      i += 1;
      continue;
    }
    if (/^(-{3,}|\*{3,}|_{3,})$/.test(trimmed)) {
      nodes.push({ type: 'thematicBreak' });
      i += 1;
      continue;
    }
    // blockquote
    if (trimmed.startsWith('>')) {
      const inner: Line[] = [];
      let j = i;
      for (; j < lines.length && lines[j]!.text.trim().startsWith('>'); j++) inner.push({ text: lines[j]!.text.trim().replace(/^>\s?/, ''), no: lines[j]!.no });
      nodes.push({ type: 'blockquote', children: parseBlocks(inner, out) });
      i = j;
      continue;
    }
    // table
    if (trimmed.startsWith('|') && i + 1 < lines.length && /^\|?\s*:?-{2,}/.test(lines[i + 1]!.text.trim())) {
      const rows: InlineNode[][][] = [];
      let j = i;
      for (; j < lines.length && lines[j]!.text.trim().startsWith('|'); j++) {
        if (j === i + 1) continue;
        const cells = lines[j]!.text.trim().replace(/^\||\|$/g, '').split('|').map((c) => parseInline(c.trim(), { line: lines[j]!.no, out }));
        rows.push(cells);
      }
      nodes.push({ type: 'table', rows });
      i = j;
      continue;
    }
    // list
    const li = LIST_ITEM.exec(text);
    if (li) {
      const baseIndent = li[1]!.length;
      const ordered = /\d/.test(li[2]!);
      const items: BlockNode[] = [];
      let j = i;
      while (j < lines.length) {
        const m = LIST_ITEM.exec(lines[j]!.text);
        if (!m || m[1]!.length !== baseIndent || /\d/.test(m[2]!) !== ordered) break;
        const contentIndent = baseIndent + m[2]!.length + 1;
        const itemLines: Line[] = [{ text: m[3]!, no: lines[j]!.no }];
        let k = j + 1;
        for (; k < lines.length; k++) {
          const t = lines[k]!.text;
          if (t.trim() === '') {
            const next = lines.slice(k + 1).find((x) => x.text.trim() !== '');
            if (!next || indentOf(next.text) < contentIndent) break;
            itemLines.push({ text: '', no: lines[k]!.no });
            continue;
          }
          if (indentOf(t) < contentIndent) {
            const isNextItem = LIST_ITEM.exec(t) && indentOf(t) <= baseIndent;
            if (isNextItem || indentOf(t) <= baseIndent) break;
          }
          itemLines.push({ text: t.slice(Math.min(indentOf(t), contentIndent)), no: lines[k]!.no });
        }
        items.push({ type: 'listItem', children: parseBlocks(itemLines, out) });
        j = k;
        while (j < lines.length && lines[j]!.text.trim() === '') j += 1;
      }
      nodes.push({ type: 'list', ordered, ...(ordered ? { start: Number.parseInt(li[2]!, 10) } : {}), children: items });
      i = j;
      continue;
    }
    // paragraph
    const para: Line[] = [];
    let j = i;
    for (; j < lines.length; j++) {
      const t = lines[j]!.text;
      if (t.trim() === '' || FENCE.test(t) || /^\s*:{2,}[a-z]/.test(t) || /^\s*:{3,}\s*$/.test(t) || /^#{1,6}\s/.test(t.trim()) || (j > i && LIST_ITEM.test(t))) break;
      para.push(lines[j]!);
    }
    if (!para.length) {
      out.errors.push({ message: `cannot parse line: ${trimmed.slice(0, 60)}`, line: no });
      i += 1;
      continue;
    }
    const children: InlineNode[] = [];
    para.forEach((l, idx) => {
      if (idx > 0) children.push({ type: 'text', value: '\n' });
      children.push(...parseInline(l.text.trim(), { line: l.no, out }));
    });
    nodes.push({ type: 'paragraph', children });
    i = j;
  }
  return nodes;
}

export function parseManual(text: string, file: string): ParsedManual {
  const { frontMatter, body, bodyLine } = splitFrontMatter(text, file);
  const out: ParsedManual = {
    file,
    frontMatter,
    body,
    ast: { type: 'root', schema: 'atl.mdast/v1', children: [] },
    directives: [],
    code: [],
    variables: [],
    links: [],
    images: [],
    headings: [],
    rawHtml: [],
    errors: [],
  };
  const lines = body.split('\n').map((t, idx) => ({ text: t, no: bodyLine + idx }));
  out.ast.children = parseBlocks(lines, out);
  return out;
}

// ---------------------------------------------------------------------------------------------------------------
// variables (04 §4.4)

export const VARIABLE_NAMESPACES = ['session', 'target', 'workstation', 'stack', 'cap', 'envfile', 'var', 'sample', 'learner', 'platform'] as const;
export const VARIABLE_FILTERS = ['default', 'mask', 'host', 'trimScheme', 'shell', 'url', 'json', 'lower', 'upper'] as const;

export interface VariableRef {
  ns: string;
  path: string[];
  filters: { name: string; arg?: string }[];
}

/** `ns.a.b | filter:"x" | other` → parts; `null` when the expression is not a §4.4 variable (e.g. `$.path` templates). */
export function parseVariable(expr: string): VariableRef | null {
  const [head, ...filters] = expr.split('|').map((s) => s.trim());
  if (!head || head.startsWith('$')) return null;
  const segs = head.split('.');
  if (segs.length < 2 || !segs.every((s) => /^[A-Za-z0-9_-]+$/.test(s))) return null;
  return {
    ns: segs[0]!,
    path: segs.slice(1),
    filters: filters.map((f) => {
      const m = /^([A-Za-z]+)(?::(.*))?$/.exec(f);
      return m ? { name: m[1]!, ...(m[2] !== undefined ? { arg: m[2] } : {}) } : { name: f };
    }),
  };
}
