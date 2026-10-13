/**
 * Progress, result and module-operation reports of scripts/module (06 PM-35).
 *   --progress-jsonl <file|->  one JSON per line: { ts, runId, opId, phase, module, step, status, message, pct }
 *                              (the runner forwards it to POST /api/v1/internal/runs/{runId}/events, 02 §4.3)
 *   --result-json <file>       cloudalbum.module-result/v1: the runner's failure classification input (classification itself
 *                              is computed by the runner, 02 §4.3)
 *   module-ops                 best effort POST {ATL_AGENT_API}/api/v1/{agent|internal}/sessions/{sid}/module-ops at the start
 *                              and the end of enable / disable / profile apply / seed / tls-preview when CLOUDALBUM_OPS_REPORT ≠ off;
 *                              SigV4 (execute-api) with the default credential chain, 3 s timeout, one retry; failures only go
 *                              to stderr and never change the operation (01 §9.6)
 */
import { createHash, createHmac } from 'node:crypto';
import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type { PlatformEnv } from './env.js';

export const PROGRESS_PHASES = ['plan', 'lock', 'deploy-stack', 'injects', 'policy', 'migrate', 'deliver', 'check-config', 'restart',
  'health', 'finalize', 'destroy', 'seed', 'preview'] as const;
export type ProgressPhase = (typeof PROGRESS_PHASES)[number];

export interface ProgressEvent {
  ts: string;
  runId: string | null;
  opId: string;
  phase: ProgressPhase;
  module: string | null;
  step: string | null;
  status: 'started' | 'progress' | 'succeeded' | 'failed';
  message: string;
  pct: number | null;
}

export interface CfnFailure { stack: string; logicalId: string; status: string; reason: string }

export interface ModuleResult {
  schema: 'cloudalbum.module-result/v1';
  runId: string | null;
  command: string;
  exitCode: number;
  phase: ProgressPhase | null;
  module: string | null;
  cfnFailures: CfnFailure[];
  stateEtag: string | null;
  lock: { waitedSec: number; holder: string | null };
  changed: { enabled: string[]; disabled: string[]; updated: string[] };
  warnings: string[];
  skipped: Array<Record<string, unknown>>;
  error?: { code: string; message: string; [k: string]: unknown };
}

/** enable step number -> progress phase (enable.ts step labels) */
export function phaseOfStep(step: string | number, title = ''): ProgressPhase {
  const s = String(step);
  if (s === '1') return 'plan';
  if (s === '3' || s === '3-5') return 'deploy-stack';
  if (s === '4' || s === '4b') return 'injects';
  if (s === '5') return 'policy';
  if (s === '6') return 'migrate';
  if (s === '7-9') return 'deliver';
  if (s === '10') return 'health';
  if (s === '11') return 'finalize';
  if (/destroy|delete/i.test(title)) return 'destroy';
  return 'plan';
}

export class Reporter {
  phase: ProgressPhase | null = null;
  module: string | null = null;
  readonly cfnFailures: CfnFailure[] = [];
  readonly warnings: string[] = [];
  readonly skipped: Array<Record<string, unknown>> = [];
  readonly changed = { enabled: [] as string[], disabled: [] as string[], updated: [] as string[] };

  constructor(readonly opts: { opId: string; runId: string | null; progressFile?: string; resultFile?: string; command: string }) {
    if (opts.progressFile && opts.progressFile !== '-') mkdirSync(path.dirname(path.resolve(opts.progressFile)), { recursive: true });
  }

  progress(phase: ProgressPhase, status: ProgressEvent['status'], message = '', extra: { module?: string | null; step?: string | null; pct?: number | null } = {}): void {
    this.phase = phase;
    if (extra.module !== undefined) this.module = extra.module;
    if (!this.opts.progressFile) return;
    const e: ProgressEvent = {
      ts: new Date().toISOString(), runId: this.opts.runId, opId: this.opts.opId, phase, module: extra.module ?? this.module,
      step: extra.step ?? null, status, message: message.slice(0, 500), pct: extra.pct ?? null,
    };
    const line = `${JSON.stringify(e)}\n`;
    if (this.opts.progressFile === '-') process.stdout.write(line);
    else appendFileSync(this.opts.progressFile, line);
  }

  result(exitCode: number, extra: { stateEtag?: string | null; lock?: { waitedSec: number; holder: string | null }; error?: ModuleResult['error'] } = {}): ModuleResult {
    const r: ModuleResult = {
      schema: 'cloudalbum.module-result/v1', runId: this.opts.runId, command: this.opts.command, exitCode, phase: this.phase, module: this.module,
      cfnFailures: this.cfnFailures, stateEtag: extra.stateEtag ?? null, lock: extra.lock ?? { waitedSec: 0, holder: null },
      changed: this.changed, warnings: this.warnings, skipped: this.skipped, ...(extra.error ? { error: extra.error } : {}),
    };
    if (this.opts.resultFile) {
      mkdirSync(path.dirname(path.resolve(this.opts.resultFile)), { recursive: true });
      writeFileSync(this.opts.resultFile, `${JSON.stringify(r, null, 2)}\n`);
    }
    return r;
  }
}

/** Printer decorator: every step / section also becomes a progress event (platform mode with --progress-jsonl) */
export class ReportingPrinter {
  constructor(private readonly inner: {
    info(l: string): void; step(n: number | string, t: string): void; dry(l: string): void; warn(l: string): void;
    error(l: string): void; debug(l: string): void; section(t: string): void;
  }, private readonly reporter: Reporter) {}
  info(line: string): void { this.inner.info(line); }
  dry(line: string): void { this.inner.dry(line); }
  debug(line: string): void { this.inner.debug(line); }
  warn(line: string): void {
    this.inner.warn(line);
    if (this.reporter.warnings.length < 50) this.reporter.warnings.push(line.trim().slice(0, 300));
  }
  error(line: string): void { this.inner.error(line); }
  step(n: number | string, title: string): void {
    this.inner.step(n, title);
    this.reporter.progress(phaseOfStep(n, title), 'progress', title, { step: String(n) });
  }
  section(title: string): void {
    this.inner.section(title);
    const m = /^(?:plan: )?(enable|disable) ([a-z][a-z0-9-]*)/.exec(title);
    if (m) this.reporter.progress(m[1] === 'disable' ? 'destroy' : 'plan', 'started', title, { module: m[2]! });
  }
}

// ------------------------------------------------------------------------------------------------ module-ops (SigV4)

class Sha256 {
  private readonly h: ReturnType<typeof createHash> | ReturnType<typeof createHmac>;
  constructor(secret?: string | Uint8Array) {
    this.h = secret ? createHmac('sha256', Buffer.from(secret)) : createHash('sha256');
  }
  update(data: string | Uint8Array): void {
    this.h.update(typeof data === 'string' ? Buffer.from(data) : Buffer.from(data));
  }
  async digest(): Promise<Uint8Array> {
    return new Uint8Array(this.h.digest());
  }
}

export interface ModuleOpBody {
  opId: string;
  phase: 'started' | 'succeeded' | 'failed';
  command: string;
  module: string | null;
  driver: string | null;
  profile: string | null;
  exitCode: number | null;
  at: string;
  runId: string | null;
}

/** POST …/module-ops (best effort). `fetchImpl` / `signer` are injectable for tests. */
export async function reportModuleOp(p: PlatformEnv, body: ModuleOpBody, deps: {
  fetchImpl?: typeof fetch;
  sign?: (req: { method: string; url: URL; headers: Record<string, string>; body: string }) => Promise<Record<string, string>>;
  log?: (line: string) => void;
} = {}): Promise<boolean> {
  if (p.opsReport === 'off' || !p.agentApi) return false;
  const scope = p.opsReport === 'agent' ? 'agent' : 'internal';
  const url = new URL(`${p.agentApi.replace(/\/+$/, '')}/api/v1/${scope}/sessions/${p.sessionId}/module-ops`);
  const payload = JSON.stringify(body);
  const headers: Record<string, string> = {
    'content-type': 'application/json', host: url.host, 'idempotency-key': `${body.opId}-${body.phase}`,
  };
  const sign = deps.sign ?? (async (req) => {
    const [{ SignatureV4 }, { fromNodeProviderChain }] = await Promise.all([
      import('@smithy/signature-v4' as string) as Promise<{ SignatureV4: new (o: Record<string, unknown>) => { sign(r: unknown): Promise<{ headers: Record<string, string> }> } }>,
      import('@aws-sdk/credential-providers' as string) as Promise<{ fromNodeProviderChain: () => unknown }>,
    ]);
    const signer = new SignatureV4({ service: 'execute-api', region: p.region, credentials: fromNodeProviderChain(), sha256: Sha256 });
    const signed = await signer.sign({
      method: req.method, protocol: req.url.protocol, hostname: req.url.hostname, ...(req.url.port ? { port: Number(req.url.port) } : {}),
      path: req.url.pathname, headers: req.headers, body: req.body,
    });
    return signed.headers;
  });
  const fetchImpl = deps.fetchImpl ?? fetch;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const signedHeaders = await sign({ method: 'POST', url, headers, body: payload });
      const ctl = new AbortController();
      const t = setTimeout(() => ctl.abort(), 3000);
      try {
        const r = await fetchImpl(url, { method: 'POST', headers: signedHeaders, body: payload, signal: ctl.signal });
        if (r.status < 500) return r.ok;
      } finally {
        clearTimeout(t);
      }
    } catch (e) {
      if (attempt === 1) (deps.log ?? ((l) => process.stderr.write(`${l}\n`)))(`WARN  module-ops report failed: ${(e as Error).message}`);
    }
  }
  return false;
}
