/**
 * ATL-RunCheck client (04 §6): SendCommand with ENV_VAR parameters, pinned document version / hash, batches of ≤ 10
 * items within the ArgsB64 limit, polling GetCommandInvocation with backoff, and strict verification of every result
 * line (runToken, sessionId, bundle digest, host instance) — anything else is `RUNNER_INTEGRITY` (§6.5).
 */
import {
  bytesToBase64Url,
  encodeJsonArgs,
  isFinalInvocationStatus,
  isPortError,
  RUN_CHECK_PARAMETER_PATTERNS,
  RUN_CHECK_RESULT_PREFIX,
  type ClockPort,
  type RunCommandPort,
} from '@atl/shared';
import type { CheckErrorCode } from '../types.js';

export interface RunCheckItem {
  key: string;
  checkId: string;
  args: Record<string, unknown>;
}

export interface RunCheckOutcome {
  key: string;
  checkId: string;
  status: 'ok' | 'error';
  errorCode: CheckErrorCode | null;
  message?: string;
  observed: unknown;
  truncated: boolean;
  instanceId: string;
  commandId: string | null;
  durationMs?: number;
}

export interface RunCheckClientOptions {
  runCommand: RunCommandPort;
  clock: ClockPort;
  sessionId: string;
  bundleDigest: string | null;
  documentVersion?: string;
  documentHash?: string;
  /** Overall budget per command (default 30 s, max 90 s, 04 §5.6). */
  timeoutMs?: number;
}

const MAX_ITEMS = 10;
const MAX_ARGS_B64 = 6000;

/** Map ATL-RunCheck error codes of the runner / launcher to engine codes. */
function mapRunnerCode(code: unknown): CheckErrorCode {
  const known: CheckErrorCode[] = ['TIMEOUT', 'THROTTLED', 'NETWORK', 'NOT_ALLOWED', 'TARGET_UNRESOLVED', 'RUNNER_INTEGRITY', 'RUNNER_UNAVAILABLE', 'PRECONDITION', 'INTERNAL'];
  return known.includes(code as CheckErrorCode) ? (code as CheckErrorCode) : 'INTERNAL';
}

export function newRunToken(): string {
  const b = new Uint8Array(24);
  globalThis.crypto.getRandomValues(b);
  return bytesToBase64Url(b);
}

/** Split items into batches whose ArgsB64 stays within the document's limit. */
export function planBatches(items: RunCheckItem[]): RunCheckItem[][] {
  const out: RunCheckItem[][] = [];
  let cur: RunCheckItem[] = [];
  for (const it of items) {
    const next = [...cur, it];
    const size = next.length === 1 ? encodeJsonArgs(it.args).length : encodeJsonArgs({ items: next }).length;
    if (cur.length > 0 && (next.length > MAX_ITEMS || size > MAX_ARGS_B64)) {
      out.push(cur);
      cur = [it];
    } else cur = next;
  }
  if (cur.length) out.push(cur);
  return out;
}

export class RunCheckClient {
  constructor(private readonly o: RunCheckClientOptions) {}

  async run(instanceId: string, items: RunCheckItem[]): Promise<RunCheckOutcome[]> {
    const out: RunCheckOutcome[] = [];
    for (const batch of planBatches(items)) out.push(...(await this.runBatch(instanceId, batch)));
    return out;
  }

  private fail(instanceId: string, items: RunCheckItem[], code: CheckErrorCode, message: string, commandId: string | null = null): RunCheckOutcome[] {
    return items.map((i) => ({ key: i.key, checkId: i.checkId, status: 'error', errorCode: code, message, observed: null, truncated: false, instanceId, commandId }));
  }

  private async runBatch(instanceId: string, items: RunCheckItem[]): Promise<RunCheckOutcome[]> {
    if (!this.o.bundleDigest || !RUN_CHECK_PARAMETER_PATTERNS.BundleDigest.test(this.o.bundleDigest)) {
      return this.fail(instanceId, items, 'RUNNER_UNAVAILABLE', 'no check bundle digest registered for this platform release');
    }
    const timeoutMs = Math.min(this.o.timeoutMs ?? 30_000, 90_000);
    const timeoutSec = Math.max(1, Math.min(80, Math.floor(timeoutMs / 1000) - 5));
    const runToken = newRunToken();
    const single = items.length === 1;
    const argsB64 = single ? encodeJsonArgs(items[0]!.args) : encodeJsonArgs({ items: items.map((i) => ({ key: i.key, checkId: i.checkId, args: i.args })) });
    const parameters: Record<string, string> = {
      CheckId: single ? items[0]!.checkId : 'batch',
      ArgsB64: argsB64.length >= 2 ? argsB64 : 'e30',
      RunToken: runToken,
      SessionId: this.o.sessionId,
      BundleDigest: this.o.bundleDigest,
      TimeoutSec: String(timeoutSec),
    };
    for (const [k, v] of Object.entries(parameters)) {
      if (!RUN_CHECK_PARAMETER_PATTERNS[k as keyof typeof RUN_CHECK_PARAMETER_PATTERNS].test(v)) return this.fail(instanceId, items, 'NOT_ALLOWED', `parameter ${k} would be rejected by ATL-RunCheck`);
    }
    let commandId: string;
    try {
      ({ commandId } = await this.o.runCommand.sendCommand({
        documentName: 'ATL-RunCheck',
        instanceIds: [instanceId],
        parameters,
        timeoutSeconds: Math.max(30, Math.ceil(timeoutMs / 1000)),
        comment: `atl ${this.o.sessionId} ${parameters.CheckId}`,
        ...(this.o.documentVersion ? { documentVersion: this.o.documentVersion } : {}),
        ...(this.o.documentHash ? { documentHash: this.o.documentHash } : {}),
      }));
    } catch (e) {
      if (isPortError(e, 'Throttled')) return this.fail(instanceId, items, 'THROTTLED', 'SendCommand throttled');
      if (isPortError(e, 'AccessDenied')) return this.fail(instanceId, items, 'CHANNEL_DOWN', 'SendCommand denied (instance tags or role changed)');
      if (isPortError(e, 'NotFound') || isPortError(e, 'InvalidInput')) {
        const msg = e instanceof Error ? e.message : String(e);
        // InvalidInstanceId = not a managed node / agent offline; InvalidDocument(Version) / hash mismatch = document changed
        if (/Document|Hash/i.test(msg)) return this.fail(instanceId, items, 'RUNNER_INTEGRITY', `ATL-RunCheck rejected: ${msg}`);
        return this.fail(instanceId, items, 'CHANNEL_DOWN', `instance not reachable through SSM: ${msg}`);
      }
      return this.fail(instanceId, items, 'NETWORK', `SendCommand failed: ${e instanceof Error ? e.message : String(e)}`);
    }

    const deadline = this.o.clock.nowMs() + timeoutMs;
    let delay = 500;
    let inv: Awaited<ReturnType<RunCommandPort['getInvocation']>> | null = null;
    for (;;) {
      await this.o.clock.sleep(delay);
      delay = Math.min(delay * 2, 4000);
      try {
        inv = await this.o.runCommand.getInvocation(commandId, instanceId);
        if (isFinalInvocationStatus(inv.status)) break;
      } catch (e) {
        if (!isPortError(e, 'NotFound') && !isPortError(e, 'Throttled')) return this.fail(instanceId, items, 'NETWORK', `GetCommandInvocation failed: ${String(e)}`, commandId);
      }
      if (this.o.clock.nowMs() >= deadline) return this.fail(instanceId, items, 'TIMEOUT', 'ATL-RunCheck did not finish in time', commandId);
    }
    const parsed = parseResultLines(inv.stdout);
    const byKey = new Map<string, Record<string, unknown>>();
    for (const r of parsed) byKey.set(String(r.key), r);
    // launcher / runner failures come back as one line keyed 'launcher' / 'runner'
    const global = byKey.get('launcher') ?? byKey.get('runner');
    return items.map((it) => {
      const key = single && !byKey.has(it.key) && !global && parsed.length === 1 ? String(parsed[0]!.key) : it.key;
      const r = byKey.get(key) ?? global;
      const base = { key: it.key, checkId: it.checkId, instanceId, commandId, truncated: false };
      if (!r) {
        if (inv!.status === 'TimedOut') return { ...base, status: 'error', errorCode: 'TIMEOUT', message: 'ATL-RunCheck timed out', observed: null };
        // no result line at all: launcher missing, Node missing or a crashed runner
        return { ...base, status: 'error', errorCode: 'RUNNER_UNAVAILABLE', message: `no result line (status ${inv!.status}): ${inv!.stderr.slice(-200)}`, observed: null };
      }
      const integrity = verifyResultLine(r, { runToken, sessionId: this.o.sessionId, bundleDigest: this.o.bundleDigest!, instanceId });
      if (integrity) return { ...base, status: 'error', errorCode: 'RUNNER_INTEGRITY', message: integrity, observed: null };
      if (r.status === 'ok') return { ...base, status: 'ok', errorCode: null, observed: r.observed ?? null, truncated: r.truncated === true, ...(typeof r.durationMs === 'number' ? { durationMs: r.durationMs } : {}) };
      return { ...base, status: 'error', errorCode: mapRunnerCode(r.errorCode), message: typeof r.message === 'string' ? r.message : undefined, observed: r.observed ?? null };
    }) as RunCheckOutcome[];
  }
}

export function parseResultLines(stdout: string): Record<string, unknown>[] {
  const out: Record<string, unknown>[] = [];
  for (const line of stdout.split(/\r?\n/)) {
    if (!line.startsWith(RUN_CHECK_RESULT_PREFIX)) continue;
    try {
      const b64 = line.slice(RUN_CHECK_RESULT_PREFIX.length).trim();
      const json = JSON.parse(Buffer.from(b64, 'base64url').toString('utf8')) as Record<string, unknown>;
      if (json && json.schema === 'atl.runcheck.result/v1') out.push(json);
    } catch {
      /* ignore garbage lines */
    }
  }
  return out;
}

/** 04 §6.5 platform-side verification; returns the reason of a mismatch or null. */
export function verifyResultLine(r: Record<string, unknown>, expect: { runToken: string; sessionId: string; bundleDigest: string; instanceId: string }): string | null {
  // a launcher that could not even read its parameters reports null fields; its own errorCode then stands
  if ((r.key === 'launcher' || r.key === 'runner') && r.status === 'error' && r.runToken === null) return null;
  if (r.runToken !== expect.runToken) return 'runToken mismatch';
  if (r.sessionId !== expect.sessionId) return 'sessionId mismatch';
  const bundle = r.bundle as { digest?: unknown } | undefined;
  if (bundle?.digest !== expect.bundleDigest && !(r.key === 'launcher' && r.status === 'error')) return 'bundle digest mismatch';
  // launcher-level failures happen before the instance id is known; everything else must name the target instance
  if (r.key !== 'launcher' && r.key !== 'runner') {
    const host = r.host as { instanceId?: unknown } | undefined;
    if (host?.instanceId !== expect.instanceId) return 'host instance mismatch';
  }
  return null;
}
