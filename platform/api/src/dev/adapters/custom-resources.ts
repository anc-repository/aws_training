/**
 * Dev atl-custom-resources: the real handler of `platform/infra/custom-resources` (SeedData, WebDeploy, JwksPublish,
 * UninstallGuard, UninstallRoleCleanup, …) on dev ports, so that ATL_DEV_MODE can run the install / uninstall custom
 * resources against DynamoDB Local, the directory buckets, the dev signer, the in-process simulator and the lifecycle's
 * dev IAM state (ATLRevokedSessions, the workstation role tag). CloudFormation responses (the presigned ResponseURL) are
 * captured in `responses` instead of being sent.
 *
 * The infra package is type-checked on its own (platform/infra/tsconfig.json) and only runs through tsx / esbuild; the
 * handler is therefore loaded with a computed specifier (tsx and vitest resolve the .ts source). Dev only.
 */
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { GetCommand, PutCommand, QueryCommand, UpdateCommand, type DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { isPortError, STATE_MACHINES, type ClockPort, type LambdaFunctionName, type ObjectStorePort, type OrchestratorPort, type SignerPort, type StateMachineName } from '@atl/shared';
import { REPO_ROOT } from '../config.js';

type Item = Record<string, unknown>;

/** The lifecycle dev cloud's IAM state (src/orchestrator-dev/lifecycle-cloud.ts, structural). */
export interface DevIamState {
  revocations: { revoked: Record<string, unknown>; finalizing: unknown };
  workstationTag: string | null;
}

export interface CfnResponseRecord {
  url: string;
  status: string;
  reason: string;
  physicalResourceId: string;
  data: Record<string, unknown>;
}

export interface DevCustomResourcesOptions {
  db: DynamoDBDocumentClient;
  objects: ObjectStorePort;
  signer: SignerPort;
  orchestrator: OrchestratorPort;
  clock: ClockPort;
  /** lifecycle dev IAM state; without it the roles have no run-time policies */
  iam?: () => DevIamState | null;
  /** atl-main of this runtime (UninstallRoleCleanup reads ATL_TABLE) */
  tableName?: string;
  log?: (message: string, extra?: Record<string, unknown>) => void;
}

export interface DevCustomResources {
  handler: (event: unknown) => Promise<unknown>;
  responses: CfnResponseRecord[];
  /** role → inline policy names / managed policy ARNs that are not lifecycle state (tests add some) */
  roles: Map<string, { inline: Set<string>; managed: Set<string> }>;
  stackCalls: { op: string; stackId: string; arg: unknown }[];
}

function stateMachineOfArn(arn: string): StateMachineName {
  const m = /:stateMachine:(atl-[a-z-]+)$/.exec(arn);
  if (!m || !(STATE_MACHINES as readonly string[]).includes(m[1]!)) throw new Error(`dev: unknown state machine ${arn}`);
  return m[1] as StateMachineName;
}

export async function createDevCustomResources(o: DevCustomResourcesOptions): Promise<DevCustomResources> {
  const file = path.join(REPO_ROOT, 'platform', 'infra', 'custom-resources', 'src', 'handler.ts');
  const mod = (await import(pathToFileURL(file).href)) as {
    createCustomResourcesHandler(getPorts: () => Promise<unknown>, env?: NodeJS.ProcessEnv): (event: unknown) => Promise<unknown>;
  };
  const responses: CfnResponseRecord[] = [];
  const roles = new Map<string, { inline: Set<string>; managed: Set<string> }>();
  const stackCalls: DevCustomResources['stackCalls'] = [];
  const role = (name: string) => {
    let r = roles.get(name);
    if (!r) roles.set(name, (r = { inline: new Set(), managed: new Set() }));
    return r;
  };
  const log = o.log ?? (() => undefined);
  const ports = {
    s3: {
      bucketExists: async () => true,
      listObjectVersions: async (bucket: string) => ({ items: (await o.objects.list(bucket, '')).map((key) => ({ key })) }),
      deleteObjects: async (bucket: string, items: { key: string }[]) => {
        for (const i of items) await o.objects.delete(bucket, i.key);
      },
      getObject: async (bucket: string, key: string) => {
        const b = await o.objects.get(bucket, key);
        return b ? Buffer.from(b) : null;
      },
      putObject: async (bucket: string, key: string, body: Buffer | string, meta?: { contentType?: string }) => o.objects.put(bucket, key, body, meta?.contentType ? { contentType: meta.contentType } : {}),
      listKeys: (bucket: string, prefix: string) => o.objects.list(bucket, prefix),
    },
    table: {
      async get(table: string, key: { PK: string; SK: string }) {
        return (await o.db.send(new GetCommand({ TableName: table, Key: key, ConsistentRead: true }))).Item as Item | undefined;
      },
      async put(table: string, item: Item, opts?: { ifNotExists?: boolean }) {
        try {
          await o.db.send(new PutCommand({ TableName: table, Item: item, ...(opts?.ifNotExists ? { ConditionExpression: 'attribute_not_exists(PK)' } : {}) }));
          return true;
        } catch (e) {
          if (opts?.ifNotExists && (e as { name?: string }).name === 'ConditionalCheckFailedException') return false;
          throw e;
        }
      },
      async update(table: string, key: { PK: string; SK: string }, set: Item) {
        const names: Record<string, string> = {};
        const values: Record<string, unknown> = {};
        const parts = Object.entries(set).map(([k, v], i) => {
          names[`#a${i}`] = k;
          values[`:v${i}`] = v;
          return `#a${i} = :v${i}`;
        });
        if (!parts.length) return;
        await o.db.send(new UpdateCommand({ TableName: table, Key: key, UpdateExpression: `SET ${parts.join(', ')}`, ExpressionAttributeNames: names, ExpressionAttributeValues: values }));
      },
      async increment(table: string, key: { PK: string; SK: string }, attr: string) {
        const r = await o.db.send(
          new UpdateCommand({ TableName: table, Key: key, UpdateExpression: 'ADD #n :one', ExpressionAttributeNames: { '#n': attr }, ExpressionAttributeValues: { ':one': 1 }, ReturnValues: 'UPDATED_NEW' }),
        );
        return Number(r.Attributes?.[attr] ?? 0);
      },
      async queryIndex(table: string, index: 'GSI1' | 'GSI2', partition: string, limit: number) {
        const pk = index === 'GSI1' ? 'GSI1PK' : 'GSI2PK';
        const r = await o.db.send(
          new QueryCommand({ TableName: table, IndexName: index, KeyConditionExpression: '#p = :p', ExpressionAttributeNames: { '#p': pk }, ExpressionAttributeValues: { ':p': partition }, Limit: limit }),
        );
        return (r.Items ?? []) as Item[];
      },
    },
    iam: {
      async listRolePolicies(name: string) {
        const inline = [...role(name).inline];
        const st = o.iam?.();
        if (name === 'ATLLearnerRole' && st && (Object.keys(st.revocations.revoked).length || st.revocations.finalizing)) inline.push('ATLRevokedSessions');
        return inline;
      },
      async deleteRolePolicy(name: string, policy: string) {
        role(name).inline.delete(policy);
        const st = o.iam?.();
        if (name === 'ATLLearnerRole' && policy === 'ATLRevokedSessions' && st) st.revocations = { revoked: {}, finalizing: null };
      },
      listAttachedRolePolicies: async (name: string) => [...role(name).managed],
      detachRolePolicy: async (name: string, arn: string) => void role(name).managed.delete(arn),
      async listRoleTags(name: string) {
        const st = o.iam?.();
        return name === 'ATLWorkstationRole' && st?.workstationTag ? [{ key: 'atl:active-session-id', value: st.workstationTag }] : [];
      },
      async untagRole(name: string) {
        const st = o.iam?.();
        if (name === 'ATLWorkstationRole' && st) st.workstationTag = null;
      },
    },
    stack: {
      updateTerminationProtection: async (stackId: string, enable: boolean) => void stackCalls.push({ op: 'UpdateTerminationProtection', stackId, arg: enable }),
      setStackPolicy: async (stackId: string, body: string) => void stackCalls.push({ op: 'SetStackPolicy', stackId, arg: body }),
    },
    workflow: {
      async startExecution(arn: string, name: string, input: unknown) {
        try {
          const r = await o.orchestrator.startExecution({ stateMachine: stateMachineOfArn(arn), name, input });
          return { executionArn: r.executionArn, alreadyExists: false };
        } catch (e) {
          if (isPortError(e, 'ExecutionAlreadyExists')) return { executionArn: o.orchestrator.executionArn(stateMachineOfArn(arn), name), alreadyExists: true };
          throw e;
        }
      },
    },
    kms: {
      async getPublicKey(keyId: string) {
        const k = await o.signer.getPublicKey(keyId);
        return { der: k.spkiDer, keySpec: 'ECC_NIST_P256', keyArn: k.keyId };
      },
    },
    cdn: { invalidate: async () => undefined },
    users: { ensureUser: async () => 'exists' as const },
    preflight: {
      run: async () => [{ id: 'dev', status: 'info', detail: 'ATL_DEV_MODE: account preflight is simulated (no AWS account)' }],
    },
    async fetch(url: string, init: { method: string; body: string }) {
      const b = JSON.parse(init.body) as { Status: string; Reason: string; PhysicalResourceId: string; Data?: Record<string, unknown> };
      responses.push({ url, status: b.Status, reason: b.Reason, physicalResourceId: b.PhysicalResourceId, data: b.Data ?? {} });
      return { ok: true, status: 200 };
    },
    now: () => o.clock.now(),
    log,
  };
  const handler = mod.createCustomResourcesHandler(async () => ports, { ...process.env, ...(o.tableName ? { ATL_TABLE: o.tableName } : {}) });
  return { handler, responses, roles, stackCalls };
}

/** Register the dev custom resources as `atl-custom-resources` in a dev runtime's invoker. */
export async function installDevCustomResources(
  rt: { invoker: { register(fn: LambdaFunctionName, h: (p: unknown) => Promise<unknown>): void } },
  o: DevCustomResourcesOptions,
): Promise<DevCustomResources> {
  const cr = await createDevCustomResources(o);
  rt.invoker.register('atl-custom-resources', (p) => cr.handler(p));
  return cr;
}
