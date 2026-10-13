/**
 * Minimal API Gateway HTTP API (payload format 2.0) shapes used by atl-api / atl-agent / atl-public.
 * The dev server produces the same shape.
 */
export interface HttpEvent {
  version?: '2.0';
  routeKey?: string;
  rawPath: string;
  rawQueryString?: string;
  headers?: Record<string, string | undefined>;
  queryStringParameters?: Record<string, string | undefined>;
  body?: string;
  isBase64Encoded?: boolean;
  requestContext: {
    requestId?: string;
    http: { method: string; path?: string; sourceIp?: string; userAgent?: string };
    authorizer?: {
      /** AWS_IAM routes: the SigV4 caller. */
      iam?: { userArn?: string; accountId?: string; callerId?: string };
      /** JWT routes (API Gateway JWT authorizer); atl-api re-verifies the token itself through AuthPort. */
      jwt?: { claims?: Record<string, unknown>; scopes?: string[] };
    };
  };
}

export interface HttpResult {
  statusCode: number;
  headers?: Record<string, string>;
  body?: string;
  isBase64Encoded?: boolean;
}

export function header(event: HttpEvent, name: string): string | undefined {
  const h = event.headers ?? {};
  const lower = name.toLowerCase();
  for (const [k, v] of Object.entries(h)) if (k.toLowerCase() === lower) return v;
  return undefined;
}

export function json(statusCode: number, body: unknown, headers: Record<string, string> = {}): HttpResult {
  return {
    statusCode,
    headers: { 'content-type': 'application/json; charset=utf-8', ...headers },
    body: body === undefined ? '' : JSON.stringify(body),
  };
}

export function parseJsonBody<T = unknown>(event: HttpEvent): T | undefined {
  if (!event.body) return undefined;
  const text = event.isBase64Encoded ? Buffer.from(event.body, 'base64').toString('utf8') : event.body;
  return JSON.parse(text) as T;
}
