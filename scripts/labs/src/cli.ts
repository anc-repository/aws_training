#!/usr/bin/env node
/**
 * Card content tools (04 §2.5, §3.5; 05 §8). Root scripts: `npm run labs:<command>`.
 *
 *   schema   write labs/_schema/*.schema.json (lab = 04 §3.3 transcription in @atl/shared; check, quiz, track, taxonomy,
 *            pricing, manual front matter, planned placeholder)
 *   lint     schema + group A / B rules + catalog rules C-1…C-15 + track rules            exit 1 on errors
 *   derive   group C (DRV-1…DRV-11) via scripts/module plan --start-of (reference derivation when unavailable)
 *   build    dist/content/<catalogVersion>/ (catalog index, intros, expanded cards, profiles, manifest)
 *   catalog  write labs/_catalog/catalog.yaml (--check: compare only)
 *   policy   ATLVerifierRole read-only actions of the content (--out <file>, default: print)
 *
 * Options: --labs <dir> (default <repo>/labs), --card <id>[,<id>] (derive), --deriver auto|cli|reference,
 *          --catalog-version <v> and --out <dir> (build), --json (machine-readable issues), --warnings-as-errors
 */
import fs from 'node:fs';
import path from 'node:path';
import { buildContent } from './build.js';
import { loadContent, type LintIssue } from './content.js';
import { deriveAll, type DeriverMode } from './derive/index.js';
import { lintContent, renderCatalogYaml } from './lint/index.js';
import { labsPaths } from './paths.js';
import { verifierPolicy } from './policy.js';
import { SCHEMA_FILES, schemaObject, type SchemaName } from './schemas/index.js';

function opt(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i > 0 && process.argv[i + 1] && !process.argv[i + 1]!.startsWith('--') ? process.argv[i + 1] : undefined;
}

const flag = (name: string) => process.argv.includes(name);

export function writeSchemas(labsDir: string): string[] {
  const dir = path.join(labsDir, '_schema');
  fs.mkdirSync(dir, { recursive: true });
  return (Object.keys(SCHEMA_FILES) as SchemaName[]).map((name) => {
    const file = path.join(dir, SCHEMA_FILES[name]);
    fs.writeFileSync(file, `${JSON.stringify(schemaObject(name), null, 2)}\n`);
    return file;
  });
}

function report(issues: readonly LintIssue[], label: string, cards: number): number {
  const asErrors = flag('--warnings-as-errors');
  if (flag('--json')) {
    process.stdout.write(`${JSON.stringify({ cards, issues }, null, 2)}\n`);
  } else {
    for (const i of issues) console.log(`${i.severity === 'error' ? '✗' : '!'} ${i.card} [${i.rule}] ${i.message}`);
  }
  const errors = issues.filter((i) => i.severity === 'error' || asErrors).length;
  console.error(`${label}: ${cards} card(s), ${issues.filter((i) => i.severity === 'error').length} error(s), ${issues.filter((i) => i.severity === 'warn').length} warning(s)`);
  return errors > 0 ? 1 : 0;
}

async function main(): Promise<number> {
  const cmd = process.argv[2];
  const paths = labsPaths(opt('--labs'));
  const deriver = (opt('--deriver') ?? 'auto') as DeriverMode;
  if (!['auto', 'cli', 'reference'].includes(deriver)) {
    console.error('--deriver must be auto, cli or reference');
    return 2;
  }
  switch (cmd) {
    case 'schema': {
      for (const f of writeSchemas(paths.labs)) console.log(`wrote ${path.relative(process.cwd(), f)}`);
      return 0;
    }
    case 'lint': {
      const r = await lintContent(loadContent(paths));
      return report(r.issues, 'labs:lint', r.cards.length);
    }
    case 'derive': {
      const set = loadContent(paths);
      const only = opt('--card')?.split(',');
      const r = await deriveAll(set, deriver, only);
      if (!flag('--json')) {
        for (const c of r.cards) {
          for (const v of c.variants) {
            const p = v.plan;
            console.log(
              `${c.card} [${v.variant}] ${p ? `${p.deriver} ${p.digest.slice(0, 19)}… start=${p.start.filter((e) => e.basis !== 'base').map((e) => `${e.kind === 'module' ? '' : `${e.kind}:`}${e.id}`).join(',') || '—'} https=${p.platform['preview.directHttps']} class=${v.provisionClass ?? '?'} tier=${v.cost?.required ?? '?'}/${v.cost?.withOptional ?? '?'}` : 'no plan'}`,
            );
          }
        }
      }
      return report(r.issues, `labs:derive (${r.deriver})`, r.cards.length);
    }
    case 'build': {
      const set = loadContent(paths);
      const lint = await lintContent(set);
      const lintErrors = lint.issues.filter((i) => i.severity === 'error');
      if (lintErrors.length && !flag('--force')) {
        report(lint.issues, 'labs:build (lint)', lint.cards.length);
        console.error('labs:build: fix the lint errors first (or pass --force)');
        return 1;
      }
      const r = await buildContent(set, { ...(opt('--out') ? { outDir: opt('--out')! } : {}), ...(opt('--catalog-version') ? { catalogVersion: opt('--catalog-version')! } : {}), deriver });
      const code = report(r.issues, `labs:build (${r.deriver})`, set.cards.length);
      console.error(`labs:build: ${r.files} file(s) → ${path.relative(process.cwd(), r.dir)} (catalogVersion ${r.catalogVersion}, contentDigest ${r.contentDigest})`);
      return code;
    }
    case 'catalog': {
      const set = loadContent(paths);
      const text = renderCatalogYaml(set);
      if (flag('--check')) {
        const current = fs.existsSync(paths.catalog) ? fs.readFileSync(paths.catalog, 'utf8').replace(/\r\n/g, '\n') : null;
        if (current !== text) {
          console.error('labs:catalog --check: labs/_catalog/catalog.yaml is stale (run npm run labs:catalog)');
          return 1;
        }
        console.error('labs:catalog --check: up to date');
        return 0;
      }
      fs.mkdirSync(path.dirname(paths.catalog), { recursive: true });
      fs.writeFileSync(paths.catalog, text);
      console.error(`wrote ${path.relative(process.cwd(), paths.catalog)}`);
      return 0;
    }
    case 'policy': {
      const r = verifierPolicy(loadContent(paths));
      for (const x of r.rejected) console.error(`✗ ${x.card} [A8] ${x.check}: ${x.action} is not in the 04 §5.7 whitelist`);
      const out = opt('--out');
      const text = `${JSON.stringify(r.document, null, 2)}\n`;
      if (out) {
        fs.mkdirSync(path.dirname(path.resolve(out)), { recursive: true });
        fs.writeFileSync(path.resolve(out), text);
        console.error(`wrote ${out} (${r.iamActions.length} IAM action(s))`);
      } else process.stdout.write(text);
      return r.rejected.length ? 1 : 0;
    }
    default:
      console.error('usage: atl-labs <schema|lint|derive|build|catalog|policy> [--labs <dir>] [--card <id>] [--deriver auto|cli|reference] [--out <path>] [--catalog-version <v>] [--json] [--check]');
      return 2;
  }
}

if (process.argv[1] && /cli\.(ts|js)$/.test(process.argv[1])) {
  main().then(
    (code) => {
      process.exitCode = code;
    },
    (e: unknown) => {
      console.error(e instanceof Error ? (e.stack ?? e.message) : String(e));
      process.exitCode = 2;
    },
  );
}
