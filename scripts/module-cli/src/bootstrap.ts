/**
 * `scripts/module bootstrap` (toolchain stack), `base deploy` (first deployment of the ec2 base stack, 00-ec2-base.md 8)
 * and `teardown` (10.2 / 00 section 8). All AWS calls go through the gateway (printed in --dry-run).
 */
import { writeFileSync, mkdirSync, existsSync } from 'node:fs';
import path from 'node:path';
import type { Ctx } from './context.js';
import { disableCommand } from './disable.js';
import { registryEdges } from './meta.js';
import { CliError, EXIT } from './printer.js';
import { orderSteps } from './deps.js';
import { registryVersion, stackName } from './registry.js';
import { deleteStack, deployStack, describeStack, stackTags } from './stack.js';
import { recordHistory } from './state.js';
import type { ModuleId } from '@cloudalbum/contracts';
import { RemoteScript } from './deliver.js';
import { presignRelease, uploadRelease } from './platform/release.js';
import { cfnFailures } from './stack.js';
import { deleteStack as deleteStackFn } from './stack.js';

export async function bootstrapCommand(ctx: Ctx, opts: { releaseFile?: string } = {}): Promise<number> {
  if (opts.releaseFile && !ctx.platform) throw new CliError('--release-file is only used in platform mode (06 PM-30)', EXIT.rules, 'PLATFORM_ONLY');
  ctx.out.section(`bootstrap: toolchain stack ${stackName(ctx.env, 'toolchain')}${ctx.dryRun ? ' [dry-run]' : ''}`);
  const res = await deployStack(ctx.aws, ctx.out, ctx.repoRoot, {
    stackName: stackName(ctx.env, 'toolchain'), template: 'infra/modules/toolchain.yaml',
    params: { Env: ctx.env, ModuleVersion: '1' }, tags: stackTags(ctx.env, 'toolchain', 1),
  });
  ctx.state.toolchain = { ...(ctx.state.toolchain ?? {}), stackName: stackName(ctx.env, 'toolchain'), bucket: res.outputs.InfoArtifactBucket };
  ctx.out.info(`  artifact bucket: ${res.outputs.InfoArtifactBucket}`);
  if (opts.releaseFile) {
    // platform mode: the release archive goes to the toolchain bucket (the runner gets it from cloudalbum-infra.zip)
    const bucket = ctx.ph(res.outputs.InfoArtifactBucket, 'toolchain:InfoArtifactBucket');
    ctx.state.toolchain.release = await uploadRelease(ctx, opts.releaseFile, bucket);
    ctx.out.info(`  release: s3://${bucket}/${ctx.state.toolchain.release.key} (sha256 ${ctx.state.toolchain.release.sha256})`);
  }
  recordHistory(ctx.state, { op: 'bootstrap', result: ctx.dryRun ? 'dry-run' : 'ok', exitCode: EXIT.ok });
  ctx.save();
  return EXIT.ok;
}

export interface BaseDeployOptions {
  sshCidr?: string;
  adminEmail?: string;
  keyName?: string;
  arch?: 'arm64' | 'x86_64';
  instanceType?: string;
  appArchiveUrl?: string;
  appArchiveSha256?: string;
  subnetId?: string;
  param?: string[];
  /** platform mode (06 PM-05, PM-32) */
  instanceProfile?: string;
  disableRollback?: boolean;
  retryAz?: boolean;
}

async function myPublicIp(ctx: Ctx): Promise<string> {
  if (ctx.dryRun) return '<operator-ip>';
  const r = await fetch('https://checkip.amazonaws.com/');
  const ip = (await r.text()).trim();
  if (!/^\d+\.\d+\.\d+\.\d+$/.test(ip)) throw new CliError(`cannot determine the operator IP (${ip})`, EXIT.rules);
  return ip;
}

export async function baseDeploy(ctx: Ctx, opts: BaseDeployOptions): Promise<number> {
  if (ctx.platform) return baseDeployPlatform(ctx, opts);
  const arch = opts.arch ?? 'arm64';
  const instanceType = opts.instanceType ?? (arch === 'arm64' ? 't4g.small' : 't3.small');
  if (!opts.appArchiveUrl || !opts.appArchiveSha256) throw new CliError('--app-archive-url and --app-archive-sha256 are required (scripts/release prints them)', EXIT.rules);
  ctx.out.section(`base deploy: ${stackName(ctx.env, 'ec2')}${ctx.dryRun ? ' [dry-run]' : ''}`);
  const who = await ctx.aws.send<{ Account?: string; Arn?: string }>({ service: 'sts', op: 'GetCallerIdentity', input: {} });
  ctx.out.info(`  deployer: ${who?.Arn ?? '<deployer identity>'}`);

  // default VPC + default subnet of <region>a (or --subnet-id)
  const vpcs = await ctx.aws.send<{ Vpcs?: Array<{ VpcId?: string }> }>({ service: 'ec2', op: 'DescribeVpcs', input: { Filters: [{ Name: 'is-default', Values: ['true'] }] } });
  const vpcId = ctx.ph(vpcs?.Vpcs?.[0]?.VpcId, 'default-vpc');
  const subnets = await ctx.aws.send<{ Subnets?: Array<{ SubnetId?: string; AvailabilityZone?: string; MapPublicIpOnLaunch?: boolean }> }>({
    service: 'ec2', op: 'DescribeSubnets', input: { Filters: [{ Name: 'vpc-id', Values: [vpcId] }, { Name: 'default-for-az', Values: ['true'] }] },
  });
  const all = (subnets?.Subnets ?? []).sort((a, b) => String(a.AvailabilityZone).localeCompare(String(b.AvailabilityZone)));
  const chosen = opts.subnetId ? all.find((s) => s.SubnetId === opts.subnetId) : (all.find((s) => s.AvailabilityZone === `${ctx.region}a`) ?? all[0]);
  if (chosen && chosen.MapPublicIpOnLaunch === false) throw new CliError('preflight ec2-public-ipv4-at-boot: the subnet does not auto-assign public IPv4', EXIT.rules);
  const subnetId = ctx.ph(opts.subnetId ?? chosen?.SubnetId, 'default-subnet');
  const az = ctx.ph(chosen?.AvailabilityZone, `${ctx.region}a`);

  // E1: pin the AMI resolved NOW into our own parameter, pass its name
  const pub = `/aws/service/ami-amazon-linux-latest/al2023-ami-kernel-default-${arch}`;
  const amiParam = `/cloudalbum/${ctx.env}/ec2/image-id`;
  const ami = await ctx.aws.send<{ Parameter?: { Value?: string } }>({ service: 'ssm', op: 'GetParameter', input: { Name: pub } });
  await ctx.aws.send({ service: 'ssm', op: 'PutParameter', input: { Name: amiParam, Type: 'String', DataType: 'aws:ec2:image', Value: ctx.ph(ami?.Parameter?.Value, 'ami-id'), Overwrite: true } });

  // key pair (L0 delivery channel): created once, private key kept on the operator machine
  const keyName = opts.keyName ?? `cloudalbum-${ctx.env}-key`;
  const keyFile = path.join(path.dirname(ctx.stateFile), `${keyName}.pem`);
  const keys = await ctx.aws.send<{ KeyPairs?: unknown[] }>({ service: 'ec2', op: 'DescribeKeyPairs', input: { Filters: [{ Name: 'key-name', Values: [keyName] }] } });
  if (!ctx.dryRun && !keys?.KeyPairs?.length) {
    const k = await ctx.aws.send<{ KeyMaterial?: string }>({ service: 'ec2', op: 'CreateKeyPair', input: { KeyName: keyName, KeyType: 'ed25519', KeyFormat: 'pem' }, display: { KeyName: keyName } });
    mkdirSync(path.dirname(keyFile), { recursive: true });
    writeFileSync(keyFile, k?.KeyMaterial ?? '', { mode: 0o600 });
    ctx.out.info(`  key pair ${keyName} created, private key saved to ${keyFile}`);
  } else if (ctx.dryRun) {
    await ctx.aws.send({ service: 'ec2', op: 'CreateKeyPair', input: { KeyName: keyName, KeyType: 'ed25519' } });
  }

  const sshCidr = !opts.sshCidr || opts.sshCidr === 'auto' ? `${await myPublicIp(ctx)}/32` : opts.sshCidr;
  if (/\/(?:[0-9]|[12][0-9]|3[01])$/.test(sshCidr) || sshCidr === '0.0.0.0/0') {
    throw new CliError(`preflight ec2-ssh-cidr: ${sshCidr} is wider than /32 (the open-SSH experiment is not supported by base deploy)`, EXIT.rules);
  }
  const params: Record<string, string> = {
    Env: ctx.env, ModuleVersion: String(registryVersion('ec2')), Arch: arch, InstanceType: instanceType, ImageId: amiParam,
    KeyName: keyName, VpcId: vpcId, SubnetId: subnetId, DataVolumeAz: az, SshIngressCidr: sshCidr,
    AppArchiveUrl: opts.appArchiveUrl, AppArchiveSha256: opts.appArchiveSha256, AdminEmail: opts.adminEmail ?? '',
  };
  for (const kv of opts.param ?? []) { const i = kv.indexOf('='); if (i > 0) params[kv.slice(0, i)] = kv.slice(i + 1); }
  const res = await deployStack(ctx.aws, ctx.out, ctx.repoRoot, { stackName: stackName(ctx.env, 'ec2'), template: 'infra/modules/ec2.yaml', params, tags: stackTags(ctx.env, 'ec2', registryVersion('ec2')) });
  const o = res.outputs;
  {
    if (who?.Account) ctx.state.accountId = who.Account;
    ctx.state.base = {
      stackName: stackName(ctx.env, 'ec2'), instanceId: o.InstanceId, publicIp: o.PublicIp, publicDnsName: o.InfoPublicDnsName,
      securityGroupId: o.InstanceSecurityGroupId, vpcId: o.VpcId, subnetId: o.SubnetId, availabilityZone: o.AvailabilityZone,
      dataVolumeId: o.DataVolumeId, arch, defaultSubnetIds: all.map((s) => s.SubnetId!).filter(Boolean),
      params: Object.fromEntries(Object.entries(params).filter(([k]) => k !== 'AppArchiveSha256')),
    };
    ctx.state.delivery = { channel: 'ssh', sshUser: 'ec2-user', ...(existsSync(keyFile) ? { sshKeyPath: keyFile } : {}), host: o.PublicIp };
    ctx.state.baseConfig = { AWS_REGION: ctx.region, CLOUDALBUM_ENV: ctx.env, APP_BASE_URL: `http://${o.PublicIp}`, DEPLOY_MODE: 'single' };
  }
  // operator address for fail2ban ignoreip, then the key fingerprint (invariant 3)
  const s = new RemoteScript('base deploy: operator ip + fingerprint');
  s.line(`echo '${sshCidr}' > /etc/cloudalbum/fail2ban-ignoreip`, '/usr/local/lib/cloudalbum/render-fail2ban.sh || true');
  s.cli('keys:fingerprint');
  const fp = await ctx.deliverer().run(s, { capture: true, timeoutSec: 120 });
  if (!ctx.dryRun && fp.code === 0 && ctx.state.base) ctx.state.base.keyFingerprint = fp.stdout.trim().split('\n').pop();
  recordHistory(ctx.state, { op: 'base deploy', result: ctx.dryRun ? 'dry-run' : 'ok', exitCode: EXIT.ok });
  ctx.save();
  ctx.out.info(`  entry: http://${o.PublicIp}   initial admin password: /root/cloudalbum-admin.txt on the instance`);
  ctx.out.info('  next: L0 smoke test  ->  npm run exp -- ec2 --scenario smoke --label l0');
  return EXIT.ok;
}

/**
 * `base deploy --platform` (06 PM-05, 02 §4.3 base-deploy step 3): PlatformMode=on, InstanceProfileName=CloudAlbumAppRole from the
 * first deployment (the management channel, P7), the session key pair created by the runner, no SSH ingress (the workstation
 * gets it through PROFILE_BASE_PARAMS when a card asks), the release from the toolchain bucket as a presigned URL,
 * --disable-rollback (the failed stack stays for diagnosis), --retry-az: on InsufficientInstanceCapacity delete the failed stack
 * and retry once in another AZ of the default VPC. The administrator is created by the runner (admin:ensure --password-hash).
 */
async function baseDeployPlatform(ctx: Ctx, opts: BaseDeployOptions): Promise<number> {
  const p = ctx.platform!;
  const arch = opts.arch ?? ctx.state.toolchain?.release?.arch ?? 'arm64';
  const instanceType = opts.instanceType ?? (arch === 'arm64' ? 't4g.small' : 't3.small');
  const instanceProfile = opts.instanceProfile ?? 'CloudAlbumAppRole';
  if (instanceProfile !== 'CloudAlbumAppRole') throw new CliError('ATL-IAM-001: platform mode needs --instance-profile CloudAlbumAppRole', EXIT.rules, 'ATL-IAM-001');
  ctx.out.section(`base deploy --platform: ${stackName(ctx.env, 'ec2')}${ctx.dryRun ? ' [dry-run]' : ''}`);
  p.reporter.progress('deploy-stack', 'started', 'ec2 base stack', { module: 'ec2' });
  const vpcs = await ctx.aws.send<{ Vpcs?: Array<{ VpcId?: string }> }>({ service: 'ec2', op: 'DescribeVpcs', input: { Filters: [{ Name: 'is-default', Values: ['true'] }] } });
  const vpcId = ctx.ph(vpcs?.Vpcs?.[0]?.VpcId, 'default-vpc');
  const subnets = await ctx.aws.send<{ Subnets?: Array<{ SubnetId?: string; AvailabilityZone?: string; MapPublicIpOnLaunch?: boolean }> }>({
    service: 'ec2', op: 'DescribeSubnets', input: { Filters: [{ Name: 'vpc-id', Values: [vpcId] }, { Name: 'default-for-az', Values: ['true'] }] },
  });
  const all = (subnets?.Subnets ?? []).filter((x) => x.MapPublicIpOnLaunch !== false).sort((a, b) => String(a.AvailabilityZone).localeCompare(String(b.AvailabilityZone)));
  const keyName = opts.keyName ?? `cloudalbum-${ctx.env}-key`;
  const keys = await ctx.aws.send<{ KeyPairs?: unknown[] }>({ service: 'ec2', op: 'DescribeKeyPairs', input: { Filters: [{ Name: 'key-name', Values: [keyName] }] } });
  if (!ctx.dryRun && !keys?.KeyPairs?.length) throw new CliError(`key pair ${keyName} does not exist: the runner creates it before base deploy (01 §9.2)`, EXIT.rules, 'KEY_PAIR_MISSING');
  const pub = `/aws/service/ami-amazon-linux-latest/al2023-ami-kernel-default-${arch}`;
  const amiParam = `/cloudalbum/${ctx.env}/ec2/image-id`;
  const ami = await ctx.aws.send<{ Parameter?: { Value?: string } }>({ service: 'ssm', op: 'GetParameter', input: { Name: pub } });
  await ctx.aws.send({ service: 'ssm', op: 'PutParameter', input: { Name: amiParam, Type: 'String', DataType: 'aws:ec2:image', Value: ctx.ph(ami?.Parameter?.Value, 'ami-id'), Overwrite: true } });
  let url = opts.appArchiveUrl;
  let sha = opts.appArchiveSha256 ?? ctx.state.toolchain?.release?.sha256;
  if (!url) {
    const rel = ctx.state.toolchain?.release;
    const bucket = ctx.state.toolchain?.bucket;
    if ((!rel || !bucket) && !ctx.dryRun) throw new CliError('no release in the toolchain bucket: run `scripts/module bootstrap --platform --release-file <archive>` first', EXIT.rules, 'RELEASE_MISSING');
    url = await presignRelease(ctx, bucket ?? '<toolchain-bucket>', rel?.key ?? 'releases/<ver>/<arch>.tgz');
  }
  sha ??= ctx.dryRun ? '<sha256>' : undefined;
  if (!sha) throw new CliError('--app-archive-sha256 is required (or bootstrap --release-file)', EXIT.rules, 'RELEASE_MISSING');
  const attempt = async (subnet: { SubnetId?: string; AvailabilityZone?: string } | undefined) => {
    const params: Record<string, string> = {
      Env: ctx.env, ModuleVersion: String(registryVersion('ec2')), Arch: arch, InstanceType: instanceType, ImageId: amiParam, KeyName: keyName,
      VpcId: vpcId, SubnetId: ctx.ph(opts.subnetId ?? subnet?.SubnetId, 'default-subnet'), DataVolumeAz: ctx.ph(subnet?.AvailabilityZone, `${ctx.region}a`),
      SshIngressCidr: '', AppArchiveUrl: url!, AppArchiveSha256: sha!, AdminEmail: '', PlatformMode: 'on', InstanceProfileName: instanceProfile,
    };
    for (const kv of opts.param ?? []) { const i = kv.indexOf('='); if (i > 0) params[kv.slice(0, i)] = kv.slice(i + 1); }
    const res = await deployStack(ctx.aws, ctx.out, ctx.repoRoot, { stackName: stackName(ctx.env, 'ec2'), template: 'infra/modules/ec2.yaml', params,
      secretParams: ['AppArchiveUrl'], tags: stackTags(ctx.env, 'ec2', registryVersion('ec2')), disableRollback: Boolean(opts.disableRollback) });
    return { res, params };
  };
  const preferred = opts.subnetId ? all.find((x) => x.SubnetId === opts.subnetId) : (all.find((x) => x.AvailabilityZone === `${ctx.region}a`) ?? all[0]);
  let out: Awaited<ReturnType<typeof attempt>>;
  try {
    out = await attempt(preferred);
  } catch (e) {
    const capacity = cfnFailures.some((f) => /InsufficientInstanceCapacity/.test(f.reason));
    if (!opts.retryAz || !capacity || opts.subnetId) throw e;
    const other = all.find((x) => x.AvailabilityZone !== preferred?.AvailabilityZone);
    if (!other) throw e;
    ctx.out.warn(`  InsufficientInstanceCapacity in ${preferred?.AvailabilityZone}: deleting the failed stack and retrying in ${other.AvailabilityZone}`);
    await deleteStackFn(ctx.aws, ctx.out, stackName(ctx.env, 'ec2'));
    cfnFailures.length = 0;
    out = await attempt(other);
  }
  const o = out.res.outputs;
  ctx.state.base = {
    stackName: stackName(ctx.env, 'ec2'), instanceId: o.InstanceId, publicIp: o.PublicIp, publicDnsName: o.InfoPublicDnsName,
    securityGroupId: o.InstanceSecurityGroupId, vpcId: o.VpcId, subnetId: o.SubnetId, availabilityZone: o.AvailabilityZone,
    dataVolumeId: o.DataVolumeId, arch, defaultSubnetIds: all.map((x) => x.SubnetId!).filter(Boolean),
    params: Object.fromEntries(Object.entries(out.params).filter(([k]) => k !== 'AppArchiveSha256' && k !== 'AppArchiveUrl')),
  };
  ctx.state.delivery = { channel: 'ssm', sshUser: 'ec2-user', ...(o.PublicIp ? { host: o.PublicIp } : {}) };
  ctx.state.baseConfig = { AWS_REGION: ctx.region, CLOUDALBUM_ENV: ctx.env, APP_BASE_URL: `http://${ctx.ph(o.PublicIp, 'ec2:PublicIp')}`, DEPLOY_MODE: 'single' };
  ctx.state.outOfBand.push({ module: 'ec2', kind: 'ec2-key-pair', id: keyName, at: new Date().toISOString() });
  ctx.save();
  p.reporter.progress('deploy-stack', 'succeeded', 'ec2 base stack', { module: 'ec2' });
  // key fingerprint over SSM (no secret travels: only the fingerprint comes back)
  const s = new RemoteScript('base deploy: key fingerprint');
  s.cli('keys:fingerprint');
  const fp = await ctx.deliverer().run(s, { capture: true, timeoutSec: 300 });
  if (!ctx.dryRun && fp.code === 0 && ctx.state.base) ctx.state.base.keyFingerprint = fp.stdout.trim().split('\n').pop();
  recordHistory(ctx.state, { op: 'base deploy', result: ctx.dryRun ? 'dry-run' : 'ok', exitCode: EXIT.ok, opId: p.opId,
    ...(p.identity ? { actor: p.identity.sessionName } : {}), runId: p.env.runId ?? null });
  ctx.save();
  ctx.out.info(`  entry: http://${o.PublicIp ?? '<eip>'}   next (runner): platform:apply-env, probe-token --init, admin:ensure --password-hash`);
  return EXIT.ok;
}

export async function teardownCommand(ctx: Ctx, opts: { purgeData?: boolean }): Promise<number> {
  ctx.out.section(`teardown env ${ctx.env}${ctx.dryRun ? ' [dry-run]' : ''}`);
  const enabled = Object.keys(ctx.state.modules) as ModuleId[];
  const order = orderSteps(enabled.map((module) => ({ module })), registryEdges()).map((s) => s.module).reverse();
  for (const id of order) {
    const code = await disableCommand(ctx, id, { cascade: true, abandonData: true, skipHealth: false });
    if (code !== EXIT.ok) return code;
  }
  if (ctx.state.toolchain || ctx.dryRun) await deleteStack(ctx.aws, ctx.out, stackName(ctx.env, 'toolchain'));
  const base = await describeStack(ctx.aws, stackName(ctx.env, 'ec2'));
  if (base !== null) await deleteStack(ctx.aws, ctx.out, stackName(ctx.env, 'ec2'));
  await ctx.aws.send({ service: 'ssm', op: 'DeleteParameter', input: { Name: `/cloudalbum/${ctx.env}/ec2/image-id` } }).catch(() => undefined);
  ctx.out.warn(`  kept (DeletionPolicy Retain): data volume ${ctx.state.base?.dataVolumeId ?? '<vol>'} (billed per GB-month), S3 buckets, toolchain bucket, RDS final snapshots`);
  if (opts.purgeData) ctx.out.warn('  --purge-data (final snapshot + volume deletion) is not implemented in this round: delete the volume in the EC2 console');
  delete ctx.state.base;
  delete ctx.state.toolchain;
  recordHistory(ctx.state, { op: 'teardown', result: ctx.dryRun ? 'dry-run' : 'ok', exitCode: EXIT.ok });
  ctx.save();
  return EXIT.ok;
}
