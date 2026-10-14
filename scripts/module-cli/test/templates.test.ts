import { readdirSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { classifyOutput } from '../src/outputs.js';
import { MODULE_IDS, MVP_MODULES, REGISTRY } from '../src/registry.js';
import { findExportsAndImports, loadTemplate, mainTemplatePath, parseTemplate, staticOutputValue, type CfnTemplate } from '../src/template.js';
import { REPO_ROOT, modulesWithTemplates } from './helpers.js';

const IMPLEMENTED_MODULES = modulesWithTemplates();   // wave1-prep: wave 1 templates may still be pending (helpers.ts)

const TEMPLATES = readdirSync(path.join(REPO_ROOT, 'infra', 'modules')).filter((f) => f.endsWith('.yaml'));
const load = (f: string): CfnTemplate => loadTemplate(REPO_ROOT, `infra/modules/${f}`);

describe('infra/modules templates follow the 9.1 conventions', () => {
  it('every MVP module (and ec2, toolchain) has its template', () => {
    for (const id of [...MVP_MODULES, ...IMPLEMENTED_MODULES, 'ec2' as const]) expect(TEMPLATES, id).toContain(path.basename(mainTemplatePath(id)));
    expect(TEMPLATES).toContain('toolchain.yaml');
  });

  it.each(TEMPLATES)('%s: no Export / ImportValue (D2)', (f) => {
    expect(findExportsAndImports(load(f))).toEqual([]);
  });

  it.each(TEMPLATES)('%s: ModuleId / ModuleVersion outputs and Env* / Info* / PolicyArn naming', (f) => {
    const t = load(f);
    expect(t.Outputs.ModuleId).toBeDefined();
    expect(t.Outputs.ModuleVersion).toBeDefined();
    expect(t.Parameters.Env).toMatchObject({ Default: 'lab' });
    expect(t.Parameters.ModuleVersion).toBeDefined();
    const kinds = Object.keys(t.Outputs).map((k) => [k, classifyOutput(k)]);
    const context = kinds.filter(([, kind]) => kind === 'context').map(([k]) => k);
    if (f === 'ec2.yaml') {
      expect(context.sort()).toEqual(['AvailabilityZone', 'DataVolumeId', 'InstanceId', 'InstanceSecurityGroupId', 'PublicIp', 'SubnetId', 'VpcId']);
    } else {
      expect(context, f).toEqual([]);
    }
  });

  it.each(TEMPLATES)('%s: managed policies are never attached by the template; roles honour PermissionsBoundaryArn', (f) => {
    const t = load(f);
    for (const [name, r] of Object.entries(t.Resources)) {
      if (r.Type === 'AWS::IAM::ManagedPolicy' && f !== 'iam.yaml') {
        expect(r.Properties?.Roles, `${f} ${name}`).toBeUndefined();
        expect(r.Properties?.Users, `${f} ${name}`).toBeUndefined();
        expect(r.Properties?.Groups, `${f} ${name}`).toBeUndefined();
      }
      if (r.Type === 'AWS::IAM::Role' || r.Type === 'AWS::IAM::User') {
        expect(t.Parameters.PermissionsBoundaryArn, `${f} ${name}`).toMatchObject({ Default: '' });
        expect(JSON.stringify(r.Properties?.PermissionsBoundary), `${f} ${name}`).toContain('PermissionsBoundaryArn');
        const n = (r.Properties?.RoleName ?? r.Properties?.UserName) as unknown;
        if (typeof n === 'string') expect(n).toMatch(/^(cloudalbum-|CloudAlbum)/);
        else if (n) expect(JSON.stringify(n)).toMatch(/cloudalbum-\$\{Env\}/);
      }
    }
  });

  it('templates of modules with a PolicyArn output create exactly one customer managed policy named cloudalbum-<env>-<id>', () => {
    for (const id of IMPLEMENTED_MODULES.filter((m) => m !== 'iam')) {
      const t = loadTemplate(REPO_ROOT, mainTemplatePath(id));
      expect(t.Outputs.PolicyArn, id).toBeDefined();
      const policies = Object.values(t.Resources).filter((r) => r.Type === 'AWS::IAM::ManagedPolicy');
      expect(policies, id).toHaveLength(1);
      expect(JSON.stringify(policies[0]!.Properties?.ManagedPolicyName)).toContain(`cloudalbum-\${Env}-${id}`);
    }
    // total outline 9.1: the iam stack only outputs Info* (its roles reference the read-only base policy directly)
    expect(loadTemplate(REPO_ROOT, mainTemplatePath('iam')).Outputs.PolicyArn).toBeUndefined();
  });

  it('every parameter injected into a module by a provider is declared optional (Default \'\')', () => {
    for (const provider of MODULE_IDS) {
      for (const inj of REGISTRY[provider]?.injects ?? []) {
        const targets = inj.target === '*' ? IMPLEMENTED_MODULES : IMPLEMENTED_MODULES.filter((m) => m === inj.target);
        for (const target of targets) {
          const t = loadTemplate(REPO_ROOT, mainTemplatePath(target));
          for (const param of Object.keys(inj.params)) {
            const p = t.Parameters[param];
            if (!p) continue;   // the target stack does not use it (allowed for "*")
            const optional = p.Default !== undefined || ['VpcId', 'SubnetIds', 'RawBucketName', 'MediaBucketName', 'AppOrigins'].includes(param);
            expect(optional, `${provider} -> ${target}.${param}`).toBe(true);
          }
        }
      }
    }
  });

  it('templates that use KmsKeyArn accept the kms injection', () => {
    for (const id of ['storage', 'queue', 'cache', 'database', 'image-processing', 'auth'] as const) {
      expect(loadTemplate(REPO_ROOT, mainTemplatePath(id)).Parameters.KmsKeyArn, id).toMatchObject({ Default: '' });
    }
  });

  it('data resources are retained (9.1 data protection)', () => {
    const storage = loadTemplate(REPO_ROOT, 'infra/modules/storage.yaml');
    for (const b of ['RawBucket', 'MediaBucket']) {
      expect(storage.Resources[b]).toMatchObject({ DeletionPolicy: 'Retain', UpdateReplacePolicy: 'Retain' });
    }
    expect(loadTemplate(REPO_ROOT, 'infra/modules/auth.yaml').Resources.UserPool).toMatchObject({ DeletionPolicy: 'Retain' });
    expect(loadTemplate(REPO_ROOT, 'infra/modules/database.yaml').Resources.DbInstance).toMatchObject({ DeletionPolicy: 'Snapshot', UpdateReplacePolicy: 'Snapshot' });
    expect(loadTemplate(REPO_ROOT, 'infra/modules/ec2.yaml').Resources.DataVolume).toMatchObject({ DeletionPolicy: 'Retain' });
  });

  it('MUTEX-004: the raw bucket notification configuration only enables EventBridge', () => {
    const raw = loadTemplate(REPO_ROOT, 'infra/modules/storage.yaml').Resources.RawBucket!;
    expect(raw.Properties?.NotificationConfiguration).toEqual({ EventBridgeConfiguration: { EventBridgeEnabled: true } });
    const media = loadTemplate(REPO_ROOT, 'infra/modules/storage.yaml').Resources.MediaBucket!;
    expect(media.Properties?.NotificationConfiguration).toBeUndefined();
  });

  it('image-processing: the EventBridge rule name is the fixed one the probe looks up', () => {
    const rule = loadTemplate(REPO_ROOT, 'infra/modules/image-processing.yaml').Resources.RawObjectCreatedRule!;
    expect(rule.Properties?.Name).toEqual({ 'Fn::Sub': 'cloudalbum-${Env}-image-processing-raw-created' });
  });
});

describe('ec2 base stack (00-ec2-base.md 6.2 / 6.6)', () => {
  const t = loadTemplate(REPO_ROOT, 'infra/modules/ec2.yaml');

  it('declares the 30 parameters of the contract', () => {
    expect(Object.keys(t.Parameters).sort()).toEqual([
      'AdminEmail', 'AdminIngressCidr', 'AlbSecurityGroupId', 'AppArchiveSha256', 'AppArchiveUrl', 'Arch', 'AssociateEip',
      'CpuCredits', 'DataVolumeAttach', 'DataVolumeAz', 'DataVolumeId', 'DataVolumeKmsKeyId', 'DataVolumeSizeGiB',
      'DetailedMonitoring', 'Env', 'ExtraSecurityGroupIds', 'HttpPutResponseHopLimit', 'ImageId', 'InstanceBackupTag',
      'InstanceProfileName', 'InstanceSlot', 'InstanceType', 'KeyName', 'ModuleVersion', 'PlatformMode', 'PublicHttpIngress',
      'RootVolumeSizeGiB', 'SshIngressCidr', 'SubnetId', 'VpcId',
    ]);
    expect(t.Parameters.ImageId!.Type).toBe('AWS::SSM::Parameter::Value<AWS::EC2::Image::Id>');
  });

  it('no IAM resources and no PolicyArn in L0', () => {
    expect(Object.values(t.Resources).filter((r) => r.Type.startsWith('AWS::IAM::'))).toEqual([]);
    expect(t.Outputs.PolicyArn).toBeUndefined();
  });

  it('InstanceA and InstanceB are identical except Condition and the CloudAlbumLogicalId tag', () => {
    const strip = (r: unknown, logical: string) => JSON.parse(JSON.stringify(r).split(`"Value":"${logical}"`).join('"Value":"<slot>"'));
    const a = strip(t.Resources.InstanceA, 'InstanceA');
    const b = strip(t.Resources.InstanceB, 'InstanceB');
    delete a.Condition; delete b.Condition;
    expect(a).toEqual(b);
  });

  it('IMDSv2 required, CreationPolicy waits for cfn-signal, data volume via Volumes, data volume retained', () => {
    const a = t.Resources.InstanceA!;
    expect(a.CreationPolicy).toEqual({ ResourceSignal: { Count: 1, Timeout: 'PT20M' } });
    expect(a.Properties?.MetadataOptions).toMatchObject({ HttpTokens: 'required', InstanceMetadataTags: 'enabled' });
    expect(JSON.stringify(a.Properties?.Volumes)).toContain('/dev/sdf');
    expect(JSON.stringify(a.Properties?.UserData)).toContain('l0-bootstrap.sh all');
    expect(JSON.stringify(a.Properties?.UserData)).not.toMatch(/SECRET|PASSWORD|HMAC/);
  });
});

describe('staticOutputValue（--dry-run 计划校验用的部署前输出值）', () => {
  it('字面量、!Ref 参数默认值，以及只依赖参数的 !If（auth / cache 的枚举型 Env 输出）', () => {
    expect(staticOutputValue(load('auth.yaml'), 'EnvCognitoTriggers')).toBe('off');
    expect(staticOutputValue(load('auth.yaml'), 'EnvCognitoTriggers', { EnableTriggers: 'true' })).toBe('on');
    expect(staticOutputValue(load('cache.yaml'), 'EnvRedisClientMode')).toBe('single');
    expect(staticOutputValue(load('cache.yaml'), 'EnvRedisClientMode', { CacheMode: 'serverless' })).toBe('cluster');
    const t = parseTemplate([
      'Parameters: { A: { Type: String, Default: x }, B: { Type: String } }',
      'Conditions: { IsX: !Equals [!Ref A, x], Both: !And [!Condition IsX, !Not [!Equals [!Ref A, y]]], Unknown: !Equals [!Ref B, z] }',
      'Outputs:',
      '  O1: { Value: !If [Both, first, second] }',
      '  O2: { Value: !If [Unknown, first, second] }',
      '  O3: { Value: !GetAtt R.Arn }',
    ].join('\n'));
    expect(staticOutputValue(t, 'O1')).toBe('first');
    expect(staticOutputValue(t, 'O2')).toBeUndefined();
    expect(staticOutputValue(t, 'O3')).toBeUndefined();
  });
});
