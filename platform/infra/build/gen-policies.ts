/**
 * Generate the platform IAM policies (01 §6.4–§6.8, §6.10) from `policies/*.json.tmpl`:
 *   - CloudFormation form (`Fn::Sub`, `Fn::If`, `Ref`) that merge-template.ts embeds for `@@POLICY:<Name>@@`;
 *   - a rendered example (ap-northeast-1, DR ap-northeast-3, account 111122223333) for review;
 *   - the size report (managed policies ≤ 6,144 non-whitespace characters, role inline policies ≤ 10,240 in total, with a
 *     reserve for the run-time ATLRevokedSessions on ATLLearnerRole). Over the limit → exit 1 (CI fails, 01 §6.5).
 *
 * Template mini-language (keeps the .json.tmpl files close to the JSON in 01):
 *   - a string containing `${…}` becomes `Fn::Sub` (IAM policy variables are written `${!aws:…}`);
 *   - `"@@NAME"` is replaced by MACROS[NAME] (a list macro inside a list is spliced);
 *   - a statement with `"//if": "<Condition>"` becomes `Fn::If [<Condition>, <statement>, AWS::NoValue]`;
 *   - keys starting with `//` are comments.
 *
 *   npm run policies -w @atl/infra            # write policies/generated/ and check the sizes
 *   npm run policies -w @atl/infra -- --check # only check (no write); exit 1 when generated files are stale
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseCfnYaml } from './cfn-yaml.js';
import { evaluate, evaluateConditions, EXAMPLE_PSEUDO, type EvalContext } from './intrinsics.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const INFRA_DIR = path.resolve(HERE, '..');
export const POLICIES_DIR = path.join(INFRA_DIR, 'policies');
export const GENERATED_DIR = path.join(POLICIES_DIR, 'generated');

// ---------------------------------------------------------------------------------------------------------------
// Macros (01 §6.5–§6.7)

/** AllowLabServices of 01 §6.5: the services used by the 40 modules and the platform workflows. */
export const LAB_SERVICE_ACTIONS = [
  'access-analyzer:Get*', 'access-analyzer:List*', 'acm:*', 'apigateway:*', 'application-autoscaling:*', 'athena:*', 'autoscaling:*',
  'backup:*', 'backup-storage:*', 'budgets:*', 'ce:Describe*', 'ce:Get*', 'ce:List*', 'cloudformation:*', 'cloudfront:*',
  'cloudshell:*', 'cloudtrail:*', 'cloudwatch:*', 'cognito-identity:*', 'cognito-idp:*', 'config:*', 'dynamodb:*', 'ec2:*',
  'ec2-instance-connect:*', 'ec2messages:*', 'elasticache:*', 'elasticfilesystem:*', 'elasticloadbalancing:*', 'events:*',
  'execute-api:*', 'firehose:*', 'glue:*', 'guardduty:*', 'health:Describe*', 'iam:*', 'imagebuilder:*', 'inspector2:*', 'kms:*',
  'lambda:*', 'logs:*', 'pricing:*', 'rds:*', 'rds-db:*', 'rekognition:*', 'resource-groups:*', 'route53:*', 's3:*', 'scheduler:*',
  'secretsmanager:*', 'servicequotas:Get*', 'servicequotas:List*', 'ses:*', 'sns:*', 'sqs:*', 'ssm:*', 'ssmmessages:*', 'states:*',
  'sts:*', 'tag:*', 'wafv2:*', 'xray:*',
] as const;

/** Global services exempt from the region deny (01 §6.5 DenyOtherRegions). */
export const GLOBAL_SERVICE_ACTIONS = ['iam:*', 'sts:*', 'cloudfront:*', 'route53:*', 'budgets:*', 'ce:*', 'health:*', 'pricing:*'] as const;

/**
 * CloudFront resources of the platform stack (01 §3.8). None of them can carry the `atl:component` tag (CloudFormation
 * does not tag functions, response headers / cache policies or OACs), and `cloudfront:*` is a global lab service, so each
 * one is denied by ARN (test/inventory.test.ts checks that every AWS::CloudFront::* resource of the template is covered).
 * IDs are unique, so the ARNs use `*` for the account and the resource-type segment (keeps ATLWorkloadBoundary within the
 * managed-policy size limit); the function is matched by its reserved `atl-` name.
 */
export const PLATFORM_CLOUDFRONT_ARNS = [
  'arn:${AWS::Partition}:cloudfront::*:*/${WebDistribution}',
  'arn:${AWS::Partition}:cloudfront::*:function/atl-*',
  'arn:${AWS::Partition}:cloudfront::*:*/${SpaHeadersPolicy}',
  'arn:${AWS::Partition}:cloudfront::*:*/${VerifyHeadersPolicy}',
  'arn:${AWS::Partition}:cloudfront::*:*/${ShareHeadersPolicy}',
  'arn:${AWS::Partition}:cloudfront::*:*/${ShortTtlCachePolicy}',
  'arn:${AWS::Partition}:cloudfront::*:*/${WebOac}',
] as const;

export const MACROS: Record<string, unknown> = {
  LAB_SERVICE_ACTIONS: [...LAB_SERVICE_ACTIONS],
  /** 01 §6.6: same list without cloudformation:*; IAM / STS are granted by separate statements. */
  WORKLOAD_SERVICE_ACTIONS: LAB_SERVICE_ACTIONS.filter((a) => !['cloudformation:*', 'iam:*', 'sts:*'].includes(a)),
  /** 01 §6.7 #2 ⑤: plus ce:UpdateCostAllocationTagsStatus (platform action activateCostAllocationTags). */
  PROVISIONER_SERVICE_ACTIONS: [...LAB_SERVICE_ACTIONS, 'ce:UpdateCostAllocationTagsStatus'],
  GLOBAL_SERVICE_ACTIONS: [...GLOBAL_SERVICE_ACTIONS],
  US_EAST_1_EDGE_ACTIONS: [
    ...GLOBAL_SERVICE_ACTIONS, 'acm:*', 'wafv2:*', 'cloudwatch:*', 'logs:*', 'sns:*', 's3:ListAllMyBuckets', 's3:GetBucketLocation',
    'cloudtrail:LookupEvents', 'cloudformation:*',
  ],
  DR_REGION_ACTIONS: [
    'iam:*', 'sts:*', 'backup:*', 'backup-storage:*', 'kms:*', 's3:*', 'tag:GetResources', 'cloudformation:*', 'ec2:Describe*',
    'ec2:*Snapshot*', 'ec2:CreateTags', 'ec2:CreateVolume', 'ec2:DeleteVolume', 'rds:Describe*', 'rds:*DBSnapshot*',
    'rds:AddTagsToResource', 'rds:CreateDBInstanceReadReplica', 'rds:DeleteDBInstance', 'rds:*DBSubnetGroup', 'cloudwatch:Get*',
    'cloudwatch:List*',
  ],
  /** Lab region, us-east-1 and the DR region (must equal the reclaim scan regions of 02 §7.1). */
  ALLOWED_REGIONS: {
    'Fn::If': [
      'IsUsEast1',
      { 'Fn::If': ['HasDrRegion', ['us-east-1', { Ref: 'DrRegion' }], ['us-east-1']] },
      { 'Fn::If': ['HasDrRegion', [{ Ref: 'AWS::Region' }, 'us-east-1', { Ref: 'DrRegion' }], [{ Ref: 'AWS::Region' }, 'us-east-1']] },
    ],
  },
  // 01 §6.5 DenyPlatformByName. The IAM entry covers role/, policy/ and instance-profile/ATL* in one ARN (saves boundary characters).
  PLATFORM_NAME_RESOURCES: [
    'arn:${AWS::Partition}:iam::*:*/ATL*',
    ...platformNameCommon('arn:${AWS::Partition}:s3:::atl-*', 'arn:${AWS::Partition}:cloudformation:*:*:stack/atl*'),
  ],
  PROVISIONER_PLATFORM_NAME_RESOURCES: [
    'arn:${AWS::Partition}:iam::*:policy/ATL*',
    'arn:${AWS::Partition}:s3:::atl-web-*',
    'arn:${AWS::Partition}:s3:::atl-trail-*',
    ...platformNameCommon(null, 'arn:${AWS::Partition}:cloudformation:*:*:stack/${AWS::StackName}/*'),
  ],
  PLATFORM_TAG_EXEMPT_ACTIONS: [
    'ssm:StartSession', 'ssm:ResumeSession', 'ssm:TerminateSession', 'ssm:DescribeSessions', 'ssm:GetConnectionStatus',
    'ssm:DescribeInstanceInformation', 'execute-api:Invoke',
  ],
  PROVISIONER_TAG_EXEMPT_ACTIONS: [
    'ssm:SendCommand', 'ssm:StartSession', 'ssm:TerminateSession', 'ssm:DescribeSessions', 'ssm:DescribeInstanceInformation',
    'execute-api:Invoke',
  ],
  ACCOUNT_IAM_ACTIONS: ['iam:CreateUser', 'iam:CreateAccessKey', ...accountIamActions()],
  ACCOUNT_IAM_ACTIONS_NO_USERS: accountIamActions(),
  PLATFORM_ARNS: platformArns(true),
  PLATFORM_ARNS_NO_ASSOCIATION: platformArns(false),
  RDS_INSTANCE_WRITE_ACTIONS: ['rds:CreateDBInstance', 'rds:CreateDBInstanceReadReplica', 'rds:ModifyDBInstance', 'rds:RestoreDBInstance*'],
  STACK_WRITE_ACTIONS: [
    'cloudformation:CreateStack', 'cloudformation:UpdateStack', 'cloudformation:DeleteStack', 'cloudformation:CreateChangeSet',
    'cloudformation:ExecuteChangeSet',
  ],
  RECORDING_DESTRUCTIVE_ACTIONS: [
    'logs:DeleteLogGroup', 'logs:DeleteLogStream', 'logs:PutRetentionPolicy', 'logs:DeleteRetentionPolicy', 'logs:AssociateKmsKey',
    'logs:DisassociateKmsKey', 'logs:PutSubscriptionFilter', 'logs:DeleteSubscriptionFilter', 'logs:PutDataProtectionPolicy',
    'logs:TagResource', 'logs:UntagResource', 'logs:TagLogGroup', 'logs:UntagLogGroup',
  ],
};

function platformNameCommon(s3: string | null, stack: string): string[] {
  return [
    ...(s3 ? [s3] : []),
    'arn:${AWS::Partition}:dynamodb:*:*:table/atl-*', 'arn:${AWS::Partition}:lambda:*:*:function:atl-*', 'arn:${AWS::Partition}:states:*:*:*:atl-*',
    'arn:${AWS::Partition}:codebuild:*:*:project/atl-*', stack, 'arn:${AWS::Partition}:scheduler:*:*:schedule*/atl-*',
    'arn:${AWS::Partition}:logs:*:*:log-group:/atl/*', 'arn:${AWS::Partition}:logs:*:*:log-group:/aws/*/atl-*',
    'arn:${AWS::Partition}:ssm:*:*:parameter/atl/*', 'arn:${AWS::Partition}:sns:*:*:atl-*', 'arn:${AWS::Partition}:sqs:*:*:atl-*',
    'arn:${AWS::Partition}:kms:*:*:alias/atl-*', 'arn:${AWS::Partition}:events:*:*:*/atl-*',
    'arn:${AWS::Partition}:budgets::*:budget/atl-*', 'arn:${AWS::Partition}:access-analyzer:*:*:analyzer/atl-*',
  ];
}

function accountIamActions(): string[] {
  return [
    'iam:CreateLoginProfile', 'iam:UpdateLoginProfile', 'iam:AddUserToGroup', 'iam:CreateGroup', 'iam:AttachGroupPolicy', 'iam:PutGroupPolicy',
    'iam:CreateSAMLProvider', 'iam:CreateOpenIDConnectProvider', 'iam:Update*Provider*', 'iam:*AccountAlias', 'iam:*AccountPasswordPolicy',
    'iam:*MFADevice', 'iam:CreateServiceSpecificCredential', 'iam:UploadSSHPublicKey', 'iam:UploadSigningCertificate',
    'iam:SetSecurityTokenServicePreferences',
  ];
}

/** DenyPlatformByArn: platform resources whose names are not predictable (01 §6.5). */
function platformArns(withAssociation: boolean): string[] {
  return [
    ...PLATFORM_CLOUDFRONT_ARNS,
    'arn:${AWS::Partition}:cognito-idp:*:*:userpool/${UserPool}',
    // the HTTP API and all its sub-resources (API ids have a fixed length of 10)
    'arn:${AWS::Partition}:apigateway:*::/apis/${HttpApi}*',
    'arn:${AWS::Partition}:kms:*:*:key/${CertSigningKey}',
    ...(withAssociation ? ['arn:${AWS::Partition}:ssm:${AWS::Region}:${AWS::AccountId}:association/${PrepareInstanceAssociation}'] : []),
  ];
}

// ---------------------------------------------------------------------------------------------------------------
// Policy registry

export type PolicyKind = 'managed' | 'inline';
export interface PolicySpec {
  name: string;
  kind: PolicyKind;
  /** Role that carries an inline policy (inline sizes are summed per role). */
  role?: string;
  source: string;
}

export const POLICY_SPECS: readonly PolicySpec[] = [
  { name: 'ATLLearnerBoundary', kind: 'managed', source: 'ATLLearnerBoundary.json.tmpl' },
  { name: 'ATLWorkloadBoundary', kind: 'managed', source: 'ATLWorkloadBoundary.json.tmpl' },
  { name: 'ATLProvisionerBoundary', kind: 'managed', source: 'ATLProvisionerBoundary.json.tmpl' },
  { name: 'ATLLearnerGuardrails', kind: 'managed', source: 'ATLLearnerGuardrails.json.tmpl' },
  { name: 'ATLLearnerCostGuards', kind: 'managed', source: 'ATLLearnerCostGuards.json.tmpl' },
  { name: 'ATLProvisionerPolicy-Core', kind: 'managed', source: 'ATLProvisionerPolicy-Core.json.tmpl' },
  { name: 'ATLProvisionerPolicy-Guards', kind: 'managed', source: 'ATLProvisionerPolicy-Guards.json.tmpl' },
  { name: 'ATLLearnerIam', kind: 'inline', role: 'ATLLearnerRole', source: 'ATLLearnerIam.json.tmpl' },
  { name: 'ATLAgentApi', kind: 'inline', role: 'ATLLearnerRole', source: 'ATLAgentApi.json.tmpl' },
  { name: 'ATLVerifierReadOnly', kind: 'inline', role: 'ATLVerifierRole', source: 'verifier-readonly' },
  { name: 'ATLVerifierRunCheck', kind: 'inline', role: 'ATLVerifierRole', source: 'ATLVerifierRunCheck.json.tmpl' },
];

/** IAM quotas (01 §6.5, §6.10; values per the IAM quotas page at the time of writing — verified again in 07). */
export const MANAGED_POLICY_MAX_CHARS = 6144;
export const ROLE_INLINE_MAX_CHARS = 10240;
/** Reserved inline budget on ATLLearnerRole for the run-time ATLRevokedSessions (single-digit entries, 02 §6.3). */
export const REVOKED_SESSIONS_RESERVE = 2000;

// ---------------------------------------------------------------------------------------------------------------
// Compile

function isObject(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

function macro(name: string): unknown {
  if (!(name in MACROS)) throw new Error(`unknown policy macro @@${name}`);
  return structuredClone(MACROS[name]);
}

export function compilePolicyNode(node: unknown): unknown {
  if (typeof node === 'string') {
    if (node.startsWith('@@')) return compilePolicyNode(macro(node.slice(2)));
    if (!node.includes('${')) return node;
    // only escaped IAM variables (${!aws:…}) → a plain string with ${aws:…}, no Fn::Sub needed
    if (!/\$\{(?!!)/.test(node)) return node.replace(/\$\{!/g, '${');
    return { 'Fn::Sub': node };
  }
  if (Array.isArray(node)) {
    const out: unknown[] = [];
    for (const item of node) {
      if (typeof item === 'string' && item.startsWith('@@')) {
        const v = compilePolicyNode(macro(item.slice(2)));
        if (Array.isArray(v)) out.push(...v);
        else out.push(v);
      } else out.push(compilePolicyNode(item));
    }
    return out;
  }
  if (!isObject(node)) return node;
  // intrinsic functions already written in JSON form are compiled inside, keys untouched
  const cond = typeof node['//if'] === 'string' ? (node['//if'] as string) : null;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(node)) {
    if (k.startsWith('//')) continue;
    out[k] = k === 'Fn::Sub' || k === 'Ref' ? v : compilePolicyNode(v);
  }
  return cond ? { 'Fn::If': [cond, out, { Ref: 'AWS::NoValue' }] } : out;
}

export function loadPolicySource(spec: PolicySpec, dir: string = POLICIES_DIR): unknown {
  if (spec.source === 'verifier-readonly') {
    const generated = path.join(dir, 'generated', 'verifier-readonly.json');
    const file = fs.existsSync(generated) ? generated : path.join(dir, 'verifier-readonly.base.json');
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  }
  return JSON.parse(fs.readFileSync(path.join(dir, spec.source), 'utf8'));
}

/** Compiled (CloudFormation-form) policy documents by name. */
export function compilePolicies(dir: string = POLICIES_DIR): Record<string, Record<string, unknown>> {
  const out: Record<string, Record<string, unknown>> = {};
  for (const spec of POLICY_SPECS) out[spec.name] = compilePolicyNode(loadPolicySource(spec, dir)) as Record<string, unknown>;
  return out;
}

// ---------------------------------------------------------------------------------------------------------------
// Render (example values) and sizes

export const EXAMPLE_PARAMS: Record<string, string | string[]> = {
  DrRegion: 'ap-northeast-3',
  AllowedInstanceTypes: ['t3.micro', 't3.small', 't3.medium', 't4g.micro', 't4g.small', 't4g.medium'],
  AllowedDbClasses: ['db.t3.micro', 'db.t4g.micro', 'db.t4g.small'],
  AllowedCacheNodeTypes: ['cache.t3.micro', 'cache.t4g.micro', 'cache.t4g.small'],
  AsgMaxSizeLimit: '4',
  MaxEbsVolumeGiB: '100',
  MaxDbStorageGiB: '100',
};

/** Example physical ids of the resources the policies reference (lengths as in AWS). */
export function exampleResolvers(pseudo: Record<string, string>): Pick<EvalContext, 'ref' | 'getAtt'> {
  const acct = pseudo['AWS::AccountId']!;
  const region = pseudo['AWS::Region']!;
  const refs: Record<string, string> = {
    WebDistribution: 'E2EXAMPLEATL01',
    SpaHeadersPolicy: '11111111-aaaa-4bbb-8ccc-000000000001',
    VerifyHeadersPolicy: '11111111-aaaa-4bbb-8ccc-000000000002',
    ShareHeadersPolicy: '11111111-aaaa-4bbb-8ccc-000000000003',
    ShortTtlCachePolicy: '22222222-aaaa-4bbb-8ccc-000000000001',
    WebOac: 'E3EXAMPLEOAC01',
    CertSigningKey: '1234abcd-12ab-34cd-56ef-1234567890ab',
    UserPool: `${region}_EXAMPLE12`,
    HttpApi: 'a1b2c3d4e5',
    PrepareInstanceAssociation: '00000000-0000-4000-8000-000000000000',
    LabStateBucket: `cloudalbum-lab-state-${acct}-${region}`,
    LabLockTable: 'cloudalbum-lab-locks',
    DataBucket: `atl-data-${acct}-${region}`,
    ArtifactsBucket: `atl-artifacts-${acct}-${region}`,
    WebBucket: `atl-web-${acct}-${region}`,
  };
  const atts: Record<string, string> = {
    'CertSigningKey.Arn': `arn:aws:kms:${region}:${acct}:key/1234abcd-12ab-34cd-56ef-1234567890ab`,
    'LabLockTable.Arn': `arn:aws:dynamodb:${region}:${acct}:table/cloudalbum-lab-locks`,
  };
  return {
    ref: (id) => {
      const v = refs[id];
      if (v === undefined) throw new Error(`no example value for Ref ${id}`);
      return v;
    },
    getAtt: (id, attr) => {
      const v = atts[`${id}.${attr}`];
      if (v === undefined) throw new Error(`no example value for GetAtt ${id}.${attr}`);
      return v;
    },
  };
}

export interface Scenario {
  name: string;
  region: string;
  drRegion: string;
}

export const SCENARIOS: readonly Scenario[] = [
  { name: 'ap-northeast-1 + DR ap-northeast-3', region: 'ap-northeast-1', drRegion: 'ap-northeast-3' },
  { name: 'ap-southeast-2 + DR ap-southeast-4', region: 'ap-southeast-2', drRegion: 'ap-southeast-4' },
  { name: 'us-east-1 without DR', region: 'us-east-1', drRegion: '' },
];

let metaCache: Record<string, unknown> | null = null;
function loadMeta(): Record<string, unknown> {
  metaCache ??= parseCfnYaml(fs.readFileSync(path.join(INFRA_DIR, 'src', '00-meta.yaml'), 'utf8'));
  return metaCache;
}

export function loadMetaConditions(): Record<string, unknown> {
  return (loadMeta().Conditions ?? {}) as Record<string, unknown>;
}

/** Render a compiled policy for a scenario (all template conditions evaluated with the example parameters). */
export function renderPolicy(compiled: unknown, scenario: Scenario = SCENARIOS[0]!, overrides: Record<string, string | string[]> = {}): Record<string, unknown> {
  const pseudo = { ...EXAMPLE_PSEUDO, 'AWS::Region': scenario.region };
  const params = { ...defaultParams(), ...EXAMPLE_PARAMS, DrRegion: scenario.drRegion, ...overrides };
  const base = { params, pseudo, ...exampleResolvers(pseudo) };
  const conditions = evaluateConditions(loadMetaConditions(), base);
  return evaluate(compiled, { ...base, conditions }) as Record<string, unknown>;
}

let defaultsCache: Record<string, string | string[]> | null = null;
/** Default values of the template parameters (from src/00-meta.yaml). */
export function defaultParams(): Record<string, string | string[]> {
  if (defaultsCache) return defaultsCache;
  const meta = loadMeta();
  const out: Record<string, string | string[]> = {};
  for (const [name, def] of Object.entries((meta.Parameters ?? {}) as Record<string, Record<string, unknown>>)) {
    const d = def.Default;
    if (d === undefined) {
      out[name] = def.Type === 'CommaDelimitedList' ? [] : '';
      continue;
    }
    out[name] = def.Type === 'CommaDelimitedList' ? String(d).split(',').map((s) => s.trim()) : String(d);
  }
  defaultsCache = out;
  return out;
}

/** IAM counts policy size without whitespace. */
export function policySize(doc: unknown): number {
  return JSON.stringify(doc).replace(/\s+/g, '').length;
}

export interface SizeReport {
  scenario: string;
  managed: { name: string; size: number; limit: number; headroom: number }[];
  inline: { role: string; policies: string[]; size: number; reserve: number; limit: number; headroom: number }[];
}

export function sizeReport(compiled: Record<string, Record<string, unknown>> = compilePolicies()): SizeReport[] {
  return SCENARIOS.map((sc) => {
    const managed = POLICY_SPECS.filter((s) => s.kind === 'managed').map((s) => {
      const size = policySize(renderPolicy(compiled[s.name], sc));
      return { name: s.name, size, limit: MANAGED_POLICY_MAX_CHARS, headroom: MANAGED_POLICY_MAX_CHARS - size };
    });
    const roles = [...new Set(POLICY_SPECS.filter((s) => s.kind === 'inline').map((s) => s.role!))];
    const inline = roles.map((role) => {
      const specs = POLICY_SPECS.filter((s) => s.role === role);
      const size = specs.reduce((n, s) => n + policySize(renderPolicy(compiled[s.name], sc)), 0);
      const reserve = role === 'ATLLearnerRole' ? REVOKED_SESSIONS_RESERVE : 0;
      return { role, policies: specs.map((s) => s.name), size, reserve, limit: ROLE_INLINE_MAX_CHARS, headroom: ROLE_INLINE_MAX_CHARS - reserve - size };
    });
    return { scenario: sc.name, managed, inline };
  });
}

export function sizeViolations(reports: SizeReport[]): string[] {
  const out: string[] = [];
  for (const r of reports) {
    for (const m of r.managed) if (m.headroom < 0) out.push(`${r.scenario}: ${m.name} is ${m.size} characters (limit ${m.limit})`);
    for (const i of r.inline)
      if (i.headroom < 0) out.push(`${r.scenario}: inline policies of ${i.role} are ${i.size} characters (+${i.reserve} reserve, limit ${i.limit})`);
  }
  return out;
}

// ---------------------------------------------------------------------------------------------------------------
// Generated files

export function generatedFiles(): Record<string, string> {
  const compiled = compilePolicies();
  const files: Record<string, string> = {};
  for (const spec of POLICY_SPECS) {
    files[`${spec.name}.cfn.json`] = JSON.stringify(compiled[spec.name], null, 2) + '\n';
    files[`${spec.name}.example.json`] = JSON.stringify(renderPolicy(compiled[spec.name]), null, 2) + '\n';
  }
  files['sizes.json'] = JSON.stringify(sizeReport(compiled), null, 2) + '\n';
  return files;
}

function main(): void {
  const check = process.argv.includes('--check');
  const files = generatedFiles();
  const stale: string[] = [];
  if (!check) fs.mkdirSync(GENERATED_DIR, { recursive: true });
  for (const [name, body] of Object.entries(files)) {
    const file = path.join(GENERATED_DIR, name);
    if (check) {
      if (!fs.existsSync(file) || fs.readFileSync(file, 'utf8') !== body) stale.push(name);
    } else fs.writeFileSync(file, body);
  }
  const reports = JSON.parse(files['sizes.json']!) as SizeReport[];
  for (const r of reports) {
    console.log(`# ${r.scenario}`);
    for (const m of r.managed) console.log(`  ${m.name.padEnd(28)} ${String(m.size).padStart(5)} / ${m.limit}  (headroom ${m.headroom})`);
    for (const i of r.inline)
      console.log(`  inline ${i.role.padEnd(21)} ${String(i.size).padStart(5)} / ${i.limit - i.reserve}  (headroom ${i.headroom}; ${i.policies.join(', ')})`);
  }
  const violations = sizeViolations(reports);
  for (const v of violations) console.error(`ERROR ${v}`);
  if (stale.length) console.error(`ERROR generated policies are stale (run npm run policies -w @atl/infra): ${stale.join(', ')}`);
  if (violations.length || stale.length) process.exitCode = 1;
}

if (process.argv[1] && /gen-policies\.(ts|js)$/.test(process.argv[1])) main();
