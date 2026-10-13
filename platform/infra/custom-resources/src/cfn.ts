/**
 * CloudFormation custom resource protocol (request event, presigned S3 response URL). Used by every handler of
 * atl-custom-resources and by UninstallRoleCleanup, which answers the UninstallGuard request on behalf of the guard
 * (the guard hands the response URL to atl-platform-uninstall, 01 §4.8).
 */

export type CfnRequestType = 'Create' | 'Update' | 'Delete';

export interface CfnEvent {
  RequestType: CfnRequestType;
  ResponseURL: string;
  StackId: string;
  RequestId: string;
  ResourceType: string;
  LogicalResourceId: string;
  PhysicalResourceId?: string;
  ResourceProperties: Record<string, unknown>;
  OldResourceProperties?: Record<string, unknown>;
}

/** What a handler returns; `noResponse` = somebody else answers later (UninstallGuard Delete). */
export interface CfnResult {
  physicalResourceId?: string;
  data?: Record<string, string>;
  noResponse?: boolean;
}

/** The callback the uninstall state machine carries (01 §4.8: `cfn: {responseUrl, requestId, stackId, …}`). */
export interface CfnCallback {
  responseUrl: string;
  requestId: string;
  stackId: string;
  logicalResourceId: string;
  physicalResourceId: string;
}

export type FetchLike = (url: string, init: { method: string; body: string; headers: Record<string, string> }) => Promise<{ ok: boolean; status: number }>;

export function isCfnEvent(e: unknown): e is CfnEvent {
  if (!e || typeof e !== 'object') return false;
  const o = e as Record<string, unknown>;
  return typeof o.RequestType === 'string' && typeof o.ResponseURL === 'string' && typeof o.ResourceType === 'string';
}

/** `Custom::StackGuard` → `StackGuard`. */
export function handlerName(event: CfnEvent): string {
  return event.ResourceType.replace(/^Custom::/, '');
}

export function callbackOf(event: CfnEvent, physicalResourceId: string): CfnCallback {
  return {
    responseUrl: event.ResponseURL,
    requestId: event.RequestId,
    stackId: event.StackId,
    logicalResourceId: event.LogicalResourceId,
    physicalResourceId,
  };
}

/** Physical id of a custom resource that has no real resource behind it. */
export function defaultPhysicalId(event: CfnEvent): string {
  return event.PhysicalResourceId ?? `atl-${handlerName(event).toLowerCase()}`;
}

export function isCallback(v: unknown): v is CfnCallback {
  if (!v || typeof v !== 'object') return false;
  const o = v as Record<string, unknown>;
  return ['responseUrl', 'requestId', 'stackId', 'logicalResourceId', 'physicalResourceId'].every((k) => typeof o[k] === 'string' && o[k]);
}

/** PUT the response document to the presigned URL (no Content-Type: the URL is signed without it). */
export async function sendCfnResponse(
  cb: CfnCallback,
  status: 'SUCCESS' | 'FAILED',
  reason: string,
  data: Record<string, string>,
  fetchImpl: FetchLike,
): Promise<void> {
  if (!/^https:\/\//.test(cb.responseUrl)) throw new Error('CloudFormation response URL must be https');
  const body = JSON.stringify({
    Status: status,
    Reason: reason.slice(0, 3500),
    PhysicalResourceId: cb.physicalResourceId,
    StackId: cb.stackId,
    RequestId: cb.requestId,
    LogicalResourceId: cb.logicalResourceId,
    NoEcho: false,
    Data: data,
  });
  let lastError: unknown = null;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const res = await fetchImpl(cb.responseUrl, {
        method: 'PUT',
        body,
        headers: { 'content-type': '', 'content-length': String(Buffer.byteLength(body)) },
      });
      if (res.ok) return;
      lastError = new Error(`response URL returned HTTP ${res.status}`);
    } catch (e) {
      lastError = e;
    }
    await new Promise((r) => setTimeout(r, 500 * 2 ** attempt));
  }
  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}

export function prop(event: CfnEvent, name: string): string {
  const v = event.ResourceProperties[name];
  if (typeof v !== 'string' || !v) throw new Error(`${handlerName(event)}: property ${name} is required`);
  return v;
}

export function optProp(event: CfnEvent, name: string): string {
  const v = event.ResourceProperties[name];
  return typeof v === 'string' ? v : v === undefined || v === null ? '' : String(v);
}
