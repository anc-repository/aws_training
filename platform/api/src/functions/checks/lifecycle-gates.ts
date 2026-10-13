/**
 * The two synchronous calls `atl-lifecycle` makes into atl-checks during the start workflow (02 §3.5, §4.4), with the
 * request / result shapes the lifecycle implementation uses:
 *  - `Preflight`: read-only account checks as ATLVerifierRole (default VPC, account singletons of the card's targets,
 *    pre-flight variant selection) and the baseline inventory (`InventorySnapshot`, fresh environments only);
 *  - `RunHealthGate`: `base.ready`, `caps.profile` (healthy with the card's expectedWarnings), `ws.ready` through
 *    ATL-RunCheck, mapped to `PASS | NOT_READY | FAIL`.
 */
import { Keys } from '../../data/keys.js';
import type { FunctionDeps } from '../../runtime/deps.js';
import { mutate, type ItemStore } from '../../services/progress/store.js';
import { evaluateWhen } from './engine/expr.js';
import { ContentUnavailableError, loadFacts, type SessionFacts, type SessionRecord } from './engine/facts.js';
import { AwsCallError, type CheckEnginePorts } from './engine/ports.js';
import { healthGate } from './flows.js';
import type { CardBuild } from './types.js';

export interface PreflightRequest {
  sessionId: string;
  envId: string;
  fresh?: boolean;
  labId?: string;
  variant?: string;
  startProfile?: string;
  preflightVariants?: { id: string; when?: string; digest?: string }[];
  regions?: { extra?: string[] };
  baseline?: boolean;
}

export interface PreflightItem {
  id: string;
  level: 'FAIL' | 'WARN' | 'INFO';
  message: string;
  code?: string | null;
}

const INVENTORY_TYPES = ['ec2:instance', 'ec2:natgateway', 'ec2:elastic-ip', 'ec2:vpc-endpoint', 'elasticloadbalancing:loadbalancer', 'rds:db', 'elasticache:cluster', 'elasticache:serverlesscache', 'elasticfilesystem:file-system'];

export async function preflight(deps: FunctionDeps, engine: CheckEnginePorts, store: ItemStore, req: PreflightRequest): Promise<Record<string, unknown>> {
  const session = await store.get<SessionRecord>(Keys.labSession(req.sessionId));
  const pc = await store.get<{ region?: string; preflight?: { keys?: Record<string, unknown> } }>(Keys.platformConfig());
  const region = pc?.region ?? deps.env.region;
  const s = { sid: req.sessionId, envId: req.envId };
  const items: PreflightItem[] = [];
  const call = (service: string, action: string, params: Record<string, unknown> = {}) => engine.aws.call({ service, action, params, region, session: s });

  try {
    const v = await call('ec2', 'DescribeVpcs', { Filters: [{ Name: 'isDefault', Values: ['true'] }] });
    const vpcs = (v.Vpcs as unknown[] | undefined) ?? [];
    if (vpcs.length === 0) items.push({ id: 'default-vpc', level: 'FAIL', code: 'PREFLIGHT_NO_DEFAULT_VPC', message: `区域 ${region} 没有默认 VPC。请自行执行：aws ec2 create-default-vpc --region ${region}（平台不会自动创建，也不会回收默认 VPC）` });
    else items.push({ id: 'default-vpc', level: 'INFO', message: 'default VPC present' });
  } catch (e) {
    items.push({ id: 'default-vpc', level: 'WARN', message: `default VPC could not be checked: ${e instanceof Error ? e.message : String(e)}` });
  }
  items.push({ id: 'quotas', level: 'INFO', message: '配额以 Service Quotas 为准；CodeBuild 并发构建配额较低时会出现排队' });

  const targets = new Set(((session?.targetModules as { id: string }[] | undefined) ?? []).map((t) => t.id));
  const singletons: [string, string, string, string, (r: Record<string, unknown>) => number][] = [
    ['threat-detection', 'guardduty', 'ListDetectors', 'GuardDuty 检测器已存在，模块将只读接入', (r) => ((r.DetectorIds as unknown[]) ?? []).length],
    ['compliance', 'config', 'DescribeConfigurationRecorders', 'Config 记录器已存在，模块将只读接入', (r) => ((r.ConfigurationRecorders as unknown[]) ?? []).length],
    ['audit', 'cloudtrail', 'DescribeTrails', '账号中已有 CloudTrail 跟踪', (r) => ((r.trailList as unknown[]) ?? []).length],
  ];
  for (const [module, service, action, msg, count] of singletons) {
    if (!targets.has(module)) continue;
    try {
      if (count(await call(service, action)) > 0) items.push({ id: `existing-${module}`, level: 'WARN', message: msg });
    } catch (e) {
      if (!(e instanceof AwsCallError)) throw e;
    }
  }

  // pre-flight variants (02 §3.6): `when` may only use registered pre-flight keys; unknown keys are false
  const keys: Record<string, unknown> = { 'preflight.tlsAcme': pc?.preflight?.keys?.tlsAcme ?? true };
  let variant: string | null = null;
  let variantDigest: string | null = null;
  for (const v of req.preflightVariants ?? []) {
    if (!v.when) continue;
    try {
      if (await evaluateWhen(v.when, (ref) => keys[ref])) {
        variant = v.id;
        variantDigest = v.digest ?? null;
        items.push({ id: `variant-${v.id}`, level: 'WARN', message: `已改用回退档 ${v.id}` });
        break;
      }
    } catch {
      items.push({ id: `variant-${v.id}`, level: 'WARN', message: `variant ${v.id}: unreadable condition` });
    }
  }

  // baseline inventory of expensive resources (fresh environments only; reuse keeps the creation baseline)
  if (req.baseline !== false && req.fresh !== false) {
    const arns: string[] = [];
    try {
      let token: string | undefined;
      for (let page = 0; page < 5; page++) {
        const r = await call('tag', 'GetResources', { ResourceTypeFilters: INVENTORY_TYPES, ...(token ? { PaginationToken: token } : {}) });
        for (const m of (r.ResourceTagMappingList as { ResourceARN?: string }[] | undefined) ?? []) if (m.ResourceARN) arns.push(m.ResourceARN);
        token = (r.PaginationToken as string | undefined) || undefined;
        if (!token) break;
      }
      const at = new Date(deps.ports.clock.nowMs()).toISOString();
      await mutate<Record<string, unknown>>(store, Keys.inventorySnapshot(req.envId), (cur) => (cur ? null : { type: 'InventorySnapshot', envId: req.envId, sessionId: req.sessionId, at, region, resourceArns: arns.slice(0, 2000), count: arns.length, source: 'tag:GetResources' }), { now: () => at });
    } catch (e) {
      items.push({ id: 'inventory', level: 'WARN', message: `baseline inventory incomplete: ${e instanceof Error ? e.message : String(e)}` });
    }
  }
  const fail = items.find((i) => i.level === 'FAIL');
  return {
    result: fail ? 'FAIL' : items.some((i) => i.level === 'WARN') ? 'WARN' : 'PASS',
    failureCode: fail?.code ?? null,
    message: fail?.message ?? null,
    items,
    warnings: items.filter((i) => i.level === 'WARN').map((i) => i.message),
    variant,
    variantDigest,
  };
}

export interface RunHealthGateRequest {
  sessionId: string;
  envId: string;
  profile?: string;
  gates?: ('base.ready' | 'caps.profile' | 'ws.ready')[];
  expectedWarnings?: string[];
  targetModules?: { id: string; from: string | null; to: string }[];
}

const NOT_READY_CODES = new Set(['CHANNEL_DOWN', 'RUNNER_UNAVAILABLE', 'TIMEOUT', 'NETWORK', 'THROTTLED', 'TARGET_UNRESOLVED']);

/** Gate results mapped to the lifecycle contract; `expect` = the start profile's module provisions (any driver). */
export async function runHealthGate(deps: FunctionDeps, engine: CheckEnginePorts, store: ItemStore, req: RunHealthGateRequest): Promise<Record<string, unknown>> {
  let facts: SessionFacts | null = null;
  try {
    facts = await loadFacts(deps, store, req.sessionId);
  } catch (e) {
    if (!(e instanceof ContentUnavailableError)) throw e;
  }
  const expect: Record<string, string> = {};
  const card: CardBuild | null = facts?.card ?? null;
  // target modules are off or at their precursor value here and do not take part (02 §3.6)
  const targets = new Set((req.targetModules ?? []).map((t) => t.id));
  for (const p of card?.lab.startProfile.provisions ?? []) if (p.kind === 'module' && !targets.has(p.item)) expect[p.item] = '*';
  const r = (await healthGate(deps, engine, store, {
    sessionId: req.sessionId,
    envId: req.envId,
    ...(req.gates ? { gates: req.gates } : {}),
    expect,
    expectedWarnings: req.expectedWarnings ?? card?.lab.expectedWarnings ?? [],
  } as never)) as { ok: boolean; gates: Record<string, { ok: boolean; errorCode?: string | null; message?: string; diffs?: unknown[]; observed?: { expectedHit?: string[] } }> };
  const failed = Object.entries(r.gates).filter(([, g]) => !g.ok);
  const notReady = failed.length > 0 && failed.every(([, g]) => g.errorCode && NOT_READY_CODES.has(g.errorCode));
  const warnings = [...new Set(Object.values(r.gates).flatMap((g) => g.observed?.expectedHit ?? []))].map((w) => `expected warning ${w}`);
  return {
    status: r.ok ? 'PASS' : notReady ? 'NOT_READY' : 'FAIL',
    report: r.gates,
    ...(failed.length ? { message: failed.map(([id, g]) => `${id}: ${g.errorCode ?? (g.diffs?.length ? 'profile differs' : 'not ready')}${g.message ? ` (${g.message})` : ''}`).join('; ') } : {}),
    warnings,
  };
}
