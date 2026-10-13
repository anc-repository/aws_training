/** In-memory ports for the custom resource tests (no AWS). */
import type { FetchLike } from '../../custom-resources/src/cfn.js';
import type { Item, ObjectRef, Ports, PreflightItem } from '../../custom-resources/src/ports.js';

export interface FakeState {
  buckets: Map<string, Map<string, { versions: string[]; data: Buffer; meta?: { contentType?: string; cacheControl?: string } }>>;
  items: Map<string, Item>;
  rolePolicies: Map<string, string[]>;
  attached: Map<string, string[]>;
  roleTags: Map<string, { key: string; value: string }[]>;
  stack: { protection?: boolean; policy?: string };
  executions: { arn: string; name: string; input: unknown }[];
  invalidations: { distributionId: string; paths: string[] }[];
  users: Map<string, string[]>;
  responses: { url: string; body: Record<string, unknown> }[];
  publicKeyDer?: Uint8Array;
  logs: string[];
  now: Date;
}

const itemKey = (table: string, key: { PK: string; SK: string }) => `${table}|${key.PK}|${key.SK}`;

export function fakePorts(init: Partial<FakeState> = {}): { ports: Ports; state: FakeState } {
  const state: FakeState = {
    buckets: new Map(),
    items: new Map(),
    rolePolicies: new Map(),
    attached: new Map(),
    roleTags: new Map(),
    stack: {},
    executions: [],
    invalidations: [],
    users: new Map(),
    responses: [],
    logs: [],
    now: new Date('2026-10-14T00:00:00Z'),
    ...init,
  };
  const bucket = (b: string) => {
    let m = state.buckets.get(b);
    if (!m) state.buckets.set(b, (m = new Map()));
    return m;
  };
  const fetchImpl: FetchLike = async (url, init) => {
    state.responses.push({ url, body: JSON.parse(init.body) as Record<string, unknown> });
    return { ok: true, status: 200 };
  };
  const ports: Ports = {
    s3: {
      async bucketExists(b) {
        return state.buckets.has(b);
      },
      async listObjectVersions(b) {
        const items: ObjectRef[] = [];
        for (const [key, o] of bucket(b)) for (const v of o.versions) items.push({ key, versionId: v });
        return { items: items.slice(0, 3) };
      },
      async deleteObjects(b, items) {
        for (const i of items) {
          const o = bucket(b).get(i.key);
          if (!o) continue;
          o.versions = o.versions.filter((v) => v !== i.versionId);
          if (!o.versions.length) bucket(b).delete(i.key);
        }
      },
      async getObject(b, key) {
        return state.buckets.get(b)?.get(key)?.data ?? null;
      },
      async putObject(b, key, body, meta) {
        const prev = bucket(b).get(key);
        bucket(b).set(key, { versions: [...(prev?.versions ?? []), `v${(prev?.versions.length ?? 0) + 1}`], data: Buffer.from(body), meta });
      },
      async listKeys(b, prefix) {
        return [...bucket(b).keys()].filter((k) => k.startsWith(prefix)).sort();
      },
    },
    table: {
      async get(table, key) {
        const v = state.items.get(itemKey(table, key));
        return v ? structuredClone(v) : undefined;
      },
      async put(table, item, opts) {
        const k = itemKey(table, item as { PK: string; SK: string });
        if (opts?.ifNotExists && state.items.has(k)) return false;
        state.items.set(k, structuredClone(item));
        return true;
      },
      async update(table, key, set) {
        const k = itemKey(table, key);
        state.items.set(k, { ...(state.items.get(k) ?? { ...key }), ...structuredClone(set) });
      },
      async increment(table, key, attr) {
        const k = itemKey(table, key);
        const cur = state.items.get(k) ?? { ...key };
        const n = Number(cur[attr] ?? 0) + 1;
        state.items.set(k, { ...cur, [attr]: n });
        return n;
      },
      async queryIndex(table, index, partition, limit) {
        const pk = index === 'GSI1' ? 'GSI1PK' : 'GSI2PK';
        return [...state.items.entries()]
          .filter(([k, v]) => k.startsWith(`${table}|`) && v[pk] === partition)
          .map(([, v]) => structuredClone(v))
          .slice(0, limit);
      },
    },
    iam: {
      async listRolePolicies(role) {
        return [...(state.rolePolicies.get(role) ?? [])];
      },
      async deleteRolePolicy(role, name) {
        state.rolePolicies.set(role, (state.rolePolicies.get(role) ?? []).filter((n) => n !== name));
      },
      async listAttachedRolePolicies(role) {
        return [...(state.attached.get(role) ?? [])];
      },
      async detachRolePolicy(role, arn) {
        state.attached.set(role, (state.attached.get(role) ?? []).filter((a) => a !== arn));
      },
      async listRoleTags(role) {
        return [...(state.roleTags.get(role) ?? [])];
      },
      async untagRole(role, keys) {
        state.roleTags.set(role, (state.roleTags.get(role) ?? []).filter((t) => !keys.includes(t.key)));
      },
    },
    stack: {
      async updateTerminationProtection(_id, enable) {
        state.stack.protection = enable;
      },
      async setStackPolicy(_id, body) {
        state.stack.policy = body;
      },
    },
    workflow: {
      async startExecution(arn, name, input) {
        const exists = state.executions.some((e) => e.name === name);
        if (!exists) state.executions.push({ arn, name, input });
        return { executionArn: `${arn}:${name}`, alreadyExists: exists };
      },
    },
    kms: {
      async getPublicKey(keyId) {
        if (!state.publicKeyDer) throw new Error('no key');
        return { der: state.publicKeyDer, keySpec: 'ECC_NIST_P256', keyArn: `arn:aws:kms:ap-northeast-1:111122223333:key/${keyId}` };
      },
    },
    cdn: {
      async invalidate(distributionId, paths) {
        state.invalidations.push({ distributionId, paths });
      },
    },
    users: {
      async ensureUser(pool, email, group) {
        const existing = state.users.get(`${pool}|${email}`);
        if (existing) {
          if (!existing.includes(group)) existing.push(group);
          return 'exists';
        }
        state.users.set(`${pool}|${email}`, [group]);
        return 'created';
      },
    },
    preflight: {
      async run(): Promise<PreflightItem[]> {
        return [
          { id: 'default-vpc', status: 'ok', detail: 'default VPC vpc-1' },
          { id: 'vcpu-quota', status: 'warn', detail: 'quota 2', hint: 'request more' },
        ];
      },
    },
    fetch: fetchImpl,
    now: () => state.now,
    log: (m) => state.logs.push(m),
  };
  return { ports, state };
}

export function cfnEvent(resourceType: string, requestType: 'Create' | 'Update' | 'Delete', props: Record<string, unknown>, physicalId?: string) {
  return {
    RequestType: requestType,
    ResponseURL: 'https://cloudformation-custom-resource-response-apnortheast1.s3.amazonaws.com/presigned',
    StackId: 'arn:aws:cloudformation:ap-northeast-1:111122223333:stack/atl/1a2b3c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5d',
    RequestId: 'req-1',
    ResourceType: `Custom::${resourceType}`,
    LogicalResourceId: resourceType,
    ...(physicalId ? { PhysicalResourceId: physicalId } : {}),
    ResourceProperties: { ServiceToken: 'arn:aws:lambda:ap-northeast-1:111122223333:function:atl-custom-resources', ...props },
  };
}
