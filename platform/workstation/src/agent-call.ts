/**
 * atl-agent-call — call the agent routes `/api/v1/agent/*` of the platform API from the workstation with the learner's
 * credentials (`ATLLearnerRole/atl-<sid>-ws` from the default credential chain = the CLI profile written by
 * ATL-WorkstationSetup), signed with SigV4 for `execute-api` and sent directly to the execute-api endpoint (not through
 * CloudFront: the signature covers the Host header, 03 §4.6, 04 §7.2).
 *
 * Retries (03 §4.6 step 2): network errors, 5xx, 429 and credential errors (the role tag atl:active-session-id may not have
 * propagated yet) after 2, 4, 8, 16, 30 s, at most ~2 minutes. 403 and 409 are not retried.
 * Exit codes: 0 ok (body on stdout), 3 non-retryable rejection (4xx), 4 temporarily unavailable (retries exhausted), 2 usage.
 */

export interface AgentRequest {
  endpoint: string;
  method: string;
  path: string;
  body?: string;
  idempotencyKey?: string;
}

export interface SignedRequest {
  method: string;
  url: string;
  headers: Record<string, string>;
  body?: string;
}

export interface AgentCallDeps {
  /** Sign the request (SigV4 for execute-api in the endpoint's region). Throws on credential errors. */
  sign(req: { method: string; url: URL; headers: Record<string, string>; body?: string; region: string }): Promise<Record<string, string>>;
  fetch(url: string, init: { method: string; headers: Record<string, string>; body?: string }): Promise<{ status: number; text(): Promise<string> }>;
  sleep(ms: number): Promise<void>;
  now(): number;
  log(line: string): void;
}

export interface AgentCallResult {
  exitCode: 0 | 3 | 4;
  status: number | null;
  body: string;
  attempts: number;
}

export const RETRY_DELAYS_SECONDS = [2, 4, 8, 16, 30] as const;
export const RETRY_BUDGET_MS = 125_000;

const ENDPOINT_RE = /^https:\/\/[a-z0-9]{10}\.execute-api\.([a-z]{2}-[a-z]+-[0-9])\.amazonaws\.com$/;
const PATH_RE = /^\/api\/v1\/agent(-fallback)?\/[A-Za-z0-9._~\-/]+(\?[A-Za-z0-9._~\-=&%]*)?$/;

export function regionOfEndpoint(endpoint: string): string {
  const m = ENDPOINT_RE.exec(endpoint.replace(/\/+$/, ''));
  if (!m) throw new UsageError(`not an execute-api endpoint: ${endpoint}`);
  return m[1]!;
}

export class UsageError extends Error {
  readonly exitCode = 2;
}

export function validateRequest(req: AgentRequest): void {
  regionOfEndpoint(req.endpoint);
  if (!/^(GET|POST|PUT|PATCH|DELETE)$/.test(req.method)) throw new UsageError(`unsupported method ${req.method}`);
  if (!PATH_RE.test(req.path)) throw new UsageError(`path must be an agent route (/api/v1/agent/…): ${req.path}`);
}

function isCredentialError(e: unknown): boolean {
  const name = e && typeof e === 'object' && 'name' in e ? String((e as { name: unknown }).name) : '';
  const msg = e instanceof Error ? e.message : String(e);
  return /AccessDenied|CredentialsProviderError|ExpiredToken|InvalidClientTokenId|not authorized to perform: sts:AssumeRole/i.test(`${name} ${msg}`);
}

export async function callAgent(req: AgentRequest, deps: AgentCallDeps, budgetMs: number = RETRY_BUDGET_MS): Promise<AgentCallResult> {
  validateRequest(req);
  const endpoint = req.endpoint.replace(/\/+$/, '');
  const region = regionOfEndpoint(endpoint);
  const url = new URL(endpoint + req.path);
  const started = deps.now();
  let attempts = 0;
  let last: AgentCallResult = { exitCode: 4, status: null, body: '', attempts: 0 };
  for (let i = 0; ; i++) {
    attempts++;
    let retryable = false;
    try {
      const headers: Record<string, string> = { host: url.host, accept: 'application/json' };
      if (req.body !== undefined) headers['content-type'] = 'application/json';
      if (req.idempotencyKey) headers['idempotency-key'] = req.idempotencyKey;
      const signed = await deps.sign({ method: req.method, url, headers, body: req.body, region });
      const res = await deps.fetch(url.toString(), { method: req.method, headers: signed, body: req.body });
      const body = await res.text();
      last = { exitCode: res.status < 300 ? 0 : res.status >= 500 || res.status === 429 ? 4 : 3, status: res.status, body, attempts };
      if (res.status < 300) return last;
      retryable = res.status >= 500 || res.status === 429;
      deps.log(`atl-agent-call: HTTP ${res.status} (${retryable ? 'will retry' : 'not retryable'})`);
      if (!retryable) return last;
    } catch (e) {
      retryable = true;
      last = { exitCode: 4, status: null, body: '', attempts };
      deps.log(`atl-agent-call: ${isCredentialError(e) ? 'credentials not available yet' : 'request failed'}: ${e instanceof Error ? e.message : String(e)}`);
    }
    const delay = (RETRY_DELAYS_SECONDS[Math.min(i, RETRY_DELAYS_SECONDS.length - 1)] ?? 30) * 1000;
    if (i >= RETRY_DELAYS_SECONDS.length || deps.now() - started + delay > budgetMs) {
      return { ...last, exitCode: retryable ? 4 : last.exitCode, attempts };
    }
    await deps.sleep(delay);
  }
}

/** Read `ATL_AGENT_API` from a `KEY='value'` env file (/etc/atl/session.env). */
export function agentApiFromEnvFile(text: string): string | null {
  for (const line of text.split(/\r?\n/)) {
    const m = /^ATL_AGENT_API='?([^']*)'?$/.exec(line.trim());
    if (m) return m[1]!;
  }
  return null;
}
