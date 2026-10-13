/**
 * Single-card rules of `labs:lint` (04 §3.5 group A, 1–20) for startable cards, and the metadata subset for catalog
 * placeholders (`status: planned`). Group B and the catalog / track rules are in `catalog.ts`.
 */
import fs from 'node:fs';
import path from 'node:path';
import type { LabStep, LabV2, ProvisionItem, TargetModule } from '@atl/shared';
import { BASE_ALLOWLIST, DR_REGION_SERVICES, FORBIDDEN_IAM_ACTIONS, GLOBAL_SERVICES, iamActionOf, isAllowed } from '../allowlist.js';
import { checkUses, dependenciesOf, effectiveDrift, isRequiredUse, refFromOwner, resolveRef, SHARED_CHECK_ALIASES, type CheckUse } from '../checks.js';
import { CONSOLE_LINKS_03, isRegisteredConsoleLink } from '../console-links.js';
import type { CardContent, CheckDef, ContentSet, LintIssue, Severity } from '../content.js';
import { parseVariable, VARIABLE_FILTERS, VARIABLE_NAMESPACES, type ParsedManual } from '../manual.js';
import {
  isInfraModule,
  loadExperimentManifest,
  loadRegistry,
  localDrivers,
  type CheckBundleCatalogue,
  type RuleLevel,
} from '../registry.js';
import { validateWith } from '../schemas/index.js';

export interface LintContext {
  set: ContentSet;
  rules: Map<string, RuleLevel>;
  checkCatalogue: CheckBundleCatalogue;
}

/** 04 §4.3 directives. */
export const DIRECTIVES = {
  container: new Set(['why', 'tip', 'warning', 'danger', 'method', 'expected', 'wait', 'reveal', 'saa', 'code-ref']),
  leaf: new Set(['check', 'checks', 'console-link', 'open-tab', 'var-input', 'platform-action', 'experiment', 'include']),
  text: new Set(['kbd', 'term']),
} as const;

/** 04 §3.5 A13: external links allowed in manuals. */
export const LINK_ALLOWLIST = [/^https:\/\/docs\.aws\.amazon\.com\//, /^https:\/\/aws\.amazon\.com\//];

/** 02 / 01: platform hard limit of `retain.maxHours` (MaxKeepHours hard cap). */
export const RETAIN_HARD_MAX_HOURS = 72;

const SECRET_NAME = /(SECRET|PASSWORD|TOKEN|PRIVATE|_KEY)$/i;

export function lintCard(ctx: LintContext, card: CardContent): LintIssue[] {
  const issues: LintIssue[] = [];
  const add = (rule: string, message: string, severity: Severity = 'error') => issues.push({ card: card.id, rule, severity, message });

  // ---- A1: schema, id, kind, title, module, modules.target
  const schemaIssues = validateWith(card.planned ? 'lab-planned' : 'lab', card.raw);
  if (schemaIssues.length) {
    for (const i of schemaIssues.slice(0, 30)) add('A1', `schema${card.planned ? ' (planned)' : ''}: ${i.path}: ${i.message}`);
    return issues;
  }
  const lab = card.lab;
  if (lab.id !== card.id) add('A1', `id ${lab.id} differs from the directory name ${card.id}`);
  const expectedKind = lab.id.startsWith('svc-') ? 'service' : 'scenario';
  if (lab.kind !== expectedKind) add('A1', `kind ${lab.kind} does not match the id prefix (${expectedKind})`);
  if (lab.kind === 'service' && lab.title !== `${lab.service}：${lab.function}`) add('A1', `title must be "<service>：<function>" = "${lab.service}：${lab.function}"`);
  const registry = loadRegistry(ctx.set.paths).modules;
  if (lab.kind === 'service') {
    const mod = lab.id.slice(4);
    if (!registry[mod]) add('A1', `svc-${mod}: module ${mod} does not exist in modules/registry.yaml`);
  }
  const target = [...lab.modules.target].sort();
  const tm = [...new Set((lab.targetModules ?? []).map((t) => t.id))].sort();
  if (JSON.stringify(target) !== JSON.stringify(tm)) add('A1', `modules.target [${target}] must equal targetModules[].id [${tm}]`);
  for (const m of [...lab.modules.target, ...lab.modules.start, ...(lab.modules.context ?? []), ...(lab.modules.related ?? [])]) {
    if (!registry[m]) add('A1', `modules: ${m} is not a module of modules/registry.yaml`);
  }

  lintStartProfile(ctx, card, add);
  lintTime(lab, add);
  lintIntroAndBadge(card, add);
  lintServicesAndTargets(ctx, lab, add);

  if (card.planned) return issues;

  lintManuals(ctx, card, add);
  lintWire(ctx, card, add);
  lintChecks(ctx, card, add);
  lintOnce(ctx, card, add);
  lintExperiments(ctx, card, add);
  lintVariables(ctx, card, add);
  lintCost(ctx, lab, add);
  lintPermissions(lab, add);
  lintQuiz(card, add);
  lintLearnerInputs(card, add);
  lintExtraStacks(card, add);
  return issues;
}

type Add = (rule: string, message: string, severity?: Severity) => void;

// ---------------------------------------------------------------------------------------------------------------
// A4 / A5 / A6: start profile

function lintStartProfile(ctx: LintContext, card: CardContent, add: Add): void {
  const lab = card.lab;
  const sp = lab.startProfile;
  if (!sp) {
    if (!card.planned) add('A4', 'startProfile is required');
    return;
  }
  const all: { variant: string; provisions: ProvisionItem[]; https: string | undefined; targets: TargetModule[] }[] = [
    { variant: 'default', provisions: sp.provisions, https: sp.platform?.preview?.directHttps, targets: lab.targetModules ?? [] },
    ...(sp.variants ?? []).map((v) => ({
      variant: v.id,
      provisions: v.provisions,
      https: (v.platform ?? sp.platform)?.preview?.directHttps,
      targets: v.targetModules ?? lab.targetModules ?? [],
    })),
  ];
  for (const v of all) {
    const tag = v.variant === 'default' ? '' : ` [variant ${v.variant}]`;
    // A4: kind: module entries ↔ modules.start ∪ modules.context (default variant only; variants may differ)
    if (v.variant === 'default') {
      const mods = new Set(v.provisions.filter((p) => p.kind === 'module').map((p) => p.item));
      const declared = new Set([...lab.modules.start, ...(lab.modules.context ?? [])]);
      for (const m of mods) if (!declared.has(m)) add('A4', `provision module ${m} is missing from modules.start / modules.context`);
      for (const m of declared) if (!mods.has(m)) add('A4', `modules.start / context lists ${m} but startProfile.provisions has no kind: module entry for it`);
      for (const m of lab.modules.context ?? []) {
        const p = v.provisions.find((x) => x.item === m && x.kind === 'module');
        if (p && p.basis !== 'context') add('A4', `modules.context ${m}: its provision must have basis: context`);
      }
    }
    for (const p of v.provisions) {
      if (p.basis === 'context' && lab.kind !== 'scenario') add('A4', `basis: context (background module ${p.item}) is only allowed on scenario cards${tag}`);
    }
    const previewItem = v.provisions.some((p) => p.kind === 'platform' && p.item === 'preview-direct-https');
    if (v.https === 'on' && !previewItem) add('A4', `startProfile.platform.preview.directHttps is on: list the preview-direct-https platform item for the learner${tag}`);
    // A5: C3 iam rule
    const iam = v.provisions.find((p) => p.item === 'iam' && p.kind === 'module');
    if (lab.id === 'svc-ec2' || lab.id === 'svc-iam') {
      if (iam) add('A5', `${lab.id} must not pre-provision iam${tag}`);
    } else if (!iam || iam.basis !== 'credential' || String(iam.set?.IAM_CREDENTIALS) !== 'role') {
      add('A5', `startProfile.provisions must contain { item: iam, kind: module, basis: credential, set: { IAM_CREDENTIALS: role } }${tag}`);
    }
    // A6: scheme B off when autoscaling / tls are involved; warn for private networks
    const startMods = new Set(v.provisions.filter((p) => p.kind === 'module').map((p) => p.item));
    const targetMods = new Set(v.targets.map((t) => t.id));
    if ((startMods.has('autoscaling') || targetMods.has('autoscaling') || targetMods.has('tls')) && v.https !== 'off') {
      add('A6', `start state or targets contain autoscaling / tls: startProfile.platform.preview.directHttps must be off (ASG-014, C5)${tag}`);
    }
    if (v.targets.some((t) => t.id === 'network' && t.driver === 'private') && v.https !== 'off') add('A6', `a target moves network to private: directHttps should be off${tag}`, 'warn');
  }
}

// ---------------------------------------------------------------------------------------------------------------
// A16 time, A18 intro / badge, B21 / B22

function lintTime(lab: LabV2, add: Add): void {
  if (lab.timeLimitMinutes < lab.estimatedMinutes * 1.5) add('A16', `timeLimitMinutes ${lab.timeLimitMinutes} < estimatedMinutes × 1.5 (${lab.estimatedMinutes * 1.5})`);
  if ((lab.retain?.maxHours ?? 0) > RETAIN_HARD_MAX_HOURS) add('A16', `retain.maxHours ${lab.retain.maxHours} exceeds the platform hard limit ${RETAIN_HARD_MAX_HOURS}`);
  if (lab.cost?.tier === 'high' && (lab.retain?.maxHours ?? 0) > 12) add('A16', 'cost tier high: retain.maxHours ≤ 12 is recommended (04 §3.2.1)', 'warn');
  const waits = (lab.steps ?? []).reduce((n, s) => n + (s.wait?.maxMinutes ?? 0), 0);
  if (waits > lab.timeLimitMinutes / 2) add('A16', `sum of steps[].wait.maxMinutes (${waits}) exceeds 50% of timeLimitMinutes`, 'warn');
}

function lintIntroAndBadge(card: CardContent, add: Add): void {
  const lab = card.lab;
  if (lab.difficulty === 'intro' && ((lab.targetModules ?? []).length || lab.modules.start.length)) {
    add('A18', 'difficulty intro is only for cards without target modules and without start-state modules');
  }
  if (lab.badge?.icon && !fs.existsSync(path.join(card.dir, lab.badge.icon))) add('A18', `badge.icon ${lab.badge.icon} does not exist`);
}

function lintServicesAndTargets(ctx: LintContext, lab: LabV2, add: Add): void {
  const services = lab.services ?? [];
  const targets = lab.targetModules ?? [];
  if (lab.kind === 'service') {
    const primary = services.filter((s) => s.role === 'primary');
    const mod = lab.id.slice(4);
    if (primary.length !== 1) add('B21', `service card: exactly one primary service (found ${primary.length})`);
    else if (primary[0]!.module !== mod) add('B21', `service card: the primary service's module must be ${mod} (found ${primary[0]!.module ?? 'none'})`);
    const required = targets.filter((t) => !t.optional);
    const expectedTargets = lab.id === 'svc-ec2' ? 0 : 1;
    if (required.length !== expectedTargets) add('B22', `service card: exactly ${expectedTargets} non-optional target module(s) (found ${required.length})`);
    if (lab.id !== 'svc-ec2' && required[0] && required[0].id !== mod) add('B22', `service card svc-${mod}: the target module must be ${mod}`);
  } else {
    const ps = services.filter((s) => s.role === 'primary' || s.role === 'supporting');
    if (ps.length < 2) add('B21', `scenario card: primary + supporting services ≥ 2 (found ${ps.length})`);
    const required = targets.filter((t) => !t.optional);
    if (required.length < 1 || required.length > 5) add('B22', `scenario card: 1–5 non-optional targets (found ${required.length})`);
    const credited = services.filter((s) => (s.creditBy ?? []).length).length;
    if (required.length + credited < 2) add('B22', 'scenario card: non-optional targets + services with creditBy ≥ 2');
  }
  for (const t of targets) {
    const sw = loadRegistry(ctx.set.paths).modules[t.id]?.switch;
    if (!sw) continue;
    if (sw.kind !== 'param' && sw.values && !sw.values.includes(t.driver)) add('A1', `targetModules ${t.id}: driver ${t.driver} is not a value of ${sw.var} (${sw.values.join(', ')})`);
  }
}

// ---------------------------------------------------------------------------------------------------------------
// A2 / A13: manuals

function stepOfManual(lab: LabV2): Map<string, LabStep> {
  return new Map((lab.steps ?? []).map((s) => [s.manual, s]));
}

function lintManuals(ctx: LintContext, card: CardContent, add: Add): void {
  const lab = card.lab;
  const byManual = stepOfManual(lab);
  const seen = new Map<string, string>();
  for (const s of lab.steps) {
    const m = card.manuals.get(s.manual);
    if (!m) add('A2', `step ${s.id}: manual file ${s.manual} does not exist`);
    else if (m.frontMatter?.step !== s.id) add('A2', `${s.manual}: front matter step must be ${s.id} (found ${String(m.frontMatter?.step ?? m.frontMatter?.section ?? 'none')})`);
    const other = seen.get(s.manual);
    if (other) add('A2', `steps ${other} and ${s.id} share the manual file ${s.manual}`);
    seen.set(s.manual, s.id);
  }
  const ids = lab.steps.map((s) => s.id);
  for (const d of ids.filter((x, i) => ids.indexOf(x) !== i)) add('A2', `duplicate step id ${d}`);
  const sections = new Set<string>();
  for (const [file, m] of card.manuals) {
    for (const e of m.errors) add('A13', `${file}:${e.line}: ${e.message}`);
    const fmIssues = validateWith('manual-frontmatter', m.frontMatter ?? {});
    if (!m.frontMatter) add('A2', `${file}: front matter (--- step: … --- or --- section: … ---) is missing`);
    else if (fmIssues.length) add('A2', `${file}: front matter: ${fmIssues.map((i) => `${i.path} ${i.message}`).join('; ')}`);
    if (typeof m.frontMatter?.section === 'string') sections.add(m.frontMatter.section);
    if (m.frontMatter?.step && !byManual.has(file)) add('A2', `${file} is a step file (step: ${String(m.frontMatter.step)}) but no step references it`);
    lintManualBody(ctx, card, file, m, byManual.get(file) ?? null, add);
  }
  if (!sections.has('overview')) add('C-12', 'manual/00-overview.md (section: overview) is missing');
  for (const s of ['wrap-up', 'cleanup']) if (!sections.has(s)) add('A2', `manual section ${s} is missing (04 §2.1)`, 'warn');
  const overview = [...card.manuals.values()].find((m) => m.frontMatter?.section === 'overview');
  if (overview) {
    const h2 = overview.headings.filter((h) => h.depth === 2).map((h) => h.text);
    if (!h2.includes('背景')) add('C-12', '00-overview.md must have “## 背景”');
    if (!h2.includes('对比实验预告')) add('C-12', '00-overview.md must have “## 对比实验预告”');
    if (lab.kind === 'scenario' && !h2.includes('为什么组合在一起')) add('C-12', 'scenario card: 00-overview.md must have “## 为什么组合在一起”');
    const h3 = overview.headings.filter((h) => h.depth === 3).map((h) => h.text);
    for (const e of (lab.experiments ?? []).filter((x) => x.required)) {
      if (!h3.some((t) => t.includes(`${e.module}/${e.id}`))) add('C-12', `00-overview.md: “## 对比实验预告” needs a ### heading containing ${e.module}/${e.id}`);
    }
  }
}

function lintManualBody(ctx: LintContext, card: CardContent, file: string, m: ParsedManual, step: LabStep | null, add: Add): void {
  const lab = card.lab;
  const at = (line: number) => `${file}:${line}`;
  for (const h of m.rawHtml) add('A13', `${at(h.line)}: raw HTML is not allowed (${h.snippet})`);
  for (const d of m.directives) {
    const known = DIRECTIVES[d.kind] as Set<string>;
    if (!known.has(d.name)) {
      add('A13', `${at(d.line)}: directive ${d.kind === 'container' ? ':::' : d.kind === 'leaf' ? '::' : ':'}${d.name} is not in 04 §4.3`);
      continue;
    }
    if (d.name === 'method') {
      const kind = d.attributes.kind;
      if (!['console', 'cli', 'script', 'code'].includes(String(kind))) add('A13', `${at(d.line)}: :::method needs kind=console|cli|script|code`);
      else if (step && step.methods && !step.methods.includes(kind as 'console')) add('A13', `${at(d.line)}: :::method{kind=${String(kind)}} is not listed in step.methods`);
    }
    if (d.name === 'check') {
      const id = String(d.attributes.id ?? '');
      const stepChecks = step ? step.checks.map((r) => (typeof r === 'string' ? r : (r.as ?? r.ref))) : [];
      if (!id) add('A13', `${at(d.line)}: ::check needs id`);
      else if (step && !stepChecks.some((c) => c === id || c.endsWith(`/${id}`))) add('A13', `${at(d.line)}: ::check{id=${id}} is not a check of step ${step.id}`);
    }
    if (d.name === 'console-link') {
      const link = String(d.attributes.link ?? '');
      if (!isRegisteredConsoleLink(link)) add('A13', `${at(d.line)}: ::console-link link=${link} is not in the 03 §5.4 deep-link registry`);
      else {
        const params = CONSOLE_LINKS_03[link]!.params;
        for (const p of params) if (d.attributes[p] === undefined) add('A13', `${at(d.line)}: ::console-link{link=${link}} needs the parameter ${p}`);
        for (const [k, v] of Object.entries(d.attributes)) {
          if (k === 'link') continue;
          if (!params.includes(k)) add('A13', `${at(d.line)}: ::console-link{link=${link}} has no parameter ${k}`);
          else if (typeof v === 'string' && !/^\{\{.*\}\}$/.test(v.trim())) add('A13', `${at(d.line)}: console-link parameters must be §4.4 variables`);
        }
      }
    }
    if (d.name === 'platform-action') {
      const id = String(d.attributes.id ?? '');
      const declared = new Set((lab.platformOps ?? []).map((o) => o.id));
      for (const x of lab.extraStacks ?? []) if (x.deploy.startsWith('step:')) declared.add(`xstk-${x.id}`);
      if (!declared.has(id)) add('A13', `${at(d.line)}: ::platform-action{id=${id}} is not declared in platformOps`);
    }
    if (d.name === 'var-input') {
      const name = String(d.attributes.name ?? '');
      const v = lab.variables?.[name];
      if (!v) add('A12', `${at(d.line)}: ::var-input{name=${name}} is not a declared variable`);
      else if (v.from !== 'input') add('A12', `${at(d.line)}: ::var-input{name=${name}}: the variable is derived, not an input`);
    }
    if (d.name === 'open-tab' && !['terminal-lab', 'terminal-workstation', 'console', 'preview'].includes(String(d.attributes.tab))) add('A13', `${at(d.line)}: ::open-tab tab must be terminal-lab|terminal-workstation|console|preview`);
    if (d.name === 'experiment') {
      const e = (lab.experiments ?? []).find((x) => x.module === d.attributes.module && x.id === d.attributes.id);
      if (!e) add('A11', `${at(d.line)}: ::experiment{module=${String(d.attributes.module)} id=${String(d.attributes.id)}} is not declared in experiments`);
    }
    if (d.name === 'include') add('A13', `${at(d.line)}: ::include needs guides or _shared/snippets, which this content does not ship`, 'warn');
    if (d.name === 'wait') {
      if (!d.attributes.typical || !d.attributes.max) add('A13', `${at(d.line)}: :::wait needs typical and max`);
    }
    if (d.name === 'saa' && !['secure', 'resilient', 'performance', 'cost'].includes(String(d.attributes.domain))) add('A13', `${at(d.line)}: :::saa needs domain=secure|resilient|performance|cost`);
    if (d.name === 'code-ref') {
      const p = String(d.attributes.path ?? '');
      if (!p || !fs.existsSync(path.join(ctx.set.paths.repo, p))) add('A13', `${at(d.line)}: :::code-ref path=${p} does not exist in the repository`);
    }
  }
  for (const c of m.code) {
    const runsOn = c.attributes.runsOn;
    if (runsOn !== undefined && !['workstation', 'lab', 'local', 'cloudshell'].includes(String(runsOn))) add('A13', `${at(c.line)}: code block runsOn must be workstation|lab|local|cloudshell`);
    for (const k of Object.keys(c.attributes)) if (!['runsOn', 'copy', 'vars', 'danger'].includes(k)) add('A13', `${at(c.line)}: unknown code block attribute ${k}`);
  }
  for (const img of m.images) {
    if (!img.src.startsWith('assets/') && !img.src.startsWith('../assets/')) add('A13', `${at(img.line)}: images may only come from assets/ (${img.src})`);
    else if (!fs.existsSync(path.join(card.dir, img.src.replace(/^\.\.\//, '')))) add('A13', `${at(img.line)}: image ${img.src} does not exist`);
  }
  for (const l of m.links) {
    if (/^https?:/.test(l.url) && !LINK_ALLOWLIST.some((re) => re.test(l.url))) add('A13', `${at(l.line)}: external link ${l.url} is not allowed (docs.aws.amazon.com, aws.amazon.com)`);
    if (/^http:/.test(l.url)) add('A13', `${at(l.line)}: plain http link ${l.url}`);
  }
  if (step) {
    // 04 §4.1: required content per step type
    const has = (name: string, kind?: string) => m.directives.some((d) => d.name === name && (kind === undefined || d.attributes.kind === kind));
    if (step.type === 'console' && !has('method', 'console')) add('A13', `${file}: console step needs a :::method{kind=console} block`);
    if (step.type === 'cli' && !m.code.some((c) => c.attributes.runsOn !== undefined)) add('A13', `${file}: cli step needs at least one code block with runsOn`);
    if (step.type === 'script') {
      if (!has('method', 'script')) add('A13', `${file}: script step needs a :::method{kind=script} block`);
      if (!m.code.some((c) => /--dry-run/.test(c.value))) add('A13', `${file}: script step needs a --dry-run preview command`);
    }
    if (step.type === 'code' && !has('code-ref')) add('A13', `${file}: code step needs a :::code-ref block`);
    if (step.type === 'observe' && !has('expected')) add('A13', `${file}: observe step needs an :::expected block`);
    for (const meth of step.methods ?? []) if (!has('method', meth)) add('A13', `${file}: step.methods lists ${meth} but the manual has no :::method{kind=${meth}}`);
    if (step.type === 'experiment' && step.experiment) {
      const cmd = new RegExp(`npm run exp -- ${step.experiment.module} .*--label ${step.experiment.label}\\b.*--scenario ${step.experiment.id}\\b|npm run exp -- ${step.experiment.module} .*--scenario ${step.experiment.id}\\b.*--label ${step.experiment.label}\\b`);
      if (!m.code.some((c) => cmd.test(c.value))) add('A11', `${file}: experiment step needs the runner command npm run exp -- ${step.experiment.module} --label ${step.experiment.label} --scenario ${step.experiment.id} --upload`);
    }
  }
}

// ---------------------------------------------------------------------------------------------------------------
// A3: wire steps

function lintWire(ctx: LintContext, card: CardContent, add: Add): void {
  const lab = card.lab;
  const steps = new Map(lab.steps.map((s) => [s.id, s]));
  const referenced = new Map<string, string>();
  for (const t of lab.targetModules) {
    const w = steps.get(t.wireStep);
    if (!w) {
      add('A3', `target ${t.id}: wireStep ${t.wireStep} is not a step`);
      continue;
    }
    if (!w.wire) add('A3', `target ${t.id}: step ${w.id} must have wire: true`);
    const prev = referenced.get(w.id);
    if (prev) add('A3', `wire step ${w.id} is referenced by targets ${prev} and ${t.id}`);
    referenced.set(w.id, t.id);
    if (t.optional && !w.optional) add('A3', `optional target ${t.id}: its wire step ${w.id} must be optional`);
    // evidence: ① capability (healthy or driver) ② real wiring
    const decls = w.checks
      .map((r) => resolveRef(ctx.set, card, typeof r === 'string' ? r : r.ref))
      .filter((r) => r.ok)
      .map((r) => (r as { ok: true; check: { decl: CheckDef } }).check.decl);
    const capOk = decls.some(
      (d) => d.type === 'capability' && d.module === t.id && (d.assert as { op: string; path: string }[] | undefined)?.some((a) => a.op === 'healthy' || a.path === '$.driver'),
    );
    if (!capOk) add('A3', `wire step ${w.id}: needs a capability check of ${t.id} with op: healthy or a driver assertion`);
    const wired = decls.some(
      (d) =>
        (d.type === 'http-header' && (d.from === 'platform' || d.from === 'lab')) ||
        (d.type === 'local' && (d.checkId === 'http-probe' || d.checkId === 'path-seen')),
    );
    const infraOk = isInfraModule(ctx.set.paths, t.id) && decls.some((d) => d.type === 'local' && d.checkId === 'module-state') && decls.some((d) => d.type === 'aws-readonly' && !!d.ownership);
    // iam is the credential provider: no request path carries an iam segment; the evidence is the credential source the
    // application really uses (local aws-cred-source) plus the module's policy with ownership (implementation-notes)
    const credentialOk = t.id === 'iam' && decls.some((d) => d.type === 'local' && d.checkId === 'aws-cred-source') && decls.some((d) => d.type === 'aws-readonly' && !!d.ownership);
    if (!wired && !infraOk && !credentialOk) add('A3', `wire step ${w.id}: needs evidence of real wiring (http-header from platform|lab, local http-probe / path-seen; infra modules: module-state + aws-readonly with ownership)`);
  }
  for (const s of lab.steps) if (s.wire && !referenced.has(s.id)) add('A3', `step ${s.id} has wire: true but no target references it`);
}

// ---------------------------------------------------------------------------------------------------------------
// A7 / A8 / A10: checks

function stepTypeOf(lab: LabV2, use: CheckUse): string | null {
  return use.stepId ? (lab.steps.find((s) => s.id === use.stepId)?.type ?? null) : null;
}

function lintChecks(ctx: LintContext, card: CardContent, add: Add): void {
  const lab = card.lab;
  const fileIssues = new Set<string>();
  for (const f of card.checkFiles) {
    for (const i of validateWith('check', f.doc)) {
      const k = `${f.file} ${i.path} ${i.message}`;
      if (!fileIssues.has(k)) {
        fileIssues.add(k);
        add('A7', `${f.file}: schema: ${i.path}: ${i.message}`);
      }
    }
  }
  const uses = checkUses(lab);
  const usedLocal = new Set<string>();
  const cardWarnings = new Set(lab.expectedWarnings ?? []);
  for (const w of cardWarnings) {
    const level = ctx.rules.get(w);
    if (!level) add('A10', `expectedWarnings: rule ${w} does not exist in backend/src/rules/rules.ts`);
    else if (level !== 'warn') add('A10', `expectedWarnings: rule ${w} is ${level}-level; only warn rules may be expected`);
  }
  for (const use of uses) {
    if (SHARED_CHECK_ALIASES[use.ref]) add('A7', `${use.ref} is the old name of the shared check ${SHARED_CHECK_ALIASES[use.ref]}`, 'warn');
    const r = resolveRef(ctx.set, card, use.ref);
    if (!r.ok) {
      add('A7', `${use.stepId ? `step ${use.stepId}` : use.where}: ${r.message}`);
      continue;
    }
    if (r.check.origin === 'card') usedLocal.add(use.ref);
    const decl = r.check.decl;
    const required = use.where === 'step' && isRequiredUse(decl, use) && !isOptionalStep(lab, use.stepId);
    if (use.where === 'cleanup' && !(decl.type === 'aws-readonly' && decl.expectError)) add('A7', `cleanup.verify ${use.localId}: only aws-readonly checks with expectError run after the reclaim (04 §3.2.12)`);
    if (required && decl.type === 'http-header' && decl.from === 'browser') add('A8', `required check ${use.localId} uses from: browser`);
    const ew = use.overrides?.expectedWarnings ?? (decl.expectedWarnings as string[] | undefined);
    for (const w of ew ?? []) if (!cardWarnings.has(w)) add('A10', `check ${use.localId}: expectedWarnings ${w} is not in the card-level list`);
    if (decl.type === 'capability' && (decl.assert as { path: string; op: string; value?: unknown }[]).some((a) => a.path === '$.status' && a.op === 'eq' && a.value === 'ok')) {
      add('A10', `check ${use.localId}: { path: $.status, op: eq, value: ok } — use op: healthy (04 §5.3)`, 'warn');
    }
    if (stepTypeOf(lab, use) === 'observe' && decl.type === 'manual' && !(lab.steps.find((s) => s.id === use.stepId)?.checks.length ?? 0)) {
      add('A7', `observe step ${use.stepId} has no checks`);
    }
  }
  // the checks themselves (local definitions + referenced shared ones)
  const declsToCheck = new Map<string, { decl: CheckDef; owner?: string }>();
  for (const [id, c] of card.checks) declsToCheck.set(id, { decl: c });
  for (const use of uses) {
    const r = resolveRef(ctx.set, card, use.ref);
    if (r.ok && r.check.origin !== 'card') declsToCheck.set(use.localId, { decl: r.check.decl, ...(r.check.card ? { owner: r.check.card } : {}) });
  }
  const importedIds = new Set(uses.map((u) => u.localId));
  for (const [id, x] of declsToCheck) lintCheckDecl(ctx, card, id, x.decl, add, x.owner, importedIds);
  for (const id of card.checks.keys()) {
    const referencedByOthers = [...card.checks.values()].some((c) => dependenciesOf(c).includes(id)) || (lab.experiments ?? []).some((e) => (e.corroborateWith ?? []).includes(id));
    if (!usedLocal.has(id) && !referencedByOthers && !uses.some((u) => u.localId === id)) add('A7', `check ${id} is defined but never used`, 'warn');
  }
  for (const [id, p] of card.pitfalls) {
    for (const mt of p.match ?? []) {
      const cid = mt.checkId as string | undefined;
      if (cid && !declsToCheck.has(cid)) add('A7', `pitfall ${id}: match.checkId ${cid} is not a check of this card`);
    }
  }
}

function isOptionalStep(lab: LabV2, stepId: string | null): boolean {
  if (!stepId) return false;
  const s = lab.steps.find((x) => x.id === stepId);
  return !!s?.optional || !!s?.when;
}

function lintCheckDecl(ctx: LintContext, card: CardContent, id: string, d: CheckDef, add: Add, owner?: string, usedIds: Set<string> = new Set()): void {
  const lab = card.lab;
  const ownerCard = owner ? ctx.set.byId.get(owner) : undefined;
  for (const dep of (d.dependsOn as string[] | undefined) ?? []) {
    // a local id of a referenced check (`as` or last segment) is part of the expanded set (04 §2.3)
    if (!owner && usedIds.has(dep)) continue;
    if (!resolveRef(ctx.set, card, refFromOwner(card, owner, dep)).ok) add('A7', `check ${id}: dependsOn ${dep} does not resolve`);
  }
  for (const m of JSON.stringify(d).matchAll(/\{\{\s*\$check\.([a-z][a-z0-9-]*)\./g)) {
    if (!((d.dependsOn as string[] | undefined) ?? []).includes(m[1]!)) add('A7', `check ${id}: {{$check.${m[1]}…}} requires ${m[1]} in dependsOn (04 §5.3)`);
  }
  for (const p of (d.pitfalls as string[] | undefined) ?? []) {
    if (!card.pitfalls.has(p) && !ctx.set.sharedPitfalls.has(p) && !ownerCard?.pitfalls.has(p)) add('A7', `check ${id}: pitfall ${p} is not defined in any checks file`);
  }
  if (d.type === 'aws-readonly') {
    const service = String(d.service);
    const action = String(d.action);
    if (!d.manualFallback) add('A8', `aws-readonly ${id}: manualFallback is required`);
    if (!d.reproduce) add('A8', `aws-readonly ${id}: reproduce is required`);
    if (!BASE_ALLOWLIST[service]) add('A8', `aws-readonly ${id}: service ${service} is not an IAM prefix of the 04 §5.7 whitelist`);
    else if (!isAllowed(service, action)) add('A8', `aws-readonly ${id}: ${service}:${action} is not in the 04 §5.7 read-only whitelist (SDK operation names)`);
    if (FORBIDDEN_IAM_ACTIONS.includes(iamActionOf(service, action))) add('A8', `aws-readonly ${id}: ${iamActionOf(service, action)} is deliberately not granted (04 §5.7)`);
    const region = (d.region as string | undefined) ?? 'app';
    if (GLOBAL_SERVICES.has(service) && region !== 'global' && region !== 'us-east-1') add('A8', `aws-readonly ${id}: ${service} is global; use region: global`, 'warn');
    if (region === 'dr-region') {
      if (!DR_REGION_SERVICES.has(service)) add('A8', `aws-readonly ${id}: region dr-region only allows backup, s3, rds, route53`);
      if (!(lab.regions?.extra ?? []).includes('dr-region')) add('A20', `aws-readonly ${id}: region dr-region needs regions.extra: [dr-region]`);
    }
    if (/^List/.test(action) && d.ownership && !String((d.ownership as { resource: string }).resource).includes('{{')) {
      add('A8', `aws-readonly ${id}: List* returns many resources; ownership needs a resource template (04 §5.2.4)`, 'warn');
    }
    if (action === 'LookupEvents' && ((d.drift as { policy?: string } | undefined)?.policy !== 'once' || !d.wait)) add('A8', `aws-readonly ${id}: LookupEvents checks must be wait-type with drift once (04 §5.9)`);
  }
  if (d.type === 'local' || d.type === 'capability') {
    const checkId = d.type === 'local' ? String(d.checkId) : 'capability-snapshot';
    if (!ctx.checkCatalogue.ids.has(checkId)) add('A8', `check ${id}: checkId ${checkId} is not in the ATL-RunCheck catalogue (04 §6.4)`);
    else if (d.type === 'local') for (const e of ctx.checkCatalogue.validate(checkId, d.args ?? {})) add('A8', `check ${id}: args of ${checkId}: ${e}`);
  }
  for (const c of (d.corroborate as Record<string, unknown>[] | undefined) ?? []) {
    if (c.via === 'local') {
      const cid = String(c.checkId);
      if (!ctx.checkCatalogue.ids.has(cid)) add('A8', `check ${id}: corroboration ${String(c.id)} uses unknown checkId ${cid}`);
      else for (const e of ctx.checkCatalogue.validate(cid, c.args ?? {})) add('A8', `check ${id}: corroboration ${String(c.id)} args of ${cid}: ${e}`);
    }
    if (c.via === 'aws-readonly' && !isAllowed(String(c.service), String(c.action))) add('A8', `check ${id}: corroboration ${String(c.id)} ${String(c.service)}:${String(c.action)} is not whitelisted`);
  }
  if (d.type === 'http-header') {
    const target = String(d.target);
    if (d.from === 'platform' && ['self', 'origin-private', 'cdn-origin'].includes(target)) add('A8', `check ${id}: target ${target} only exists on the lab instance (from: lab)`);
    if (d.from === 'lab' && !['self', 'origin-private', 'cdn-origin', 'cdn', 'tls-domain'].includes(target)) add('A8', `check ${id}: from: lab only reaches self, origin-private, cdn-origin, cdn, tls-domain (04 §5.2.3)`);
  }
  if (d.type === 'experiment') {
    const e = (lab.experiments ?? []).find((x) => x.module === d.module && x.id === d.experiment);
    if (!e) add('A11', `experiment check ${id}: ${String(d.module)}/${String(d.experiment)} is not declared in experiments`);
    else {
      const labels = labelIds(e.labels);
      if (d.label && !labels.includes(String(d.label))) add('A11', `experiment check ${id}: label ${String(d.label)} is not declared for ${e.module}/${e.id}`);
      if (Array.isArray(d.pair)) for (const l of d.pair as string[]) if (!labels.includes(l)) add('A11', `experiment check ${id}: pair label ${l} is not declared`);
    }
  }
}

// ---------------------------------------------------------------------------------------------------------------
// A9: before-state checks are once

function lintOnce(ctx: LintContext, card: CardContent, add: Add): void {
  const lab = card.lab;
  const idx = new Map(lab.steps.map((s, i) => [s.id, i]));
  for (const use of checkUses(lab)) {
    const r = resolveRef(ctx.set, card, use.ref);
    if (!r.ok) continue;
    const d = r.check.decl;
    const stepType = stepTypeOf(lab, use);
    const drift = effectiveDrift(d, use, stepType);
    if (drift === 'once') continue;
    const asserts = (d.assert as { path: string; op: string; value?: unknown }[] | undefined) ?? [];
    for (const t of lab.targetModules) {
      const wire = idx.get(t.wireStep) ?? Number.MAX_SAFE_INTEGER;
      const assertsTarget =
        (d.type === 'capability' && d.module === t.id) ||
        ((d.type === 'http-header' || d.type === 'local') && JSON.stringify(d).includes(`pathSegments.${t.id}`)) ||
        (d.type === 'local' && d.checkId === 'path-seen' && (d.args as { segment?: string } | undefined)?.segment === t.id) ||
        (d.type === 'aws-readonly' && JSON.stringify(d).includes(`stack.${t.id}.`));
      // ① before the target's wire step and about the target
      if (use.where === 'step' && use.stepIndex < wire && assertsTarget) {
        const step = lab.steps[use.stepIndex]!;
        const afterWire = (step.requires?.steps ?? []).includes(t.wireStep);
        if (!afterWire) add('A9', `check ${use.localId} (step ${use.stepId}) describes ${t.id} before its wire step ${t.wireStep}: drift must be once`);
      }
      // ② asserts the start / local driver or status off
      if (d.type === 'capability' && d.module === t.id) {
        const local = new Set([...localDrivers(ctx.set.paths, t.id), ...(t.fromDriver ? [t.fromDriver] : [])]);
        const before = asserts.some((a) => (a.path === '$.driver' && a.op === 'eq' && local.has(String(a.value))) || (a.path === '$.status' && a.op === 'eq' && a.value === 'off'));
        if (before) add('A9', `check ${use.localId} asserts the before state of ${t.id} (driver ${[...local].join('/')} or status off): drift must be once`);
      }
    }
  }
}

// ---------------------------------------------------------------------------------------------------------------
// A11: experiments

export function labelIds(labels: readonly (string | { id: string })[]): string[] {
  return labels.map((l) => (typeof l === 'string' ? l : l.id));
}

function lintExperiments(ctx: LintContext, card: CardContent, add: Add): void {
  const lab = card.lab;
  const exps = lab.experiments ?? [];
  const keys = new Set<string>();
  for (const e of exps) {
    const k = `${e.module}/${e.id}`;
    if (keys.has(k)) add('A11', `experiment ${k} is declared twice`);
    keys.add(k);
    const labels = labelIds(e.labels);
    for (const pair of e.pairs ?? []) for (const l of pair) if (!labels.includes(l)) add('A11', `${k}: pair label ${l} is not declared`);
    for (const l of e.requiredLabels ?? []) if (!labels.includes(l)) add('A11', `${k}: requiredLabels ${l} is not declared`);
    for (const c of e.corroborateWith ?? []) if (!resolveRef(ctx.set, card, c).ok) add('A11', `${k}: corroborateWith ${c} is not a check of this card`);
    const manifest = loadExperimentManifest(ctx.set.paths, e.module);
    const entry = manifest?.find((x) => x.id === e.id);
    if (!manifest) add('A11', `${k}: experiments/${e.module}/experiment.json does not exist`, e.required ? 'error' : 'warn');
    else if (!entry) add('A11', `${k}: experiments/${e.module}/experiment.json has no experiment ${e.id}`, e.required ? 'error' : 'warn');
    else {
      if (entry.scenario?.tool === 'manual') add('A11', `${k}: the runner treats ${e.id} as a manual experiment (no result can be uploaded)`, e.required ? 'error' : 'warn');
      const req = entry.requires ?? null;
      if (req) for (const l of labels) if (!Object.prototype.hasOwnProperty.call(req, l)) add('A11', `${k}: label ${l} is not a requires key of experiment.json (the runner rejects it)`, e.required ? 'error' : 'warn');
    }
    const usedLabels = new Set(lab.steps.filter((s) => s.experiment && s.experiment.module === e.module && s.experiment.id === e.id).map((s) => s.experiment!.label));
    if (e.required) for (const l of e.requiredLabels ?? labels) if (!usedLabels.has(l)) add('A11', `${k}: required label ${l} has no experiment step`);
  }
  for (const s of lab.steps) {
    if (s.type === 'experiment' && !s.experiment) add('A11', `experiment step ${s.id} needs experiment {module, id, label}`);
    if (!s.experiment) continue;
    const e = exps.find((x) => x.module === s.experiment!.module && x.id === s.experiment!.id);
    if (!e) add('A11', `step ${s.id}: experiment ${s.experiment.module}/${s.experiment.id} is not declared in experiments`);
    else if (!labelIds(e.labels).includes(s.experiment.label)) add('A11', `step ${s.id}: label ${s.experiment.label} is not declared for ${e.module}/${e.id}`);
    if (e?.required && s.optional) {
      const label = s.experiment.label;
      const covered = lab.steps.some((x) => x !== s && !x.optional && !x.when && x.experiment?.module === e.module && x.experiment.id === e.id && x.experiment.label === label);
      if (!covered && (e.requiredLabels ?? labelIds(e.labels)).includes(label)) add('A11', `step ${s.id} is optional but is the only step recording the required label ${label}`);
    }
  }
}

// ---------------------------------------------------------------------------------------------------------------
// A12: variables

function lintVariables(_ctx: LintContext, card: CardContent, add: Add): void {
  const lab = card.lab;
  const declared = new Set(Object.keys(lab.variables ?? {}));
  for (const [name, v] of Object.entries(lab.variables ?? {})) {
    if (SECRET_NAME.test(name)) add('A12', `variable ${name}: secret-like names are not allowed`);
    if (v.pattern) {
      try {
        new RegExp(v.pattern);
      } catch {
        add('A12', `variable ${name}: pattern is not a valid regular expression`);
      }
    }
    if (v.fillFrom) checkExpr(`variable ${name} fillFrom`, v.fillFrom, false);
  }
  const inputs = new Set<string>((lab.prerequisites?.learnerInputs ?? []).map((i) => i.id));
  function checkExpr(where: string, expr: string, inManual: boolean): void {
    const v = parseVariable(expr);
    if (!v) {
      if (!expr.trim().startsWith('$')) add('A12', `${where}: {{ ${expr} }} is not a §4.4 variable`);
      return;
    }
    if (!(VARIABLE_NAMESPACES as readonly string[]).includes(v.ns)) add('A12', `${where}: unknown namespace ${v.ns} in {{ ${expr} }}`);
    if (v.ns === 'var' && !declared.has(v.path[0]!)) add('A12', `${where}: var.${v.path[0]} is not declared in variables`);
    if (v.ns === 'sample' && inManual) add('A12', `${where}: sample.* is only available in check definitions`);
    if (v.ns === 'learner' && (v.path[0] !== 'inputs' || !inputs.has(v.path[1] ?? ''))) {
      if (inManual || v.path[0] === 'inputs') add('A12', `${where}: {{ ${expr} }} — only learner.inputs.<declared input> is allowed`);
    }
    for (const f of v.filters) if (!(VARIABLE_FILTERS as readonly string[]).includes(f.name)) add('A12', `${where}: unknown filter ${f.name}`);
  }
  for (const [file, m] of card.manuals) {
    for (const v of m.variables) checkExpr(`${file}:${v.line}`, v.expr, true);
    for (const c of m.code) {
      if (c.attributes.vars === 'false') continue;
      for (const mm of c.value.matchAll(/(?<!\\)\{\{\s*([^}]+?)\s*\}\}/g)) {
        const v = parseVariable(mm[1]!);
        if (v && v.ns === 'cap' && !v.filters.some((f) => f.name === 'shell')) add('A12', `${file}:${c.line}: {{ ${mm[1]} }} has no pattern; use | shell in code blocks (04 §4.4 rule 2)`, 'warn');
      }
    }
  }
  for (const [id, d] of card.checks) {
    for (const mm of JSON.stringify(d).matchAll(/\{\{\s*([^}$][^}]*?)\s*\}\}/g)) checkExpr(`check ${id}`, mm[1]!, false);
  }
  for (const s of lab.steps) if (s.when) for (const mm of s.when.matchAll(/\b(var|learner|envfile|session|platform)\.[A-Za-z0-9_.-]+/g)) checkExpr(`step ${s.id} when`, mm[0], false);
}

// ---------------------------------------------------------------------------------------------------------------
// A14 / A15: cost keys and permissions

function lintCost(ctx: LintContext, lab: LabV2, add: Add): void {
  const dims = ctx.set.pricing?.dimensions ?? {};
  for (const b of lab.cost.basis ?? []) {
    if ('pricingKey' in b && !dims[b.pricingKey]) add('A14', `cost.basis ${b.key}: pricingKey ${b.pricingKey} is not in labs/_pricing/dimensions.yaml`);
  }
  for (const s of lab.steps) for (const k of s.startsBilling?.pricingKeys ?? []) if (!dims[k]) add('A14', `step ${s.id} startsBilling: pricingKey ${k} is not in labs/_pricing/dimensions.yaml`);
}

function lintPermissions(lab: LabV2, add: Add): void {
  const list = lab.permissions?.learner ?? [];
  const seen = new Set<string>();
  for (const a of list) {
    if (seen.has(a)) add('A15', `permissions.learner lists ${a} twice`);
    seen.add(a);
    if (FORBIDDEN_IAM_ACTIONS.includes(a) && !a.startsWith('s3:ListBucket')) add('A15', `permissions.learner: ${a}`, 'warn');
  }
}

// ---------------------------------------------------------------------------------------------------------------
// A17: quiz

function lintQuiz(card: CardContent, add: Add): void {
  const lab = card.lab;
  if (!lab.quiz) return;
  if (card.quiz === undefined) {
    add('A17', 'quiz.file quiz.yaml does not exist');
    return;
  }
  const issues = validateWith('quiz', card.quiz);
  if (issues.length) {
    for (const i of issues.slice(0, 20)) add('A17', `quiz.yaml: schema: ${i.path}: ${i.message}`);
    return;
  }
  const q = card.quiz as { questions: { id: string; type: string; kind?: string; options: { id: string }[]; answer: string[]; relatesTo?: string }[] };
  const ids = new Set<string>();
  const stepIds = new Set(lab.steps.map((s) => s.id));
  for (const x of q.questions) {
    if (ids.has(x.id)) add('A17', `quiz: duplicate question id ${x.id}`);
    ids.add(x.id);
    const opts = x.options.map((o) => o.id);
    if (new Set(opts).size !== opts.length) add('A17', `quiz ${x.id}: duplicate option ids`);
    for (const a of x.answer) if (!opts.includes(a)) add('A17', `quiz ${x.id}: answer ${a} is not an option`);
    if (x.type === 'single' && x.answer.length !== 1) add('A17', `quiz ${x.id}: single-choice questions have exactly one answer`);
    if (x.type === 'multi' && x.answer.length < 2) add('A17', `quiz ${x.id}: multi-choice questions have at least two answers`, 'warn');
    if (x.relatesTo && !stepIds.has(x.relatesTo)) add('A17', `quiz ${x.id}: relatesTo ${x.relatesTo} is not a step`);
  }
  if (q.questions.length < (lab.quiz.draw ?? 1)) add('A17', `quiz: ${q.questions.length} question(s) < draw ${lab.quiz.draw}`);
  if (lab.kind === 'scenario') {
    const sc = q.questions.filter((x) => x.kind === 'scenario').length;
    if (sc * 2 < q.questions.length) add('A17', `scenario card: at least half of the questions must be kind: scenario (${sc}/${q.questions.length})`);
  }
}

// ---------------------------------------------------------------------------------------------------------------
// A19: learner inputs, A20: extra stacks

function lintLearnerInputs(card: CardContent, add: Add): void {
  const lab = card.lab;
  const inputs = new Map<string, boolean>((lab.prerequisites?.learnerInputs ?? []).map((i) => [i.id, i.required !== false]));
  for (const s of lab.steps) {
    const m = card.manuals.get(s.manual);
    const text = `${m?.body ?? ''} ${JSON.stringify(s)}`;
    for (const mm of text.matchAll(/learner\.inputs\.([a-z-]+)/g)) {
      const id = mm[1]!;
      if (!inputs.has(id)) {
        add('A19', `step ${s.id}: learner.inputs.${id} is not declared in prerequisites.learnerInputs`);
        continue;
      }
      if (inputs.get(id) === false && !(s.when ?? '').includes(`learner.inputs.${id} != ''`) && !(typeof s.optional === 'object' && (s.optional.when ?? '').includes(`learner.inputs.${id}`))) {
        add('A19', `step ${s.id} uses the optional input ${id}: it needs when: learner.inputs.${id} != ''`);
      }
    }
  }
  const unconditional = lab.steps.filter((s) => !s.when && !s.optional);
  if (!unconditional.length) add('A19', 'without the optional learner inputs the card has no required step');
}

function lintExtraStacks(card: CardContent, add: Add): void {
  const lab = card.lab;
  for (const x of lab.extraStacks ?? []) {
    if (!fs.existsSync(path.join(card.dir, x.template))) add('A20', `extraStacks ${x.id}: ${x.template} does not exist`);
    if (x.region === 'dr-region' && !(lab.regions?.extra ?? []).includes('dr-region')) add('A20', `extraStacks ${x.id}: region dr-region needs regions.extra: [dr-region]`);
    const usedByStep = x.deploy.startsWith('step:') ? lab.steps.some((s) => s.id === x.deploy.slice(5)) : true;
    if (!usedByStep) add('A20', `extraStacks ${x.id}: deploy ${x.deploy} names an unknown step`);
  }
}
