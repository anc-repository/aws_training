/**
 * “Healthy, allowing expected warnings” (04 §5.3, decision C14). Pure function; also used by the health gate
 * `caps.profile` (02 §3.6) and by `finalChecks`.
 */

export interface CapModule {
  driver?: string;
  status?: string;
  localHealth?: unknown;
  confidence?: unknown;
  detail?: unknown;
  [k: string]: unknown;
}

export interface ValidationIssue {
  rule: string;
  modules?: string[];
}

export interface Validation {
  errors?: ValidationIssue[];
  warnings?: ValidationIssue[];
}

export interface HealthyVerdict {
  ok: boolean;
  why?: string;
  note?: string;
  /** Expected warnings that were present (shown as “正常（含预期警告 …）”). */
  expectedHit: string[];
}

export function healthy(mod: CapModule | undefined, v: Validation | undefined, moduleId: string, expected: ReadonlySet<string>): HealthyVerdict {
  if (!mod) return { ok: false, why: `module ${moduleId} is not in capabilities`, expectedHit: [] };
  const errs = (v?.errors ?? []).filter((e) => (e.modules ?? []).includes(moduleId));
  const warns = (v?.warnings ?? []).filter((w) => (w.modules ?? []).includes(moduleId)).map((w) => w.rule);
  if (errs.length > 0) return { ok: false, why: `errors: ${errs.map((e) => e.rule).join(',')}`, expectedHit: [] };
  if (mod.status === 'ok') return { ok: true, expectedHit: warns.filter((r) => expected.has(r)) };
  if (mod.status === 'degraded') {
    const unexpected = warns.filter((r) => !expected.has(r));
    if (warns.length > 0 && unexpected.length === 0) return { ok: true, note: `expected warnings: ${warns.join(',')}`, expectedHit: warns };
    return { ok: false, why: unexpected.length ? `unexpected warnings: ${unexpected.join(',')}` : 'degraded without a rule', expectedHit: warns.filter((r) => expected.has(r)) };
  }
  return { ok: false, why: `status=${String(mod.status)}`, expectedHit: [] };
}

/**
 * `caps.profile` judgement (02 §3.6): every module of the start profile must be healthy (expected warnings allowed) and
 * have the expected driver; modules not in `expect` (e.g. the target, still off) are ignored.
 */
export function profileHealthy(
  caps: { modules?: Record<string, CapModule>; validation?: Validation },
  expect: Record<string, string>,
  expectedWarnings: Iterable<string>,
): { ok: boolean; diffs: { module: string; expected: string; driver?: string; status?: string; why?: string }[]; expectedHit: string[] } {
  const exp = new Set(expectedWarnings);
  const diffs: { module: string; expected: string; driver?: string; status?: string; why?: string }[] = [];
  const hit = new Set<string>();
  for (const [module, driver] of Object.entries(expect)) {
    const m = caps.modules?.[module];
    const h = healthy(m, caps.validation, module, exp);
    h.expectedHit.forEach((r) => hit.add(r));
    const driverOk = m?.driver === driver;
    if (!driverOk || !h.ok) {
      diffs.push({
        module,
        expected: driver,
        ...(m?.driver !== undefined ? { driver: m.driver } : {}),
        ...(m?.status !== undefined ? { status: m.status } : {}),
        why: !driverOk ? `driver ${String(m?.driver)} ≠ ${driver}` : h.why ?? 'not healthy',
      });
    }
  }
  return { ok: diffs.length === 0, diffs, expectedHit: [...hit] };
}
