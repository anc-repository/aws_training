// wave1-prep: the module hook mechanism (module-hooks/) and the generic multi-stack / multi-region deployment of enable / disable.
import { describe, expect, it } from 'vitest';
import { disableCommand } from '../src/disable.js';
import { enableCommand } from '../src/enable.js';
import { moduleContributions } from '../src/base-params.js';
import { hookFor, hookedModules, mergeStackOutputs, selectStacks, setModuleHookForTest, stackDrift } from '../src/module-hooks/index.js';
import { stagedValue } from '../src/plan.js';
import { loadLab, planStartOf } from '../src/plan-start.js';
import { desiredPolicies } from '../src/policy.js';
import { WAVE1_MODULES } from '../src/registry.js';
import type { ModuleRecord } from '../src/state.js';
import { parseConfig } from '../../../backend/src/config/schema.js';
import { REPO_ROOT, dryContext } from './helpers.js';

const CDN = { MODULE_CDN: 'on', CDN_BASE_URL: 'https://d111.cloudfront.net' };

describe('module hook registry', () => {
  it('every wave 1 module has a hook file, and only those', () => {
    expect(hookedModules().sort()).toEqual([...WAVE1_MODULES].sort());
    for (const id of WAVE1_MODULES) expect(hookFor(id)?.id).toBe(id);
    expect(hookFor('storage')).toBeUndefined();   // MVP modules keep hooks.ts
  });
});

describe('stack selection from the registry (stacks[].when / region)', () => {
  it('tls: main only with TLS_ACME=on; edge in us-east-1 when cdn is enabled; regional with load-balancer', () => {
    const names = (env: Record<string, string>) => selectStacks('tls', env, 'ap-northeast-1').map((s) => `${s.name}@${s.region}`);
    expect(names({ TLS_MODE: 'acm', TLS_ACME: 'on' })).toEqual(['main@ap-northeast-1']);
    expect(names({ TLS_MODE: 'acm', TLS_ACME: 'on', ...CDN })).toEqual(['main@ap-northeast-1', 'edge@us-east-1']);
    expect(names({ TLS_MODE: 'acm', TLS_ACME: 'off', ...CDN })).toEqual(['edge@us-east-1']);
    expect(names({ TLS_MODE: 'acm', TLS_ACME: 'off', MODULE_LOAD_BALANCER: 'on', LB_MODE: 'alb' })).toEqual(['regional@ap-northeast-1']);
  });

  it('waf: CLOUDFRONT scope in us-east-1 with cdn, REGIONAL with load-balancer; no stack without either', () => {
    expect(selectStacks('waf', { WAF_MODE: 'aws', ...CDN }, 'ap-northeast-1')).toEqual([
      { name: 'edge', template: 'infra/modules/waf.yaml', region: 'us-east-1' },
    ]);
    expect(selectStacks('waf', { WAF_MODE: 'aws', LB_MODE: 'alb' }, 'ap-northeast-1').map((s) => s.name)).toEqual(['regional']);
    expect(selectStacks('waf', { WAF_MODE: 'aws' }, 'ap-northeast-1')).toEqual([]);
  });

  it('modules without conditions deploy their main stack in the default region', () => {
    expect(selectStacks('dns', {}, 'ap-northeast-1')).toEqual([{ name: 'main', template: 'infra/modules/dns.yaml', region: 'ap-northeast-1' }]);
  });

  it('outputs of several stacks merge in deployment order; a non-empty value wins', () => {
    expect(mergeStackOutputs([
      { EnvAcmCertArnEdge: '', EnvTlsAcme: 'on', PolicyArn: 'arn:aws:iam::1:policy/a' },
      { EnvAcmCertArnEdge: 'arn:aws:acm:us-east-1:1:certificate/x', EnvTlsAcme: 'on', PolicyArn: 'arn:aws:iam::1:policy/b' },
    ])).toEqual({ EnvAcmCertArnEdge: 'arn:aws:acm:us-east-1:1:certificate/x', EnvTlsAcme: 'on', PolicyArn: 'arn:aws:iam::1:policy/a' });
  });

  it('stackDrift: tls enabled before cdn needs its edge stack once cdn is on', () => {
    const tls = { tier: 'aws', value: 'acm', env: { MODULE_TLS: 'on', TLS_MODE: 'acm', TLS_ACME: 'on' }, params: {}, outputs: {},
      stacks: [{ name: 'main', stackName: 'cloudalbum-lab-tls', region: 'ap-northeast-1' }] } as unknown as ModuleRecord;
    expect(stackDrift({ tls }, {}, 'ap-northeast-1')).toEqual([]);
    expect(stackDrift({ tls }, CDN, 'ap-northeast-1')).toEqual([{ module: 'tls', add: ['edge'], remove: [] }]);
  });

  it('every PolicyArn of a multi-stack module is attached', () => {
    const state = { modules: { waf: { tier: 'aws', outputs: { PolicyArn: 'arn:p/edge' },
      stacks: [{ name: 'edge', outputs: { PolicyArn: 'arn:p/edge' } }, { name: 'regional', outputs: { PolicyArn: 'arn:p/regional' } }] } } };
    expect(desiredPolicies(state as never)).toEqual([{ module: 'waf', policyArn: 'arn:p/edge' }, { module: 'waf', policyArn: 'arn:p/regional' }]);
  });
});

describe('baseParams: the literal \'\' clears a base parameter (shell-access closes port 22)', () => {
  const rec = (keep: string) => ({ outputs: {}, params: {}, value: 'ssm', env: { SHELL_ACCESS_MODE: 'ssm', SHELL_ACCESS_KEEP_SSH: keep } });
  it('SHELL_ACCESS_KEEP_SSH=false -> SshIngressCidr \'\'; true -> no contribution', () => {
    expect(moduleContributions('shell-access', rec('false'), { Env: 'lab' })).toEqual([{ module: 'shell-access', param: 'SshIngressCidr', value: '', append: false }]);
    expect(moduleContributions('shell-access', rec('true'), { Env: 'lab' })).toEqual([]);
  });
  it('a reference that evaluates to \'\' is still ignored (dns ExtraSecurityGroupIds without a health-check group)', () => {
    expect(moduleContributions('dns', { outputs: { InfoHealthCheckSecurityGroupId: '' }, params: {}, value: 'route53', env: {} }, { Env: 'lab' })).toEqual([]);
  });
});

describe('hook points in enable / plan / disable (dry-run)', () => {
  it('a missing manual prerequisite stops enable with exit 2 and the hint; plan prints it and skips (exit 0)', async () => {
    const restore = setModuleHookForTest('dns', {
      plan: (_ctx, _step, args) => (args.domain ? { settings: { DNS_RECORD_NAME: args.domain } }
        : { missing: [{ prerequisite: 'domain', message: 'no own domain', hint: 'scripts/module enable dns --domain album.example.com' }] }),
    });
    try {
      const a = dryContext();
      expect(await enableCommand(a.ctx, 'dns', {})).toBe(2);
      expect(a.out.text()).toContain('manual prerequisite "domain" is not met: no own domain');
      expect(a.out.text()).toContain('scripts/module enable dns --domain album.example.com');
      expect(a.aws.calls.filter((c) => /Stack$/.test(c.op))).toEqual([]);
      const b = dryContext();
      expect(await enableCommand(b.ctx, 'dns', { planOnly: true })).toBe(0);
      expect(b.out.text()).toContain('plan skipped: dns');
    } finally {
      restore();
    }
  });

  it('stacks() adds a us-east-1 stack: both are deployed, recorded with their region, and deleted on disable', async () => {
    const calls: string[] = [];
    const restore = setModuleHookForTest('cdn', {
      plan: () => { calls.push('plan'); return { notes: ['test note'] }; },
      prepare: (_ctx, _step, _args, p) => { calls.push('prepare'); p.settings.CDN_DIRECT_ACCESS = 'open'; },
      stacks: (_ctx, _step, _args, selected) => [...selected, { name: 'edge', template: 'infra/modules/cdn.yaml', region: 'us-east-1', params: { MediaOrigin: 'ec2' } }],
      afterDeploy: (_ctx, _step, _args, d) => { calls.push(`afterDeploy:${Object.keys(d.byStack).join('+')}`); },
      beforeDisable: () => { calls.push('beforeDisable'); return { notes: ['bye'] }; },
      afterDisable: () => { calls.push('afterDisable'); },
    });
    try {
      const { ctx, out, aws } = dryContext();
      expect(await enableCommand(ctx, 'cdn', {})).toBe(0);
      const deploys = aws.calls.filter((c) => c.service === 'cloudformation' && /Stack$/.test(c.op) && String(c.input.StackName).startsWith('cloudalbum-lab-cdn'));
      expect(deploys.map((c) => `${String(c.input.StackName)}@${c.region ?? 'default'}`)).toEqual(['cloudalbum-lab-cdn@default', 'cloudalbum-lab-cdn-edge@us-east-1']);
      expect(ctx.state.modules.cdn?.stacks.map((s) => `${s.name}@${s.region}`)).toEqual(['main@ap-northeast-1', 'edge@us-east-1']);
      expect(out.text()).toContain('cdn: test note');
      expect(await disableCommand(ctx, 'cdn', {})).toBe(0);
      const deletes = aws.calls.filter((c) => c.op === 'DeleteStack').map((c) => `${String(c.input.StackName)}@${c.region ?? 'default'}`);
      expect(deletes).toEqual(['cloudalbum-lab-cdn@ap-northeast-1', 'cloudalbum-lab-cdn-edge@us-east-1']);
      expect(calls).toEqual(['plan', 'prepare', 'afterDeploy:main+edge', 'beforeDisable', 'afterDisable']);
    } finally {
      restore();
    }
  });

  it('beforeDisable keepBaseParams keeps the current base parameter instead of restoring it', async () => {
    const restore = setModuleHookForTest('cdn', { beforeDisable: () => ({ keepBaseParams: ['PublicHttpIngress'] }) });
    try {
      const { ctx, aws } = dryContext();
      expect(await enableCommand(ctx, 'cdn', { set: ['CDN_DIRECT_ACCESS=closed'] })).toBe(0);
      expect(ctx.state.baseParams.PublicHttpIngress).toMatchObject({ value: 'closed', original: 'open' });
      const before = aws.calls.length;
      expect(await disableCommand(ctx, 'cdn', {})).toBe(0);
      const baseUpdates = aws.calls.slice(before).filter((c) => c.input.StackName === 'cloudalbum-lab-ec2' && /Stack$/.test(c.op));
      expect(JSON.stringify(baseUpdates)).not.toContain('"PublicHttpIngress","ParameterValue":"open"');
    } finally {
      restore();
    }
  });

  it('plan --start-of carries the pure planHints of the target as warnings', () => {
    const restore = setModuleHookForTest('dns', { planHints: () => ['needs your own domain (manual prerequisite)'] });
    try {
      const r = planStartOf(loadLab(REPO_ROOT, 'svc-dns'), { repoRoot: REPO_ROOT });
      expect(r.warnings).toContain('dns: needs your own domain (manual prerequisite)');
    } finally {
      restore();
    }
  });
});

describe('staged plan placeholders pass the backend schema for the wave 1 keys', () => {
  it('ARNs, numbers, enumerations and IDs', () => {
    const env: Record<string, string> = { CLOUDALBUM_ROLE: 'cli' };
    const keys = {
      MODULE_NOTIFICATION: 'on', NOTIFY_DRIVER: 'sns', NOTIFY_TOPIC_ARN: '<x>', NOTIFY_INBOX_QUEUE_URL: '<x>',
      MODULE_WAF: 'on', WAF_MODE: 'aws', WAF_SCOPE: '<x>', WAF_WEB_ACL_ARN: '<x>', WAF_IP_SET_ID: '<x>', WAF_IP_SET_NAME: '<x>', WAF_RATE_WINDOW_SEC: '<x>',
      MODULE_IDENTITY_POOL: 'on', IDENTITY_POOL_ID: '<x>', IDENTITY_STAGING_BUCKET: '<x>',
      MODULE_TLS: 'on', TLS_MODE: 'acm', TLS_DOMAIN: 'album.example.com', TLS_ACME: 'on', TLS_ACME_DIRECTORY_URL: '<x>', ACM_CERT_ARN_EDGE: '<x>',
      MODULE_DNS: 'on', DNS_PROVIDER: 'route53', DNS_HOSTED_ZONE_ID: '<x>', DNS_RECORD_NAME: '<x>', DNS_TTL: '<x>',
      MODULE_COST: 'on', COST_MODE: 'budgets', COST_BUDGET_NAMES: '<x>', COST_TOPIC_ARN: '<x>',
    };
    for (const [k, v] of Object.entries(keys)) env[k] = stagedValue(k, v);
    const r = parseConfig(env, { checkImplemented: true });
    expect(r.errors).toEqual([]);
  });
});
