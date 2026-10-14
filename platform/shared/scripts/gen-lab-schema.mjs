// Regenerates src/lab/lab-schema.generated.ts from the YAML block in docs/platform/04-lab-format-checks-reports.md §3.3.
// Usage: node platform/shared/scripts/gen-lab-schema.mjs  (test/lab-schema.test.ts checks that the two stay identical)
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import YAML from 'yaml';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DOC = path.resolve(HERE, '../../../docs/platform/04-lab-format-checks-reports.md');
const OUT = path.resolve(HERE, '../src/lab/lab-schema.generated.ts');

const md = fs.readFileSync(DOC, 'utf8');
const start = md.indexOf('### 3.3 JSON Schema');
const a = md.indexOf('```yaml\n', start) + '```yaml\n'.length;
const schema = YAML.parse(md.slice(a, md.indexOf('\n```', a)), { version: '1.2' });

const head = fs.readFileSync(OUT, 'utf8').split('export const LAB_SCHEMA_V2')[0];
fs.writeFileSync(OUT, `${head}export const LAB_SCHEMA_V2: Readonly<Record<string, unknown>> = ${JSON.stringify(schema, null, 2)};\n`);
console.log(`wrote ${path.relative(process.cwd(), OUT)}`);
