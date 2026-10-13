// capabilities snapshot (04 §5.2.2, 06 PM-03 / PM-15) and the `healthy` judgement used by caps.profile (04 §5.3).
import { CheckError } from './context.mjs';
import { probe } from './http.mjs';

/** Minimum projection of 01 §9.3 / 04 §5.2.2 (+ `public` / `data` for the asserted views). */
export const BASE_FIELDS = [
  'app.profile',
  'app.entry',
  'app.configHash',
  'app.instance',
  'app.platform',
  'https',
  'validation.errors[].rule',
  'validation.errors[].modules',
  'validation.warnings[].rule',
  'validation.warnings[].modules',
  'modules.*.driver',
  'modules.*.status',
  'modules.*.localHealth',
  'modules.*.confidence',
  'modules.*.detail',
  'modules.*.public',
  'features.*.enabled',
];

/** Keep only the listed modules and the projected fields when the server ignored the projection. */
function localProjection(data, modules) {
  if (!data || typeof data !== 'object') return data;
  const out = { ...data };
  if (modules && modules.length && data.modules && typeof data.modules === 'object') {
    out.modules = Object.fromEntries(Object.entries(data.modules).filter(([k]) => modules.includes(k)));
  }
  if (out.modules) {
    out.modules = Object.fromEntries(
      Object.entries(out.modules).map(([k, m]) => {
        if (!m || typeof m !== 'object') return [k, m];
        const { driver, status, localHealth, confidence, detail, public: pub, data: d } = m;
        return [k, { driver, status, localHealth, confidence, detail, ...(pub !== undefined ? { public: pub } : {}), ...(d !== undefined ? { data: d } : {}) }];
      }),
    );
  }
  if (out.validation) {
    const slim = (list) => (Array.isArray(list) ? list.map((x) => ({ rule: x.rule, modules: Array.isArray(x.modules) ? x.modules : [] })) : []);
    out.validation = { errors: slim(out.validation.errors), warnings: slim(out.validation.warnings) };
  }
  return out;
}

export async function capabilitySnapshot(ctx, { modules, view = 'public', fields } = {}) {
  const f = fields && fields.length ? fields : view === 'admin' ? [...BASE_FIELDS, 'modules.*.data'] : BASE_FIELDS;
  const qs = new URLSearchParams();
  qs.set('fields', f.join(','));
  if (modules && modules.length) qs.set('modules', modules.join(','));
  if (view === 'admin') qs.set('view', 'admin');
  const headers = { Accept: 'application/json' };
  if (view === 'admin') {
    const t = ctx.localProbeToken();
    if (!t) throw new CheckError('RUNNER_UNAVAILABLE', 'local probe token missing (cloudalbum probe-token --init)');
    headers['X-ATL-Probe-Token'] = t;
  }
  const base = ctx.appBaseUrl;
  if (!base) throw new CheckError('RUNNER_UNAVAILABLE', 'no local CloudAlbum to probe');
  const get = async (query) => (await probe({ url: `${base}/api/capabilities${query ? `?${query}` : ''}`, headers, timeoutMs: 8000 }))[0];
  let r;
  try {
    r = await get(qs.toString());
    if (r.status === 400) {
      // FIELDS_INVALID on an older CloudAlbum: take the full view and project locally
      const q2 = new URLSearchParams();
      if (view === 'admin') q2.set('view', 'admin');
      r = await get(q2.toString());
    }
  } catch (e) {
    if (ctx.dev) throw e;
    // 80 unavailable → the CLI falls back to the app port itself (06 PM-15)
    const args = ['capabilities', '--fields', f.join(','), '--view', view, '--json'];
    if (modules && modules.length) args.splice(1, 0, '--modules', modules.join(','));
    const c = await ctx.cli(args);
    return { via: c.via ?? 'cli', data: localProjection(c.data, modules) };
  }
  if (r.status !== 200 || !r.json) throw new CheckError(r.status === 401 || r.status === 403 ? 'RUNNER_UNAVAILABLE' : 'NETWORK', `capabilities returned ${r.status}`);
  return { via: 'nginx', data: localProjection(r.json, modules) };
}

/** Same rule as the platform's healthy() (04 §5.3). */
export function healthy(mod, validation, moduleId, expected) {
  if (!mod) return { ok: false, why: `module ${moduleId} missing`, expectedHit: [] };
  const errs = (validation?.errors ?? []).filter((e) => (e.modules ?? []).includes(moduleId));
  const warns = (validation?.warnings ?? []).filter((w) => (w.modules ?? []).includes(moduleId)).map((w) => w.rule);
  if (errs.length) return { ok: false, why: `errors: ${errs.map((e) => e.rule).join(',')}`, expectedHit: [] };
  if (mod.status === 'ok') return { ok: true, expectedHit: warns.filter((r) => expected.has(r)) };
  if (mod.status === 'degraded') {
    const unexpected = warns.filter((r) => !expected.has(r));
    if (warns.length && !unexpected.length) return { ok: true, expectedHit: warns };
    return { ok: false, why: unexpected.length ? `unexpected warnings: ${unexpected.join(',')}` : 'degraded without a rule', expectedHit: [] };
  }
  return { ok: false, why: `status=${mod.status}`, expectedHit: [] };
}
