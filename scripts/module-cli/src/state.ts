/**
 * .cloudalbum/state.json — local state of scripts/module on the operator machine (modular-design.md 9.2):
 * environment, region, base stack, instance, delivery channel, enabled modules (env, outputs, parameters),
 * PolicyArn attachments, baseParams contributions, out-of-band resources and the operation history.
 * Written atomically (temporary file + rename). Never contains secret values.
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type { ModuleId } from '@cloudalbum/contracts';
import type { EnvMap } from './env-file.js';
import type { Tier } from './deps.js';

export interface StackRecord {
  name: string;          // registry stack name (main, edge, ...)
  stackName: string;     // CloudFormation stack name
  region: string;
  status?: string;
}

export interface ModuleRecord {
  enabledAt: string;
  updatedAt: string;
  tier: Tier;
  /** switch value (enum switches) or 'aws' (parameter switches) */
  value: string;
  version: number;
  /** exact content of modules.d/<id>.env (no secrets, CFG-002) */
  env: EnvMap;
  stacks: StackRecord[];
  outputs: Record<string, string>;
  /** non-secret stack parameters of the last deployment */
  params: Record<string, string>;
  /** secrets.env keys written by this module (secretParams), removed on disable */
  secretKeys: string[];
}

export interface Attachment {
  module: ModuleId;
  policyArn: string;
  principal: { type: 'role' | 'user'; name: string };
  at: string;
}

export interface BaseParamRecord {
  value: string;
  /** value before any module touched it (restored when the last contributor is disabled) */
  original: string;
  by: ModuleId[];
  at: string;
}

export interface HistoryEntry {
  at: string;
  op: string;
  module?: string;
  result: 'ok' | 'failed' | 'dry-run' | 'rolled-back';
  exitCode: number;
  detail?: string;
  /** platform mode (06 PM-27): operation id, caller role session name, runner run id */
  opId?: string;
  actor?: string;
  runId?: string | null;
}

/** Platform section of state.json v2 (06 PM-27) */
export interface PlatformStateSection {
  envId: string;
  /** environment-level tags only (Project, atl:component, atl:env-id); session tags come from CLOUDALBUM_PLATFORM_TAGS */
  platformTags: Record<string, string>;
  sessionChain: string[];
  preview?: { directHttps: 'on' | 'off'; status: 'issued' | 'failed' | 'off' | 'pending'; reason?: string; ip?: string };
  lastApply?: { profile: string; digest: string; mode: 'fresh' | 'additive'; at: string; by: string };
  pendingHooks: Array<{ id: string; reason: string; createdAt: string; requires: 'learner' }>;
  seeds: Record<string, { instance?: 'done' | 'pending' | 'failed'; cognito?: 'done' | 'pending' | 'failed'; at?: string }>;
  /** --allow-any-identity was used (development only; leaves a trace) */
  anyIdentityUsed?: boolean;
}

export interface BaseRecord {
  stackName: string;
  instanceId?: string;
  publicIp?: string;
  publicDnsName?: string;
  securityGroupId?: string;
  vpcId?: string;
  subnetId?: string;
  availabilityZone?: string;
  dataVolumeId?: string;
  arch?: 'arm64' | 'x86_64';
  /** default-VPC subnets in >= 2 AZs (RDS / ElastiCache subnet groups) */
  defaultSubnetIds?: string[];
  params: Record<string, string>;
  keyFingerprint?: string;
}

export interface CloudAlbumState {
  /** 2 since the platform mode (06 PM-27); v1 files are upgraded on load */
  version: 2;
  schemaVersion: 2;
  mode: 'standalone' | 'platform';
  env: string;
  region: string;
  accountId?: string;
  createdAt: string;
  updatedAt: string;
  base?: BaseRecord;
  delivery: { channel: 'ssh' | 'ssm'; sshUser: string; sshKeyPath?: string; host?: string };
  toolchain?: { stackName: string; bucket?: string; release?: { version: string; arch: 'arm64' | 'x86_64'; key: string; sha256: string; at: string } };
  iam?: { mode: 'role' | 'keys'; roleName: string; userName?: string };
  /** base configuration (cloudalbum.env) as last written by scripts/module */
  baseConfig: EnvMap;
  modules: Partial<Record<ModuleId, ModuleRecord>>;
  attachments: Attachment[];
  baseParams: Record<string, BaseParamRecord>;
  outOfBand: Array<{ module: ModuleId; kind: string; id: string; at: string }>;
  profile?: string;
  history: HistoryEntry[];
  /** platform mode only */
  platform?: PlatformStateSection;
  /** backups of account-level singletons taken before a change (<envName>/backups/… in the state bucket) */
  backups: Array<{ type: string; id: string; key: string; at: string }>;
  /** resources imported into stacks (04 §5.2.4: imported resources are not created by the stack) */
  imports: Array<{ stack: string; logicalId: string; physicalId: string; type: string; at: string }>;
  /** env suspend / resume (02 §8.2) */
  suspended: { at: string; stopped: string[]; skipped: Array<{ id: string; reason: string }> } | null;
}

export function nowIso(): string {
  return new Date().toISOString();
}

export function newState(env: string, region: string, mode: CloudAlbumState['mode'] = 'standalone'): CloudAlbumState {
  const at = nowIso();
  return {
    version: 2, schemaVersion: 2, mode, env, region, createdAt: at, updatedAt: at,
    delivery: { channel: mode === 'platform' ? 'ssm' : 'ssh', sshUser: 'ec2-user' },
    baseConfig: {}, modules: {}, attachments: [], baseParams: {}, outOfBand: [], history: [], backups: [], imports: [], suspended: null,
  };
}

/** v1 -> v2 (standalone files are upgraded transparently; 06 PM-27) and missing collections */
export function upgradeState(raw: Record<string, unknown>, file = 'state.json'): CloudAlbumState {
  const version = Number(raw.version);
  if (version !== 1 && version !== 2) throw new Error(`${file}: unsupported state version ${String(raw.version)}`);
  const s = raw as unknown as CloudAlbumState;
  if (version === 1) {
    s.version = 2;
    s.mode = 'standalone';
  }
  s.schemaVersion = 2;
  s.mode ??= s.platform ? 'platform' : 'standalone';
  s.modules ??= {};
  s.attachments ??= [];
  s.baseParams ??= {};
  s.outOfBand ??= [];
  s.history ??= [];
  s.baseConfig ??= {};
  s.backups ??= [];
  s.imports ??= [];
  s.suspended ??= null;
  return s;
}

export function defaultStatePath(repoRoot: string): string {
  return path.join(repoRoot, '.cloudalbum', 'state.json');
}

export function loadState(file: string, env: string, region: string): CloudAlbumState {
  if (!existsSync(file)) return newState(env, region);
  const s = upgradeState(JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>, file);
  if (s.env !== env) throw new Error(`${file} belongs to env "${s.env}", not "${env}" (use --state <file> or --env ${s.env})`);
  return s;
}

export function saveState(file: string, state: CloudAlbumState): void {
  state.updatedAt = nowIso();
  mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
  renameSync(tmp, file);
}

/** Merged env of the instance as scripts/module knows it: base configuration + every modules.d file. */
export function currentEnv(state: CloudAlbumState): EnvMap {
  const env: EnvMap = { ...state.baseConfig };
  for (const rec of Object.values(state.modules)) Object.assign(env, rec?.env ?? {});
  return env;
}

export function recordHistory(state: CloudAlbumState, e: Omit<HistoryEntry, 'at'>): void {
  state.history.push({ at: nowIso(), ...e });
  if (state.history.length > 500) state.history.splice(0, state.history.length - 500);
}
