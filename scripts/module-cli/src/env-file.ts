/**
 * dotenv-style files written to /etc/cloudalbum (modules.d/<id>.env, cloudalbum.env) and profile files.
 * Same grammar as backend/src/config/load-env.ts parseEnvFile: KEY=value, `#` comments, `export ` prefix,
 * single / double quotes, ` #` trailing comments on unquoted values, no variable expansion.
 */
export type EnvMap = Record<string, string>;

export function parseEnvFile(text: string): EnvMap {
  const out: EnvMap = {};
  for (const rawLine of text.replace(/^\uFEFF/, '').split(/\r?\n/)) {
    let line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    if (line.startsWith('export ')) line = line.slice(7).trim();
    const eq = line.indexOf('=');
    if (eq <= 0) continue;
    const key = line.slice(0, eq).trim();
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) continue;
    let value = line.slice(eq + 1).trim();
    if (value.startsWith('"')) {
      const end = closingQuote(value);
      value = value.slice(1, end).replace(/\\(n|r|t|"|\\)/g, (_m, c: string) => ({ n: '\n', r: '\r', t: '\t', '"': '"', '\\': '\\' })[c] ?? c);
    } else if (value.startsWith("'")) {
      const end = value.indexOf("'", 1);
      value = value.slice(1, end === -1 ? undefined : end);
    } else {
      const hash = value.search(/\s#/);
      if (hash !== -1) value = value.slice(0, hash).trim();
    }
    out[key] = value;
  }
  return out;
}

function closingQuote(v: string): number {
  for (let i = 1; i < v.length; i += 1) {
    if (v[i] === '\\') { i += 1; continue; }
    if (v[i] === '"') return i;
  }
  return v.length;
}

/** Quote a value only when needed (spaces, #, quotes, empty is written as KEY=). */
export function formatEnvValue(value: string): string {
  if (value === '') return '';
  if (/^[A-Za-z0-9_@%+=:,./\-[\]()*]+$/.test(value) && !value.includes(' #')) return value;
  return `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n')}"`;
}

export interface RenderEnvOptions {
  header?: string[];
  /** Keys rendered first, in this order */
  order?: string[];
}

export function renderEnvFile(env: EnvMap, opts: RenderEnvOptions = {}): string {
  const lines: string[] = [];
  for (const h of opts.header ?? []) lines.push(`# ${h}`);
  const seen = new Set<string>();
  for (const k of [...(opts.order ?? []), ...Object.keys(env)]) {
    if (seen.has(k) || !(k in env)) continue;
    seen.add(k);
    lines.push(`${k}=${formatEnvValue(env[k] ?? '')}`);
  }
  return `${lines.join('\n')}\n`;
}

/**
 * KEY=VALUE pairs from repeated CLI options (--set A=1 --set B=2) or comma lists (A=1,B=2). A comma segment without
 * `=` belongs to the previous value, so list values survive: `AppOrigins=a,b,X=1` -> { AppOrigins: 'a,b', X: '1' }.
 */
export function parseAssignments(items: readonly string[] | undefined, what = 'assignment'): EnvMap {
  const out: EnvMap = {};
  for (const item of items ?? []) {
    let last: string | undefined;
    for (const part of item.split(',')) {
      const eq = part.indexOf('=');
      if (eq <= 0 || !/^[A-Za-z_][A-Za-z0-9_.]*$/.test(part.slice(0, eq).trim())) {
        if (last === undefined) {
          if (!part.trim()) continue;
          throw new Error(`invalid ${what} "${part}" (expected KEY=VALUE)`);
        }
        out[last] = `${out[last]},${part.trim()}`;
        continue;
      }
      last = part.slice(0, eq).trim();
      out[last] = part.slice(eq + 1).trim();
    }
  }
  return out;
}

export function splitList(value: string | undefined): string[] {
  return (value ?? '').split(',').map((s) => s.trim()).filter(Boolean);
}
