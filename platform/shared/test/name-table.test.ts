/**
 * Cross-check the constants against the name table of 01 §14 (“唯一权威”). Skipped when the doc is not present.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  ATL_OPS,
  CHECK_SOURCES,
  CLEANUP_STATES,
  COGNITO_GROUPS,
  DEPRECATED_ENTITY_TYPES,
  DISCOVERED_BY,
  ENTITY_TYPES,
  LAMBDA_FUNCTIONS,
  RESOURCE_SEVERITIES,
  ROLE_NAMES,
  SSM_DOCUMENTS,
  STATE_MACHINES,
  TAG_KEYS,
  TIMER_KINDS,
  ROUTES,
  ERROR_CODES,
  SESSION_EVENT_TYPES,
  AUDIT_ACTIONS,
  API_PREFIX,
} from '../src/index.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DOC = path.resolve(HERE, '../../../docs/platform/01-architecture.md');
const hasDoc = fs.existsSync(DOC);
const md = hasDoc ? fs.readFileSync(DOC, 'utf8') : '';

function section(title: string, next: string): string {
  const a = md.indexOf(title);
  const b = md.indexOf(next, a + title.length);
  return md.slice(a, b);
}

/** Backticked names of a §14 row, before the word 废弃 (deprecated). */
function row(category: string): string[] {
  const table = section('## 14. 名称表（唯一权威）', '\n**写入分工**');
  const line = table.split('\n').find((l) => l.startsWith(`| ${category} |`));
  if (!line) throw new Error(`row not found: ${category}`);
  const names = line.split('|')[2]!.split('废弃')[0]!;
  return [...names.matchAll(/`([^`]+)`/g)].map((m) => m[1]!);
}

describe.skipIf(!hasDoc)('01 §14 name table', () => {
  it('entities', () => {
    // the row mentions the replaced names in parentheses (“含原 PlatformSettings”, “取代 ReclaimItem”)
    const names = row('实体').filter((n) => !(n in DEPRECATED_ENTITY_TYPES));
    expect([...ENTITY_TYPES].sort()).toEqual(names.sort());
  });

  it('state machines', () => {
    expect([...STATE_MACHINES].sort()).toEqual(row('状态机').sort());
  });

  it('Lambda functions', () => {
    const names = row('Lambda').filter((n) => /^atl-[a-z-]+$/.test(n));
    const listed = names.slice(0, names.indexOf('atl-tagger') + 1);
    expect([...LAMBDA_FUNCTIONS].sort()).toEqual(listed.sort());
  });

  it('ATL_OP', () => {
    const ops = row('CodeBuild').filter((n) => !n.startsWith('atl-') && !n.startsWith('ATL_'));
    expect([...ATL_OPS].sort()).toEqual([...new Set(ops)].sort());
  });

  it('roles', () => {
    expect([...ROLE_NAMES].sort()).toEqual(row('角色').sort());
  });

  it('Cognito groups', () => {
    expect([...COGNITO_GROUPS].sort()).toEqual(row('Cognito 组').sort());
  });

  it('check sources', () => {
    expect([...CHECK_SOURCES].sort()).toEqual(row('检查来源').sort());
  });

  it('SessionResource enums', () => {
    const all = row('`SessionResource` 枚举');
    for (const v of [...CLEANUP_STATES, ...RESOURCE_SEVERITIES, ...DISCOVERED_BY]) expect(all).toContain(v);
    expect(all.filter((n) => !['cleanupState', 'severity', 'discoveredBy'].includes(n)).sort()).toEqual(
      [...CLEANUP_STATES, ...RESOURCE_SEVERITIES, ...DISCOVERED_BY].sort(),
    );
  });

  it('tags', () => {
    const tags = row('标签').filter((n) => n.startsWith('atl:') || n === 'Project');
    expect(Object.values(TAG_KEYS).sort()).toEqual(tags.sort());
  });

  it('SSM documents', () => {
    const docs = row('SSM').filter((n) => /^ATL-[A-Za-z-]+$/.test(n));
    expect([...SSM_DOCUMENTS].sort()).toEqual(docs.sort());
  });

  it('timer kinds (动作名 row)', () => {
    const kinds = row('动作名（跨文档接口）').filter((n) => /^[A-Z_0-9]+$/.test(n));
    expect([...TIMER_KINDS].sort()).toEqual(kinds.sort());
  });
});

describe.skipIf(!hasDoc)('01 §8 tables', () => {
  it('ROUTES equals the routes of the §8.2 tables', () => {
    const s = section('### 8.2 端点总表', '### 8.3');
    const found = new Set<string>();
    for (const raw of s.split('\n')) {
      if (!raw.startsWith('| `')) continue;
      const cell = raw.replace(/\\\|/g, '¦').split('|')[1]!;
      let lastPath = '';
      for (const m of cell.matchAll(/`([A-Z]+) ([^`]+)`/g)) {
        let p = m[2]!.split('?')[0]!;
        // `DELETE …/skip`, `GET …/shares`: continue the previous path of the same cell
        if (p.startsWith('…')) p = lastPath.replace(/\/[^/]+$/, '') + p.slice(1);
        lastPath = p;
        found.add(`${m[1]} ${p}`);
      }
    }
    // `pending01`: requested by 08 §9.2 and implemented by its definition, not in the 01 table yet
    const ours = new Set(ROUTES.filter((r) => r.kind !== 'agent-fallback' && !r.pending01).map((r) => `${r.method} ${r.path}`));
    expect([...ours].sort()).toEqual([...found].sort());
    expect(API_PREFIX).toBe('/api/v1');
  });

  it('error codes of §8.6 are all registered', () => {
    const s = section('### 8.6 错误码', '## 9.');
    const codes = new Set([...s.matchAll(/^\| `([A-Z_]+)`(?:、`([A-Z_]+)`)? \|/gm)].flatMap((m) => [m[1], m[2]]).filter(Boolean) as string[]);
    for (const c of codes) expect(Object.keys(ERROR_CODES)).toContain(c);
  });

  it('session event types of §8.4 are all registered', () => {
    const s = section('### 8.4 会话事件类型', '### 8.5');
    for (const line of s.split('\n').filter((l) => l.startsWith('| `'))) {
      const cell = line.split('|')[1]!;
      for (const m of cell.matchAll(/`([a-z_]+\.[a-z_.*]+)`/g)) {
        if (m[1]!.endsWith('*')) continue;
        expect(Object.keys(SESSION_EVENT_TYPES), m[1]).toContain(m[1]);
      }
    }
  });

  it('audit actions of §8.5 are all registered', () => {
    const s = section('### 8.5 审计动作', '### 8.6');
    const actions = [...s.matchAll(/`([a-z_]+(?:\.[a-z_]+)?)`/g)].map((m) => m[1]!);
    expect(actions.length).toBeGreaterThan(30);
    for (const a of actions) expect(AUDIT_ACTIONS as readonly string[], a).toContain(a);
  });
});
