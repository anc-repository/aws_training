/**
 * CloudFormation stack operations of scripts/module (9.2 step 3): equivalent of
 * `aws cloudformation deploy --capabilities CAPABILITY_NAMED_IAM --tags ... --no-fail-on-empty-changeset`.
 * Stack-level tags (propagated to most resources): Project=CloudAlbum, Env, Module, ModuleVersion, ManagedBy=scripts/module.
 * In --dry-run every call is printed and the returned outputs are placeholders `<stack:Output>` derived from the template.
 */
import type { AwsGateway } from './aws.js';
import { isAwsError } from './aws.js';
import type { Printer } from './printer.js';
import { CliError, EXIT } from './printer.js';
import { sleep } from './deliver.js';
import { loadTemplate, readTemplateBody, staticOutputValue } from './template.js';

export interface StackInfo {
  status: string;
  outputs: Record<string, string>;
  parameters: Record<string, string>;
  tags: Record<string, string>;
}

type CfnStack = {
  StackStatus?: string;
  StackStatusReason?: string;
  Outputs?: Array<{ OutputKey?: string; OutputValue?: string }>;
  Parameters?: Array<{ ParameterKey?: string; ParameterValue?: string }>;
  Tags?: Array<{ Key?: string; Value?: string }>;
};

/** undefined = dry-run (unknown); null = the stack does not exist */
export async function describeStack(aws: AwsGateway, stackName: string, region?: string): Promise<StackInfo | null | undefined> {
  try {
    const r = await aws.send<{ Stacks?: CfnStack[] }>({ service: 'cloudformation', op: 'DescribeStacks', input: { StackName: stackName }, ...(region ? { region } : {}) });
    if (r === undefined) return undefined;
    const s = r.Stacks?.[0];
    if (!s) return null;
    return toInfo(s);
  } catch (e) {
    if (isAwsError(e, 'does not exist')) return null;
    throw e;
  }
}

function toInfo(s: CfnStack): StackInfo {
  return {
    status: s.StackStatus ?? 'UNKNOWN',
    outputs: Object.fromEntries((s.Outputs ?? []).map((o) => [o.OutputKey ?? '', o.OutputValue ?? ''])),
    parameters: Object.fromEntries((s.Parameters ?? []).map((p) => [p.ParameterKey ?? '', p.ParameterValue ?? ''])),
    tags: Object.fromEntries((s.Tags ?? []).map((t) => [t.Key ?? '', t.Value ?? ''])),
  };
}

export interface DeployRequest {
  stackName: string;
  /** repository-relative template path */
  template: string;
  /** parameter values; parameters of an existing stack that are absent here keep their previous value */
  params: Record<string, string>;
  /** parameter names whose values are secret (NoEcho): redacted in output */
  secretParams?: readonly string[];
  tags: Record<string, string>;
  region?: string;
  /** S3 bucket for templates larger than the TemplateBody limit (toolchain bucket) */
  templateBucket?: string;
  /** first deployment in platform mode (06 PM-05): keep the failed stack for diagnosis */
  disableRollback?: boolean;
}

export interface DeployResult {
  outputs: Record<string, string>;
  status: string;
  changed: boolean;
  created: boolean;
}

const TERMINAL_OK = new Set(['CREATE_COMPLETE', 'UPDATE_COMPLETE', 'IMPORT_COMPLETE']);
const TEMPLATE_BODY_LIMIT = 51_200;

/**
 * Platform mode stack tags (06 PM-29): environment-level tags (Project, atl:component=env, atl:env-id; from state.platform) and
 * session-level tags (atl:session-id, atl:lab-id; from CLOUDALBUM_PLATFORM_TAGS). `cloudformation deploy --tags` replaces the
 * stack tags and propagates them to resources, so an UPDATE keeps the session tags the stack was created with (02 §8.4 rule 4:
 * a resource keeps the atl:session-id of its creation); only new stacks get the current session. atl:role is never set here.
 */
export const SESSION_TAG_KEYS = ['atl:session-id', 'atl:lab-id'] as const;
let platformTags: { env: Record<string, string>; session: Record<string, string> } | null = null;

export function configurePlatformTags(tags: { env: Record<string, string>; session: Record<string, string> } | null): void {
  if (tags && Object.keys({ ...tags.env, ...tags.session }).some((k) => k === 'atl:role')) throw new Error('atl:role is only set by templates (01 ProtectRoleTag)');
  platformTags = tags;
}

export function stackTags(env: string, module: string, version: string | number, extra: Record<string, string> = {}): Record<string, string> {
  return {
    Project: 'CloudAlbum', Env: env, Module: module, ModuleVersion: String(version), ManagedBy: 'scripts/module',
    ...(platformTags ? { ...platformTags.env, 'atl:component': 'env', ...platformTags.session } : {}), ...extra,
  };
}

/** update of an existing stack: keep its session-level tags (06 PM-29) */
export function preserveSessionTags(tags: Record<string, string>, existing: Record<string, string> | undefined): Record<string, string> {
  if (!platformTags || !existing) return tags;
  const out = { ...tags };
  for (const k of SESSION_TAG_KEYS) if (existing[k]) out[k] = existing[k];
  return out;
}

/** CREATE_FAILED / UPDATE_FAILED events of the last failed deployment (06 PM-35 result cfnFailures) */
export const cfnFailures: Array<{ stack: string; logicalId: string; status: string; reason: string }> = [];

/** Placeholder outputs for dry-run plans: every output declared by the template becomes `<stack:Output>`. */
export function placeholderOutputs(repoRoot: string, template: string, stackName: string, params: Readonly<Record<string, string>> = {}): Record<string, string> {
  const t = loadTemplate(repoRoot, template);
  return Object.fromEntries(Object.keys(t.Outputs).map((k) => [k, staticOutputValue(t, k, params) ?? `<${stackName}:${k}>`]));
}

export async function deployStack(aws: AwsGateway, out: Printer, repoRoot: string, req: DeployRequest): Promise<DeployResult> {
  const t = loadTemplate(repoRoot, req.template);
  const declared = Object.keys(t.Parameters);
  const unknown = Object.keys(req.params).filter((k) => !declared.includes(k));
  if (unknown.length) throw new CliError(`${req.template} does not declare parameter(s): ${unknown.join(', ')}`, EXIT.stack);

  const existing = await describeStack(aws, req.stackName, req.region);
  const create = existing === null || existing?.status === 'REVIEW_IN_PROGRESS';
  if (existing && /_IN_PROGRESS$/.test(existing.status) && existing.status !== 'REVIEW_IN_PROGRESS') {
    throw new CliError(`${req.stackName} is ${existing.status}; wait until it finishes`, EXIT.stack);
  }
  if (existing?.status === 'ROLLBACK_COMPLETE') {
    throw new CliError(`${req.stackName} is ROLLBACK_COMPLETE (failed creation): delete it first (scripts/module disable … --force-delete-stack)`, EXIT.stack);
  }

  const secret = new Set(req.secretParams ?? []);
  const parameters = declared
    .filter((k) => k in req.params || (existing && k in existing.parameters))
    .map((k) => (k in req.params
      ? { ParameterKey: k, ParameterValue: req.params[k] }
      : { ParameterKey: k, UsePreviousValue: true }));
  const shown = parameters.map((p) => ('ParameterValue' in p && secret.has(p.ParameterKey) ? { ...p, ParameterValue: '***' } : p));

  const body = readTemplateBody(repoRoot, req.template);
  let templateArg: Record<string, string> = { TemplateBody: body };
  if (Buffer.byteLength(body) > TEMPLATE_BODY_LIMIT) {
    if (!req.templateBucket) throw new CliError(`${req.template} exceeds the TemplateBody limit; run scripts/module bootstrap (toolchain bucket)`, EXIT.stack);
    const key = `templates/${req.stackName}/${Date.now()}.yaml`;
    await aws.send({ service: 's3', op: 'PutObject', input: { Bucket: req.templateBucket, Key: key, Body: body }, display: { Bucket: req.templateBucket, Key: key, Body: `<${req.template}>` } });
    templateArg = { TemplateURL: `https://${req.templateBucket}.s3.amazonaws.com/${key}` };
  }
  const tags = Object.entries(preserveSessionTags(req.tags, existing ? existing.tags : undefined)).map(([Key, Value]) => ({ Key, Value }));
  const input = {
    StackName: req.stackName, ...templateArg, Parameters: parameters, Tags: tags, Capabilities: ['CAPABILITY_NAMED_IAM'],
    ...(create && req.disableRollback ? { DisableRollback: true } : {}),
  };
  const display = { ...input, ...('TemplateBody' in templateArg ? { TemplateBody: `<${req.template}>` } : {}), Parameters: shown };

  if (aws.dryRun) {
    await aws.send({ service: 'cloudformation', op: existing === undefined ? 'CreateOrUpdateStack' : (create ? 'CreateStack' : 'UpdateStack'), input, display, ...(req.region ? { region: req.region } : {}) });
    return { outputs: placeholderOutputs(repoRoot, req.template, req.stackName, req.params), status: 'DRY_RUN', changed: true, created: create };
  }

  try {
    await aws.send({ service: 'cloudformation', op: create ? 'CreateStack' : 'UpdateStack', input, display, ...(req.region ? { region: req.region } : {}) });
  } catch (e) {
    if (!create && isAwsError(e, 'No updates are to be performed')) {
      out.info(`      ${req.stackName}: no changes`);
      return { outputs: existing?.outputs ?? {}, status: existing?.status ?? 'UPDATE_COMPLETE', changed: false, created: false };
    }
    throw new CliError(`${req.stackName}: ${(e as Error).message}`, EXIT.stack);
  }
  const done = await waitForStack(aws, out, req.stackName, req.region);
  if (!TERMINAL_OK.has(done.status)) {
    await printFailureEvents(aws, out, req.stackName, req.region);
    throw new CliError(`${req.stackName} ended in ${done.status}${req.disableRollback ? ' (rollback disabled: the stack is kept for diagnosis)' : ' (CloudFormation rolled back)'}`,
      EXIT.stack, 'STACK_FAILED', { stack: req.stackName, status: done.status });
  }
  return { outputs: done.outputs, status: done.status, changed: true, created: create };
}

export async function waitForStack(aws: AwsGateway, out: Printer, stackName: string, region?: string, timeoutMin = 90): Promise<StackInfo> {
  const deadline = Date.now() + timeoutMin * 60_000;
  let last = '';
  for (;;) {
    const info = await describeStack(aws, stackName, region);
    if (info === null) return { status: 'DELETE_COMPLETE', outputs: {}, parameters: {}, tags: {} };
    if (info === undefined) return { status: 'DRY_RUN', outputs: {}, parameters: {}, tags: {} };
    if (info.status !== last) { out.info(`      ${stackName}: ${info.status}`); last = info.status; }
    if (!/_IN_PROGRESS$/.test(info.status)) return info;
    if (Date.now() > deadline) throw new CliError(`${stackName}: timed out waiting (${info.status})`, EXIT.stack);
    await sleep(10_000);
  }
}

async function printFailureEvents(aws: AwsGateway, out: Printer, stackName: string, region?: string): Promise<void> {
  const r = await aws.send<{ StackEvents?: Array<{ LogicalResourceId?: string; ResourceStatus?: string; ResourceStatusReason?: string }> }>({
    service: 'cloudformation', op: 'DescribeStackEvents', input: { StackName: stackName }, ...(region ? { region } : {}),
  }).catch(() => undefined);
  for (const e of (r?.StackEvents ?? []).filter((x) => /FAILED/.test(x.ResourceStatus ?? '')).slice(0, 10)) {
    out.error(`      ${e.LogicalResourceId}: ${e.ResourceStatus} ${e.ResourceStatusReason ?? ''}`);
    cfnFailures.push({ stack: stackName, logicalId: e.LogicalResourceId ?? '?', status: e.ResourceStatus ?? '?', reason: e.ResourceStatusReason ?? '' });
  }
}

export async function deleteStack(aws: AwsGateway, out: Printer, stackName: string, region?: string): Promise<void> {
  const existing = await describeStack(aws, stackName, region);
  if (existing === null) { out.info(`      ${stackName}: already deleted`); return; }
  await aws.send({ service: 'cloudformation', op: 'DeleteStack', input: { StackName: stackName }, ...(region ? { region } : {}) });
  if (aws.dryRun) return;
  const done = await waitForStack(aws, out, stackName, region);
  if (done.status !== 'DELETE_COMPLETE') throw new CliError(`${stackName}: delete ended in ${done.status}`, EXIT.stack);
}
