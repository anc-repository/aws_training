/**
 * A deliberately small IAM policy evaluator for the guardrail tests (07 V5-2 cases, offline). It implements the parts of
 * the evaluation logic the platform policies rely on: Action / NotAction, Resource / NotResource with * and ? wildcards,
 * explicit Deny wins, identity Allow ∩ permissions-boundary Allow, condition operators String(Not)Equals / String(Not)Like /
 * ArnEquals / ArnLike / NumericGreaterThan / Bool / Null with ForAnyValue / ForAllValues, policy variables ${aws:…} and
 * the missing-key rules (negated operators match when the key is absent). It is not a replacement for the IAM policy
 * simulator (07 V1-8) — it checks that our statements say what 01 §6.5–§6.8 says.
 */

export interface PolicyDoc {
  Statement: Statement[] | Statement;
}
export interface Statement {
  Sid?: string;
  Effect: 'Allow' | 'Deny';
  Action?: string | string[];
  NotAction?: string | string[];
  Resource?: string | string[];
  NotResource?: string | string[];
  Condition?: Record<string, Record<string, string | string[] | number | boolean>>;
}

export type ContextValue = string | string[] | number | boolean;
export interface RequestContext {
  action: string;
  resource: string;
  /** Condition keys (case-insensitive), e.g. `aws:RequestedRegion`, `aws:RequestTag/atl:component`. */
  keys?: Record<string, ContextValue>;
}

export type Decision = 'allow' | 'deny' | 'implicit-deny';

const list = (v: string | string[] | undefined): string[] => (v === undefined ? [] : Array.isArray(v) ? v : [v]);

function wildcard(pattern: string, value: string, caseInsensitive: boolean): boolean {
  const re = new RegExp(
    '^' +
      pattern
        .split('')
        .map((c) => (c === '*' ? '.*' : c === '?' ? '.' : c.replace(/[.+^${}()|[\]\\]/g, '\\$&')))
        .join('') +
      '$',
    caseInsensitive ? 'is' : 's',
  );
  return re.test(value);
}

function substitute(value: string, keys: Record<string, ContextValue>): string | null {
  let missing = false;
  const out = value.replace(/\$\{([^}]+)\}/g, (_m, name: string) => {
    const v = lookup(keys, name);
    if (v === undefined) {
      missing = true;
      return '';
    }
    return String(Array.isArray(v) ? v[0] : v);
  });
  return missing ? null : out;
}

function lookup(keys: Record<string, ContextValue>, name: string): ContextValue | undefined {
  const lower = name.toLowerCase();
  for (const [k, v] of Object.entries(keys)) if (k.toLowerCase() === lower) return v;
  return undefined;
}

function matchesAction(s: Statement, action: string): boolean {
  if (s.Action !== undefined) return list(s.Action).some((a) => wildcard(a, action, true));
  return !list(s.NotAction).some((a) => wildcard(a, action, true));
}

function matchesResource(s: Statement, resource: string, keys: Record<string, ContextValue>): boolean {
  const pats = (v: string | string[] | undefined) => list(v).map((p) => substitute(p, keys) ?? '\u0000never');
  if (s.Resource !== undefined) return pats(s.Resource).some((p) => wildcard(p, resource, false));
  return !pats(s.NotResource).some((p) => wildcard(p, resource, false));
}

function compare(op: string, expected: string, actual: string): boolean {
  switch (op) {
    case 'StringEquals':
    case 'StringNotEquals':
    case 'ArnEquals':
    case 'ArnNotEquals':
      return expected === actual;
    case 'StringEqualsIgnoreCase':
      return expected.toLowerCase() === actual.toLowerCase();
    case 'StringLike':
    case 'StringNotLike':
    case 'ArnLike':
    case 'ArnNotLike':
      return wildcard(expected, actual, false);
    case 'NumericGreaterThan':
      return Number(actual) > Number(expected);
    case 'NumericLessThan':
      return Number(actual) < Number(expected);
    case 'Bool':
      return String(actual).toLowerCase() === String(expected).toLowerCase();
    default:
      throw new Error(`condition operator ${op} is not supported by the test evaluator`);
  }
}

function conditionHolds(rawOp: string, key: string, expectedRaw: string | string[] | number | boolean, keys: Record<string, ContextValue>): boolean {
  let op = rawOp;
  let set: 'any' | 'all' | null = null;
  if (op.startsWith('ForAnyValue:')) {
    set = 'any';
    op = op.slice('ForAnyValue:'.length);
  } else if (op.startsWith('ForAllValues:')) {
    set = 'all';
    op = op.slice('ForAllValues:'.length);
  }
  const expected = (Array.isArray(expectedRaw) ? expectedRaw : [expectedRaw]).map((e) => substitute(String(e), keys));
  const value = lookup(keys, key);
  if (op === 'Null') {
    const wantMissing = String(expected[0]).toLowerCase() === 'true';
    return wantMissing === (value === undefined);
  }
  const negated = /Not/.test(op);
  if (value === undefined) {
    if (set === 'all') return true;
    if (set === 'any') return false;
    return negated;
  }
  const actuals = (Array.isArray(value) ? value : [value]).map(String);
  const positive = (a: string) => expected.some((e) => e !== null && compare(op, e, a));
  const test = (a: string) => (negated ? !positive(a) : positive(a));
  if (set === 'all') return actuals.every(test);
  if (set === 'any') return actuals.some(test);
  return test(actuals[0]!);
}

export function statementApplies(s: Statement, req: RequestContext): boolean {
  const keys = req.keys ?? {};
  if (!matchesAction(s, req.action) || !matchesResource(s, req.resource, keys)) return false;
  for (const [op, kv] of Object.entries(s.Condition ?? {})) {
    for (const [key, expected] of Object.entries(kv)) if (!conditionHolds(op, key, expected, keys)) return false;
  }
  return true;
}

function statements(doc: PolicyDoc): Statement[] {
  return Array.isArray(doc.Statement) ? doc.Statement : [doc.Statement];
}

/** The Sids of the statements of `policies` that apply to the request with the given effect. */
export function matchingSids(policies: PolicyDoc[], req: RequestContext, effect: 'Allow' | 'Deny'): string[] {
  return policies.flatMap((p) => statements(p).filter((s) => s.Effect === effect && statementApplies(s, req)).map((s) => s.Sid ?? '(no sid)'));
}

/** Identity policies ∩ permissions boundary (∩ session policy), explicit Deny anywhere wins. */
export function evaluate(req: RequestContext, identity: PolicyDoc[], boundary?: PolicyDoc, session?: PolicyDoc): Decision {
  const all = [...identity, ...(boundary ? [boundary] : []), ...(session ? [session] : [])];
  if (matchingSids(all, req, 'Deny').length) return 'deny';
  if (!matchingSids(identity, req, 'Allow').length) return 'implicit-deny';
  if (boundary && !matchingSids([boundary], req, 'Allow').length) return 'implicit-deny';
  if (session && !matchingSids([session], req, 'Allow').length) return 'implicit-deny';
  return 'allow';
}

/** AWS managed PowerUserAccess (as published; IAM, Organizations and Account excluded). */
export const POWER_USER_ACCESS: PolicyDoc = {
  Statement: [
    { Effect: 'Allow', NotAction: ['iam:*', 'organizations:*', 'account:*'], Resource: '*' },
    {
      Effect: 'Allow',
      Action: ['iam:CreateServiceLinkedRole', 'iam:DeleteServiceLinkedRole', 'iam:ListRoles', 'organizations:DescribeOrganization', 'account:ListRegions', 'account:GetAccountInformation'],
      Resource: '*',
    },
  ],
};

/** Worst case for a workload role: a learner attached AdministratorAccess (the boundary must still hold, 01 §6.6). */
export const ADMINISTRATOR_ACCESS: PolicyDoc = { Statement: [{ Sid: 'Admin', Effect: 'Allow', Action: '*', Resource: '*' }] };
