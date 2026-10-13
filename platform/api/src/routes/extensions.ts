/**
 * Pluggable providers for routes whose AWS work belongs to another implementation area, and the downstream action
 * names this API sends to other functions. The route layer (state gates, RBAC, rate limits, audit, events) lives here;
 * a provider only does the part that needs AWS APIs without a shared port yet.
 *
 * | Provider          | Owner                 | Routes                                                                      |
 * |-------------------|-----------------------|-----------------------------------------------------------------------------|
 * | `workspace`       | 03 (terminal/console) | `POST/DELETE …/terminals`, `…/resume`, `…/console-link`, `…/app-credentials` |
 * | `memberDirectory` | 01 §5.4 (Cognito)     | `POST /members`, `DELETE /members/{sub}`                                     |
 *
 * Without a provider these routes answer `501 NOT_IMPLEMENTED`. Production wires `services/workspace` (AWS) and
 * `services/members` (Cognito) in `functions/api/index.ts`; the dev server wires the dev variants (SSM mock, federation
 * stub). Everything else is served by the API itself or by asynchronous invocations of the owning function
 * (`DOWNSTREAM_ACTIONS`).
 */
import type { JwtPrincipal } from '@atl/shared';
import type { FunctionDeps } from '../runtime/deps.js';
import type { EnvironmentRecord, PlatformConfig, Repositories, SessionItem } from '../repositories/index.js';

export interface WorkspaceCallContext {
  deps: FunctionDeps;
  repos: Repositories;
  session: SessionItem;
  env: EnvironmentRecord | null;
  config: PlatformConfig | null;
  principal: JwtPrincipal;
  nowMs: number;
  requestId: string;
}

export interface ProviderResult {
  status: number;
  body: unknown;
  headers?: Record<string, string>;
}

export interface WorkspaceProvider {
  /** 03 §3.2 steps 2–10 (the route already checked state, deadline, revocation and recent login). */
  openTerminal(ctx: WorkspaceCallContext, body: { target: 'lab' | 'workstation'; instanceId?: string; cols?: number; rows?: number; clientId?: string }): Promise<ProviderResult>;
  resumeTerminal(ctx: WorkspaceCallContext, terminalId: string, body: { clientId?: string }): Promise<ProviderResult>;
  closeTerminal(ctx: WorkspaceCallContext, terminalId: string): Promise<ProviderResult>;
  /** 03 §5.2 (`params`: deep-link parameters of the registry entry `linkId`). */
  consoleLink(ctx: WorkspaceCallContext, body: { destination?: string; linkId?: string; params?: Record<string, string> }): Promise<ProviderResult>;
  /** 01 §8.2 `GET …/app-credentials` (reads `/cloudalbum/<envName>/atl/app-admin-password`). */
  appCredentials(ctx: WorkspaceCallContext): Promise<ProviderResult>;
  /** 03 §6.1 live probe; without it `GET …/preview` answers from `LabSession.app` / `Environment.endpoints`. */
  preview?(ctx: WorkspaceCallContext): Promise<ProviderResult>;
  /** 03 §2.7 live target discovery (atl:env-id + atl:role + stack-name check); without it the cached `Environment.instances`. */
  describeTargets?(ctx: WorkspaceCallContext): Promise<unknown[]>;
}

export interface MemberDirectory {
  /** `AdminCreateUser` + `AdminAddUserToGroup`; returns the new user's `sub`. */
  invite(input: { email: string; role: 'assistant' | 'observer' }): Promise<{ sub: string }>;
  /** `AdminDeleteUser`. */
  remove(sub: string): Promise<void>;
}

export interface ApiExtensions {
  workspace?: WorkspaceProvider;
  memberDirectory?: MemberDirectory;
}

/**
 * Asynchronous (or, where noted, synchronous) invocations of other functions by atl-api / atl-agent (01 §3.2:
 * “异步调用 atl-checks、atl-certs、atl-reaper”). Payload = `{ action, … }`. Names other than `FinalizeAttempt`,
 * `CaptureLedger` and `OwnershipLookup` are not yet in the 01 name table (see implementation notes).
 */
export const DOWNSTREAM_ACTIONS = {
  checks: {
    runChecks: 'RunChecks',
    stepAction: 'StepAction',
    submitAttempt: 'SubmitAttempt',
    applyManualConfirmation: 'ApplyManualConfirmation',
    applyManualReview: 'ApplyManualReview',
    crossCheckExperiment: 'CrossCheckExperiment',
  },
  certs: {
    generateReport: 'GenerateReport',
    exportReport: 'ExportReport',
    createShare: 'CreateShare',
    revokeShare: 'RevokeShare',
    issueCertificate: 'IssueCertificate',
    revokeCertificate: 'RevokeCertificate',
    publishCertificate: 'PublishCertificate',
    exportArchive: 'ExportArchive',
  },
  lifecycle: { resolveCleanup: 'ResolveCleanup' },
  pricing: { priceQuote: 'PriceQuote' },
} as const;
