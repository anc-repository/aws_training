/**
 * baseParams: module requirements on the ec2 base stack parameters (modular-design.md 2.3, 3.5; 00-ec2-base.md 6.3).
 *   - PublicHttpIngress: the strictest requirement wins (closed > admin-ip > open)
 *   - list parameters ("+" prefix, ExtraSecurityGroupIds): union of all contributions
 *   - any other parameter: a single writer at a time (conflict = plan error, exit 2)
 *   - when the last contributor is disabled the parameter returns to its original value (recorded in state.json)
 *   - replacement-class parameters are never written outside the staged replacement flow (preflight ec2-replacement-staged)
 */
import type { ModuleId } from '@cloudalbum/contracts';
import { REGISTRY, type Registry } from './registry.js';
import { baseParamExpr, evaluateExpr, unionList, whenHolds } from './expr.js';
import type { CloudAlbumState, ModuleRecord } from './state.js';
import type { EnvMap } from './env-file.js';

export const REPLACEMENT_PARAMS = new Set(['ImageId', 'Arch', 'KeyName', 'VpcId', 'SubnetId', 'InstanceSlot', 'RootVolumeSizeGiB']);
export const LIST_PARAMS = new Set(['ExtraSecurityGroupIds']);
const INGRESS_RANK: Record<string, number> = { open: 0, 'admin-ip': 1, closed: 2 };

/** L0 defaults of the base stack parameters that modules may write (00-ec2-base.md 6.2). */
export const BASE_PARAM_DEFAULTS: Readonly<Record<string, string>> = {
  PublicHttpIngress: 'open', AdminIngressCidr: '', ExtraSecurityGroupIds: '', AlbSecurityGroupId: '', InstanceProfileName: '',
  DetailedMonitoring: 'false', InstanceBackupTag: 'false', AssociateEip: 'true', SshIngressCidr: '', DataVolumeAttach: 'true',
};

export interface Contribution { module: ModuleId; param: string; value: string; append: boolean }

/**
 * Contributions of one module, evaluated with its outputs / env / params. A value that evaluates to '' because a reference is
 * empty or unresolved is ignored; the literal '' is a deliberate "clear" (shell-access: SshIngressCidr '' closes port 22).
 */
export function moduleContributions(id: ModuleId, rec: Pick<ModuleRecord, 'outputs' | 'env' | 'params' | 'value'>,
  ctx: { Env: string; Arch?: string }, registry: Registry = REGISTRY): Contribution[] {
  const decl = registry[id]?.baseParams ?? {};
  const out: Contribution[] = [];
  for (const [param, raw] of Object.entries(decl)) {
    const { expr, when } = baseParamExpr(raw);
    if (!whenHolds(when, rec.env)) continue;
    // iam: only the role mode attaches an instance profile (keys / none -> empty, 02#iam)
    if (id === 'iam' && param === 'InstanceProfileName' && rec.value !== 'role') continue;
    const v = evaluateExpr(expr, { outputs: rec.outputs, env: rec.env, params: rec.params, context: ctx });
    if (v.unresolved.length || (v.value === '' && expr !== '')) continue;
    out.push({ module: id, param, value: v.value, append: v.append });
  }
  return out;
}

export interface BaseParamPlan {
  /** parameter -> desired value (only parameters with at least one contribution or a recorded original) */
  desired: Record<string, string>;
  /** parameter -> contributing modules */
  by: Record<string, ModuleId[]>;
  conflicts: string[];
  /** parameters whose desired value differs from the current one */
  changes: Array<{ param: string; from: string; to: string }>;
}

/**
 * Merge every contribution of `records` (the modules enabled after the operation) against the current base parameter
 * values. `original` = the value before any module touched the parameter.
 */
export function mergeBaseParams(records: Partial<Record<ModuleId, Pick<ModuleRecord, 'outputs' | 'env' | 'params' | 'value' | 'tier'>>>,
  current: Readonly<Record<string, string>>, original: Readonly<Record<string, string>>,
  ctx: { Env: string; Arch?: string }, registry: Registry = REGISTRY): BaseParamPlan {
  const contributions: Contribution[] = [];
  for (const [id, rec] of Object.entries(records)) {
    if (!rec || rec.tier !== 'aws') continue;
    contributions.push(...moduleContributions(id as ModuleId, rec, ctx, registry));
  }
  const byParam = new Map<string, Contribution[]>();
  for (const c of contributions) byParam.set(c.param, [...(byParam.get(c.param) ?? []), c]);

  const desired: Record<string, string> = {};
  const by: Record<string, ModuleId[]> = {};
  const conflicts: string[] = [];
  const params = new Set([...byParam.keys(), ...Object.keys(original)]);
  for (const param of params) {
    const cs = byParam.get(param) ?? [];
    const base = original[param] ?? current[param] ?? BASE_PARAM_DEFAULTS[param] ?? '';
    by[param] = cs.map((c) => c.module);
    if (!cs.length) { desired[param] = base; continue; }
    if (REPLACEMENT_PARAMS.has(param)) {
      conflicts.push(`${param} is a replacement-class parameter (instance replacement flow only; requested by ${by[param]!.join(', ')})`);
      continue;
    }
    if (param === 'PublicHttpIngress') {
      desired[param] = cs.map((c) => c.value).reduce((a, b) => ((INGRESS_RANK[b] ?? 0) > (INGRESS_RANK[a] ?? 0) ? b : a), base || 'open');
    } else if (LIST_PARAMS.has(param) || cs.some((c) => c.append)) {
      desired[param] = unionList(base, ...cs.map((c) => c.value)).join(',');
    } else {
      const values = [...new Set(cs.map((c) => c.value))];
      if (values.length > 1) conflicts.push(`${param}: conflicting values ${cs.map((c) => `${c.module}=${c.value}`).join(', ')}`);
      desired[param] = values[0]!;
    }
  }
  // AdminIngressCidr only matters (and is only kept) with admin-ip
  if (desired.PublicHttpIngress !== undefined && desired.PublicHttpIngress !== 'admin-ip' && by.AdminIngressCidr?.length) {
    desired.AdminIngressCidr = original.AdminIngressCidr ?? '';
  }
  const changes = Object.entries(desired)
    .filter(([p, v]) => (current[p] ?? BASE_PARAM_DEFAULTS[p] ?? '') !== v)
    .map(([param, to]) => ({ param, from: current[param] ?? BASE_PARAM_DEFAULTS[param] ?? '', to }));
  return { desired, by, conflicts, changes };
}

/** Records of state.modules as they will be after enabling `next` (or disabling `removed`). */
export function recordsAfter(state: CloudAlbumState, change: { set?: [ModuleId, ModuleRecord]; removed?: ModuleId }): CloudAlbumState['modules'] {
  const out: CloudAlbumState['modules'] = { ...state.modules };
  if (change.set) out[change.set[0]] = change.set[1];
  if (change.removed) delete out[change.removed];
  return out;
}

/** Original values to remember the first time a module touches a base parameter. */
export function originalsFor(state: CloudAlbumState): Record<string, string> {
  return Object.fromEntries(Object.entries(state.baseParams).map(([k, r]) => [k, r.original]));
}

export function envOf(rec: ModuleRecord | undefined): EnvMap {
  return rec?.env ?? {};
}
