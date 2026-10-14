/**
 * scripts/module hook of waf (wave1-waf). Contract: ./types.ts.
 * Design: docs/modules/01-edge-network-scaling.md#waf (section 6 "切换、数据迁移与回滚", section 0 registry entry, section 12 platform mode).
 *
 * What this module needs beyond the generic flow:
 *   - mount point (DEP-006, checked by the rule engine): cdn -> stack `edge` in us-east-1 (Scope=CLOUDFRONT); only load-balancer
 *     -> stack `regional` in the app region (Scope=REGIONAL). With both, edge only; `--param AlsoRegional=true` adds the regional
 *     web ACL (defence in depth; its rate keys use FORWARDED_IP because the ALB sees CloudFront addresses). WAF_SCOPE is written
 *     explicitly: the registry inject WebAclArn -> cdn (the distribution's WebACLId) only applies when WAF_SCOPE=CLOUDFRONT.
 *   - stack parameters (re-enable keeps the last deployed values unless given again):
 *       RuleAction=count|block (also --set WAF_RULE_ACTION=…; default count: observe the COUNT records first, 01#waf section 6),
 *       RateLimit (>= 10), RateWindowSec (60|120|300|600), LoginRateLimit (>= 10),
 *       LabAllowCidr (also --set WAF_LAB_ALLOW_CIDR=…; comma separated IPv4 CIDRs, normally empty; platform placeholders such as
 *       ${atl:workstationPublicCidr} are replaced by the runner before scripts/module runs, an unreplaced one is refused).
 *     There is no `scripts/module set` sub-command in this round: `enable waf --param RuleAction=block` is the stack update
 *     that the module document writes as `scripts/module set waf WAF_RULE_ACTION=block` (cards appendix B-27).
 *   - CreateLogGroup: the log group aws-waf-logs-cloudalbum-<env> is retained on disable (data protection); a later enable finds
 *     it with logs:DescribeLogGroups in the stack region and adopts it (CreateLogGroup=false) instead of failing on AlreadyExists.
 *   - afterDeploy: first full import of security/denylist.conf into the IP set cloudalbum-blocklist (the job of
 *     scripts/waf/sync-denylist in the registry): read the file over the delivery channel, then wafv2:GetIPSet + UpdateIPSet
 *     (optimistic lock) in the web ACL's region. A failure only warns: the worker of the aws driver syncs every minute.
 *   - DEP-018 (entry not locked): plan prints the warning and the command that locks the origin (the card does it in step 4).
 *   - disable: the generic flow first updates cdn with WebAclArn='' (a web ACL still in use cannot be deleted), then deletes the
 *     stacks; the log group stays (reminder with the delete command); denylist.conf stays the single source for Nginx.
 * Platform mode: out-of-band calls are GetIPSet / UpdateIPSet on the stack-owned IP set and DescribeLogGroups (read-only).
 */
import type { ModuleId } from '@cloudalbum/contracts';
import type { Ctx } from '../context.js';
import type { PlanStep } from '../deps.js';
import { RemoteScript } from '../deliver.js';
import { CliError, EXIT } from '../printer.js';
import { isEnabled } from '../registry.js';
import { currentEnv } from '../state.js';
import type { HookArgs, ModuleHook, StackPlan } from './types.js';

const ID: ModuleId = 'waf';
const WINDOWS = ['60', '120', '300', '600'];
const IPV4_CIDR = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})(?:\/(\d{1,2}))?$/;
const DENYLIST = '/var/lib/cloudalbum/security/denylist.conf';
export const LOG_GROUP = (env: string) => `aws-waf-logs-cloudalbum-${env}`;

/** IPv4 address or CIDR -> network-aligned CIDR (single address = /32); undefined when invalid (WAF IP sets want CIDRs) */
export function toIpv4Cidr(value: string): string | undefined {
  const m = IPV4_CIDR.exec(value.trim());
  if (!m) return undefined;
  const octets = m.slice(1, 5).map(Number);
  if (octets.some((o) => o > 255)) return undefined;
  const prefix = m[5] === undefined ? 32 : Number(m[5]);
  if (prefix < 1 || prefix > 32) return undefined;
  const n = octets.reduce((a, o) => ((a << 8) | o) >>> 0, 0);
  const mask = prefix === 32 ? 0xffffffff : (~((1 << (32 - prefix)) - 1)) >>> 0;
  const net = (n & mask) >>> 0;
  return `${[24, 16, 8, 0].map((s) => (net >>> s) & 0xff).join('.')}/${prefix}`;
}

/** WAF_LAB_ALLOW_CIDR / --param LabAllowCidr: comma separated IPv4 CIDRs, normalised; '' = empty list */
export function normalizeAllowList(raw: string): string {
  if (/\$\{atl:/.test(raw)) {
    throw new CliError(`waf: LabAllowCidr contains an unreplaced platform placeholder (${raw}); the runner replaces \${atl:workstationPublicCidr} before scripts/module runs`, EXIT.rules, 'BAD_PARAM');
  }
  const items = raw.split(',').map((s) => s.trim()).filter(Boolean);
  const out: string[] = [];
  for (const it of items) {
    const c = toIpv4Cidr(it);
    if (!c) throw new CliError(`waf: LabAllowCidr entry "${it}" is not an IPv4 address or CIDR (the allow-lab IP set is IPV4)`, EXIT.rules, 'BAD_PARAM');
    if (!out.includes(c)) out.push(c);
  }
  return out.join(',');
}

/** active (not expired) entries of denylist.conf -> IPv4 CIDRs of the IP set; IPv6 entries stay local (Nginx geo) */
export function denylistToIpSet(text: string, now = Date.now()): { addresses: string[]; skippedIpv6: number } {
  const set = new Set<string>();
  let skippedIpv6 = 0;
  for (const line of text.split(/\r?\n/)) {
    const m = /^\s*([0-9A-Fa-f.:/]+)\s+1;\s*(?:#(.*))?$/.exec(line);
    if (!m) continue;
    const until = /until=(\S+)/.exec(m[2] ?? '')?.[1];
    if (until && Date.parse(until) <= now) continue;
    if (m[1]!.includes(':')) {
      skippedIpv6 += 1;
      continue;
    }
    const c = toIpv4Cidr(m[1]!);
    if (c) set.add(c);
  }
  return { addresses: [...set].sort(), skippedIpv6 };
}

interface Choice { value: string; from: 'param' | 'setting' | 'previous' | 'default' }

function pick(args: HookArgs, step: PlanStep, prev: Readonly<Record<string, string>> | undefined, param: string, setting: string | undefined, def: string): Choice {
  if (args.params[param] !== undefined) return { value: args.params[param]!, from: 'param' };
  if (setting && step.settings[setting] !== undefined) return { value: step.settings[setting]!, from: 'setting' };
  if (prev?.[param] !== undefined) return { value: prev[param]!, from: 'previous' };
  return { value: def, from: 'default' };
}

export interface WafChoices {
  scope?: 'CLOUDFRONT' | 'REGIONAL';
  alsoRegional: boolean;
  ruleAction: string;
  rateLimit: string;
  loginRateLimit: string;
  rateWindowSec: string;
  labAllowCidr: string;
}

/** Validated choices of this operation (plan and prepare compute the same values). */
export function wafChoices(ctx: Ctx, step: PlanStep, args: HookArgs): WafChoices {
  const env = currentEnv(ctx.state);
  const prev = ctx.state.modules.waf?.params;
  const cdn = isEnabled(env, 'cdn');
  const lb = isEnabled(env, 'load-balancer');
  const ruleAction = pick(args, step, prev, 'RuleAction', 'WAF_RULE_ACTION', 'count').value;
  if (!['count', 'block'].includes(ruleAction)) throw new CliError(`waf: RuleAction=${ruleAction} must be count or block`, EXIT.rules, 'BAD_PARAM');
  const rateLimit = pick(args, step, prev, 'RateLimit', 'WAF_RATE_LIMIT', '300').value;
  const loginRateLimit = pick(args, step, prev, 'LoginRateLimit', undefined, '100').value;
  for (const [k, v] of [['RateLimit', rateLimit], ['LoginRateLimit', loginRateLimit]] as const) {
    if (!/^\d+$/.test(v) || Number(v) < 10 || Number(v) > 2_000_000_000) throw new CliError(`waf: ${k}=${v} must be an integer >= 10 (WAF minimum)`, EXIT.rules, 'BAD_PARAM');
  }
  const rateWindowSec = pick(args, step, prev, 'RateWindowSec', 'WAF_RATE_WINDOW_SEC', '300').value;
  if (!WINDOWS.includes(rateWindowSec)) throw new CliError(`waf: RateWindowSec=${rateWindowSec} must be one of ${WINDOWS.join(' | ')}`, EXIT.rules, 'BAD_PARAM');
  const labAllowCidr = normalizeAllowList(pick(args, step, prev, 'LabAllowCidr', 'WAF_LAB_ALLOW_CIDR', '').value);
  const alsoRegional = (args.params.AlsoRegional ?? prev?.AlsoRegional ?? 'false') === 'true';
  return {
    ...(cdn ? { scope: 'CLOUDFRONT' as const } : lb ? { scope: 'REGIONAL' as const } : {}),
    alsoRegional: alsoRegional && cdn && lb, ruleAction, rateLimit, loginRateLimit, rateWindowSec, labAllowCidr,
  };
}

/** stack region -> CreateLogGroup decided in prepare() (stacks() is synchronous) */
const logGroupDecisions = new WeakMap<Ctx, Record<string, 'true' | 'false'>>();
/** contexts whose plan() already printed the DEP-018 note (prepare() prints it when cdn was enabled by --with-deps) */
const dep018Noted = new WeakSet<Ctx>();

function dep018Note(ctx: Ctx): string | undefined {
  const env = currentEnv(ctx.state);
  if (!isEnabled(env, 'cdn') || (env.CDN_DIRECT_ACCESS ?? 'open') !== 'open' || dep018Noted.has(ctx)) return undefined;
  dep018Noted.add(ctx);
  return 'DEP-018: CDN_DIRECT_ACCESS=open - the EC2 origin is still reachable directly, so the web ACL can be bypassed; lock it with '
    + '`scripts/module enable cdn --set CDN_DIRECT_ACCESS=admin-ip --set CDN_ADMIN_CIDR=<your-ip>/32`';
}

function selectedRegions(ctx: Ctx, c: WafChoices): string[] {
  const env = currentEnv(ctx.state);
  const out: string[] = [];
  if (isEnabled(env, 'cdn')) out.push('us-east-1');
  if (isEnabled(env, 'load-balancer') && (!isEnabled(env, 'cdn') || c.alsoRegional)) out.push(ctx.region);
  return out;
}

async function readDenylist(ctx: Ctx): Promise<string | undefined> {
  const s = new RemoteScript('waf: read security/denylist.conf for the first IP-set import');
  s.line(`cat ${DENYLIST} 2>/dev/null || true`);
  const r = await ctx.deliverer().run(s, { capture: true, timeoutSec: 60 });
  return r.code === 0 ? r.stdout : undefined;
}

export const wafHook: ModuleHook = {
  id: ID,

  planHints(target) {
    if (target.tier !== 'aws') return [];
    return [
      'mount point: cdn (CLOUDFRONT scope, web ACL / IP sets / log group in us-east-1) or load-balancer (REGIONAL); WAF cannot be '
      + 'associated with EC2 / EIP / NLB (DEP-006)',
      'lock the origin (CDN_DIRECT_ACCESS=admin-ip|closed) or attackers bypass the web ACL by calling the EC2 directly (DEP-018)',
    ];
  },

  plan(ctx, step, args) {
    if (step.tier !== 'aws') return {};
    const c = wafChoices(ctx, step, args);
    const settings: Record<string, string> = {
      WAF_RULE_ACTION: c.ruleAction, WAF_RATE_LIMIT: c.rateLimit, WAF_RATE_WINDOW_SEC: c.rateWindowSec, WAF_LAB_ALLOW_CIDR: c.labAllowCidr,
      WAF_ORIGIN_NGINX_LIMIT: step.settings.WAF_ORIGIN_NGINX_LIMIT ?? ctx.state.modules.waf?.env.WAF_ORIGIN_NGINX_LIMIT ?? 'relaxed',
    };
    if (c.scope) settings.WAF_SCOPE = c.scope;
    const notes: string[] = [];
    if (c.scope === 'CLOUDFRONT') {
      notes.push(`stack cloudalbum-${ctx.env}-waf-edge in us-east-1 (CLOUDFRONT scope); the cdn stack gets WebAclArn and the distribution redeploys (minutes)`);
      const dep018 = dep018Note(ctx);
      if (dep018) notes.push(dep018);
    } else if (c.scope === 'REGIONAL') {
      notes.push(`stack cloudalbum-${ctx.env}-waf-regional in ${ctx.region} (REGIONAL scope, WebACLAssociation with the ALB)`);
    }
    if (c.alsoRegional) notes.push('AlsoRegional=true: a second (REGIONAL) web ACL on the ALB as defence in depth; rate keys use FORWARDED_IP; the request charges double');
    if (c.ruleAction === 'count') notes.push('RuleAction=count: managed rule groups only count; read the COUNT records, then `scripts/module enable waf --param RuleAction=block`');
    if (c.labAllowCidr) notes.push(`LabAllowCidr=${c.labAllowCidr}: these addresses skip EVERY rule (allow-lab); keep it empty for the waf experiments and clear it after load tests`);
    return { settings, notes };
  },

  async prepare(ctx, step, args, p) {
    if (step.tier !== 'aws') return;
    const c = wafChoices(ctx, step, args);
    // dependencies enabled by --with-deps (cdn) are in the state now: the scope is known even when plan() could not tell
    if (c.scope) p.settings.WAF_SCOPE = c.scope;
    const dep018 = dep018Note(ctx);
    if (dep018) p.notes.push(`waf: ${dep018}`);
    Object.assign(p.params, {
      RuleAction: c.ruleAction, RateLimit: c.rateLimit, LoginRateLimit: c.loginRateLimit, RateWindowSec: c.rateWindowSec, LabAllowCidr: c.labAllowCidr,
      AlsoRegional: c.alsoRegional ? 'true' : 'false',
    });
    // the retained log group of an earlier deployment is adopted instead of failing on AlreadyExists
    const prev = ctx.state.modules.waf;
    const decisions: Record<string, 'true' | 'false'> = {};
    for (const region of selectedRegions(ctx, c)) {
      const deployed = prev?.stacks.some((s) => (s.region ?? ctx.region) === region);
      if (deployed) {
        decisions[region] = prev?.params.CreateLogGroup === 'false' ? 'false' : 'true';   // never flipped on an update
        continue;
      }
      const r = await ctx.aws.send<{ logGroups?: Array<{ logGroupName?: string }> }>({
        service: 'logs', op: 'DescribeLogGroups', region, input: { logGroupNamePrefix: LOG_GROUP(ctx.env), limit: 5 },
      });
      if (r === undefined) {
        decisions[region] = 'true';
        p.notes.push(`waf: (dry-run) DescribeLogGroups ${LOG_GROUP(ctx.env)} [${region}] not executed: assuming the stack creates the log group`);
      } else if (r.logGroups?.some((g) => g.logGroupName === LOG_GROUP(ctx.env))) {
        decisions[region] = 'false';
        p.notes.push(`waf: log group ${LOG_GROUP(ctx.env)} [${region}] already exists (retained by an earlier disable): adopted`);
      } else {
        decisions[region] = 'true';
      }
    }
    logGroupDecisions.set(ctx, decisions);
  },

  stacks(ctx, _step, args, selected) {
    const env = currentEnv(ctx.state);
    const prevAlso = ctx.state.modules.waf?.params.AlsoRegional;
    const also = (args.params.AlsoRegional ?? prevAlso ?? 'false') === 'true';
    const hasEdge = selected.some((s) => s.name === 'edge');
    const decisions = logGroupDecisions.get(ctx) ?? {};
    const out: StackPlan[] = [];
    for (const s of selected) {
      if (s.name === 'regional' && hasEdge && !also) {
        ctx.out.info(`      waf: cdn and load-balancer are both enabled -> edge only (add --param AlsoRegional=true for a second web ACL on the ALB)`);
        continue;
      }
      const regional = s.name === 'regional';
      const forwarded = regional && isEnabled(env, 'cdn');
      if (forwarded) {
        ctx.out.info('      waf: regional web ACL behind CloudFront: IP sets match the LAST X-Forwarded-For address (appended by CloudFront; '
          + 'the first one is client controlled) and it has no rate-based rules — rate limiting stays on the CLOUDFRONT web ACL');
      }
      out.push({
        ...s,
        params: {
          ...(s.params ?? {}),
          StackRole: s.name, Scope: regional ? 'REGIONAL' : 'CLOUDFRONT',
          // an ALB behind CloudFront sees CloudFront addresses: the IP sets read X-Forwarded-For (Position LAST) and the
          // template leaves the rate-based rules out (WAF aggregates FORWARDED_IP on the spoofable first address; wave1-fix)
          RateKey: forwarded ? 'FORWARDED_IP' : 'IP',
          CreateLogGroup: decisions[s.region] ?? 'true',
        },
      });
    }
    return out;
  },

  async afterDeploy(ctx, _step, args, deployed) {
    if (args.planOnly) return;
    const edge = deployed.byStack.edge ? 'edge' : Object.keys(deployed.byStack)[0];
    const o = (edge ? deployed.byStack[edge] : undefined) ?? deployed.outputs;
    const scope = o.EnvWafScope ?? (edge === 'regional' ? 'REGIONAL' : 'CLOUDFRONT');
    const region = deployed.stacks.find((s) => s.name === edge)?.region ?? (scope === 'CLOUDFRONT' ? 'us-east-1' : ctx.region);
    if (ctx.dryRun) {
      ctx.out.dry(`first import: read ${DENYLIST} on the instance, then wafv2:GetIPSet + UpdateIPSet ${o.EnvWafIpSetName ?? 'cloudalbum-blocklist'} [${region}]`);
      return;
    }
    try {
      const text = await readDenylist(ctx);
      if (text === undefined) {
        ctx.out.warn('      waf: could not read denylist.conf on the instance; the worker (aws driver) imports it within a minute');
        return;
      }
      const want = denylistToIpSet(text);
      const key = { Name: o.EnvWafIpSetName ?? 'cloudalbum-blocklist', Scope: scope, Id: o.EnvWafIpSetId ?? '' };
      for (let attempt = 1; ; attempt += 1) {
        const got = await ctx.aws.send<{ IPSet?: { Addresses?: string[]; Description?: string }; LockToken?: string }>({ service: 'wafv2', op: 'GetIPSet', region, input: key });
        const current = [...(got?.IPSet?.Addresses ?? [])].sort();
        if (current.join(',') === want.addresses.join(',')) {
          ctx.out.info(`      waf: IP set ${key.Name} already matches denylist.conf (${want.addresses.length} IPv4 entries)`);
          break;
        }
        try {
          await ctx.aws.send({
            service: 'wafv2', op: 'UpdateIPSet', region,
            input: { ...key, Addresses: want.addresses, LockToken: got?.LockToken, ...(got?.IPSet?.Description ? { Description: got.IPSet.Description } : {}) },
          });
          ctx.out.info(`      waf: imported ${want.addresses.length} IPv4 entries of denylist.conf into ${key.Name}${want.skippedIpv6 ? ` (${want.skippedIpv6} IPv6 entries stay local)` : ''}`);
          break;
        } catch (e) {
          if (attempt < 3 && /WAFOptimisticLockException/.test(String((e as Error)?.message ?? e))) continue;
          throw e;
        }
      }
    } catch (e) {
      ctx.out.warn(`      waf: first IP-set import failed (${(e as Error).message}); the worker (aws driver) retries every minute`);
    }
  },

  beforeDisable(_ctx, rec) {
    const notes = [
      'the cdn stack gets WebAclArn=\'\' first (a web ACL that is still associated cannot be deleted); the distribution redeploys',
      'WAF_MODE=nginx again: Nginx limit_req / signature blocking / denylist.conf (unchanged, still read by Nginx)',
    ];
    if (rec.env.WAF_LAB_ALLOW_CIDR) notes.push(`WAF_LAB_ALLOW_CIDR=${rec.env.WAF_LAB_ALLOW_CIDR} is dropped with the env`);
    return { notes };
  },

  afterDisable(ctx, rec) {
    const regions = [...new Set(rec.stacks.map((s) => s.region ?? ctx.region))];
    for (const region of regions.length ? regions : ['us-east-1']) {
      ctx.out.warn(`      waf: log group ${LOG_GROUP(ctx.env)} [${region}] is retained (data protection); delete it when no longer needed: `
        + `aws logs delete-log-group --region ${region} --log-group-name ${LOG_GROUP(ctx.env)}`);
    }
  },
};
