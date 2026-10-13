/**
 * 工作台用到的响应结构（03 §2.7、§3.2、§5、§6.1；04 §8；字段名以 platform/api 当前实现为准：routes/workspace.ts、progress.ts、reports.ts）。
 * 契约 `@atl/contracts` 的 openapi.yaml 尚未生成，这里只声明工作台用到的字段。
 */
import type { CheckRunView, StepResultView } from '../model/checks';
import type { ExperimentRunView } from '../model/experiments';

export interface WorkspaceTarget {
  tab?: 'terminal-lab' | 'terminal-workstation' | string;
  role?: string;
  instanceId?: string;
  primary?: boolean;
  runAs?: string;
  awsIdentity?: string;
  ssmPing?: string | null;
  prepared?: boolean | null;
  wired?: boolean | null;
  placement?: string;
  cached?: boolean;
}

export interface TerminalRecord {
  terminalId: string;
  ssmSessionId?: string;
  instanceId?: string;
  tab?: string;
  target?: string;
  openedAt?: string;
  closedAt?: string | null;
  status?: string;
  clientId?: string;
}

export interface WorkspaceView {
  sessionId: string;
  labId: string;
  variant?: string;
  state?: string;
  envId?: string | null;
  envName?: string | null;
  region?: string | null;
  access?: { available: boolean; revokedAt?: string | null; deadlineAt?: string | null };
  targets?: WorkspaceTarget[];
  terminals?: TerminalRecord[];
  console?: {
    available?: boolean;
    lastIssuedAt?: string | null;
    credentialsExpireAt?: string | null;
    links?: { linkId: string; label?: string; steps?: string[] }[];
  };
  features?: {
    workstation?: 'ec2' | 'cloudshell' | string;
    terminalRecording?: string;
    terminalPersistence?: string;
    streamUrlSigning?: string;
    previewDirectHttps?: string | null;
    provider?: boolean;
  };
  expectedOutage?: { reason?: string | null; channel?: string | null; stepId?: string | null; actionId?: string | null; until: string } | null;
  serverNow?: string;
}

export interface StepsResponse {
  sessionId: string;
  items: StepResultView[];
}

export interface ProgressResponse {
  sessionId: string;
  attempt?: Record<string, unknown> | null;
  status: string | null;
  steps: { stepId: string; title?: string | null; optional: boolean; state: string; firstPassedAt?: string | null; flags?: string[] }[];
  stepsDone: number;
  stepsTotal: number;
  drifted: string[];
  missing: string[];
  ownershipPending?: unknown[];
}

export interface CheckRunsResponse {
  items: CheckRunView[];
  next?: string | null;
}

export interface ExperimentRunsResponse {
  sessionId?: string;
  items: ExperimentRunView[];
}

export interface PreviewTarget {
  id: string;
  url: string;
  embeddable: boolean;
  reason?: string | null;
  via?: string | null;
  label?: string;
  probed?: boolean;
}

export interface PreviewView {
  sessionId?: string;
  available?: boolean;
  reason?: string;
  default?: string;
  targets: PreviewTarget[];
}

export interface ConsoleLinkResponse {
  form?: { action: string; method?: string; fields: Record<string, string> } | null;
  url?: string | null;
  consoleSessionExpiresAt?: string | null;
  issuedAt?: string | null;
  deepLink?: string | null;
}

export interface AppCredentials {
  username: string;
  password: string;
  loginUrl?: string | null;
}

export interface ModuleOpView {
  opId: string;
  actionId?: string;
  op?: string;
  source?: string;
  status?: string;
  state?: string;
  startedAt?: string;
  finishedAt?: string | null;
  exitCode?: number | null;
  summary?: string | null;
  runId?: string | null;
}

export interface SessionCostView {
  currency?: string;
  priceAsOf?: string | null;
  hourly?: { low: number | null; high: number | null } | null;
  estimate?: { low: number; high: number } | null;
  incomplete?: string[];
  billable?: { resourceKey?: string | null; type?: string | null; name?: string | null; billing?: string; since?: string | null; createdBy?: string | null }[];
  unestimatedManualResources?: number;
  disclaimer?: string;
}
