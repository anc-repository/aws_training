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
  version: 1;
  env: string;
  region: string;
  accountId?: string;
  createdAt: string;
  updatedAt: string;
  base?: BaseRecord;
  delivery: { channel: 'ssh' | 'ssm'; sshUser: string; sshKeyPath?: string; host?: string };
  toolchain?: { stackName: string; bucket?: string };
  iam?: { mode: 'role' | 'keys'; roleName: string; userName?: string };
  /** base configuration (cloudalbum.env) as last written by scripts/module */
  baseConfig: EnvMap;
  modules: Partial<Record<ModuleId, ModuleRecord>>;
  attachments: Attachment[];
  baseParams: Record<string, BaseParamRecord>;
  outOfBand: Array<{ module: ModuleId; kind: string; id: string; at: string }>;
  profile?: string;
  history: HistoryEntry[];
}

export function nowIso(): string {
  return new Date().toISOString();
}

export function newState(env: string, region: string): CloudAlbumState {
  const at = nowIso();
  return {
    version: 1, env, region, createdAt: at, updatedAt: at,
    delivery: { channel: 'ssh', sshUser: 'ec2-user' },
    baseConfig: {}, modules: {}, attachments: [], baseParams: {}, outOfBand: [], history: [],
  };
}

export function defaultStatePath(repoRoot: string): string {
  return path.join(repoRoot, '.cloudalbum', 'state.json');
}

export function loadState(file: string, env: string, region: string): CloudAlbumState {
  if (!existsSync(file)) return newState(env, region);
  const s = JSON.parse(readFileSync(file, 'utf8')) as CloudAlbumState;
  if (s.version !== 1) throw new Error(`${file}: unsupported state version ${String(s.version)}`);
  if (s.env !== env) throw new Error(`${file} belongs to env "${s.env}", not "${env}" (use --state <file> or --env ${s.env})`);
  s.modules ??= {};
  s.attachments ??= [];
  s.baseParams ??= {};
  s.outOfBand ??= [];
  s.history ??= [];
  s.baseConfig ??= {};
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
