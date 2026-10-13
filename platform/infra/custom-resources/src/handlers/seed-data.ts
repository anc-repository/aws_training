/**
 * SeedData (01 §4.6, §7.3): writes `PLATFORM / CONFIG` from the install parameters and creates the assistants listed in
 * AssistantEmails. On Create the whole item is written with the default settings; on Update only the install-derived
 * fields are refreshed, so settings changed in the platform (PATCH /settings) survive upgrades. `mode`, `maintenance`,
 * `budget.state` and `preflight` are never touched here.
 */
import { INSTALL_DEFAULTS, Keys } from '@atl/shared';
import type { CfnEvent, CfnResult } from '../cfn.js';
import { defaultPhysicalId, optProp, prop } from '../cfn.js';
import type { Item, Ports } from '../ports.js';

function num(event: CfnEvent, name: string, fallback: number): number {
  const v = Number(event.ResourceProperties[name]);
  return Number.isFinite(v) ? v : fallback;
}

/** Fields derived from the install parameters (refreshed on every Create / Update). */
export function installDerivedConfig(event: CfnEvent): Item {
  const analyzerMode = optProp(event, 'ExternalAccessAnalyzer') || 'create';
  return {
    version: prop(event, 'Version'),
    releaseVersion: optProp(event, 'ReleaseVersion'),
    installationId: prop(event, 'InstallationId'),
    region: prop(event, 'Region'),
    drRegion: optProp(event, 'DrRegion') || null,
    platformUrl: prop(event, 'PlatformUrl'),
    agentApiEndpoint: prop(event, 'AgentApiEndpoint'),
    workloadBoundaryArn: prop(event, 'WorkloadBoundaryArn'),
    limits: {
      maxSessionMinutes: num(event, 'MaxSessionMinutes', INSTALL_DEFAULTS.MaxSessionMinutes),
      extension: { minutes: num(event, 'ExtensionMinutes', INSTALL_DEFAULTS.ExtensionMinutes), maxCount: num(event, 'MaxExtensions', INSTALL_DEFAULTS.MaxExtensions) },
      maxKeepHours: num(event, 'MaxKeepHours', INSTALL_DEFAULTS.MaxKeepHours),
      keepHardMaxHours: INSTALL_DEFAULTS.KeepHardMaxHours,
      envMaxAgeDays: num(event, 'EnvMaxAgeDays', INSTALL_DEFAULTS.EnvMaxAgeDays),
      readyIdleMinutes: num(event, 'ReadyIdleMinutes', INSTALL_DEFAULTS.ReadyIdleMinutes),
      asgMaxSizeLimit: num(event, 'AsgMaxSizeLimit', INSTALL_DEFAULTS.AsgMaxSizeLimit),
    },
    allowedInstanceTypes: optProp(event, 'AllowedInstanceTypes').split(',').map((s) => s.trim()).filter(Boolean),
    accessAnalyzer: { mode: analyzerMode, arn: optProp(event, 'AnalyzerArn') || null },
  };
}

/** Default settings of a fresh installation (01 §7.3, 02 §7.7, 03 §9.4). */
export function defaultSettings(event: CfnEvent, nowIso: string): Item {
  const recording = optProp(event, 'TerminalRecording') === 'cloudwatch' ? 'cloudwatch' : 'off';
  return {
    maintenance: false,
    mode: 'NORMAL',
    budget: {
      amount: num(event, 'MonthlyBudgetAmount', 0),
      enforcement: optProp(event, 'BudgetEnforcement') || 'block-start',
      state: 'OK',
      stateAt: nowIso,
    },
    reclaim: { rescanOffsetsMinutes: [20, 60, 360], blockStartOnResidual: 'ack' },
    ownership: { maxWaitMinutes: 20, hardMaxWaitMinutes: 45 },
    terminal: { recording, persistence: 'none', streamUrlSigning: 'none', keepalive: 'off' },
    workstation: { instanceType: optProp(event, 'WorkstationInstanceType') || INSTALL_DEFAULTS.WorkstationInstanceType, ami: 'al2023' },
    console: { longSession: false },
    preview: { directHttps: 'letsencrypt-ip' },
    agent: { lateUploadFallback: 'off' },
  };
}

export async function seedData(event: CfnEvent, ports: Ports): Promise<CfnResult> {
  const id = defaultPhysicalId(event);
  if (event.RequestType === 'Delete') return { physicalResourceId: id };
  const table = prop(event, 'Table');
  const now = ports.now().toISOString();
  const key = Keys.platformConfig();
  const derived = installDerivedConfig(event);
  const existing = await ports.table.get(table, key);
  if (!existing || existing.type !== 'PlatformConfig') {
    await ports.table.put(table, {
      ...existing,
      ...key,
      type: 'PlatformConfig',
      ver: 1,
      createdAt: now,
      updatedAt: now,
      ...derived,
      ...defaultSettings(event, now),
    });
  } else {
    const budget = { ...((existing.budget as Item | undefined) ?? {}) };
    budget.amount = num(event, 'MonthlyBudgetAmount', 0);
    budget.enforcement = optProp(event, 'BudgetEnforcement') || 'block-start';
    const terminal = { ...((existing.terminal as Item | undefined) ?? {}) };
    terminal.recording = optProp(event, 'TerminalRecording') === 'cloudwatch' ? 'cloudwatch' : 'off';
    await ports.table.update(table, key, {
      ...derived,
      budget,
      terminal,
      updatedAt: now,
      ver: (typeof existing.ver === 'number' ? existing.ver : 0) + 1,
    });
  }
  const pool = optProp(event, 'UserPoolId');
  const assistants = optProp(event, 'AssistantEmails').split(',').map((s) => s.trim()).filter(Boolean);
  const created: string[] = [];
  for (const email of assistants) {
    if ((await ports.users.ensureUser(pool, email, 'assistant')) === 'created') created.push(email);
  }
  if (created.length) ports.log('assistants invited', { count: created.length });
  return { physicalResourceId: id, data: { InstallationId: String(derived.installationId) } };
}
