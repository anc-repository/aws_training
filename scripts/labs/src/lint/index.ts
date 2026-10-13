/**
 * `labs:lint` (04 §3.5 groups A and B, 05 §8.7 C-1…C-15, tracks-and-catalog §7.3): schema validation with ajv plus the
 * cross-field / cross-file rules. Group C (start-state derivation) is `labs:derive`.
 */
import { buildCatalog, CATALOG_HEADER, readCommittedCatalog } from '../catalog.js';
import { loadContent, type ContentSet, type LintIssue } from '../content.js';
import type { LabsPaths } from '../paths.js';
import { loadCheckCatalogue, loadRules } from '../registry.js';
import { stringifyYaml } from '../yaml.js';
import { lintCard, type LintContext } from './card.js';
import { lintCatalog } from './catalog.js';

export interface LintResult {
  set: ContentSet;
  cards: string[];
  issues: LintIssue[];
}

export function renderCatalogYaml(set: ContentSet): string {
  return stringifyYaml(buildCatalog(set), CATALOG_HEADER);
}

export async function lintContent(set: ContentSet, opts: { checkCatalog?: boolean } = {}): Promise<LintResult> {
  const ctx: LintContext = { set, rules: loadRules(set.paths), checkCatalogue: await loadCheckCatalogue(set.paths) };
  const issues: LintIssue[] = [...set.issues];
  for (const card of set.cards) issues.push(...lintCard(ctx, card));
  let generatedCatalog: string | undefined;
  if (opts.checkCatalog !== false) {
    try {
      generatedCatalog = renderCatalogYaml(set);
    } catch (e) {
      issues.push({ card: '_catalog', rule: 'C-2', severity: 'error', message: `catalog cannot be generated: ${e instanceof Error ? e.message : String(e)}` });
    }
  }
  issues.push(...lintCatalog(set, generatedCatalog !== undefined ? { generatedCatalog, committedCatalog: readCommittedCatalog(set) } : {}));
  return { set, cards: set.cards.map((c) => c.id), issues };
}

export async function lintLabs(paths: LabsPaths, opts: { checkCatalog?: boolean } = {}): Promise<LintResult> {
  return lintContent(loadContent(paths), opts);
}
