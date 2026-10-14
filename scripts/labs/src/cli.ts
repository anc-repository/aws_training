#!/usr/bin/env node
/**
 * Card content tools (04 §2.5, §3.5; 05 §8). Root scripts: `npm run labs:<command>`.
 *
 *   schema   write labs/_schema/*.schema.json (lab = 04 §3.3 transcription in @atl/shared; check, quiz, track, taxonomy,
 *            pricing, manual front matter, planned placeholder)
 *   lint     schema + group A / B rules + catalog rules C-1…C-15 + track rules            exit 1 on errors
 *   derive   group C (DRV-1…DRV-11) via scripts/module plan --start-of (reference derivation when unavailable)
 *   build    dist/content/<catalogVersion>/ (catalog index, intros, expanded cards, profiles, manifest)
 *   catalog  write labs/_catalog/catalog.yaml (--check: compare only; --lang ja|en [--out <file>]: print the catalog
 *            resolved to that language instead)
 *   policy   ATLVerifierRole read-only actions of the content (--out <file>, default: print)
 *   i18n     translation coverage per card (ja, en; 09 §2.3) and the translation rules I1–I5     exit 1 on errors
 *            (--min ja=100,en=100: also when a card is below the coverage threshold; --only startable: skip planned cards;
 *            --quiet: totals and issues only)
 *
 * Options: --labs <dir> (default <repo>/labs), --card <id>[,<id>] (derive), --deriver auto|cli|reference,
 *          --catalog-version <v> and --out <dir> (build), --json (machine-readable issues), --warnings-as-errors
 */
import fs from 'node:fs';
import path from 'node:path';
import { isContentLang } from '@atl/shared';
import { buildContent } from './build.js';
import { loadContent, type LintIssue } from './content.js';
import { deriveAll, type DeriverMode } from './derive/index.js';
import { CONTENT_LANGS, SOURCE_LANG } from './l10n.js';
import { lintTranslations, translationCoverage } from './lint/i18n.js';
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

/** `--min ja=100,en=100` → { ja: 100, en: 100 }; {} when absent; null when malformed. */
export function parseMin(v: string | undefined): Record<string, number> | null {
  if (v === undefined) return {};
  const out: Record<string, number> = {};
  for (const part of v.split(',').filter(Boolean)) {
    const m = /^(ja|en)=(\d{1,3})$/.exec(part.trim());
    if (!m || Number(m[2]) > 100) return null;
    out[m[1]!] = Number(m[2]);
  }
  return out;
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
      const lang = opt('--lang') ?? SOURCE_LANG;
      if (!isContentLang(lang)) {
        console.error(`--lang must be one of ${CONTENT_LANGS.join(', ')}`);
        return 2;
      }
      if (lang !== SOURCE_LANG) {
        // the committed catalog.yaml is zh-CN (the source); other languages are printed or written to --out only
        const text = renderCatalogYaml(loadContent(paths, { lang }));
        const out = opt('--out');
        if (out) fs.writeFileSync(path.resolve(out), text);
        else process.stdout.write(text);
        return 0;
      }
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
    case 'i18n': {
      const set = loadContent(paths);
      // --only startable: cards that can be started (status ≠ planned) and the shared documents (_catalog, _tracks, _shared)
      const planned = new Set(set.cards.filter((c) => c.planned).map((c) => c.id));
      const only = opt('--only');
      if (only && only !== 'startable') {
        console.error('--only must be "startable"');
        return 2;
      }
      const rows = translationCoverage(set).filter((r) => only !== 'startable' || !planned.has(r.card));
      const issues = [...lintTranslations(set)];
      // --min ja=100,en=100: fail (exit 1) when a card's field or manual coverage of a language is below the threshold (CI, 09 §2.3)
      const min = parseMin(opt('--min'));
      if (min === null) {
        console.error('--min takes <lang>=<percent>[,<lang>=<percent>] with lang ja or en, e.g. --min ja=100,en=100');
        return 2;
      }
      for (const r of rows) {
        for (const [l, want] of Object.entries(min)) {
          const fields = r.fields ? ((r.translated[l] ?? 0) / r.fields) * 100 : 100;
          const manuals = r.manuals ? ((r.manualsTranslated[l] ?? 0) / r.manuals) * 100 : 100;
          if (fields < want) issues.push({ card: r.card, rule: 'I-COV', severity: 'error', message: `${l}: ${r.translated[l] ?? 0} / ${r.fields} text field(s) translated (${Math.floor(fields)}% < ${want}%)` });
          if (manuals < want) issues.push({ card: r.card, rule: 'I-COV', severity: 'error', message: `${l}: ${r.manualsTranslated[l] ?? 0} / ${r.manuals} manual file(s) translated (${Math.floor(manuals)}% < ${want}%)` });
        }
      }
      if (flag('--json')) {
        process.stdout.write(`${JSON.stringify({ coverage: rows, issues }, null, 2)}
`);
      } else {
        const pct = (n: number, d: number) => (d ? `${Math.round((n / d) * 100)}%` : '—').padStart(5);
        console.log(`${'card'.padEnd(28)} ${'fields'.padStart(6)}    ja    en  manuals    ja    en`);
        for (const r of flag('--quiet') ? [] : rows) {
          console.log(`${r.card.padEnd(28)} ${String(r.fields).padStart(6)} ${pct(r.translated.ja ?? 0, r.fields)} ${pct(r.translated.en ?? 0, r.fields)}  ${String(r.manuals).padStart(7)} ${pct(r.manualsTranslated.ja ?? 0, r.manuals)} ${pct(r.manualsTranslated.en ?? 0, r.manuals)}`);
        }
        const sum = (f: (r: (typeof rows)[number]) => number) => rows.reduce((a, r) => a + f(r), 0);
        const fields = sum((r) => r.fields);
        const manuals = sum((r) => r.manuals);
        console.log(`${'total'.padEnd(28)} ${String(fields).padStart(6)} ${pct(sum((r) => r.translated.ja ?? 0), fields)} ${pct(sum((r) => r.translated.en ?? 0), fields)}  ${String(manuals).padStart(7)} ${pct(sum((r) => r.manualsTranslated.ja ?? 0), manuals)} ${pct(sum((r) => r.manualsTranslated.en ?? 0), manuals)}`);
        for (const i of issues) console.log(`${i.severity === 'error' ? '✗' : '!'} ${i.card} [${i.rule}] ${i.message}`);
      }
      return issues.some((i) => i.severity === 'error') ? 1 : 0;
    }
    default:
      console.error('usage: atl-labs <schema|lint|derive|build|catalog|policy|i18n> [--labs <dir>] [--card <id>] [--deriver auto|cli|reference] [--out <path>] [--catalog-version <v>] [--lang <ja|en>] [--min ja=<n>,en=<n>] [--only startable] [--json] [--check]');
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
