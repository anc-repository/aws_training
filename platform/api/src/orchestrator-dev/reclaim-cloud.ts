/**
 * ATL_DEV_MODE implementation of the reclaim cloud port: an in-memory "account" of stacks and resources. Tests (and the
 * scripted dev runner) create resources; behaviours simulate asynchronous deletion (PENDING for n polls), dependency
 * waits (RETRY), permission errors (MANUAL / BLOCKING) and deletion protection that cannot be lifted.
 * Dev only: never imported by a production entry.
 */
import type { DeleteContext, ReclaimCloud, ResourceRef, StackResource, StackSummary, StepResult } from '../functions/lifecycle/cloud/port.js';

export type FakeBehaviour =
  | { kind: 'ok' }
  | { kind: 'pending'; polls: number }
  | { kind: 'retry'; times: number }
  | { kind: 'denied' }
  | { kind: 'protected' };

export interface FakeResource {
  type: string;
  region: string;
  id: string;
  arn?: string | null;
  tags?: Record<string, string>;
  stackName?: string | null;
  logicalId?: string | null;
  inventory?: boolean;
  behaviour?: FakeBehaviour;
}

export interface FakeStack {
  name: string;
  region: string;
  status: string;
  tags: Record<string, string>;
}

const key = (type: string, region: string, id: string) => `${type}|${region}|${id}`;

/** ARNs as the Tagging API returns them (enough for refFromArn to map them back). */
function arnOf(r: { type: string; region: string; id: string }): string {
  const acct = '000000000000';
  switch (r.type) {
    case 'AWS::S3::Bucket':
      return `arn:aws:s3:::${r.id}`;
    case 'AWS::EC2::Instance':
      return `arn:aws:ec2:${r.region}:${acct}:instance/${r.id}`;
    case 'AWS::EC2::SecurityGroup':
      return `arn:aws:ec2:${r.region}:${acct}:security-group/${r.id}`;
    case 'AWS::EC2::KeyPair':
      return `arn:aws:ec2:${r.region}:${acct}:key-pair/${r.id}`;
    case 'AWS::SSM::Parameter':
      return `arn:aws:ssm:${r.region}:${acct}:parameter${r.id.startsWith('/') ? r.id : `/${r.id}`}`;
    case 'AWS::Lambda::Function':
      return `arn:aws:lambda:${r.region}:${acct}:function:${r.id}`;
    case 'AWS::Logs::LogGroup':
      return `arn:aws:logs:${r.region}:${acct}:log-group:${r.id}`;
    default:
      return `arn:aws:dev:${r.region}:${acct}:${r.type.replace(/::/g, '-')}/${r.id}`;
  }
}

export class DevReclaimCloud implements ReclaimCloud {
  readonly resources = new Map<string, FakeResource & { pendingPolls?: number; retries?: number }>();
  readonly stacks = new Map<string, FakeStack>();
  readonly deleted: string[] = [];
  readonly deleteCalls: { ref: ResourceRef; roleSessionName: string }[] = [];
  /** S6 resets performed: full (own lock) or only the ledger's attachments */
  readonly appRoleResets: { full: boolean; policyArns: string[] }[] = [];

  addResource(r: FakeResource): void {
    this.resources.set(key(r.type, r.region, r.id), { ...r });
  }

  addStack(s: FakeStack, resources: Omit<FakeResource, 'stackName' | 'region'>[] = []): void {
    this.stacks.set(`${s.region}|${s.name}`, { ...s });
    this.resources.set(key('AWS::CloudFormation::Stack', s.region, s.name), { type: 'AWS::CloudFormation::Stack', region: s.region, id: s.name, tags: s.tags });
    for (const r of resources) this.addResource({ ...r, region: s.region, stackName: s.name, tags: { ...s.tags, ...(r.tags ?? {}) } });
  }

  /** What `env destroy` does: delete the environment's stacks (with their resources). */
  deleteStack(region: string, name: string, opts: { retain?: string[] } = {}): void {
    const st = this.stacks.get(`${region}|${name}`);
    if (!st) return;
    for (const [k, r] of [...this.resources]) {
      if (r.stackName === name && r.region === region && !(opts.retain ?? []).includes(r.logicalId ?? '')) {
        this.resources.delete(k);
        this.deleted.push(k);
      }
    }
    this.resources.delete(key('AWS::CloudFormation::Stack', region, name));
    st.status = 'DELETE_COMPLETE';
  }

  has(type: string, region: string, id: string): boolean {
    return this.resources.has(key(type, region, id));
  }

  async listEnvStacks(q: { envId: string; envName: string; sessionIds: string[]; regions: string[] }): Promise<StackSummary[]> {
    return [...this.stacks.values()].filter(
      (s) =>
        q.regions.includes(s.region) &&
        (s.name.startsWith(`cloudalbum-${q.envName}-`) || q.sessionIds.some((sid) => s.name === `atl-ws-${sid}`) || s.tags['atl:env-id'] === q.envId),
    );
  }

  async listStackResources(q: { stackName: string; region: string }): Promise<StackResource[]> {
    return [...this.resources.values()]
      .filter((r) => r.stackName === q.stackName && r.region === q.region)
      .map((r) => ({ logicalId: r.logicalId ?? r.id, physicalId: r.id, type: r.type, status: 'CREATE_COMPLETE' }));
  }

  async taggedResources(q: { region: string; key: string; value: string }): Promise<{ arn: string; type: string | null }[]> {
    return [...this.resources.values()]
      .filter((r) => r.region === q.region && r.tags?.[q.key] === q.value && r.type !== 'AWS::CloudFormation::Stack')
      .map((r) => ({ arn: r.arn ?? arnOf(r), type: r.type }));
  }

  async inventory(q: { region: string }): Promise<{ type: string; id: string; arn?: string | null }[]> {
    return [...this.resources.values()].filter((r) => r.region === q.region && r.inventory).map((r) => ({ type: r.type, id: r.id, arn: r.arn ?? null }));
  }

  async exists(ref: ResourceRef): Promise<boolean> {
    return this.resources.has(key(ref.type, ref.region, ref.id));
  }

  async delete(ref: ResourceRef, ctx: DeleteContext): Promise<StepResult> {
    this.deleteCalls.push({ ref, roleSessionName: ctx.roleSessionName });
    if (ref.type === 'ATL::IAM::AppRoleReset') {
      this.appRoleResets.push({ full: ctx.ownsSharedObjects, policyArns: ctx.policyArns });
      return { status: 'DONE' };
    }
    if (ref.type.startsWith('ATL::')) return { status: 'DONE' };
    const k = key(ref.type, ref.region, ref.id);
    const r = this.resources.get(k);
    if (!r) return { status: 'DONE' };
    const b = r.behaviour ?? { kind: 'ok' };
    switch (b.kind) {
      case 'denied':
        return { status: 'MANUAL', severity: 'BLOCKING', reason: 'AccessDenied (dev)' };
      case 'protected':
        return { status: 'MANUAL', severity: 'BLOCKING', reason: 'deletion protection could not be disabled (dev)' };
      case 'retry':
        r.retries = (r.retries ?? 0) + 1;
        if (r.retries <= b.times) return { status: 'RETRY', waitSeconds: 10, reason: 'DependencyViolation (dev)' };
        break;
      case 'pending':
        r.pendingPolls = b.polls;
        return { status: 'PENDING', waitSeconds: 30 };
      default:
        break;
    }
    if (ref.type === 'AWS::CloudFormation::Stack') this.deleteStack(ref.region, ref.id);
    this.resources.delete(k);
    this.deleted.push(k);
    return { status: 'DONE' };
  }

  async poll(ref: ResourceRef): Promise<StepResult> {
    const k = key(ref.type, ref.region, ref.id);
    const r = this.resources.get(k);
    if (!r) return { status: 'DONE' };
    r.pendingPolls = (r.pendingPolls ?? 1) - 1;
    if (r.pendingPolls > 0) return { status: 'PENDING', waitSeconds: 30 };
    if (ref.type === 'AWS::CloudFormation::Stack') this.deleteStack(ref.region, ref.id);
    this.resources.delete(k);
    this.deleted.push(k);
    return { status: 'DONE' };
  }

  manualHint(ref: ResourceRef): { consoleUrl: string; cli: string; note?: string } {
    return { consoleUrl: `https://console.aws.amazon.com/?region=${ref.region}`, cli: `# delete ${ref.type} ${ref.id} in ${ref.region}` };
  }
}
