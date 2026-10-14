/**
 * scripts/module hook of tls (AWS Certificate Manager). Contract: ./types.ts.
 * Design: docs/modules/01-edge-network-scaling.md#tls (section 6 "切换、数据迁移与回滚", section 0 registry entry, section 12 platform mode).
 *
 *   plan()          manual prerequisite "domain" (--domain, an earlier TLS_DOMAIN, or the record name of an enabled dns): without
 *                   it `missing` -> enable exits 2 / plan skips. preflight acme-endpoint: acm ListAcmeEndpoints with the
 *                   deployer identity (read-only, also in `plan`); available -> TLS_ACME=on, unavailable (unknown operation,
 *                   region, AccessDenied / SCP) or --no-acme -> TLS_ACME=off, the fallback branch whose dependencies (DEP-005 3:
 *                   dns | external DNS, cdn | load-balancer) are then checked by the generic planner. --dry-run does not call
 *                   AWS: it plans with TLS_ACME=on (the value of the single-module profile) and says so.
 *                   Local tier letsencrypt: TLS_DOMAIN only (no AWS; issuance by the hostSetup over HTTP-01).
 *   prepare()       DomainName, AcmeEnabled, HostedZoneId (--zone-id; otherwise injected by dns); TLS_FORCE_HTTPS only with a
 *                   trusted certificate on the direct listener (DEP-015 spirit: never self-signed + HSTS).
 *   stacks()        StackRole=main|edge|regional per registry stack (edge in us-east-1 from the registry).
 *   afterDeploy()   TLS_ACME=on: ACME domain validation CNAME (printed when no hosted zone), wait for VALID
 *                   (--param ValidationWaitMin, default 30; ACM keeps trying for up to 72 h, re-running enable resumes),
 *                   EAB valid for 1 day -> certbot registration + issuance on the instance over the delivery channel
 *                   (ssh: stdin; SSM: a SecureString hand-off parameter deleted right after), delete the EAB, record endpoint /
 *                   validation / EAB / account / certificate in state.json outOfBand. The Nginx symlinks switch in step 7 (hostSetup).
 *   beforeDisable() optional `--param RevokeAcme=true` (ACME revoke-cert; ACM RevokeCertificate cannot revoke ACME certificates).
 *   afterDisable()  purge the certbot lineage and the ACME account of the deleted endpoint (01#tls section 6 step 7); reminders.
 * Platform mode out-of-band calls (06 PM-34, registry `platform` field pending): acm ListAcmeEndpoints,
 * DescribeAcmeDomainValidation, CreateAcmeExternalAccountBinding, GetAcmeExternalAccountBindingCredentials,
 * DeleteAcmeExternalAccountBinding, SearchCertificates; ssm PutParameter / DeleteParameter of the EAB hand-off.
 */
import { randomBytes } from 'node:crypto';
import type { Ctx } from '../context.js';
import type { ModuleTarget, PlanStep } from '../deps.js';
import { lastJsonLine, RemoteScript, shq } from '../deliver.js';
import type { Prepared } from '../hooks.js';
import { CliError, EXIT } from '../printer.js';
import { isEnabled } from '../registry.js';
import { currentEnv, nowIso, type ModuleRecord } from '../state.js';
import { domainProblem, missingDomain, normalizeDomain } from './dns.js';
import type { DeployedStacks, HookArgs, HookDisableResult, HookPlanResult, ModuleHook, StackPlan } from './types.js';

const HOST_SETUP = '/opt/cloudalbum/infra/modules/tls/host-setup.sh';

export const TLS_DOMAIN_HINT = '需要自有域名（人工前置），并能在它的 DNS 中添加 CNAME（ACME 域验证或 ACM DNS 验证）与 A 记录（→ EIP）；'
  + '没有域名时跳过本模块：plan 打印提示并跳过（退出码 0），enable 不部署任何东西（退出码 2）';

export interface AcmeProbe { available: boolean | undefined; reason: string }

/** preflight acme-endpoint (01#tls section 6 step 1): read-only ListAcmeEndpoints with the deployer identity. */
export async function probeAcmeEndpoint(ctx: Ctx): Promise<AcmeProbe> {
  try {
    const r = await ctx.aws.send<{ AcmeEndpoints?: unknown[] }>({ service: 'acm', op: 'ListAcmeEndpoints', input: { MaxResults: 1 } });
    if (r === undefined) return { available: undefined, reason: 'dry-run：未调用 acm:ListAcmeEndpoints' };
    return { available: true, reason: `acm:ListAcmeEndpoints 可用（${ctx.region}）` };
  } catch (e) {
    const m = (e as Error)?.message ?? String(e);
    return { available: false, reason: `acm:ListAcmeEndpoints 不可用：${m.slice(0, 200)}` };
  }
}

function stepHasPlaceholders(v: string | undefined): boolean {
  return !v || v.startsWith('<');
}

export const tlsHook: ModuleHook = {
  id: 'tls',

  /**
   * Hints for plan --single / --start-of when the target does not name TLS_DOMAIN. Cards set TLS_DOMAIN from
   * learner.inputs.domain and declare the prerequisite in prerequisites.learnerInputs, so they get no free-text warning.
   */
  planHints(target: ModuleTarget): string[] {
    if (target.settings.TLS_DOMAIN) return [];
    const hints = [TLS_DOMAIN_HINT];
    if (target.settings.TLS_ACME === 'off') {
      hints.push('回退分支（TLS_ACME=off）：证书只以集成证书形式挂在 CloudFront（us-east-1）或 ALB 上，需要 dns 或外部 DNS（DNS_PROVIDER=external）以及 cdn 或 load-balancer（DEP-005 ③）');
    } else if (target.tier === 'aws') {
      hints.push('ACME 端点在 enable 时探测（preflight acme-endpoint）；不可用时自动回退为 TLS_ACME=off，并按 DEP-005 ③ 检查依赖');
    }
    return hints;
  },

  async plan(ctx: Ctx, step: PlanStep, args: HookArgs): Promise<HookPlanResult> {
    const env = currentEnv(ctx.state);
    const prev = ctx.state.modules.tls?.env ?? {};
    const fromDns = isEnabled(env, 'dns') ? env.DNS_RECORD_NAME : undefined;
    const raw = args.domain ?? step.settings.TLS_DOMAIN ?? prev.TLS_DOMAIN ?? fromDns;
    if (!raw) return { missing: [missingDomain('tls', '（ACM 不能为 IP、amazonaws.com 或 cloudfront.net 名称签发证书）')] };
    const domain = normalizeDomain(raw);
    const bad = domainProblem(domain);
    if (bad) throw new CliError(`tls: ${bad}`, EXIT.rules, 'DOMAIN_INVALID');
    const notes: string[] = [];
    if (!args.domain && !step.settings.TLS_DOMAIN && !prev.TLS_DOMAIN && fromDns) notes.push(`TLS_DOMAIN=${domain}（取自 dns 的记录名；用 --domain 指定其他名称）`);

    if (step.tier === 'local') {
      // local tier letsencrypt (01#tls section 1): no AWS; the hostSetup issues over HTTP-01 (A record -> EIP, port 80 open)
      notes.push(`本地档 letsencrypt：${domain} 的 A 记录必须已指向 EIP，且 80 端口对公网开放（HTTP-01）`);
      return { settings: { TLS_DOMAIN: domain, TLS_LE_PROFILE: step.settings.TLS_LE_PROFILE ?? 'classic' }, notes };
    }

    let acme: 'on' | 'off';
    if (args.acme === false) {
      acme = 'off';
      notes.push('--no-acme：TLS_ACME=off（练习考试形态：ACM 证书只挂在 CloudFront / ALB 上）');
    } else if (step.settings.TLS_ACME === 'off') {
      acme = 'off';
      notes.push('TLS_ACME=off（--set）：回退分支');
    } else {
      const probe = await probeAcmeEndpoint(ctx);
      if (probe.available === false) {
        acme = 'off';
        notes.push(`preflight acme-endpoint：${probe.reason} → 回退为 TLS_ACME=off（DEP-005 ③：需要 dns | 外部 DNS 与 cdn | load-balancer）`);
      } else {
        acme = 'on';
        notes.push(`preflight acme-endpoint：${probe.reason}${probe.available === undefined ? '，按 TLS_ACME=on 计划（实际 enable 时不可用会回退为 off）' : ' → TLS_ACME=on'}`);
      }
    }
    const zone = args.zoneId ?? (ctx.state.modules.dns?.tier === 'aws' ? 'dns' : '');
    if (acme === 'on') {
      notes.push(`ACME 分支：证书由 ACM ACME 端点签发并装到 Nginx（45 天，certbot 续期）；浏览器访问需要 ${domain} 的 A 记录 → EIP`);
      if (!zone) notes.push('没有 Route 53 托管区域（--zone-id 或 dns 模块）：enable 会打印 ACME 域验证 CNAME，请在你的 DNS 中添加并保留');
    }
    if (isEnabled(env, 'dns') && (env.DNS_RECORD_NAME ?? '') === domain && (env.APP_BASE_URL ?? '').startsWith('http://')) {
      notes.push('dns 已启用且 APP_BASE_URL 仍是 http：tls 启用后重新执行 scripts/module enable dns，有效入口才会改为 https');
    }
    const settings: Record<string, string> = {
      TLS_DOMAIN: domain, TLS_ACME: acme,
      TLS_FORCE_HTTPS: step.settings.TLS_FORCE_HTTPS ?? prev.TLS_FORCE_HTTPS ?? 'false',
    };
    if (acme === 'on') settings.TLS_CERTBOT_CONFIG_DIR = step.settings.TLS_CERTBOT_CONFIG_DIR ?? '/etc/cloudalbum/letsencrypt';
    return { settings, notes };
  },

  prepare(ctx: Ctx, step: PlanStep, args: HookArgs, p: Prepared): void {
    if (step.tier !== 'aws') return;
    const s = step.settings;
    p.params.DomainName = s.TLS_DOMAIN!;
    p.params.AcmeEnabled = s.TLS_ACME === 'off' ? 'off' : 'on';
    if (args.zoneId) p.params.HostedZoneId = args.zoneId;
    if (s.TLS_FORCE_HTTPS === 'true' && p.params.AcmeEnabled === 'off') {
      throw new CliError('TLS_FORCE_HTTPS=true needs a trusted certificate on the direct Nginx listener; with TLS_ACME=off it stays self-signed '
        + '(self-signed + HSTS locks users out, DEP-015). Keep TLS_FORCE_HTTPS=false', EXIT.rules, 'DEP-015');
    }
    p.settings.TLS_FORCE_HTTPS = s.TLS_FORCE_HTTPS ?? 'false';
    if (p.settings.TLS_FORCE_HTTPS === 'true') p.notes.push('TLS_FORCE_HTTPS=true：直连 80→443 跳转 + HSTS（max-age 先用小值）；禁用 tls 前先改回 false');
    const zone = args.zoneId ?? (ctx.state.modules.dns?.tier === 'aws' ? ctx.state.modules.dns.env.DNS_HOSTED_ZONE_ID : '');
    const env = currentEnv(ctx.state);
    if (!zone && (isEnabled(env, 'cdn') || isEnabled(env, 'load-balancer') || isEnabled(env, 'social-api'))) {
      p.notes.push('集成证书（edge / regional）用 DNS 验证且没有托管区域：部署开始后 CloudFormation 会等待验证——在 ACM 控制台'
        + '（edge 在 us-east-1）或 `aws acm describe-certificate` 查看验证 CNAME 并添加到你的 DNS，否则栈超时失败');
    }
    if (isEnabled(env, 'cdn')) p.notes.push(`CloudFront 用的证书在 us-east-1（tls-edge 栈），注入 cdn 的 Aliases=${s.TLS_DOMAIN}`);
  },

  stacks(_ctx: Ctx, _step: PlanStep, _args: HookArgs, selected: StackPlan[]): StackPlan[] {
    return selected.map((s) => ({ ...s, params: { ...(s.params ?? {}), StackRole: s.name } }));
  },

  async afterDeploy(ctx: Ctx, step: PlanStep, args: HookArgs, deployed: DeployedStacks): Promise<void> {
    if (step.tier !== 'aws') return;
    const domain = step.settings.TLS_DOMAIN!;
    const edge = deployed.byStack.edge;
    if (edge) ctx.out.info(`      tls: CloudFront 集成证书（us-east-1）${edge.EnvAcmCertArnEdge ?? ''}：ACM 托管续期，验证 CNAME 必须保留`);
    const main = deployed.byStack.main;
    if (step.settings.TLS_ACME !== 'on' || !main) {
      ctx.out.info('      tls: TLS_ACME=off（回退分支）：Nginx 保持自签名 / Let\'s Encrypt；受信任 HTTPS 由 CloudFront / ALB 上的集成证书提供');
      return;
    }
    const endpointArn = ctx.ph(stepHasPlaceholders(main.InfoAcmeEndpointArn) && !ctx.dryRun ? undefined : main.InfoAcmeEndpointArn, 'tls:InfoAcmeEndpointArn');
    const validationArn = ctx.ph(stepHasPlaceholders(main.InfoAcmeDomainValidationArn) && !ctx.dryRun ? undefined : main.InfoAcmeDomainValidationArn, 'tls:InfoAcmeDomainValidationArn');
    const roleArn = ctx.ph(stepHasPlaceholders(main.InfoAcmeIssuerRoleArn) && !ctx.dryRun ? undefined : main.InfoAcmeIssuerRoleArn, 'tls:InfoAcmeIssuerRoleArn');
    const directory = ctx.ph(stepHasPlaceholders(main.EnvTlsAcmeDirectoryUrl) && !ctx.dryRun ? undefined : main.EnvTlsAcmeDirectoryUrl, 'tls:EnvTlsAcmeDirectoryUrl');
    const record = (kind: string, id: string, detail: Record<string, string> = {}) => {
      ctx.state.outOfBand = ctx.state.outOfBand.filter((x) => !(x.module === 'tls' && x.kind === kind && x.id === id));
      ctx.state.outOfBand.push({ module: 'tls', kind, id, at: nowIso(), region: ctx.region, detail });
    };
    record('acme-endpoint', endpointArn, { stack: 'main', note: 'deleted with the tls main stack (EAB, domain validation and accounts go with it)' });

    // 1. domain validation (persistent, pre-approved CNAME)
    type Validation = { AcmeDomainValidation?: { Status?: string; FailureDetails?: { Reason?: string; Message?: string };
      PrevalidationDetails?: { DnsPrevalidation?: { HostedZoneId?: string; ResourceRecord?: { Name?: string; Type?: string; Value?: string } } } } };
    const describe = () => ctx.aws.send<Validation>({ service: 'acm', op: 'DescribeAcmeDomainValidation', input: { AcmeDomainValidationArn: validationArn } });
    let v = await describe();
    const rr = v?.AcmeDomainValidation?.PrevalidationDetails?.DnsPrevalidation?.ResourceRecord;
    const viaZone = Boolean(v?.AcmeDomainValidation?.PrevalidationDetails?.DnsPrevalidation?.HostedZoneId);
    record('acme-domain-validation', validationArn, { domain, ...(rr?.Name ? { cname: `${rr.Name} -> ${rr.Value ?? ''}` } : {}) });
    if (rr?.Name) {
      ctx.out.warn(`      tls: ACME 域验证记录（持久保留，删除后新的签发会失败）${viaZone ? '——已由 Route 53 托管区域自动创建' : '——请添加到你的 DNS'}：`);
      ctx.out.warn(`        ${rr.Name}  ${rr.Type ?? 'CNAME'}  ${rr.Value ?? ''}`);
    } else if (ctx.dryRun) {
      ctx.out.info('      tls: （dry-run）DescribeAcmeDomainValidation 给出验证 CNAME；没有托管区域时由你添加到外部 DNS');
    }
    if (!ctx.dryRun) {
      const minutes = Number(args.params.ValidationWaitMin ?? 30);
      const deadline = Date.now() + minutes * 60_000;
      while (v?.AcmeDomainValidation?.Status !== 'VALID') {
        const st = v?.AcmeDomainValidation?.Status;
        if (st === 'INVALID') {
          const f = v?.AcmeDomainValidation?.FailureDetails;
          throw new CliError(`tls: ACME 域验证失败（${f?.Reason ?? 'INVALID'}：${f?.Message ?? ''}）。修正 DNS 记录后重新执行 scripts/module enable tls --domain ${domain}`,
            EXIT.stack, 'ACME_VALIDATION_INVALID');
        }
        if (Date.now() > deadline) {
          throw new CliError(`tls: ACME 域验证在 ${minutes} 分钟内没有变为 VALID（当前 ${st ?? '?'}）。确认上面的 CNAME 已添加后重新执行 `
            + `scripts/module enable tls --domain ${domain}（栈不变，从这一步继续；ACM 最多验证 72 小时）`, EXIT.stack, 'ACME_VALIDATION_PENDING');
        }
        await new Promise((r) => setTimeout(r, 15_000));
        v = await describe();
      }
      ctx.out.info('      tls: ACME 域验证 VALID');
    }

    // 2. EAB (1 day), handed to certbot once, then deleted
    const created = await ctx.aws.send<{ ExternalAccountBinding?: { AcmeExternalAccountBindingArn?: string } }>({
      service: 'acm', op: 'CreateAcmeExternalAccountBinding',
      input: { AcmeEndpointArn: endpointArn, RoleArn: roleArn, Expiration: { Value: 1, Type: 'DAYS' },
        IdempotencyToken: randomBytes(8).toString('hex'), Tags: [{ Key: 'Project', Value: 'CloudAlbum' }, { Key: 'Module', Value: 'tls' }] },
    });
    const eabArn = ctx.ph(created?.ExternalAccountBinding?.AcmeExternalAccountBindingArn, 'acm:AcmeExternalAccountBindingArn');
    record('acme-eab', eabArn, { deleted: 'false', expires: '1 day' });
    const deleteEab = async () => {
      await ctx.aws.send({ service: 'acm', op: 'DeleteAcmeExternalAccountBinding', input: { AcmeExternalAccountBindingArn: eabArn } }).catch(() => undefined);
      record('acme-eab', eabArn, { deleted: 'true' });
    };
    const cred = await ctx.aws.send<{ KeyId?: string; MacKey?: string }>({
      service: 'acm', op: 'GetAcmeExternalAccountBindingCredentials', input: { AcmeExternalAccountBindingArn: eabArn },
    });
    if (!ctx.dryRun && (!cred?.KeyId || !cred.MacKey)) {
      await deleteEab();
      throw new CliError('tls: GetAcmeExternalAccountBindingCredentials returned no KeyId / MacKey', EXIT.stack, 'ACME_EAB');
    }

    // 3. certbot on the instance: EAB registration + issuance (no online challenge with PRE_APPROVED)
    const email = step.settings.TLS_LE_EMAIL ? ` --email ${shq(step.settings.TLS_LE_EMAIL)}` : '';
    const s = new RemoteScript('tls: certbot EAB registration + issuance at the ACM ACME endpoint');
    const channel = ctx.deliverer().channel;
    let handoff: string | undefined;
    if (channel === 'ssh') {
      // ssh stdin only (never a command line on the operator side); registered as secrets: redacted in every display
      const kid = cred?.KeyId ? s.secret(cred.KeyId) : '<eab-key-id>';
      const mac = cred?.MacKey ? s.secret(cred.MacKey) : '<eab-mac-key>';
      s.line(`export CA_EAB_KID=${shq(kid)} CA_EAB_HMAC=${shq(mac)}`);
      s.line(`bash ${HOST_SETUP} issue-acme --server ${shq(directory)} --domain ${shq(domain)}${email}`);
    } else {
      // SSM keeps command parameters in its history: hand the EAB over through a SecureString parameter (deleted below)
      handoff = `/cloudalbum/${ctx.env}/handoff/tls-eab-${randomBytes(6).toString('hex')}`;
      await ctx.aws.send({
        service: 'ssm', op: 'PutParameter',
        input: { Name: handoff, Type: 'SecureString', Value: JSON.stringify({ KeyId: cred?.KeyId ?? '', MacKey: cred?.MacKey ?? '' }), Overwrite: true,
          Description: 'scripts/module tls: one-time ACME EAB hand-off (deleted after the issuance)' },
        display: { Name: handoff, Type: 'SecureString', Value: '***' },
      });
      s.line(`bash ${HOST_SETUP} issue-acme --server ${shq(directory)} --domain ${shq(domain)}${email} --eab-param ${shq(handoff)} --region ${ctx.region}`);
    }
    let result: { code: number; stdout: string };
    try {
      result = await ctx.deliverer().run(s, { capture: true, timeoutSec: 600 });
    } finally {
      if (handoff) await ctx.aws.send({ service: 'ssm', op: 'DeleteParameter', input: { Name: handoff } }).catch(() => undefined);
    }
    const out = lastJsonLine(result.stdout) ?? {};
    if (!ctx.dryRun && (result.code !== 0 || out.issued !== true)) {
      await deleteEab();
      throw new CliError(`tls: certbot issuance at the ACM ACME endpoint failed: ${String(out.reason ?? `exit ${result.code}`)}`, EXIT.stack, 'ACME_ISSUANCE_FAILED');
    }
    await deleteEab();
    if (typeof out.account === 'string' && out.account) record('acme-account', out.account, { endpoint: endpointArn });

    // 4. the issued certificate in ACM (ListCertificates hides ACME certificates by default; SearchCertificates includes them)
    const found = await ctx.aws.send<{ Results?: Array<{ CertificateArn?: string }> }>({
      service: 'acm', op: 'SearchCertificates',
      input: { FilterStatement: { Filter: { AcmCertificateMetadataFilter: { AcmeEndpointArn: endpointArn } } }, MaxResults: 10 },
    }).catch(() => undefined);
    const arn = found?.Results?.[0]?.CertificateArn;
    if (arn) {
      record('acme-certificate', arn, { domain });
      ctx.out.info(`      tls: ACME 证书 ${arn}（CertificateKeyPairOrigin=ACME；同一账户以相同域名续期时 ARN 不变）`);
    }
    ctx.out.info('      tls: 证书已签发到实例的 /etc/cloudalbum/letsencrypt；第 7 步投递 tls.env 后 hostSetup 切换符号链接并 reload Nginx');
  },

  async beforeDisable(ctx: Ctx, rec: ModuleRecord, args: HookArgs): Promise<HookDisableResult> {
    const notes: string[] = [];
    if (rec.env.TLS_FORCE_HTTPS === 'true') {
      notes.push('TLS_FORCE_HTTPS=true 随 tls.env 移除；浏览器会在 HSTS 的 max-age 内拒绝回到 HTTP 或自签名证书');
    }
    if ((args.params.RevokeAcme ?? '') === 'true' && rec.env.TLS_ACME === 'on') {
      const s = new RemoteScript('tls: revoke the ACME certificate (certbot revoke)');
      s.line(`bash ${HOST_SETUP} revoke-acme`);
      const r = await ctx.deliverer().run(s, { capture: true, timeoutSec: 300 });
      notes.push(r.code === 0 ? 'ACME 证书已吊销（certbot revoke；ACM 的 RevokeCertificate 对它无效）' : `certbot revoke 失败（退出码 ${r.code}），继续禁用`);
    }
    notes.push('集成证书的挂载（cdn Aliases / ALB HTTPS 监听器）先经 injects 撤销，再删除证书栈（ACM 拒绝删除仍在使用的证书）');
    return { notes };
  },

  async afterDisable(ctx: Ctx, rec: ModuleRecord): Promise<void> {
    if (rec.tier !== 'aws') return;
    if (rec.env.TLS_ACME === 'on') {
      const s = new RemoteScript('tls: remove the ACME lineage and account of the deleted endpoint');
      s.line(`bash ${HOST_SETUP} purge-acme --server ${shq(rec.env.TLS_ACME_DIRECTORY_URL ?? '')}`);
      const r = await ctx.deliverer().run(s, { capture: true, timeoutSec: 300 });
      if (r.code !== 0) ctx.out.warn(`      tls: 清理实例上的 ACME 账户失败（退出码 ${r.code}）；可以手工删除 /etc/cloudalbum/letsencrypt 中的 cloudalbum-acm`);
      for (const e of ctx.state.outOfBand.filter((x) => x.module === 'tls' && x.kind === 'acme-eab' && x.detail?.deleted !== 'true')) {
        await ctx.aws.send({ service: 'acm', op: 'DeleteAcmeExternalAccountBinding', input: { AcmeExternalAccountBindingArn: e.id } }).catch(() => undefined);
      }
    }
    // the endpoint (with its EABs, domain validations and accounts) and the integration certificates went with the stacks
    ctx.state.outOfBand = ctx.state.outOfBand.filter((x) => x.module !== 'tls');
    const zone = ctx.state.modules.dns?.tier === 'aws';
    ctx.out.warn(`      tls: ${zone ? '托管区域中的验证 CNAME 随栈删除' : '请到你的 DNS 删除 ACME 域验证 / ACM DNS 验证的 CNAME'}；`
      + '浏览器用的 A 记录（或回退分支的 CNAME）如不再需要也请删除');
    ctx.out.info('      tls: 在 ACM 控制台用 ACME 过滤条件（或 aws acm search-certificates）确认没有遗留的 ACME 证书；过期的 ACME 证书 ACM 会在一年后自动删除');
  },
};
