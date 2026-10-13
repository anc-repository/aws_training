/**
 * Ports of the check engine beyond the shared `PlatformPorts` (04 §5.2): read-only AWS calls as `ATLVerifierRole`, the
 * outbound HTTP probe (shared egress guard, 01 §3.2), and the AWS IP ranges. Production implementations are in
 * `functions/checks/aws/`, dev implementations in `functions/checks/dev/` (ATL_DEV_MODE=1, wired by the dev runtime).
 */
import type { FunctionDeps } from '../../../runtime/deps.js';

/** Error of an AWS read-only call, already classified. `awsName` keeps the service's error name for `expectError`. */
export class AwsCallError extends Error {
  constructor(
    readonly kind: 'ACCESS_DENIED' | 'THROTTLED' | 'NETWORK' | 'NOT_FOUND' | 'INVALID' | 'OTHER',
    readonly awsName: string,
    message: string,
  ) {
    super(message);
    this.name = 'AwsCallError';
  }
}

export interface AwsReadRequest {
  /** IAM service prefix (`cloudfront`, `elasticloadbalancing`, `s3control`, …; 04 §5.7). */
  service: string;
  /** SDK operation name (`GetDistribution`). */
  action: string;
  params: Record<string, unknown>;
  region: string;
  /** Verifier session: role session name `atl-<sid>-verify`, session tags atl:session-id / atl:env-id (04 §5.7). */
  session: { sid: string; envId: string };
}

export interface AwsReadPort {
  call(req: AwsReadRequest): Promise<Record<string, unknown>>;
}

export interface HttpProbeRequest {
  url: string;
  method: 'GET' | 'HEAD';
  headers: Record<string, string>;
  /** 1–5 requests over one keep-alive connection (04 §5.2.3). */
  repeat: number;
  intervalMs: number;
  timeoutMs: number;
  /** Per-request extra headers (one-time probe tokens). */
  perRequestHeaders?: (i: number) => Record<string, string>;
  /** Ports allowed besides 80/443 (enumerated targets only). */
  extraPorts?: number[];
}

export interface HttpProbeResponse {
  status: number;
  headers: Record<string, string>;
  json?: unknown;
  /** Only kept when the caller asks for it (sample.assetPath extraction); never stored as evidence. */
  bodyText?: string;
  pathSegments: Record<string, string>;
  timingMs: number;
  peer: { address: string | null; family: string | null };
  tls?: { subject: string | null; subjectAltNames: string[]; issuer: string | null; notAfter: string | null; protocol: string | null };
  reconnected?: boolean;
  dns?: { host: string; addresses: string[] };
}

export class ProbeError extends Error {
  constructor(
    readonly code: 'TARGET_UNRESOLVED' | 'NETWORK' | 'TIMEOUT',
    message: string,
  ) {
    super(message);
    this.name = 'ProbeError';
  }
}

export interface HttpProbePort {
  /** Resolve, reject private / loopback / link-local / reserved addresses, connect to the validated IP (no redirects). */
  fetch(req: HttpProbeRequest & { keepBody?: boolean }): Promise<HttpProbeResponse[]>;
  /** DNS resolution only (tls-domain entry checks). */
  resolve(host: string): Promise<string[]>;
}

export interface IpRange {
  prefix: string;
  service: string;
  region?: string;
}

export interface IpRangesPort {
  /** ip-ranges.json prefixes (IPv4 and IPv6), cached daily. */
  ranges(): Promise<IpRange[]>;
}

/** Install-time facts the engine needs (registered with the platform release; see implementation-notes platform-checks). */
export interface EngineConfig {
  /** SHA-256 of the check bundle manifest pinned for this platform release (04 §6.3). */
  bundleDigest: string | null;
  runCheckDocumentVersion?: string;
  runCheckDocumentHash?: string;
  /** Dev only: allow loopback / private targets for platform probes. Never true in production. */
  allowPrivateTargets?: boolean;
}

export interface CheckEnginePorts {
  aws: AwsReadPort;
  http: HttpProbePort;
  ipRanges: IpRangesPort;
  config: EngineConfig;
}

/** Builds the engine ports for one invocation (production: from the function env; dev: fakes). */
export type EnginePortsProvider = (deps: FunctionDeps) => Promise<CheckEnginePorts> | CheckEnginePorts;
