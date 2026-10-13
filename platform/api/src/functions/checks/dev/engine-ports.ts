/**
 * ATL_DEV_MODE=1 engine ports of atl-checks (never imported by production code; ESLint forbids `**\/dev/**`):
 *  - `FakeAws`: the verifier's read-only calls answered from an in-memory fake that knows the dev conventions — the lab
 *    instance `i-dev-<envName>-lab` (atl:env-id, atl:role=lab-app, stack cloudalbum-<envName>-ec2, public DNS
 *    `<envName>.dev.atl.test`), the workstation `i-dev-<envName>-ws`, SSM Online — plus fixtures registered with `on()`
 *    or loaded from `ATL_DEV_AWS_FIXTURES` (`{ "<service>:<Action>": <response> | { "error": "<AwsErrorName>" } }`);
 *  - `DevHttp`: the shared egress guard with private targets allowed and `*.dev.atl.test` hosts mapped to the local
 *    CloudAlbum of that environment (`.atl-dev/envs/<envId>.json` written by the dev runner);
 *  - IP ranges from a fixture (default: none);
 *  - the check bundle digest from `platform/checks/dist/bundle.json` (`node platform/checks/build.mjs`).
 * Wire it in the dev runtime: `createChecksHandler(getDeps, undefined, createDevCheckEngine({ dataDir }))`.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { CFN_STACK_NAME_TAG, envNameFromEnvId, isEnvId, TAG_KEYS } from '@atl/shared';
import type { FunctionDeps } from '../../../runtime/deps.js';
import { AwsCallError, type AwsReadPort, type AwsReadRequest, type CheckEnginePorts, type EnginePortsProvider, type HttpProbePort, type HttpProbeRequest, type HttpProbeResponse, type IpRange, type IpRangesPort } from '../engine/ports.js';
import { SafeFetch } from '../engine/safe-fetch.js';
import { classifyAwsError } from '../aws/engine-ports.js';

export const DEV_HOST_SUFFIX = '.dev.atl.test';
const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../../../..');

export type FakeHandler = (req: AwsReadRequest) => Record<string, unknown> | Promise<Record<string, unknown>>;

export function devEnvName(envId: string): string | null {
  return isEnvId(envId) ? envNameFromEnvId(envId) : null;
}

export class FakeAws implements AwsReadPort {
  private readonly handlers = new Map<string, FakeHandler>();
  readonly calls: AwsReadRequest[] = [];
  /** Instance overrides by envName (e.g. a second lab instance, PingStatus offline). */
  readonly instances = new Map<string, Record<string, unknown>[]>();
  readonly offline = new Set<string>();

  constructor(fixtures: Record<string, unknown> = {}) {
    for (const [k, v] of Object.entries(fixtures)) this.on(k, () => this.fixture(v));
  }

  private fixture(v: unknown): Record<string, unknown> {
    if (v && typeof v === 'object' && 'error' in (v as object)) {
      const name = String((v as { error: unknown }).error);
      const kind = /AccessDenied/.test(name) ? 'ACCESS_DENIED' : /Throttl/.test(name) ? 'THROTTLED' : /NotFound|NoSuch|NotExist/.test(name) ? 'NOT_FOUND' : 'OTHER';
      throw new AwsCallError(kind, name, `dev fixture error ${name}`);
    }
    return JSON.parse(JSON.stringify(v)) as Record<string, unknown>;
  }

  /** Register a fake for `<service>:<Action>` (latest registration wins). */
  on(key: string, handler: FakeHandler | Record<string, unknown>): this {
    this.handlers.set(key, typeof handler === 'function' ? handler : () => this.fixture(handler));
    return this;
  }

  labInstance(envId: string): Record<string, unknown> {
    const envName = devEnvName(envId) ?? 'edev0000';
    return {
      InstanceId: `i-dev-${envName}-lab`,
      PublicIpAddress: '127.0.0.1',
      PublicDnsName: `${envName}${DEV_HOST_SUFFIX}`,
      PrivateIpAddress: '127.0.0.1',
      Placement: { AvailabilityZone: 'ap-northeast-1a' },
      SecurityGroups: [{ GroupId: 'sg-0dev00000000000' }],
      Tags: [
        { Key: TAG_KEYS.envId, Value: envId },
        { Key: TAG_KEYS.role, Value: 'lab-app' },
        { Key: CFN_STACK_NAME_TAG, Value: `cloudalbum-${envName}-ec2` },
      ],
    };
  }

  async call(req: AwsReadRequest): Promise<Record<string, unknown>> {
    this.calls.push(req);
    const h = this.handlers.get(`${req.service}:${req.action}`);
    if (h) {
      try {
        return await h(req);
      } catch (e) {
        // fakes throw SDK-like errors (`name` = AWS error name); classify them like the production adapter
        throw e instanceof AwsCallError ? e : classifyAwsError(e);
      }
    }
    const envName = devEnvName(req.session.envId) ?? 'edev0000';
    if (req.service === 'ec2' && req.action === 'DescribeInstances') {
      const filters = (req.params.Filters as { Name: string; Values: string[] }[] | undefined) ?? [];
      const role = filters.find((f) => f.Name === `tag:${TAG_KEYS.role}`)?.Values[0];
      if (role === 'workstation') {
        return {
          Reservations: [
            {
              Instances: [
                {
                  InstanceId: `i-dev-${envName}-ws`,
                  PublicIpAddress: '127.0.0.1',
                  PrivateIpAddress: '127.0.0.1',
                  Placement: { AvailabilityZone: 'ap-northeast-1a' },
                  Tags: [
                    { Key: TAG_KEYS.sessionId, Value: req.session.sid },
                    { Key: TAG_KEYS.role, Value: 'workstation' },
                  ],
                },
              ],
            },
          ],
        };
      }
      return { Reservations: [{ Instances: this.instances.get(envName) ?? [this.labInstance(req.session.envId)] }] };
    }
    if (req.service === 'ssm' && req.action === 'DescribeInstanceInformation') {
      const ids = ((req.params.Filters as { Key: string; Values: string[] }[] | undefined) ?? []).find((f) => f.Key === 'InstanceIds')?.Values ?? [];
      return { InstanceInformationList: ids.map((id) => ({ InstanceId: id, PingStatus: this.offline.has(id) ? 'ConnectionLost' : 'Online' })) };
    }
    if (req.service === 'autoscaling' && req.action === 'DescribeAutoScalingInstances') return { AutoScalingInstances: [] };
    if (req.service === 'ec2' && req.action === 'DescribeVpcs') return { Vpcs: [{ VpcId: 'vpc-0dev0000000000000', IsDefault: true, CidrBlock: '172.31.0.0/16' }] };
    if (req.service === 'cloudformation' && (req.action === 'DescribeStacks' || req.action === 'ListStackResources' || req.action === 'DescribeStackEvents')) {
      throw new AwsCallError('NOT_FOUND', 'ValidationError', `Stack with id ${String(req.params.StackName)} does not exist (dev)`);
    }
    if (req.service === 'tag' && req.action === 'GetResources') return { ResourceTagMappingList: [] };
    throw new AwsCallError('OTHER', 'DevNoFake', `dev: no fake for ${req.service}:${req.action} (register one or use ATL_DEV_AWS_FIXTURES)`);
  }
}

/**
 * Base URL of the local CloudAlbum of an env (dev runner registry, `.atl-dev/envs/<envId>.json`). `null` envName (the
 * fake public IPv4 127.0.0.1) maps to the most recently updated env: an installation has one active environment.
 */
export function devBaseUrlFor(dataDir: string, envName: string | null): string | null {
  const dir = path.join(dataDir, 'envs');
  if (!fs.existsSync(dir)) return null;
  let latest: { at: string; url: string } | null = null;
  for (const f of fs.readdirSync(dir)) {
    if (!f.endsWith('.json')) continue;
    try {
      const r = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')) as { envName?: string; baseUrl?: string | null; updatedAt?: string };
      if (!r.baseUrl) continue;
      if (envName && r.envName === envName) return r.baseUrl;
      if (!envName && (!latest || String(r.updatedAt ?? '') > latest.at)) latest = { at: String(r.updatedAt ?? ''), url: r.baseUrl };
    } catch {
      /* ignore */
    }
  }
  return envName ? null : (latest?.url ?? null);
}

export class DevHttp implements HttpProbePort {
  private readonly inner = new SafeFetch({ allowPrivate: true, lookup: async (h) => (h.endsWith(DEV_HOST_SUFFIX) ? ['127.0.0.1'] : (await import('node:dns/promises')).lookup(h, { all: true }).then((r) => r.map((a) => a.address))) });

  constructor(private readonly resolveBase: (envName: string | null) => string | null) {}

  async resolve(host: string): Promise<string[]> {
    return this.inner.resolve(host);
  }

  async fetch(req: HttpProbeRequest & { keepBody?: boolean }): Promise<HttpProbeResponse[]> {
    const u = new URL(req.url);
    if (u.hostname.endsWith(DEV_HOST_SUFFIX) || u.hostname === '127.0.0.1') {
      const envName = u.hostname.endsWith(DEV_HOST_SUFFIX) ? u.hostname.slice(0, -DEV_HOST_SUFFIX.length) : null;
      const base = this.resolveBase(envName);
      if (base) {
        const b = new URL(base);
        const url = `${b.protocol}//${b.host}${u.pathname}${u.search}`;
        return this.inner.fetch({ ...req, url, extraPorts: [...(req.extraPorts ?? []), Number(b.port || 80)] });
      }
    }
    return this.inner.fetch(req);
  }
}

export class FixedIpRanges implements IpRangesPort {
  constructor(private readonly list: IpRange[] = []) {}
  async ranges(): Promise<IpRange[]> {
    return this.list;
  }
}

export function devBundleDigest(repoRoot = REPO_ROOT): string | null {
  if (process.env.ATL_CHECK_BUNDLE_DIGEST) return process.env.ATL_CHECK_BUNDLE_DIGEST;
  try {
    return (JSON.parse(fs.readFileSync(path.join(repoRoot, 'platform', 'checks', 'dist', 'bundle.json'), 'utf8')) as { bundleDigest?: string }).bundleDigest ?? null;
  } catch {
    return null;
  }
}

export interface DevCheckEngineOptions {
  dataDir?: string;
  aws?: FakeAws;
  http?: HttpProbePort;
  ipRanges?: IpRange[];
  bundleDigest?: string | null;
}

export function createDevCheckEngine(o: DevCheckEngineOptions = {}): EnginePortsProvider & { aws: FakeAws } {
  const dataDir = o.dataDir ?? path.join(REPO_ROOT, '.atl-dev');
  let fixtures: Record<string, unknown> = {};
  if (process.env.ATL_DEV_AWS_FIXTURES && fs.existsSync(process.env.ATL_DEV_AWS_FIXTURES)) fixtures = JSON.parse(fs.readFileSync(process.env.ATL_DEV_AWS_FIXTURES, 'utf8')) as Record<string, unknown>;
  const aws = o.aws ?? new FakeAws(fixtures);
  const http = o.http ?? new DevHttp((envName) => devBaseUrlFor(dataDir, envName));
  const ipRanges = new FixedIpRanges(o.ipRanges ?? []);
  const provider = ((_deps: FunctionDeps): CheckEnginePorts => ({
    aws,
    http,
    ipRanges,
    config: { bundleDigest: o.bundleDigest === undefined ? devBundleDigest() : o.bundleDigest, allowPrivateTargets: true },
  })) as EnginePortsProvider & { aws: FakeAws };
  provider.aws = aws;
  return provider;
}
