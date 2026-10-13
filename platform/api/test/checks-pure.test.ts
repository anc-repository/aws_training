/**
 * Pure building blocks of the check engine (04 §5.3–§5.7): JSONPath subset, placeholders and filters, `when`
 * expressions, the 21 assertion operators with `where` / `anyOf` / `severity` / `pendingIf`, the `healthy` rule,
 * redaction, evidence digests, the read-only allowlist and its IAM mapping, the egress address guard, built-in
 * corroborators and experiment comparability / validity.
 */
import { describe, expect, it } from 'vitest';
import { evaluateAll, evaluateAssertion, isPending } from '../src/functions/checks/engine/assert.js';
import { freshNonce, ipInRanges, parseIpRanges, sanMatches, tlsSan } from '../src/functions/checks/engine/builtins.js';
import { checkHash, sealEvidence, verifyEvidenceDigest } from '../src/functions/checks/engine/evidence.js';
import { comparable, experimentVerdict, validateRun, withinRunWindow, type ExperimentRunRecord } from '../src/functions/checks/engine/experiments.js';
import { evalExpr, evaluateWhen, parseExpr } from '../src/functions/checks/engine/expr.js';
import { healthy, profileHealthy } from '../src/functions/checks/engine/healthy.js';
import { exists, query, queryAll } from '../src/functions/checks/engine/jsonpath.js';
import { inCidr, isForbiddenAddress } from '../src/functions/checks/engine/net.js';
import { eventRegionOf, nextLookupDelayMinutes, resourceIdOfArn, resourceTypeOfArn } from '../src/functions/checks/engine/ownership.js';
import { hashMarker, maskText, REDACTED, redactEvidence } from '../src/functions/checks/engine/redact.js';
import { planBatches, parseResultLines, verifyResultLine } from '../src/functions/checks/engine/runcheck.js';
import { renderDeep, renderString, UnresolvedVarError } from '../src/functions/checks/engine/template.js';
import { classifyAwsError, SDK_CLIENTS } from '../src/functions/checks/aws/engine-ports.js';
import { allowlistPairs, BASE_ALLOWLIST, isAllowed } from '../src/functions/checks/verifier/allowlist.js';
import { iamActionsOf, verifierIamActions } from '../src/functions/checks/verifier/iam-map.js';
import type { CheckDecl, EvidenceEnvelope } from '../src/functions/checks/types.js';

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- decoded JSON results are asserted structurally
type Rec = any;

describe('JSONPath subset', () => {
  const doc = { a: { b: [{ x: 1 }, { x: 2 }] }, headers: { 'x-cache': 'Hit from cloudfront' }, deep: { HeaderValue: 's', n: { HeaderValue: 't' } } };
  it('dotted names with dashes, indexes, wildcards, recursive descent', () => {
    expect(query(doc, '$.headers.x-cache')).toBe('Hit from cloudfront');
    expect(query(doc, '$.a.b[1].x')).toBe(2);
    expect(query(doc, '$.a.b[-1].x')).toBe(2);
    expect(query(doc, '$.a.b[*].x')).toEqual([1, 2]);
    expect(query(doc, "$['headers']['x-cache']")).toBe('Hit from cloudfront');
    expect(queryAll(doc, '$..HeaderValue').map((m) => m.value)).toEqual(['s', 't']);
    expect(exists(doc, '$.a.missing')).toBe(false);
    expect(() => query(doc, 'a.b')).toThrow();
  });
});

describe('placeholders (04 §4.4, §5.3)', () => {
  const vars: Record<string, unknown> = { 'session.accountId': '123456789012', 'cap.cdn.public.baseUrl': 'https://d1.cloudfront.net/x', 'target.publicDns': 'ec2.example', 'var.n': "a'b" };
  const scope = { resolve: (r: string) => vars[r], self: { first: { json: { now: 42 } } }, checks: { other: { id: 'E123' } } };
  it('keeps the type of a whole-string placeholder and interpolates otherwise', async () => {
    expect(await renderString('{{$.first.json.now}}', scope)).toBe(42);
    expect(await renderString('/x/{{ target.publicDns }}/y', scope)).toBe('/x/ec2.example/y');
    expect(await renderString('{{ $check.other.id }}', scope)).toBe('E123');
    expect(await renderString('\\{{ literal }}', scope)).toBe('{{ literal }}');
  });
  it('filters', async () => {
    expect(await renderString('{{ session.accountId | mask }}', scope)).toBe('********9012');
    expect(await renderString('{{ cap.cdn.public.baseUrl | host }}', scope)).toBe('d1.cloudfront.net');
    expect(await renderString('{{ var.n | shell }}', scope)).toBe(`'a'\\''b'`);
    expect(await renderString('{{ var.missing | default:"‹分配 ID›" }}', scope)).toBe('‹分配 ID›');
    expect(await renderDeep({ a: ['{{ target.publicDns | upper }}'] }, scope)).toEqual({ a: ['EC2.EXAMPLE'] });
  });
  it('unresolved variables raise NOT_FOUND_VAR', async () => {
    await expect(renderString('{{ var.missing }}', scope)).rejects.toBeInstanceOf(UnresolvedVarError);
  });
});

describe('when expressions', () => {
  it('parses and evaluates without eval', async () => {
    expect(evalExpr(parseExpr("learner.inputs.domain != '' && !done.x"), { 'learner.inputs.domain': 'a.com', 'done.x': false })).toBe(true);
    expect(evalExpr(parseExpr("(driver.cdn == 'cloudfront' || runtime.cdn) && session.variant == 'default'"), { 'driver.cdn': 'direct', 'runtime.cdn': true, 'session.variant': 'default' })).toBe(true);
    expect(await evaluateWhen("platform.drRegion != ''", () => '')).toBe(false);
    expect(() => parseExpr('a ==')).toThrow();
    expect(() => parseExpr('process.exit()')).toThrow();
  });
});

describe('assertions (04 §5.3)', () => {
  const ev = {
    status: 200,
    headers: { 'x-cache': 'Miss from cloudfront' },
    list: [{ DomainName: 'h', CustomOriginConfig: { HTTPPort: 8080, OriginProtocolPolicy: 'http-only' } }, { DomainName: 'other' }],
    n: '5',
    s: 'abc',
  };
  const ok = (a: Parameters<typeof evaluateAssertion>[0]) => evaluateAssertion(a, ev).ok;
  it.each([
    [{ path: '$.status', op: 'eq', value: 200 }, true],
    [{ path: '$.status', op: 'eq', value: '200' }, true],
    [{ path: '$.status', op: 'neq', value: 404 }, true],
    [{ path: '$.status', op: 'in', value: [200, 204] }, true],
    [{ path: '$.status', op: 'nin', value: [500] }, true],
    [{ path: '$.headers.x-cache', op: 'exists' }, true],
    [{ path: '$.headers.age', op: 'absent' }, true],
    [{ path: '$.s', op: 'contains', value: 'b' }, true],
    [{ path: '$.headers.x-cache', op: 'icontains', value: 'MISS FROM' }, true],
    [{ path: '$.s', op: 'startsWith', value: 'ab' }, true],
    [{ path: '$.s', op: 'endsWith', value: 'bc' }, true],
    [{ path: '$.s', op: 'matches', value: '^a.c$' }, true],
    [{ path: '$.n', op: 'gt', value: 4 }, true],
    [{ path: '$.n', op: 'gte', value: 5 }, true],
    [{ path: '$.n', op: 'lt', value: 6 }, true],
    [{ path: '$.n', op: 'lte', value: 4 }, false],
    [{ path: '$.list', op: 'len_eq', value: 2 }, true],
    [{ path: '$.list', op: 'len_gte', value: 3 }, false],
    [{ path: '$.list', op: 'len_lte', value: 2 }, true],
    [{ path: '$.list', op: 'some', value: { path: '$.DomainName', op: 'eq', value: 'h' } }, true],
    [{ path: '$.list', op: 'every', value: { path: '$.DomainName', op: 'exists' } }, true],
    [{ path: '$.list', where: { DomainName: 'h', 'CustomOriginConfig.HTTPPort': 8080, 'CustomOriginConfig.OriginProtocolPolicy': 'http-only' }, op: 'len_eq', value: 1 }, true],
    [{ path: '$.list', where: { DomainName: { op: 'startsWith', value: 'oth' } }, op: 'len_eq', value: 1 }, true],
  ] as [Parameters<typeof evaluateAssertion>[0], boolean][])('%j → %s', (a, expected) => {
    expect(ok(a)).toBe(expected);
  });
  it('rejects backtracking regexes and records warn-severity failures without failing', () => {
    expect(evaluateAssertion({ path: '$.s', op: 'matches', value: '(a)\\1' }, ev).ok).toBe(false);
    const r = evaluateAll([{ path: '$.status', op: 'eq', value: 200 }, { path: '$.s', op: 'eq', value: 'zzz', severity: 'warn' }], undefined, ev);
    expect(r.ok).toBe(true);
    expect(r.outcomes[1]!.ok).toBe(false);
  });
  it('anyOf is an OR of AND groups; pendingIf wins before assert', () => {
    expect(evaluateAll([], [[{ path: '$.status', op: 'eq', value: 500 }], [{ path: '$.s', op: 'eq', value: 'abc' }]], ev).ok).toBe(true);
    expect(evaluateAll([], [[{ path: '$.status', op: 'eq', value: 500 }]], ev).ok).toBe(false);
    expect(isPending([{ path: '$.headers.x-cache', op: 'icontains', value: 'miss' }], ev)).toBe(true);
  });
});

describe('healthy (04 §5.3, decision C14)', () => {
  const v = { errors: [{ rule: 'ERR-1', modules: ['db'] }], warnings: [{ rule: 'DEP-013', modules: ['auth'] }, { rule: 'SEC-002', modules: ['lb'] }] };
  it.each([
    ['ok module', { status: 'ok' }, 'cdn', [], true],
    ['degraded only by expected warnings', { status: 'degraded' }, 'auth', ['DEP-013'], true],
    ['degraded by an unexpected warning', { status: 'degraded' }, 'lb', ['DEP-013'], false],
    ['degraded without a rule', { status: 'degraded' }, 'cdn', [], false],
    ['errors on the module', { status: 'ok' }, 'db', [], false],
    ['status off', { status: 'off' }, 'cdn', [], false],
  ])('%s', (_n, mod, id, expected, ok) => {
    expect(healthy(mod, v, id, new Set(expected)).ok).toBe(ok);
  });
  it('op: healthy inside an assertion collects expected warnings; caps.profile uses the same rule', () => {
    const hit = new Set<string>();
    const o = evaluateAssertion({ path: '$', op: 'healthy' }, { status: 'degraded' }, { healthy: { moduleId: 'auth', validation: v, expected: new Set(['DEP-013']) }, expectedHit: hit });
    expect(o.ok).toBe(true);
    expect([...hit]).toEqual(['DEP-013']);
    expect(profileHealthy({ modules: { iam: { driver: 'role', status: 'ok' }, auth: { driver: 'local', status: 'degraded' } }, validation: v }, { iam: 'role', auth: 'local' }, ['DEP-013']).ok).toBe(true);
    expect(profileHealthy({ modules: { iam: { driver: 'keys', status: 'ok' } } }, { iam: 'role' }, []).diffs[0]!.module).toBe('iam');
  });
});

describe('redaction and evidence (04 §5.5)', () => {
  it('masks origin secrets, probe tokens, correlation ids and extra paths', () => {
    const r = redactEvidence(
      {
        Distribution: { DistributionConfig: { Origins: { Items: [{ CustomHeaders: { Items: [{ HeaderName: 'X-Origin-Verify', HeaderValue: 'topsecret' }] } }] } } },
        headers: { 'x-amz-cf-id': 'abc==', authorization: 'Bearer x', 'x-cache': 'Hit' },
        tokens: ['atlpt1.aaa.bbb'],
        note: 'token atlpk1.zzzz here',
        cfIds: [{ id: 'cf-1', seen: true }],
        probeTokenPresent: true,
        extra: { secretish: 1 },
      },
      { redact: ['$.extra.secretish'] },
    );
    const v = r.value as Rec;
    expect(v.Distribution.DistributionConfig.Origins.Items[0].CustomHeaders.Items[0].HeaderValue).toBe(REDACTED);
    expect(v.headers['x-amz-cf-id']).toBe(hashMarker('abc=='));
    expect(v.headers.authorization).toBe(REDACTED);
    expect(v.headers['x-cache']).toBe('Hit');
    expect(v.tokens).toBe(REDACTED);
    expect(v.note).toBe(`token ${REDACTED} here`);
    expect(v.cfIds[0].id).toBe(hashMarker('cf-1'));
    expect(v.probeTokenPresent).toBe(true);
    expect(v.extra.secretish).toBe(REDACTED);
    expect(JSON.stringify(v)).not.toContain('topsecret');
  });
  it('keep projects large AWS responses; export masking keeps private addresses', () => {
    const r = redactEvidence({ Distribution: { Id: 'E1', Status: 'Deployed', Big: 'x'.repeat(100) } }, { keepOnly: ['$.Distribution.Id', '$.Distribution.Status'] });
    expect(r.value).toEqual({ kept: { '$.Distribution.Id': 'E1', '$.Distribution.Status': 'Deployed' } });
    expect(maskText('acct 123456789012 ip 54.1.2.3 and 10.0.0.5')).toBe('acct ********9012 ip 54.1.x.x and 10.0.0.5');
  });
  it('seals envelopes with an RFC 8785 digest', () => {
    const decl = { id: 'a', title: 't', type: 'manual', spec: {} } as CheckDecl;
    const e = sealEvidence({ schema: 'atl.evidence/v1', checkKey: 'svc-x/a', checkHash: checkHash(decl) } as Omit<EvidenceEnvelope, 'digest'>);
    expect(e.digest).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(verifyEvidenceDigest(e)).toBe(true);
    expect(verifyEvidenceDigest({ ...e, checkKey: 'svc-x/b' })).toBe(false);
  });
});

describe('read-only allowlist and IAM mapping (04 §5.7)', () => {
  it('contains the base list and nothing forbidden', () => {
    expect(isAllowed('cloudfront', 'GetDistribution')).toBe(true);
    expect(isAllowed('s3', 'GetObject')).toBe(false);
    expect(isAllowed('secretsmanager', 'GetSecretValue')).toBe(false);
    expect(isAllowed('ce', 'GetCostAndUsage')).toBe(false);
    expect(allowlistPairs().length).toBeGreaterThan(150);
  });
  it('maps every SDK operation to IAM actions and every service to an SDK client', () => {
    expect(iamActionsOf('s3control', 'GetPublicAccessBlock')).toEqual(['s3:GetAccountPublicAccessBlock']);
    expect(iamActionsOf('s3', 'ListBuckets')).toEqual(['s3:ListAllMyBuckets']);
    expect(iamActionsOf('budgets', 'DescribeBudgets')).toEqual(['budgets:ViewBudget']);
    expect(iamActionsOf('apigateway', 'GetApis')).toEqual(['apigateway:GET']);
    for (const s of Object.keys(BASE_ALLOWLIST)) expect(SDK_CLIENTS[s], s).toBeDefined();
    const iam = verifierIamActions();
    expect(iam).toContain('cloudfront:GetDistribution');
    expect(iam.some((a) => a.startsWith('s3:GetObject'))).toBe(false);
  });
  it('classifies SDK errors', () => {
    expect(classifyAwsError(Object.assign(new Error('x'), { name: 'AccessDeniedException' })).kind).toBe('ACCESS_DENIED');
    expect(classifyAwsError(Object.assign(new Error('Rate exceeded'), { name: 'ThrottlingException' })).kind).toBe('THROTTLED');
    expect(classifyAwsError(Object.assign(new Error('x'), { name: 'NoSuchDistribution' })).kind).toBe('NOT_FOUND');
    expect(classifyAwsError(Object.assign(new Error('Stack with id a does not exist'), { name: 'ValidationError' })).kind).toBe('NOT_FOUND');
  });
});

describe('egress guard and built-in corroborators', () => {
  it.each(['127.0.0.1', '10.1.2.3', '172.16.0.1', '192.168.1.1', '169.254.169.254', '100.64.0.1', '::1', 'fd00::1', 'fe80::1', '::ffff:127.0.0.1', '0.0.0.0', '224.0.0.1'])('forbids %s', (ip) => {
    expect(isForbiddenAddress(ip)).toBe(true);
  });
  it.each(['54.239.1.2', '13.32.0.1', '2600:9000::1'])('allows %s', (ip) => {
    expect(isForbiddenAddress(ip)).toBe(false);
  });
  it('matches published ranges, SAN wildcards and fresh nonces', () => {
    const ranges = parseIpRanges({ prefixes: [{ ip_prefix: '13.32.0.0/15', service: 'CLOUDFRONT', region: 'GLOBAL' }], ipv6_prefixes: [{ ipv6_prefix: '2600:9000::/28', service: 'CLOUDFRONT' }] });
    expect(inCidr('13.33.4.5', '13.32.0.0/15')).toBe(true);
    expect(ipInRanges(['13.33.4.5', '2600:9000:1::2'], 'CLOUDFRONT', ranges).ok).toBe(true);
    expect(ipInRanges(['54.1.2.3'], 'CLOUDFRONT', ranges).ok).toBe(false);
    expect(sanMatches('d111.cloudfront.net', '*.cloudfront.net')).toBe(true);
    expect(sanMatches('a.b.cloudfront.net', '*.cloudfront.net')).toBe(false);
    expect(tlsSan(['*.cloudfront.net'], '*.cloudfront.net').ok).toBe(true);
    expect(freshNonce('n0nce-123', [{ x: 'n0nce-123' }]).ok).toBe(false);
  });
});

describe('ownership helpers and ATL-RunCheck lines', () => {
  it('derives types, ids and the CloudTrail region of global services', () => {
    const arn = 'arn:aws:cloudfront::123456789012:distribution/E2QWRUHAPOMQZL';
    expect(resourceTypeOfArn(arn)).toBe('AWS::CloudFront::Distribution');
    expect(resourceIdOfArn(arn)).toBe('E2QWRUHAPOMQZL');
    expect(eventRegionOf(arn, 'ap-northeast-1')).toBe('us-east-1');
    expect(eventRegionOf('arn:aws:s3:::b', 'ap-northeast-1')).toBe('us-east-1');
    expect(eventRegionOf('arn:aws:ec2:ap-northeast-1:1:instance/i-1', 'x')).toBe('ap-northeast-1');
    expect([0, 1, 2, 3, 4, 5, 9].map(nextLookupDelayMinutes)).toEqual([2, 2, 4, 4, 8, 8, 8]);
  });
  it('batches within 10 items and the ArgsB64 limit; verifies run tokens and hosts', () => {
    const items = Array.from({ length: 23 }, (_, i) => ({ key: `c${i}`, checkId: 'env-key', args: { module: 'cdn', key: 'K' } }));
    expect(planBatches(items).map((b) => b.length)).toEqual([10, 10, 3]);
    const big = Array.from({ length: 4 }, (_, i) => ({ key: `c${i}`, checkId: 'http-probe', args: { path: `/${'a'.repeat(1500)}` } }));
    expect(planBatches(big).length).toBeGreaterThan(1);
    const line = { schema: 'atl.runcheck.result/v1', key: 'c1', runToken: 'tok', sessionId: 's4k7m2q9x1abc', bundle: { digest: 'd' }, host: { instanceId: 'i-1' }, status: 'ok' };
    const out = parseResultLines(`noise\nATL-RESULT-V1 ${Buffer.from(JSON.stringify(line)).toString('base64url')}\n`);
    expect(out).toHaveLength(1);
    const expectFor = { runToken: 'tok', sessionId: 's4k7m2q9x1abc', bundleDigest: 'd', instanceId: 'i-1' };
    expect(verifyResultLine(out[0]!, expectFor)).toBeNull();
    expect(verifyResultLine(out[0]!, { ...expectFor, runToken: 'other' })).toBe('runToken mismatch');
    expect(verifyResultLine(out[0]!, { ...expectFor, instanceId: 'i-2' })).toBe('host instance mismatch');
  });
});

describe('expanded card shapes (04 §2.5)', () => {
  it('accepts atl.card/v1 and an expanded atl.lab/v2 with checks', async () => {
    const { normalizeCard, planCard } = await import('../src/functions/checks/engine/facts.js');
    const lab = { schema: 'atl.lab/v2', id: 'svc-x', version: '1.0.0', steps: [{ id: 's', type: 'cli', checks: ['a', { ref: 'b', required: false }] }], finalChecks: ['a'], expectedWarnings: [], contentDigest: 'sha256:d', checks: { a: { id: 'a', title: 'A', type: 'manual', spec: {} }, b: { id: 'b', title: 'B', type: 'local', checkId: 'env-key', assert: [] } } };
    const card = normalizeCard(lab as never)!;
    expect(card.schema).toBe('atl.card/v1');
    expect(card.contentDigest).toBe('sha256:d');
    const plan = planCard(card);
    expect(plan.map((p) => [p.stepId, p.localId, p.required, p.drift.policy])).toEqual([
      ['s', 'a', true, 'once'],
      ['s', 'b', false, 'must-hold'],
      ['_final', 'a', true, 'once'],
    ]);
    expect(normalizeCard({ schema: 'other' })).toBeNull();
  });
});

describe('experiments (04 §3.2.10, §7.4)', () => {
  const exp = {
    module: 'cdn',
    id: 'media-load',
    labels: [
      { id: 'before', role: 'baseline' as const, requires: { cdn: 'direct' } },
      { id: 'after', role: 'treatment' as const, requires: { cdn: 'cloudfront' } },
    ],
    pairs: [['before', 'after']] as [string, string][],
    required: true,
    allowSimulatedBaseline: true,
  };
  const run = (label: string, status: 'valid' | 'simulated' | 'invalid' | 'pending-crosscheck', extra: Partial<ExperimentRunRecord> = {}): ExperimentRunRecord => ({ runId: `R${label}`, module: 'cdn', experiment: 'media-load', label, scenario: 'media-load', params: { requests: 20 }, validity: { status }, finishedAt: '2026-10-13T08:00:00Z', ...extra });
  it('requires every label and a comparable pair; simulated only for baselines', () => {
    expect(experimentVerdict(exp, [run('before', 'valid'), run('after', 'valid')]).ok).toBe(true);
    expect(experimentVerdict(exp, [run('before', 'valid')]).ok).toBe(false);
    expect(experimentVerdict(exp, [run('before', 'simulated'), run('after', 'valid')]).simulated).toBe(true);
    expect(experimentVerdict(exp, [run('before', 'valid'), run('after', 'simulated')]).ok).toBe(false);
    expect(experimentVerdict(exp, [run('before', 'valid'), run('after', 'valid', { params: { requests: 30 } })]).ok).toBe(false);
    expect(experimentVerdict(exp, [run('before', 'valid'), run('after', 'pending-crosscheck')]).pendingCrosscheck).toBe(true);
    expect(experimentVerdict(exp, [run('before', 'valid')], { label: 'before' }).ok).toBe(true);
    expect(comparable(run('a', 'valid', { forced: true }), run('b', 'valid')).ok).toBe(false);
  });
  it('validates a run against server metrics: window, drivers, per-target counts, path ratio, samples', () => {
    // the registered shape (atl-agent registerExperimentRun): { notBefore, notAfter }
    const r = { ...run('after', 'pending-crosscheck'), window: { notBefore: '2026-10-13T07:00:00Z', notAfter: '2026-10-13T08:00:00Z' } };
    const result = { startedAt: '2026-10-13T07:10:00Z', finishedAt: '2026-10-13T07:12:00Z', targets: [{ kind: 'cdn' }], client: { requests: 20, cdnHitRatio: 0.7 } };
    const metrics = { app: { requests: 6, byTarget: { cdn: 6 }, pathSignatures: [{ signature: 'entry=cloudfront>nginx;storage=local', count: 6 }] } };
    expect(validateRun({ exp, run: r, result, metrics, driversAtUpload: { cdn: 'cloudfront' } }).status).toBe('valid');
    expect(validateRun({ exp, run: r, result: { ...result, finishedAt: '2026-10-13T09:00:00Z' }, metrics }).reasons[0]).toBe('OUT_OF_WINDOW');
    // 04 §7.4 step 3 regression: a start before the window (e.g. the session start), or no times at all, is outside
    expect(validateRun({ exp, run: r, result: { ...result, startedAt: '2026-10-13T06:00:00Z' }, metrics }).reasons[0]).toBe('OUT_OF_WINDOW');
    expect(validateRun({ exp, run: r, result: { ...result, startedAt: undefined }, metrics }).reasons[0]).toBe('OUT_OF_WINDOW');
    expect(validateRun({ exp, run: r, result: { ...result, startedAt: 'yesterday' }, metrics }).reasons[0]).toBe('OUT_OF_WINDOW');
    // records of the first implementation ({ from, to }) are read as well
    const legacy = { ...r, window: { from: '2026-10-13T07:00:00Z', to: '2026-10-13T08:00:00Z' } };
    expect(validateRun({ exp, run: legacy, result: { ...result, finishedAt: '2026-10-13T09:00:00Z' }, metrics }).reasons[0]).toBe('OUT_OF_WINDOW');
    expect(withinRunWindow(r.window, result.startedAt, result.finishedAt)).toBe(true);
    expect(withinRunWindow(r.window, result.finishedAt, result.startedAt)).toBe(false);
    expect(validateRun({ exp, run: r, result, metrics, driversAtUpload: { cdn: 'direct' } }).reasons[0]).toMatch(/^DRIVER_MISMATCH/);
    expect(validateRun({ exp, run: r, result, metrics: { app: { requests: 1, byTarget: { cdn: 1 } } } }).reasons[0]).toMatch(/^NOT_CORROBORATED/);
    expect(validateRun({ exp, run: r, result, metrics: { app: { requests: 6, byTarget: { cdn: 6 }, pathSignatures: [{ signature: 'entry=nginx', count: 6 }] } } }).reasons[0]).toMatch(/^PATH_RATIO/);
    expect(validateRun({ exp, run: r, result, metrics: null }).status).toBe('pending-crosscheck');
  });
});
