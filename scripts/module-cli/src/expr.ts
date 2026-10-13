/**
 * Value expressions of registry baseParams / injects (modular-design.md 3.5):
 *   literal | ${Out.<Output>} (stack output of the providing module) | ${<VAR>} (env of the module) |
 *   ${Param.<Name>} (stack parameter of the module) | ${Env} | ${Arch}
 * A leading "+" means "append to a list parameter" (ExtraSecurityGroupIds, AppOrigins).
 * Unresolved references yield '' (or a <placeholder> when `placeholders` is set, for --dry-run plans).
 */
import type { BaseParamValue, WhenClause } from '@cloudalbum/contracts';
import type { EnvMap } from './env-file.js';

export interface ExprScope {
  outputs?: Readonly<Record<string, string>>;
  env?: Readonly<EnvMap>;
  params?: Readonly<Record<string, string>>;
  context?: { Env?: string; Arch?: string };
  /** module id used in placeholders: <cdn:Out.InfoDistributionArn> */
  module?: string;
  placeholders?: boolean;
}

export interface EvaluatedValue {
  value: string;
  append: boolean;
  /** at least one reference could not be resolved */
  unresolved: string[];
}

export function evaluateExpr(expr: string, scope: ExprScope): EvaluatedValue {
  const append = expr.startsWith('+');
  const body = append ? expr.slice(1) : expr;
  const unresolved: string[] = [];
  const value = body.replace(/\$\{([^}]+)\}/g, (_m, ref: string) => {
    let v: string | undefined;
    if (ref.startsWith('Out.')) v = scope.outputs?.[ref.slice(4)];
    else if (ref.startsWith('Param.')) v = scope.params?.[ref.slice(6)];
    else if (ref === 'Env') v = scope.context?.Env;
    else if (ref === 'Arch') v = scope.context?.Arch;
    else v = scope.env?.[ref];
    if (v === undefined) {
      unresolved.push(ref);
      return scope.placeholders ? `<${scope.module ? `${scope.module}:` : ''}${ref}>` : '';
    }
    return v;
  });
  return { value, append, unresolved };
}

/** `when` of injects / baseParams: every KEY=value must hold in env (missing keys compare as ''). */
export function whenHolds(when: WhenClause | undefined, env: Readonly<EnvMap>, defaults: Readonly<EnvMap> = {}): boolean {
  if (!when) return true;
  return Object.entries(when).every(([k, v]) => (env[k] ?? defaults[k] ?? '') === String(v));
}

export function baseParamExpr(v: BaseParamValue): { expr: string; when?: WhenClause } {
  return typeof v === 'string' ? { expr: v } : { expr: v.value, when: v.when };
}

/** Merge a list parameter: union, order of first appearance, empty items dropped. */
export function unionList(...lists: Array<string | readonly string[] | undefined>): string[] {
  const out: string[] = [];
  for (const l of lists) {
    const items = typeof l === 'string' ? l.split(',') : (l ?? []);
    for (const raw of items) {
      const s = raw.trim();
      if (s && !out.includes(s)) out.push(s);
    }
  }
  return out;
}
