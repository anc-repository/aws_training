/**
 * Discovery (02 §7.1): PlanDiscovery creates the ReclaimPass and the tasks, DiscoverPage runs one page of one task,
 * RecordDiscoverGap records a failed task as a REVIEW item; CaptureLedger (start workflow) records the environment's
 * stacks. Sources: LEDGER (runner ledgers + state.json out-of-band + runner-created names), STACK, TAG, CLOUDTRAIL,
 * INVENTORY (DERIVED runs in BuildDeletionPlan).
 */
import { DataKeys, Keys, keyPairName, SkPrefix, SsmParams, type DiscoveredBy, type ReclaimPassMode, type ResourceCreatedBy } from '@atl/shared';
import type { Ctx } from '../../lifecycle/context.js';
import { MINUTE } from '../../lifecycle/context.js';
import { WorkflowError } from '../../lifecycle/errors.js';
import { getEnvironment } from '../../lifecycle/store/environments.js';
import { emit } from '../../lifecycle/store/events.js';
import type { EnvironmentRecord, ReclaimPassRecord, SessionRecord } from '../../lifecycle/store/model.js';
import { getSession } from '../../lifecycle/store/sessions.js';
import { refFromArn } from './arn.js';
import { extractRefs, looksLikeCreation, parseTrailEvent, type ExtractedRef, type ParsedEvent } from './extractors.js';
import { attribute, identitySet } from './identity.js';
import { keyOf, listResources, POSSIBLY_PREEXISTING, upsertResource, type ResourceInput } from './ledger.js';
import { awaitLookupToken } from './rate.js';

export type DiscoveryTask =
  | { kind: 'LEDGER' }
  | { kind: 'STACK' }
  | { kind: 'TAG'; region: string }
  | { kind: 'CLOUDTRAIL'; region: string; start: string; end: string; cursor: string | null; pages: number }
  | { kind: 'INVENTORY'; region: string };

export interface DiscoveryItem {
  task: DiscoveryTask;
  envId: string;
  sessionId: string;
  passNo: number;
  mode: ReclaimPassMode;
}

const textOf = (b: Uint8Array | null): string | null => (b ? new TextDecoder().decode(b) : null);
async function readJson(ctx: Ctx, bucket: string, key: string): Promise<Record<string, unknown> | null> {
  const t = textOf(await ctx.ports.objects.get(bucket, key).catch(() => null));
  if (!t) return null;
  try {
    return JSON.parse(t) as Record<string, unknown>;
  } catch {
    return null;
  }
}

export async function mustEnv(ctx: Ctx, envId: string): Promise<EnvironmentRecord> {
  const env = await getEnvironment(ctx, envId);
  if (!env) throw new WorkflowError('Atl.NotFound', `environment ${envId} does not exist`);
  return env;
}

export async function chainSessions(ctx: Ctx, env: EnvironmentRecord): Promise<SessionRecord[]> {
  const out: SessionRecord[] = [];
  for (const sid of env.sessionChain) {
    const s = await getSession(ctx, sid);
    if (s) out.push(s);
  }
  return out;
}

// ---------------------------------------------------------------------------------------------------------------
// PlanDiscovery

export async function planDiscovery(ctx: Ctx, p: { input: { envId: string; sessionId: string; mode: ReclaimPassMode }; executionName?: string }) {
  const { envId, sessionId, mode } = p.input;
  const env = await mustEnv(ctx, envId);
  const passes = await ctx.main.query({ pk: { attr: 'PK', value: Keys.environment(envId).PK }, sk: { attr: 'SK', beginsWith: SkPrefix.pass } });
  // the same execution re-running PlanDiscovery (retry) reuses its pass
  const mine = passes.find((x) => x.executionName && x.executionName === p.executionName);
  const passNo = mine ? Number(mine.passNo) : passes.reduce((m, x) => Math.max(m, Number(x.passNo ?? 0)), 0) + 1;
  if (!mine) {
    const now = ctx.nowIso();
    const pass: ReclaimPassRecord = {
      ...Keys.reclaimPass(envId, passNo),
      type: 'ReclaimPass',
      ver: 1,
      createdAt: now,
      updatedAt: now,
      envId,
      sessionId,
      passNo,
      mode,
      startedAt: now,
      finishedAt: null,
      found: 0,
      deleted: 0,
      manual: 0,
      gaps: [],
      executionName: p.executionName ?? null,
    };
    await ctx.main.putIfAbsent(pass);
    await emit(ctx, sessionId, [{ type: 'reclaim.pass_started', data: { passNo, mode, envId }, envId }]);
  }
  const regions = env.scanRegions?.length ? env.scanRegions : [env.region];
  const start = new Date(Date.parse(env.createdAt) - 10 * MINUTE).toISOString();
  const end = ctx.nowIso();
  const trail: DiscoveryTask[] = regions.map((region) => ({ kind: 'CLOUDTRAIL', region, start, end, cursor: null, pages: 0 }));
  const tags: DiscoveryTask[] = regions.map((region) => ({ kind: 'TAG', region }));
  const tasks: DiscoveryTask[] =
    mode === 'RESCAN' || mode === 'UNINSTALL'
      ? [...trail, ...tags]
      : [{ kind: 'LEDGER' }, { kind: 'STACK' }, ...tags, ...trail, ...(mode === 'PRIMARY' ? regions.map((region) => ({ kind: 'INVENTORY' as const, region })) : [])];
  return { tasks, passNo };
}

// ---------------------------------------------------------------------------------------------------------------
// DiscoverPage

export async function discoverPage(ctx: Ctx, p: { item: DiscoveryItem }) {
  const it = p.item;
  const env = await mustEnv(ctx, it.envId);
  let task = it.task;
  let more = false;
  switch (task.kind) {
    case 'LEDGER':
      await discoverLedger(ctx, env, it.passNo);
      break;
    case 'STACK':
      await discoverStacks(ctx, env, it.passNo);
      break;
    case 'TAG':
      await discoverTags(ctx, env, task.region, it.passNo);
      break;
    case 'INVENTORY':
      await discoverInventory(ctx, env, task.region, it.passNo);
      break;
    case 'CLOUDTRAIL': {
      const r = await discoverTrailPages(ctx, env, task, it.passNo);
      task = r.task;
      more = r.more;
      break;
    }
  }
  return { task, envId: it.envId, sessionId: it.sessionId, passNo: it.passNo, mode: it.mode, more };
}

/** Out-of-band record types of scripts/module (state.json / ledger) → CloudFormation-like types. */
const OOB_TYPES: Record<string, string> = {
  'ec2-key-pair': 'AWS::EC2::KeyPair',
  'key-pair': 'AWS::EC2::KeyPair',
  'ssm-parameter': 'AWS::SSM::Parameter',
  parameter: 'AWS::SSM::Parameter',
  'ebs-snapshot': 'AWS::EC2::Snapshot',
  snapshot: 'AWS::EC2::Snapshot',
  ami: 'AWS::EC2::Image',
  image: 'AWS::EC2::Image',
  'iam-policy': 'AWS::IAM::ManagedPolicy',
  'packed-policy': 'AWS::IAM::ManagedPolicy',
  'ssm-document-default-version': 'ATL::SSM::DocumentDefaultVersion',
  'guardduty-detector': 'AWS::GuardDuty::Detector',
  'config-recorder': 'AWS::Config::ConfigurationRecorder',
  'inspector-enabler': 'AWS::Inspector2::Enabler',
  'log-group': 'AWS::Logs::LogGroup',
  volume: 'AWS::EC2::Volume',
  's3-bucket': 'AWS::S3::Bucket',
};

function asArray(v: unknown): Record<string, unknown>[] {
  return Array.isArray(v) ? (v.filter((x) => x && typeof x === 'object') as Record<string, unknown>[]) : [];
}

async function discoverLedger(ctx: Ctx, env: EnvironmentRecord, passNo: number): Promise<void> {
  const policyArns = new Set<string>();
  const add = (src: DiscoveredBy, sid: string, x: { type: string; id: string; region?: string; arn?: string | null; stackName?: string | null; logicalId?: string | null; retained?: boolean; creator?: string | null; meta?: Record<string, unknown> }) =>
    upsertResource(ctx, env.envId, {
      type: x.type,
      id: x.id,
      region: x.region ?? env.region,
      arn: x.arn ?? null,
      sessionId: sid,
      source: src,
      createdBy: 'provisioner',
      creatorSessionName: x.creator ?? null,
      stackName: x.stackName ?? null,
      logicalId: x.logicalId ?? null,
      retained: x.retained === true,
      passNo,
      ...(x.meta ? { meta: x.meta } : {}),
    });
  for (const sid of env.sessionChain) {
    const keys = (await ctx.ports.objects.list(ctx.env.buckets.data, `runs/${sid}-`).catch(() => [])).filter((k) => k.endsWith('/ledger.json'));
    for (const key of keys) {
      const ledger = await readJson(ctx, ctx.env.buckets.data, key);
      if (!ledger) continue;
      for (const st of asArray(ledger.stacks)) {
        for (const r of asArray(st.resources)) {
          if (typeof r.physicalId !== 'string' || typeof r.type !== 'string') continue;
          await add(r.retained === true ? 'RETAINED' : 'STACK', sid, {
            type: r.type,
            id: r.physicalId,
            region: typeof st.region === 'string' ? st.region : env.region,
            stackName: typeof st.name === 'string' ? st.name : null,
            logicalId: typeof r.logicalId === 'string' ? r.logicalId : null,
            retained: r.retained === true,
          });
        }
      }
      for (const o of asArray(ledger.outOfBand)) {
        const type = OOB_TYPES[String(o.type)] ?? `ATL::OutOfBand::${String(o.type)}`;
        if (typeof o.id === 'string') await add('OUT_OF_BAND', sid, { type, id: o.id, region: typeof o.region === 'string' ? o.region : env.region, creator: typeof o.createdBy === 'string' ? o.createdBy : null });
      }
      for (const a of asArray(ledger.policyAttachments)) if (typeof a.policyArn === 'string') policyArns.add(a.policyArn);
    }
  }
  // state.json (live in the state bucket, or the archived copy of the destroy run, 6.5 step 0)
  const owner = env.ownerSessionId;
  const state =
    (await readJson(ctx, ctx.env.buckets.labState, `${env.envName}/state.json`)) ?? (await readJson(ctx, ctx.env.buckets.data, `${DataKeys.archive(owner)}state.json`));
  if (state) {
    for (const o of asArray(state.outOfBand)) {
      const type = OOB_TYPES[String(o.type)] ?? `ATL::OutOfBand::${String(o.type)}`;
      if (typeof o.id !== 'string') continue;
      await add('OUT_OF_BAND', owner, {
        type,
        id: o.id,
        region: typeof o.region === 'string' ? o.region : env.region,
        creator: typeof o.createdBy === 'string' ? o.createdBy : null,
        meta: { backupKey: o.backupKey ?? null },
      });
    }
    for (const a of asArray(state.policyAttachments)) if (typeof a.policyArn === 'string') policyArns.add(a.policyArn);
    for (const p of asArray(state.packedPolicies)) if (typeof p.policyArn === 'string') await add('OUT_OF_BAND', owner, { type: 'AWS::IAM::ManagedPolicy', id: p.policyArn, arn: p.policyArn, region: 'us-east-1' });
  }
  // what the runner itself creates with direct calls (02 §4.3 base-deploy steps 2, 6; seeds): fixed names of the environment
  await add('OUT_OF_BAND', owner, { type: 'AWS::EC2::KeyPair', id: keyPairName(env.envName), creator: null });
  for (const name of [SsmParams.sshKey(env.envName), SsmParams.appAdminPassword(env.envName), SsmParams.testUsers(env.envName)]) {
    await add('OUT_OF_BAND', owner, { type: 'AWS::SSM::Parameter', id: name, creator: null });
  }
  // S6: reset of the shared CloudAlbumAppRole (6.5, 7.5 S6)
  await add('OUT_OF_BAND', owner, { type: 'ATL::IAM::AppRoleReset', id: 'CloudAlbumAppRole', region: 'us-east-1', meta: { policyArns: [...policyArns] } });
}

export async function discoverStacks(ctx: Ctx, env: EnvironmentRecord, passNo: number): Promise<number> {
  const cloud = ctx.clouds().reclaim;
  const regions = env.scanRegions?.length ? env.scanRegions : [env.region];
  const stacks = await cloud.listEnvStacks({ envId: env.envId, envName: env.envName, sessionIds: env.sessionChain, regions });
  let n = 0;
  for (const st of stacks) {
    if (st.status === 'DELETE_COMPLETE') continue;
    const sid = st.tags['atl:session-id'] && env.sessionChain.includes(st.tags['atl:session-id']) ? st.tags['atl:session-id'] : env.ownerSessionId;
    await upsertResource(ctx, env.envId, { type: 'AWS::CloudFormation::Stack', id: st.name, region: st.region, sessionId: sid, source: 'STACK', createdBy: 'provisioner', passNo, meta: { tags: st.tags } });
    n++;
    for (const r of await cloud.listStackResources({ stackName: st.name, region: st.region })) {
      if (!r.physicalId || r.status === 'DELETE_COMPLETE') continue;
      await upsertResource(ctx, env.envId, {
        type: r.type,
        id: r.physicalId,
        region: st.region,
        sessionId: sid,
        source: 'STACK',
        createdBy: 'provisioner',
        stackName: st.name,
        logicalId: r.logicalId,
        passNo,
      });
      n++;
    }
  }
  return n;
}

async function discoverTags(ctx: Ctx, env: EnvironmentRecord, region: string, passNo: number): Promise<void> {
  const found = await ctx.clouds().reclaim.taggedResources({ region, key: 'atl:env-id', value: env.envId });
  for (const f of found) {
    const ref = refFromArn(f.arn, region);
    const type = ref?.type ?? f.type ?? `ATL::Tagged::${f.arn.split(':')[2] ?? 'unknown'}`;
    const id = ref?.id ?? f.arn;
    // only a tag: REVIEW unless the ledger already has creation evidence (7.2 last paragraph)
    await upsertResource(ctx, env.envId, {
      type,
      id,
      region: ref?.region ?? region,
      arn: f.arn,
      sessionId: env.ownerSessionId,
      source: 'TAG',
      cleanupState: 'REVIEW',
      severity: 'REVIEW',
      lastError: 'found only by its atl:env-id tag (no creation evidence)',
      passNo,
    });
  }
}

/**
 * The baseline of one region as `type|id` and ARN keys. Reads the shape Preflight writes (`items: [{ type, id, arn,
 * region }]`, lifecycle-gates.ts) and older snapshots that only hold `resourceArns` (parsed with refFromArn).
 */
export function baselineKeys(snapshot: Record<string, unknown> | null, region: string): Set<string> {
  const out = new Set<string>();
  if (!snapshot) return out;
  const snapRegion = typeof snapshot.region === 'string' ? snapshot.region : region;
  for (const x of [...asArray(snapshot.items), ...asArray(snapshot.resources)]) {
    const r = typeof x.region === 'string' ? x.region : snapRegion;
    if (r !== region) continue;
    if (typeof x.type === 'string' && typeof x.id === 'string') out.add(`${x.type}|${x.id}`);
    if (typeof x.arn === 'string') out.add(x.arn);
  }
  for (const arn of Array.isArray(snapshot.resourceArns) ? snapshot.resourceArns : []) {
    if (typeof arn !== 'string') continue;
    const ref = refFromArn(arn, snapRegion);
    if ((ref?.region ?? snapRegion) !== region) continue;
    out.add(arn);
    if (ref) out.add(`${ref.type}|${ref.id}`);
  }
  return out;
}

async function discoverInventory(ctx: Ctx, env: EnvironmentRecord, region: string, passNo: number): Promise<void> {
  const baseline = baselineKeys(await ctx.main.get(Keys.inventorySnapshot(env.envId)), region);
  const ledger = new Set((await listResources(ctx, env.envId)).map((r) => r.resourceKey));
  for (const x of await ctx.clouds().reclaim.inventory({ region })) {
    if (baseline.has(`${x.type}|${x.id}`) || (x.arn && baseline.has(x.arn))) continue;
    if (ledger.has(keyOf(region, x.type, x.id, x.arn ?? null))) continue;
    await upsertResource(ctx, env.envId, {
      type: x.type,
      id: x.id,
      region,
      arn: x.arn ?? null,
      sessionId: env.ownerSessionId,
      source: 'INVENTORY',
      cleanupState: 'REVIEW',
      severity: 'REVIEW',
      lastError: 'high-cost resource that appeared during the environment and cannot be attributed (inventory difference)',
      passNo,
    });
  }
}

const TRAIL_PAGES_PER_CALL = 3;

async function discoverTrailPages(ctx: Ctx, env: EnvironmentRecord, task: Extract<DiscoveryTask, { kind: 'CLOUDTRAIL' }>, passNo: number) {
  const chain = await chainSessions(ctx, env);
  const ledger = await listResources(ctx, env.envId);
  const ids = identitySet(env, chain, ledger, ctx.nowMs());
  const minTime = Math.min(...chain.map((s) => Date.parse(s.createdAt)), Date.parse(env.createdAt));
  let cursor = task.cursor;
  let pages = task.pages;
  const alerts = new Set<string>();
  for (let i = 0; i < TRAIL_PAGES_PER_CALL; i++) {
    const wait = await awaitLookupToken(ctx, task.region);
    if (wait > 0) throw new WorkflowError('Atl.Throttled', `LookupEvents token bucket empty in ${task.region} (${wait}s)`);
    const page = await ctx.ports.trail.lookupEvents({
      region: task.region,
      attribute: { key: 'ReadOnly', value: 'false' },
      startTime: new Date(task.start),
      endTime: new Date(task.end),
      ...(cursor ? { nextToken: cursor } : {}),
      maxResults: 50,
    });
    pages++;
    for (const raw of page.events) {
      const ev = parseTrailEvent(raw);
      if (ev.errorCode || ev.readOnly) continue;
      if (Date.parse(ev.eventTime) < minTime - 10 * MINUTE) continue;
      const who = attribute(ids, ev);
      if (!who) continue;
      if (who.securityAlert) alerts.add(who.securityAlert);
      const refs = extractRefs(ev);
      if (refs === null) {
        if (!looksLikeCreation(ev.eventName)) continue;
        await upsertResource(ctx, env.envId, {
          type: `ATL::Unrecognized::${ev.service}:${ev.eventName}`,
          id: ev.eventId,
          region: ev.region,
          sessionId: who.sessionId,
          source: 'CLOUDTRAIL',
          createdBy: who.createdBy,
          creatorSessionName: who.creatorSessionName,
          eventId: ev.eventId,
          eventTime: ev.eventTime,
          cleanupState: 'REVIEW',
          severity: 'REVIEW',
          lastError: `unrecognised creation event ${ev.service}:${ev.eventName} (not deleted automatically)`,
          passNo,
        });
        continue;
      }
      for (const r of refs) {
        if (r.overwrite) {
          // create-or-overwrite (PutMetricAlarm, PutRule, Route 53 UPSERT, Put*Config*, inspector2 Enable): the call
          // succeeds on a resource that existed before the session as well — review only, never deleted automatically
          await upsertResource(ctx, env.envId, overwriteSighting(r, ev, who, passNo));
          continue;
        }
        await upsertResource(ctx, env.envId, {
          type: r.type,
          id: r.id,
          region: r.region ?? ev.region,
          arn: r.arn ?? null,
          name: r.name ?? null,
          sessionId: who.sessionId,
          source: 'CLOUDTRAIL',
          createdBy: who.createdBy,
          creatorSessionName: who.creatorSessionName,
          eventId: ev.eventId,
          eventTime: ev.eventTime,
          passNo,
          ...(r.meta || who.securityAlert ? { meta: { ...(r.meta ?? {}), ...(who.securityAlert ? { securityAlert: who.securityAlert, identity: who.identity } : {}) } } : {}),
        });
      }
    }
    cursor = page.nextToken ?? null;
    if (!cursor) break;
  }
  for (const a of alerts) await ctx.clouds().lifecycle.notify('atl-alerts', 'ATL: unexpected learner role session', a).catch(() => undefined);
  return { task: { ...task, cursor, pages }, more: !!cursor };
}

/** Ledger input of an overwrite-style write (ExtractedRef.overwrite): CLOUDTRAIL source without creation evidence. */
export function overwriteSighting(
  r: ExtractedRef,
  ev: ParsedEvent,
  who: { sessionId: string; createdBy?: ResourceCreatedBy; creatorSessionName?: string | null },
  passNo?: number,
): ResourceInput {
  return {
    type: r.type,
    id: r.id,
    region: r.region ?? ev.region,
    arn: r.arn ?? null,
    name: r.name ?? null,
    sessionId: who.sessionId,
    source: 'CLOUDTRAIL',
    weak: true,
    ...(who.createdBy ? { createdBy: who.createdBy } : {}),
    creatorSessionName: who.creatorSessionName ?? null,
    cleanupState: 'REVIEW',
    severity: 'REVIEW',
    lastError: `${POSSIBLY_PREEXISTING}：${ev.service}:${ev.eventName} 是覆盖式写入，无法证明它是本会话创建的；不会自动删除，请确认它不是账号里原有的资源后再处理`,
    ...(passNo !== undefined ? { passNo } : {}),
    meta: { ...(r.meta ?? {}), possiblyPreexisting: true, overwriteEventId: ev.eventId, overwriteEventName: `${ev.service}:${ev.eventName}`, overwriteEventTime: ev.eventTime },
  };
}

// ---------------------------------------------------------------------------------------------------------------
// RecordDiscoverGap / CaptureLedger

export async function recordDiscoverGap(ctx: Ctx, p: { item: DiscoveryItem & { discoverError?: { Error?: string; Cause?: string } } }) {
  const it = p.item;
  const t = it.task;
  const region = 'region' in t ? t.region : 'global';
  const id = `${t.kind}:${region}`;
  await upsertResource(ctx, it.envId, {
    type: 'ATL::Reclaim::ScanGap',
    id,
    region: region === 'global' ? ctx.env.region : region,
    sessionId: it.sessionId,
    source: t.kind === 'TAG' ? 'TAG' : t.kind === 'INVENTORY' ? 'INVENTORY' : t.kind === 'CLOUDTRAIL' ? 'CLOUDTRAIL' : 'STACK',
    cleanupState: 'REVIEW',
    severity: 'REVIEW',
    lastError: `scan incomplete (${t.kind} in ${region}): ${it.discoverError?.Error ?? 'error'} — the rescans repeat it`,
    passNo: it.passNo,
  });
  const key = Keys.reclaimPass(it.envId, it.passNo);
  const pass = await ctx.main.get(key);
  if (pass) await ctx.main.update(key, { gaps: [...((pass.gaps as string[] | undefined) ?? []), id], updatedAt: ctx.nowIso() });
  return {};
}

/** Start workflow (02 §4.4 CaptureLedger): stack resources and runner ledgers → SessionResource (source STACK). */
export async function captureLedger(ctx: Ctx, p: { envId: string; sessionId: string }) {
  const env = await mustEnv(ctx, p.envId);
  const n = await discoverStacks(ctx, env, 0);
  await discoverLedger(ctx, env, 0);
  return { captured: n };
}
