import { describe, expect, it } from 'vitest';
import {
  PLAN_DEFAULTS, applyTarget, needHolds, orderSteps, planEnable, remedyForAtom, resolveTarget, reverseDependents,
} from '../src/deps.js';
import { REGISTRY } from '../src/registry.js';
import { defaultEnv } from '../../../backend/src/rules/engine.js';

const L0 = {};

describe('resolveTarget', () => {
  it('enum switch: default AWS value, local tier, self-hosted', () => {
    expect(resolveTarget('storage')).toMatchObject({ value: 's3', tier: 'aws' });
    expect(resolveTarget('cache', { driver: 'memory' })).toMatchObject({ value: 'memory', tier: 'local' });
    expect(resolveTarget('cache', { selfHosted: true })).toMatchObject({ value: 'redis', tier: 'self-hosted', settings: { REDIS_URL: 'redis://127.0.0.1:6379' } });
    expect(resolveTarget('database', { selfHosted: true }).settings.DB_HOST).toBe('127.0.0.1');
    expect(resolveTarget('image-processing', { driver: 'worker' })).toMatchObject({ tier: 'local' });
    expect(resolveTarget('iam', { driver: 'keys' })).toMatchObject({ value: 'keys', tier: 'aws' });
  });

  it('parameter switch (cdn) and invalid values', () => {
    expect(resolveTarget('cdn')).toMatchObject({ value: 'aws', tier: 'aws' });
    expect(() => resolveTarget('storage', { driver: 'local' })).toThrow(/local default/);
    expect(() => resolveTarget('storage', { driver: 'efs' })).toThrow(/not owned/);
    expect(() => resolveTarget('ec2')).toThrow(/base module/);
  });

  it('applyTarget writes the switch (placeholder for parameter switches)', () => {
    expect(applyTarget(L0, resolveTarget('queue'))).toEqual({ QUEUE_DRIVER: 'sqs' });
    expect(applyTarget(L0, resolveTarget('cdn')).CDN_BASE_URL).toBe('<cdn:CDN_BASE_URL>');
  });
});

describe('planEnable: dependency planning (5.1, 9.2 step 1, 10.4)', () => {
  it('credentials: required -> CRED-001 issue without --with-deps', () => {
    const p = planEnable(L0, resolveTarget('storage'));
    expect(p.steps.map((s) => s.module)).toEqual(['storage']);
    expect(p.issues).toHaveLength(1);
    expect(p.issues[0]).toMatchObject({ rule: 'CRED-001', module: 'storage', remedy: { module: 'iam', value: 'role' } });
  });

  it('--with-deps adds iam(role) first', () => {
    const p = planEnable(L0, resolveTarget('storage'), { withDeps: true });
    expect(p.issues).toEqual([]);
    expect(p.steps.map((s) => `${s.module}=${s.value}`)).toEqual(['iam=role', 'storage=s3']);
    expect(p.env.IAM_CREDENTIALS).toBe('role');
  });

  it('credentials: optional modules do not pull iam (cdn, cache, database)', () => {
    for (const id of ['cdn', 'cache', 'database'] as const) {
      const p = planEnable(L0, resolveTarget(id), { withDeps: true });
      expect(p.steps.map((s) => s.module), id).toEqual([id]);
      expect(p.issues, id).toEqual([]);
    }
  });

  it('image-processing lambda -> iam + storage (DEP-003) in topological order', () => {
    const p = planEnable(L0, resolveTarget('image-processing'), { withDeps: true });
    expect(p.issues).toEqual([]);
    expect(p.steps.map((s) => s.module)).toEqual(['iam', 'storage', 'image-processing']);
    expect(p.steps.find((s) => s.module === 'storage')).toMatchObject({ rule: 'DEP-003', isTarget: false });
  });

  it('image-processing lambda without deps lists every missing need', () => {
    const p = planEnable(L0, resolveTarget('image-processing'));
    expect(p.issues.map((i) => i.rule).sort()).toEqual(['CRED-001', 'DEP-003']);
  });

  it('image-processing worker (local tier) needs QUEUE_DRIVER!=sync -> queue memory local tier, no AWS', () => {
    const p = planEnable(L0, resolveTarget('image-processing', { driver: 'worker' }), { withDeps: true });
    expect(p.steps.map((s) => `${s.module}=${s.value}(${s.tier})`)).toEqual(['queue=memory(local)', 'image-processing=worker(local)']);
  });

  it('a need already satisfied by the current env adds nothing', () => {
    const env = { IAM_CREDENTIALS: 'role', MODULE_IAM: 'on', STORAGE_DRIVER: 's3' };
    const p = planEnable(env, resolveTarget('image-processing'), { withDeps: true });
    expect(p.steps.map((s) => s.module)).toEqual(['image-processing']);
  });

  it('auth managed login -> DEP-029 "cdn | tls | TLS_MODE=letsencrypt": first automatic branch', () => {
    const p = planEnable(L0, resolveTarget('auth', { settings: { COGNITO_LOGIN_MODE: 'managed' } }), { withDeps: true });
    expect(p.steps.map((s) => s.module)).toEqual(['iam', 'cdn', 'auth']);
    const sdk = planEnable(L0, resolveTarget('auth'), { withDeps: true });
    expect(sdk.steps.map((s) => s.module)).toEqual(['iam', 'auth']);
  });

  it('own sub-option needs (DEP-031 lazy -> COGNITO_TRIGGERS=on) are reported, then set with --with-deps', () => {
    const t = () => resolveTarget('auth', { settings: { AUTH_MIGRATION: 'lazy' } });
    const p = planEnable({ IAM_CREDENTIALS: 'role', MODULE_IAM: 'on' }, t());
    expect(p.issues.map((i) => i.rule)).toEqual(['DEP-031']);
    const q = planEnable({ IAM_CREDENTIALS: 'role', MODULE_IAM: 'on' }, t(), { withDeps: true });
    expect(q.issues).toEqual([]);
    expect(q.steps[0]!.settings.COGNITO_TRIGGERS).toBe('on');
  });

  it('MUTEX: image-processing lambda conflicts with WORKFLOW_DRIVER=stepfunctions', () => {
    const p = planEnable({ WORKFLOW_DRIVER: 'stepfunctions', IAM_CREDENTIALS: 'role', STORAGE_DRIVER: 's3' }, resolveTarget('image-processing'));
    expect(p.issues.map((i) => i.rule)).toContain('MUTEX-005');
  });

  it('remedy of single atoms', () => {
    expect(remedyForAtom('STORAGE_DRIVER=s3', 'image-processing')).toMatchObject({ module: 'storage', tier: 'aws' });
    expect(remedyForAtom('QUEUE_DRIVER!=sync', 'image-processing')).toMatchObject({ module: 'queue', value: 'memory', tier: 'local' });
    expect(remedyForAtom('load-balancer', 'cdn')).toMatchObject({ module: 'load-balancer' });
    expect(remedyForAtom('TLS_DOMAIN!=', 'tls')).toBeUndefined();
    expect(remedyForAtom('COGNITO_TRIGGERS=on', 'auth')).toBe('own-setting');
    expect(needHolds('QUEUE_DRIVER!=sync', {})).toBe(false);
    expect(needHolds('QUEUE_DRIVER!=sync', { QUEUE_DRIVER: 'memory' })).toBe(true);
    expect(needHolds('cdn | tls', { CDN_BASE_URL: 'https://d.cloudfront.net' })).toBe(true);
  });
});

describe('ordering and reverse dependencies', () => {
  it('orderBefore is honoured (kms before storage and database)', () => {
    const steps = ['database', 'storage', 'kms'].map((module) => ({ module: module as 'database' }));
    expect(orderSteps(steps, []).map((s) => s.module)).toEqual(['kms', 'storage', 'database']);
  });

  it('dependency edges win over registry order', () => {
    const steps = [{ module: 'iam' as const }, { module: 'storage' as const }, { module: 'image-processing' as const }];
    expect(orderSteps([...steps].reverse(), [['storage', 'image-processing'], ['iam', 'storage']]).map((s) => s.module))
      .toEqual(['iam', 'storage', 'image-processing']);
  });

  it('disabling storage is refused while image-processing (lambda) depends on it', () => {
    const env = { IAM_CREDENTIALS: 'role', STORAGE_DRIVER: 's3', IMAGE_PROCESSOR: 'lambda' };
    const rev = reverseDependents(env, 'storage', ['STORAGE_DRIVER']);
    expect(rev).toEqual([{ module: 'image-processing', rule: 'DEP-003', need: 'STORAGE_DRIVER=s3' }]);
  });

  it('disabling iam is refused while a credentials: required module is enabled (CRED-001)', () => {
    const env = { IAM_CREDENTIALS: 'role', QUEUE_DRIVER: 'sqs', CACHE_DRIVER: 'redis', REDIS_URL: 'rediss://x:6379' };
    expect(reverseDependents(env, 'iam', ['IAM_CREDENTIALS']).map((d) => d.module)).toEqual(['queue']);
  });

  it('disabling queue breaks the worker local tier (DEP-004)', () => {
    const env = { QUEUE_DRIVER: 'memory', IMAGE_PROCESSOR: 'worker' };
    expect(reverseDependents(env, 'queue', ['QUEUE_DRIVER']).map((d) => d.rule)).toEqual(['DEP-004']);
  });
});

describe('planner defaults stay in sync with the backend schema', () => {
  it('PLAN_DEFAULTS equals backend defaultEnv() for every key the backend defines at L0', () => {
    const d = defaultEnv();
    const mismatches = Object.entries(PLAN_DEFAULTS).filter(([k, v]) => d[k] !== undefined && d[k] !== v);
    expect(mismatches).toEqual([]);
  });

  it('every key referenced by registry when / need clauses has a planner default', () => {
    const keys = new Set<string>();
    for (const m of Object.values(REGISTRY)) {
      for (const r of [...(m.requires ?? []), ...(m.conflicts ?? [])]) {
        Object.keys(r.when ?? {}).forEach((k) => keys.add(k));
        for (const n of r.need ?? []) for (const a of n.split('|')) { const i = a.trim().search(/!?=/); if (i > 0) keys.add(a.trim().slice(0, i)); }
      }
    }
    const missing = [...keys].filter((k) => !(k in PLAN_DEFAULTS) && !['DB_PROXY_ENDPOINT', 'WAF_SCOPE'].includes(k));
    expect(missing).toEqual([]);
  });
});
