/**
 * scripts/module hook of dns (Amazon Route 53). Contract: ./types.ts.
 * Design: docs/modules/01-edge-network-scaling.md#dns (section 6 "切换、数据迁移与回滚", section 0 registry entry, section 12 platform mode).
 *
 *   plan()          the manual prerequisite "domain": without --domain (and nothing from an earlier enable) the step returns
 *                   `missing` with the hint -> `enable` exits 2 before anything is deployed, `plan` prints it and skips (exit 0).
 *                   Settings: DNS_RECORD_NAME, DNS_TARGET_TYPE (--target, else automatic: cdn + tls -> cloudfront,
 *                   load-balancer -> alb, else eip), DNS_ROUTING_POLICY, DNS_CANONICAL_REDIRECT. Local tier `external`:
 *                   APP_BASE_URL=http://<domain> only (no AWS). --zone-id is checked with route53:GetHostedZone (read-only).
 *   prepare()       stack parameters: DomainName, ExistingHostedZoneId (--zone-id, an earlier one, or a zone retained by an
 *                   earlier disable), TargetType, TargetIp (EIP), RoutingPolicy, Ttl, AppScheme (https only when a trusted
 *                   certificate covers the domain: tls ACME / Let's Encrypt on Nginx, CloudFront alias with the edge
 *                   certificate, ALB with HTTPS), HealthCheckPrefixListId (--param HealthCheckIngress=prefix-list).
 *   afterDeploy()   new hosted zone: print the NS records and poll the public delegation (--param DelegationWaitMin=15; a
 *                   pending delegation only warns: the detector reports NXDOMAIN until it is in place); failover: upload the
 *                   maintenance page to the S3 website bucket.
 *   beforeDisable() empty the maintenance bucket (the stack deletes it); reminders.
 *   afterDisable()  the hosted zone is retained (DeletionPolicy Retain, monthly charge): recorded in state.json outOfBand
 *                   (reused by the next `enable dns`), or deleted with --param PurgeHostedZone=true; dangling NS delegation
 *                   reminder (platform mode: a security item of the session's cleanup list, 01#dns section 12).
 * Platform mode out-of-band calls (06 PM-34, registry `platform` field pending): route53 GetHostedZone / DeleteHostedZone,
 * ec2 DescribeManagedPrefixLists, s3 PutObject / DeleteObject on the maintenance bucket.
 */
import { Resolver } from 'node:dns/promises';
import type { Ctx } from '../context.js';
import type { ModuleTarget, PlanStep } from '../deps.js';
import type { EnvMap } from '../env-file.js';
import type { Prepared } from '../hooks.js';
import { CliError, EXIT } from '../printer.js';
import { isEnabled } from '../registry.js';
import { currentEnv, nowIso, type ModuleRecord } from '../state.js';
import type { DeployedStacks, HookArgs, HookPlanResult, MissingPrerequisite, ModuleHook } from './types.js';

const HOST_RE = /^(?=.{1,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z][a-z0-9-]{0,62}$/;
const TARGETS = ['eip', 'alb', 'cloudfront'] as const;
const POLICIES = ['simple', 'failover', 'weighted'] as const;

export const DOMAIN_PREREQUISITE_HINT = '需要自有域名（人工前置）：本账号已有它（或其子域）的 Route 53 公有托管区域（--zone-id），'
  + '或能在注册商 / 父域为它添加 NS 委派。没有域名时跳过本模块：plan 打印提示并跳过（退出码 0），enable 不部署任何东西（退出码 2）';

/** Lower-case, no trailing dot. */
export function normalizeDomain(raw: string): string {
  return raw.trim().toLowerCase().replace(/\.$/, '');
}

/** Why a name cannot be used as the app domain (undefined = fine). ACM / Route 53 need a real, own domain. */
export function domainProblem(domain: string): string | undefined {
  if (!domain) return '域名为空';
  if (/^\d+(\.\d+){3}$/.test(domain) || domain.includes(':')) return `${domain} 是 IP 地址：dns / tls 需要自有域名（IP 证书属于 tls 本地档 letsencrypt 的预览方案）`;
  if (!HOST_RE.test(domain)) return `${domain} 不是合法的主机名（小写字母、数字、连字符，至少两段）`;
  if (/(^|\.)(amazonaws\.com|cloudfront\.net|elb\.amazonaws\.com|localhost|invalid|test|example)$/.test(domain)) {
    return `${domain} 不是你自己的域名（amazonaws.com / cloudfront.net 与保留顶级域不能建托管区域，也不能申请证书）`;
  }
  return undefined;
}

export function missingDomain(id: 'dns' | 'tls', extra = ''): MissingPrerequisite {
  return {
    prerequisite: 'domain',
    message: `没有提供自有域名（--domain）。${id} 需要一个你能管理 DNS 的域名${extra}`,
    hint: id === 'dns'
      ? 'scripts/module enable dns --domain album.example.com [--zone-id Z…] [--target eip|alb|cloudfront]；没有域名时跳过 dns（L0 继续用 http://<EIP>）'
      : 'scripts/module enable tls --domain album.example.com [--zone-id Z…] [--no-acme]；没有域名时跳过 tls（L0 继续用自签名证书）',
  };
}

function hostOfUrl(url: string | undefined): string {
  if (!url) return '';
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return '';
  }
}

/** Automatic DNS_TARGET_TYPE (01#dns section 2): cdn (with the tls edge certificate) -> cloudfront, load-balancer -> alb, else eip. */
export function autoTarget(env: Readonly<EnvMap>): { target: (typeof TARGETS)[number]; note?: string } {
  if (isEnabled(env, 'cdn') && isEnabled(env, 'tls')) return { target: 'cloudfront' };
  if (isEnabled(env, 'cdn')) {
    return { target: 'eip', note: 'cdn 已启用但 tls 未启用：Alias 到 CloudFront 需要分配上配置该域名，而这需要 us-east-1 证书（DEP-041）。先用 eip；启用 tls 后执行 scripts/module enable dns --target cloudfront' };
  }
  if (isEnabled(env, 'load-balancer')) return { target: 'alb' };
  return { target: 'eip' };
}

/** https only when a trusted certificate covers the domain on the entry the record points to (01#dns section 3). */
export function appScheme(env: Readonly<EnvMap>, domain: string, target: string): 'http' | 'https' {
  const tlsDomain = (env.TLS_DOMAIN ?? '').toLowerCase();
  if (tlsDomain !== domain) return 'http';
  if (target === 'cloudfront') return isEnabled(env, 'cdn') && isEnabled(env, 'tls') && Boolean(env.ACM_CERT_ARN_EDGE) ? 'https' : 'http';
  if (target === 'alb') return env.LB_HTTPS === 'true' ? 'https' : 'http';
  if (env.TLS_MODE === 'acm' && env.TLS_ACME === 'on') return 'https';
  if (env.TLS_MODE === 'letsencrypt') return 'https';
  return 'http';
}

function retainedZone(ctx: Ctx, domain: string): { id: string } | undefined {
  const z = ctx.state.outOfBand.find((x) => x.module === 'dns' && x.kind === 'hosted-zone' && x.detail?.domain === domain);
  return z ? { id: z.id } : undefined;
}

function enumOf<T extends readonly string[]>(values: T, v: string | undefined, name: string): T[number] | undefined {
  if (v === undefined || v === '') return undefined;
  if (!(values as readonly string[]).includes(v)) throw new CliError(`dns: ${name}=${v} is not one of ${values.join(' | ')}`, EXIT.rules, 'USAGE');
  return v as T[number];
}

/** Public delegation check: NS seen by public resolvers == NS of the hosted zone. */
export function delegationMatches(seen: readonly string[], zoneNs: readonly string[]): boolean {
  const n = (s: string) => s.toLowerCase().replace(/\.$/, '');
  const want = new Set(zoneNs.map(n));
  return seen.length > 0 && seen.every((s) => want.has(n(s)));
}

async function publicNs(zone: string): Promise<string[]> {
  for (const servers of [['8.8.8.8', '1.1.1.1'], undefined]) {
    const r = new Resolver({ timeout: 3000, tries: 2 });
    if (servers) r.setServers(servers);
    try {
      return await r.resolveNs(zone);
    } catch {
      /* next resolver */
    }
  }
  return [];
}

const MAINTENANCE_HTML = [
  '<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><title>CloudAlbum 维护中</title></head>',
  '<body style="font-family:sans-serif;text-align:center;margin-top:15vh"><h1>CloudAlbum 正在维护</h1>',
  '<p>主站点暂时不可用：这是 Route 53 故障转移的 SECONDARY 记录指向的 S3 静态维护页（01#dns failover）。</p></body></html>',
].join('\n');

export const dnsHook: ModuleHook = {
  id: 'dns',

  /** The domain hint only when the target does not name the domain (cards set DNS_RECORD_NAME from learner.inputs.domain). */
  planHints(target: ModuleTarget): string[] {
    return target.settings.DNS_RECORD_NAME || (target.tier === 'local' && target.settings.APP_BASE_URL) ? [] : [DOMAIN_PREREQUISITE_HINT];
  },

  async plan(ctx: Ctx, step: PlanStep, args: HookArgs): Promise<HookPlanResult> {
    const prev = ctx.state.modules.dns?.env ?? {};
    const raw = args.domain ?? step.settings.DNS_RECORD_NAME ?? prev.DNS_RECORD_NAME
      ?? (step.tier === 'local' ? hostOfUrl(step.settings.APP_BASE_URL ?? prev.APP_BASE_URL) || undefined : undefined);
    if (!raw) return { missing: [missingDomain('dns', '（已有托管区域，或能在注册商处设置 NS 委派）')] };
    const domain = normalizeDomain(raw);
    const bad = domainProblem(domain);
    if (bad) throw new CliError(`dns: ${bad}`, EXIT.rules, 'DOMAIN_INVALID');
    const ip = ctx.state.base?.publicIp ?? '<EIP>';

    if (step.tier === 'local') {
      // local tier "external" (01#dns section 1): an A record at your own registrar; no MODULE_DNS, no AWS resource
      return {
        settings: { APP_BASE_URL: step.settings.APP_BASE_URL ?? `http://${domain}` },
        notes: [`本地档 external：不部署任何 AWS 资源。请在你的注册商处为 ${domain} 建 A 记录 → ${ip}（TTL 300）`],
      };
    }

    const env = currentEnv(ctx.state);
    const notes: string[] = [];
    let target = enumOf(TARGETS, args.target ?? step.settings.DNS_TARGET_TYPE, '--target');
    if (!target) {
      const auto = autoTarget(env);
      target = auto.target;
      if (auto.note) notes.push(auto.note);
      else notes.push(`DNS_TARGET_TYPE=${target}（自动选择：${target === 'cloudfront' ? 'cdn + tls 已启用' : target === 'alb' ? 'load-balancer 已启用' : '只有 L0'}；用 --target 指定）`);
    }
    const policy = enumOf(POLICIES, args.params.RoutingPolicy ?? step.settings.DNS_ROUTING_POLICY, 'RoutingPolicy') ?? 'simple';
    if (policy === 'failover') notes.push('failover：PRIMARY = EIP + 健康检查（会自动加上 --param EnableHealthCheck=true），SECONDARY = 与记录同名的 S3 网站桶（只支持 HTTP）');

    if (args.zoneId) {
      const z = await ctx.aws.send<{ HostedZone?: { Name?: string; Config?: { PrivateZone?: boolean } } }>({
        service: 'route53', op: 'GetHostedZone', input: { Id: args.zoneId },
      });
      if (z) {
        const zoneName = normalizeDomain(z.HostedZone?.Name ?? '');
        if (z.HostedZone?.Config?.PrivateZone) throw new CliError(`dns: ${args.zoneId} 是私有托管区域，公网解析不到它`, EXIT.rules, 'ZONE_PRIVATE');
        if (domain !== zoneName && !domain.endsWith(`.${zoneName}`)) {
          throw new CliError(`dns: 托管区域 ${args.zoneId}（${zoneName}）不包含 ${domain}`, EXIT.rules, 'ZONE_MISMATCH');
        }
        notes.push(`使用已有托管区域 ${args.zoneId}（${zoneName}）：不需要等待 NS 委派`);
      }
    } else if (retainedZone(ctx, domain)) {
      notes.push(`复用上次禁用时保留的托管区域 ${retainedZone(ctx, domain)!.id}（NS 不变，不需要重新委派）`);
    } else if (!ctx.state.modules.dns?.params.ExistingHostedZoneId) {
      notes.push(`将新建公有托管区域 ${domain}：部署后到注册商或父域为它添加 NS 委派（生效时间由注册商与顶级域决定，可能超过卡片时长）`);
    }
    return {
      settings: {
        DNS_RECORD_NAME: domain, DNS_TARGET_TYPE: target, DNS_ROUTING_POLICY: policy,
        DNS_CANONICAL_REDIRECT: step.settings.DNS_CANONICAL_REDIRECT ?? prev.DNS_CANONICAL_REDIRECT ?? 'off',
      },
      notes,
    };
  },

  async prepare(ctx: Ctx, step: PlanStep, args: HookArgs, p: Prepared): Promise<void> {
    if (step.tier !== 'aws') return;
    const s = step.settings;
    const domain = s.DNS_RECORD_NAME!;
    const target = s.DNS_TARGET_TYPE ?? 'eip';
    const prevParams = ctx.state.modules.dns?.params ?? {};
    p.params.DomainName = domain;
    const zone = args.zoneId ?? retainedZone(ctx, domain)?.id ?? prevParams.ExistingHostedZoneId;
    if (zone) p.params.ExistingHostedZoneId = zone;
    p.params.TargetType = target;
    p.params.TargetIp = ctx.ph(ctx.state.base?.publicIp, 'ec2:PublicIp');
    p.params.RoutingPolicy = s.DNS_ROUTING_POLICY ?? 'simple';
    if (s.DNS_TTL) p.params.Ttl = s.DNS_TTL;
    if (p.params.RoutingPolicy === 'failover') p.params.EnableHealthCheck = 'true';
    const env = currentEnv(ctx.state);
    p.params.AppScheme = appScheme(env, domain, target);
    if (p.params.AppScheme === 'http' && (env.TLS_DOMAIN ?? '').toLowerCase() === domain) {
      p.notes.push('tls 已启用，但入口上还没有覆盖该域名的受信任证书：APP_BASE_URL 先写 http；证书就绪后重新执行 scripts/module enable dns');
    }
    if ((args.params.HealthCheckIngress ?? '') === 'prefix-list') {
      const r = await ctx.aws.send<{ PrefixLists?: Array<{ PrefixListId?: string }> }>({
        service: 'ec2', op: 'DescribeManagedPrefixLists',
        input: { Filters: [{ Name: 'prefix-list-name', Values: [`com.amazonaws.${ctx.region}.route53-healthchecks`] }] },
      });
      p.params.HealthCheckPrefixListId = ctx.ph(r?.PrefixLists?.[0]?.PrefixListId, 'pl:route53-healthchecks');
      p.notes.push('健康检查器前缀列表在安全组配额中按 25 条计算；独立安全组经 ExtraSecurityGroupIds 挂到实例（覆盖范围以官方文档为准）');
    }
    p.settings.DNS_CANONICAL_REDIRECT = s.DNS_CANONICAL_REDIRECT ?? 'off';
    if (p.params.EnableHealthCheck === 'true' || args.params.EnableHealthCheck === 'true') {
      p.notes.push('Route 53 健康检查检查 origin.<域名>/api/health/ready?scope=instance；它的指标与告警在 us-east-1');
    }
  },

  async afterDeploy(ctx: Ctx, step: PlanStep, args: HookArgs, deployed: DeployedStacks): Promise<void> {
    if (step.tier !== 'aws') return;
    const o = deployed.outputs;
    const domain = step.settings.DNS_RECORD_NAME ?? o.EnvDnsRecordName ?? '';
    const ns = (o.InfoNameServers ?? '').split(',').map((x) => x.trim()).filter((x) => x && !x.startsWith('<'));
    if (o.InfoHostedZoneCreated === 'true') {
      ctx.out.warn(`      dns: 新建的托管区域 ${domain} 的名称服务器——到注册商或父域添加 NS 委派：`);
      for (const n of ns.length ? ns : ['<ns-1.awsdns-xx.org>', '<ns-2.awsdns-xx.co.uk>', '<ns-3.awsdns-xx.com>', '<ns-4.awsdns-xx.net>']) {
        ctx.out.warn(`        ${domain}.  NS  ${n}.`);
      }
      const minutes = Number(args.params.DelegationWaitMin ?? 15);
      if (!ctx.dryRun && ns.length && minutes > 0) {
        ctx.out.info(`      dns: 等待委派生效（公共解析器看到上述 NS；最多 ${minutes} 分钟，--param DelegationWaitMin=0 跳过）`);
        const deadline = Date.now() + minutes * 60_000;
        let ok = false;
        for (;;) {
          if (delegationMatches(await publicNs(domain), ns)) { ok = true; break; }
          if (Date.now() > deadline) break;
          await new Promise((r) => setTimeout(r, 20_000));
        }
        if (ok) ctx.out.info('      dns: 委派已生效');
        else ctx.out.warn(`      dns: 委派在 ${minutes} 分钟内未生效：继续启用；在它生效之前 dns 的状态为 degraded / error（名称无法解析）。生效后无需重新执行`);
      }
    }
    if (o.InfoMaintenanceBucket) {
      await ctx.aws.send({
        service: 's3', op: 'PutObject',
        input: { Bucket: o.InfoMaintenanceBucket, Key: 'maintenance.html', Body: MAINTENANCE_HTML, ContentType: 'text/html; charset=utf-8', CacheControl: 'no-store' },
        display: { Bucket: o.InfoMaintenanceBucket, Key: 'maintenance.html', Body: `<${MAINTENANCE_HTML.length} bytes>` },
      });
      ctx.out.info(`      dns: 维护页已上传到 http://${o.InfoMaintenanceBucket}（failover SECONDARY；S3 网站端点只支持 HTTP）`);
    }
    if (ctx.platform) {
      ctx.out.info('      dns: 平台模式——托管区域与记录带平台标签；手工在控制台创建的记录由平台的定向扫描确认归属');
    }
  },

  async beforeDisable(ctx: Ctx, rec: ModuleRecord, args: HookArgs): Promise<{ notes: string[] }> {
    const notes: string[] = [];
    // 01#dns section 6: records that tls depends on (validation CNAMEs) block the disable. Updating the tls stacks with an empty
    // HostedZoneId would replace the ACME domain validation / the integration certificates (create-only properties).
    const tls = ctx.state.modules.tls;
    const zone = rec.env.DNS_HOSTED_ZONE_ID ?? '';
    if (rec.tier === 'aws' && tls?.tier === 'aws' && zone && (tls.params.HostedZoneId ?? '') === zone && (args.params.Force ?? '') !== 'true') {
      throw new CliError(`dns: tls 的验证记录（ACME 域验证 / ACM DNS 验证的 CNAME）在托管区域 ${zone} 中，禁用 dns 会让 tls 栈以空的 HostedZoneId 更新并替换`
        + '域验证与证书。先执行 scripts/module disable tls；确实要先禁用 dns 时加 --param Force=true（之后的续期需要你在外部 DNS 中手工添加验证 CNAME）',
      EXIT.rules, 'DNS_IN_USE');
    }
    // the same for email (wave1-fix): a Domain identity keeps its 3 DKIM CNAMEs and the MAIL FROM records in this zone; the
    // generic step 5 would update the email stack with an empty HostedZoneId, silently deleting them (DKIM / verification
    // of the SES domain identity fail afterwards)
    const email = ctx.state.modules.email;
    if (rec.tier === 'aws' && email?.tier === 'aws' && zone && (email.params.Domain ?? '') !== '' && (email.params.HostedZoneId ?? '') === zone) {
      const dkim = email.outputs.InfoDkimRecords ?? '';
      if ((args.params.Force ?? '') !== 'true') {
        throw new CliError(`dns: email 的域名身份 ${email.params.Domain} 的 DKIM CNAME 与 MAIL FROM 记录在托管区域 ${zone} 中，禁用 dns 会让 email 栈以空的 `
          + 'HostedZoneId 更新并删除这些记录（之后 SES 的 DKIM 与域验证失效、发信失败）。先执行 scripts/module disable email；确实要先禁用 dns 时加 '
          + '--param Force=true，并在外部 DNS 中手工补回这些记录', EXIT.rules, 'DNS_IN_USE');
      }
      ctx.out.warn(`      dns: Force=true——email 的 DKIM / MAIL FROM 记录将随 HostedZoneId 置空而删除；请在外部 DNS 中手工补回：`);
      for (const r of dkim.split(' | ').filter((x) => x && !x.startsWith('n/a'))) ctx.out.warn(`        ${r}`);
      if (!dkim) ctx.out.warn('        （DKIM 记录见 email 栈的输出 InfoDkimRecords，或 aws sesv2 get-email-identity 的 DkimAttributes.Tokens）');
      if (email.params.MailFromDomain) ctx.out.warn(`        MAIL FROM ${email.params.MailFromDomain}：MX 与 SPF TXT（见 SES 控制台的“自定义 MAIL FROM 域”）`);
      notes.push(`email 的 DKIM / MAIL FROM 记录不再由 Route 53 托管：在外部 DNS 补回之前，${email.params.Domain} 的 DKIM 与 MAIL FROM 验证会失效`);
    }
    const bucket = rec.outputs.InfoMaintenanceBucket;
    if (bucket) {
      await ctx.aws.send({ service: 's3', op: 'DeleteObject', input: { Bucket: bucket, Key: 'maintenance.html' } }).catch(() => undefined);
      notes.push(`维护页桶 ${bucket} 已清空，随栈删除`);
    }
    if (rec.tier === 'local') notes.push('本地档 external：请到你的注册商删除指向 EIP 的 A 记录（如果不再需要）');
    return { notes };
  },

  async afterDisable(ctx: Ctx, rec: ModuleRecord, args: HookArgs): Promise<void> {
    if (rec.tier !== 'aws') return;
    const zoneId = rec.env.DNS_HOSTED_ZONE_ID ?? rec.outputs.EnvDnsHostedZoneId ?? '';
    const domain = rec.env.DNS_RECORD_NAME ?? '';
    const created = rec.outputs.InfoHostedZoneCreated === 'true' || Boolean(rec.outputs.InfoNameServers)
      || ctx.state.outOfBand.some((x) => x.module === 'dns' && x.kind === 'hosted-zone' && x.id === zoneId);
    if (created && zoneId) {
      ctx.state.outOfBand = ctx.state.outOfBand.filter((x) => !(x.module === 'dns' && x.kind === 'hosted-zone' && x.id === zoneId));
      if ((args.params.PurgeHostedZone ?? '') === 'true' || args.purge) {
        // the stack already deleted every record of the module; only NS / SOA are left
        await ctx.aws.send({ service: 'route53', op: 'DeleteHostedZone', input: { Id: zoneId } });
        ctx.out.info(`      dns: 托管区域 ${zoneId} 已删除（${args.purge ? '--purge' : '--param PurgeHostedZone=true'}）；重新启用会得到新的 NS，需要重新委派`);
      } else {
        ctx.state.outOfBand.push({
          module: 'dns', kind: 'hosted-zone', id: zoneId, at: nowIso(), region: 'global',
          detail: { domain, retained: 'true', nameServers: rec.outputs.InfoNameServers ?? '' },
        });
        ctx.out.warn(`      dns: 托管区域 ${zoneId}（${domain}）已保留（DeletionPolicy Retain，按月计费）：下次 enable dns 自动复用，`
          + `NS 不变；确认不再使用时执行 scripts/module disable dns --purge（或 --param PurgeHostedZone=true），或 aws route53 delete-hosted-zone --id ${zoneId}`);
      }
      ctx.out.warn(`      dns: 删除托管区域前，先到注册商或父域删除 ${domain} 的 NS 委派，否则留下悬空委派（子域可能被他人接管）`);
      if (ctx.platform) {
        ctx.state.outOfBand.push({
          module: 'dns', kind: 'dangling-delegation', id: domain, at: nowIso(), region: 'global',
          detail: { severity: 'security', action: `remove the NS delegation of ${domain} at the registrar / parent zone` },
        });
      }
    }
    if (rec.env.DNS_CANONICAL_REDIRECT === 'on') ctx.out.info('      dns: DNS_CANONICAL_REDIRECT 已随 dns.env 移除，IP 访问不再 301');
  },
};
