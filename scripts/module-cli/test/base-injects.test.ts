import { describe, expect, it } from 'vitest';
import { mergeBaseParams, moduleContributions } from '../src/base-params.js';
import { computeInjections, injectTargetsOf } from '../src/injects.js';
import { evaluateExpr, unionList, whenHolds } from '../src/expr.js';
import type { ModuleRecord } from '../src/state.js';

const rec = (p: Partial<ModuleRecord>): ModuleRecord => ({
  enabledAt: '', updatedAt: '', tier: 'aws', value: 'aws', version: 1, env: {}, stacks: [], outputs: {}, params: {}, secretKeys: [], ...p,
});
const CTX = { Env: 'lab', Arch: 'arm64' };

describe('registry value expressions (3.5)', () => {
  it('evaluates Out / env / Param / context and the + prefix', () => {
    expect(evaluateExpr('+${Out.InfoOriginSecurityGroupId}', { outputs: { InfoOriginSecurityGroupId: 'sg-1' } })).toEqual({ value: 'sg-1', append: true, unresolved: [] });
    expect(evaluateExpr('${CDN_DIRECT_ACCESS}', { env: { CDN_DIRECT_ACCESS: 'admin-ip' } }).value).toBe('admin-ip');
    expect(evaluateExpr('${Param.MultiAz}-${Env}-${Arch}', { params: { MultiAz: 'true' }, context: CTX }).value).toBe('true-lab-arm64');
    expect(evaluateExpr('${Out.Missing}', { module: 'cdn', placeholders: true })).toEqual({ value: '<cdn:Out.Missing>', append: false, unresolved: ['Out.Missing'] });
    expect(unionList('a,b', ['b', 'c'], ' ', undefined)).toEqual(['a', 'b', 'c']);
    expect(whenHolds({ DNS_TARGET_TYPE: 'cloudfront' }, {}, { DNS_TARGET_TYPE: 'eip' })).toBe(false);
  });
});

describe('baseParams merge (2.3, 00-ec2-base.md 6.3)', () => {
  const cdn = rec({ env: { CDN_DIRECT_ACCESS: 'admin-ip', CDN_ADMIN_CIDR: '198.51.100.7/32' }, outputs: { InfoOriginSecurityGroupId: 'sg-cdn' } });
  const iam = rec({ value: 'role', outputs: { InfoInstanceProfileName: 'CloudAlbumAppRole' } });

  it('cdn contributes PublicHttpIngress, AdminIngressCidr and appends its security group', () => {
    expect(moduleContributions('cdn', cdn, CTX)).toEqual([
      { module: 'cdn', param: 'ExtraSecurityGroupIds', value: 'sg-cdn', append: true },
      { module: 'cdn', param: 'PublicHttpIngress', value: 'admin-ip', append: false },
      { module: 'cdn', param: 'AdminIngressCidr', value: '198.51.100.7/32', append: false },
    ]);
  });

  it('iam only writes InstanceProfileName in role mode', () => {
    expect(moduleContributions('iam', iam, CTX)).toEqual([{ module: 'iam', param: 'InstanceProfileName', value: 'CloudAlbumAppRole', append: false }]);
    expect(moduleContributions('iam', { ...iam, value: 'keys' }, CTX)).toEqual([]);
  });

  it('merges against the current base parameters and reports changes', () => {
    const plan = mergeBaseParams({ cdn, iam }, { PublicHttpIngress: 'open', ExtraSecurityGroupIds: '' }, {}, CTX);
    expect(plan.conflicts).toEqual([]);
    expect(plan.desired).toMatchObject({ PublicHttpIngress: 'admin-ip', ExtraSecurityGroupIds: 'sg-cdn', AdminIngressCidr: '198.51.100.7/32', InstanceProfileName: 'CloudAlbumAppRole' });
    expect(plan.changes.map((c) => c.param).sort()).toEqual(['AdminIngressCidr', 'ExtraSecurityGroupIds', 'InstanceProfileName', 'PublicHttpIngress']);
  });

  it('PublicHttpIngress takes the strictest requirement; lists are unions', () => {
    const closed = rec({ env: { CDN_DIRECT_ACCESS: 'closed' }, outputs: { InfoOriginSecurityGroupId: 'sg-2' } });
    const plan = mergeBaseParams({ cdn: closed }, { PublicHttpIngress: 'admin-ip', ExtraSecurityGroupIds: 'sg-x' }, {}, CTX);
    expect(plan.desired.PublicHttpIngress).toBe('closed');
    expect(plan.desired.ExtraSecurityGroupIds).toBe('sg-x,sg-2');
  });

  it('disabling the last contributor restores the original value', () => {
    const plan = mergeBaseParams({}, { PublicHttpIngress: 'admin-ip', ExtraSecurityGroupIds: 'sg-cdn', InstanceProfileName: 'CloudAlbumAppRole' },
      { PublicHttpIngress: 'open', ExtraSecurityGroupIds: '', InstanceProfileName: '' }, CTX);
    expect(plan.desired).toEqual({ PublicHttpIngress: 'open', ExtraSecurityGroupIds: '', InstanceProfileName: '' });
  });

  it('local tiers contribute nothing', () => {
    expect(mergeBaseParams({ cdn: { ...cdn, tier: 'local' } }, {}, {}, CTX).changes).toEqual([]);
  });
});

describe('injects (D2): provider -> target stack parameters', () => {
  const storageParams = ['Env', 'ModuleVersion', 'AppOrigins', 'KmsKeyArn', 'CdnDistributionArn'];
  const cdn = rec({ outputs: { InfoDistributionArn: 'arn:aws:cloudfront::1:distribution/E1', EnvCdnBaseUrl: 'https://d1.cloudfront.net' }, env: { CDN_BASE_URL: 'https://d1.cloudfront.net' } });

  it('cdn injects its distribution ARN and appends its origin to the direct entry', () => {
    const inj = computeInjections('storage', storageParams, { records: { cdn }, env: {}, baseLists: { AppOrigins: 'http://203.0.113.10' }, context: CTX });
    expect(inj.CdnDistributionArn).toMatchObject({ value: 'arn:aws:cloudfront::1:distribution/E1', providers: ['cdn'] });
    expect(inj.AppOrigins!.value).toBe('http://203.0.113.10,https://d1.cloudfront.net');
    expect(inj.KmsKeyArn!.value).toBe('');
  });

  it('without providers the target is reset (empty / base value)', () => {
    const inj = computeInjections('storage', storageParams, { records: {}, env: {}, baseLists: { AppOrigins: 'http://203.0.113.10' }, context: CTX });
    expect(inj.CdnDistributionArn!.value).toBe('');
    expect(inj.AppOrigins!.value).toBe('http://203.0.113.10');
  });

  it('tls injects the CloudFront aliases only where the us-east-1 certificate exists (wave1-integration)', () => {
    const cdnParams = ['AcmCertificateArn', 'Aliases'];
    const env = { TLS_DOMAIN: 'album.example.com' };
    // tls first (ACME, main stack only): no edge certificate -> no alias (cdn's AliasNeedsCertificate rule would refuse the stack)
    const mainOnly = rec({ value: 'acm', env, outputs: { InfoEdgeAliases: '', EnvAcmCertArnEdge: '' } });
    const a = computeInjections('cdn', cdnParams, { records: { tls: mainOnly }, env, context: CTX });
    expect(a.Aliases!.value).toBe('');
    expect(a.AcmCertificateArn!.value).toBe('');
    // re-enable tls after cdn: the edge stack exists and gives both
    const withEdge = rec({ value: 'acm', env, outputs: { InfoEdgeAliases: 'album.example.com', EnvAcmCertArnEdge: 'arn:aws:acm:us-east-1:1:certificate/c' } });
    const b = computeInjections('cdn', cdnParams, { records: { tls: withEdge }, env, context: CTX });
    expect(b.Aliases!.value).toBe('album.example.com');
    expect(b.AcmCertificateArn!.value).toBe('arn:aws:acm:us-east-1:1:certificate/c');
  });

  it('storage injects bucket names into image-processing', () => {
    const storage = rec({ outputs: { EnvStorageS3RawBucket: 'raw-b', EnvStorageS3MediaBucket: 'media-b' } });
    const inj = computeInjections('image-processing', ['RawBucketName', 'MediaBucketName', 'KmsKeyArn', 'OriginBaseUrl'], { records: { storage }, env: {}, context: CTX });
    expect(inj.RawBucketName!.value).toBe('raw-b');
    expect(inj.MediaBucketName!.value).toBe('media-b');
  });

  it('kms target "*" only reaches stacks that declare KmsKeyArn', () => {
    const kms = rec({ outputs: { InfoKeyArn: 'arn:aws:kms:ap-northeast-1:1:key/k' } });
    expect(computeInjections('queue', ['KmsKeyArn'], { records: { kms }, env: {}, context: CTX }).KmsKeyArn!.value).toBe('arn:aws:kms:ap-northeast-1:1:key/k');
    expect(computeInjections('cdn', ['VpcId'], { records: { kms }, env: {}, context: CTX }).KmsKeyArn).toBeUndefined();
  });

  it('when-clauses of injects are honoured (cdn -> dns only with DNS_TARGET_TYPE=cloudfront)', () => {
    const p = ['TargetDnsName'];
    expect(computeInjections('dns', p, { records: { cdn }, env: {}, context: CTX }).TargetDnsName!.value).toBe('');
    const cdn2 = rec({ outputs: { InfoDistributionDomainName: 'd1.cloudfront.net' } });
    expect(computeInjections('dns', p, { records: { cdn: cdn2 }, env: { DNS_TARGET_TYPE: 'cloudfront' }, context: CTX }).TargetDnsName!.value).toBe('d1.cloudfront.net');
  });

  it('lists the enabled targets of a provider', () => {
    const modules = { storage: rec({}), auth: rec({}), queue: rec({ tier: 'local' }) };
    expect(injectTargetsOf('cdn', { modules }).sort()).toEqual(['auth', 'storage']);
  });
});
