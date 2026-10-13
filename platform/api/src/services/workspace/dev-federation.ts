/**
 * Local stand-in for `https://signin.aws.amazon.com/federation` (03 §5.1) in dev mode: `Action=getSigninToken`
 * (GET or POST, `Session` = the JSON of temporary credentials) issues an opaque token valid for 15 minutes;
 * `Action=login` (GET or POST, `SigninToken`, `Destination`, `Issuer`) consumes it and renders a page saying which
 * console page the learner would land on — it never redirects to AWS. Served by the dev server at `/__dev/federation`.
 */
import { randomBytes } from 'node:crypto';

export interface DevFederationResponse {
  status: number;
  headers: Record<string, string>;
  body: string;
}

const TOKEN_TTL_MS = 15 * 60_000;

function esc(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
}

function json(status: number, body: unknown): DevFederationResponse {
  return { status, headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' }, body: JSON.stringify(body) };
}

export class DevFederationStub {
  private readonly tokens = new Map<string, { accessKeyId: string; expiresAt: number }>();
  /** Destinations of completed logins (tests). */
  readonly logins: { destination: string; issuer: string | null; accessKeyId: string }[] = [];

  constructor(private readonly nowMs: () => number = Date.now) {}

  handle(method: string, params: URLSearchParams): DevFederationResponse {
    const action = params.get('Action');
    if (action === 'getSigninToken') {
      if (params.has('SessionDuration')) return json(400, { message: 'SessionDuration is not allowed with role-chained credentials (03 §5.3)' });
      let session: { sessionId?: string; sessionKey?: string; sessionToken?: string };
      try {
        session = JSON.parse(params.get('Session') ?? '') as typeof session;
      } catch {
        return json(400, { message: 'Session must be the JSON of temporary credentials' });
      }
      if (!session.sessionId || !session.sessionKey || !session.sessionToken) return json(400, { message: 'Session needs sessionId, sessionKey and sessionToken' });
      const token = `dev-signin-${randomBytes(24).toString('base64url')}`;
      this.tokens.set(token, { accessKeyId: session.sessionId, expiresAt: this.nowMs() + TOKEN_TTL_MS });
      return json(200, { SigninToken: token });
    }
    if (action === 'login') {
      const token = params.get('SigninToken') ?? '';
      const t = this.tokens.get(token);
      this.tokens.delete(token);
      if (!t || t.expiresAt < this.nowMs()) return { status: 400, headers: { 'content-type': 'text/plain; charset=utf-8' }, body: 'dev federation: unknown or expired SigninToken' };
      const destination = params.get('Destination') ?? '';
      const issuer = params.get('Issuer');
      this.logins.push({ destination, issuer, accessKeyId: t.accessKeyId });
      const back = issuer && /^https?:\/\//.test(issuer) ? `<p><a href="${esc(issuer)}">回到工作台</a></p>` : '';
      return {
        status: 200,
        headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', 'referrer-policy': 'no-referrer' },
        body: `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><title>ATL dev 控制台（模拟）</title></head><body><h1>ATL dev：联合登录桩</h1><p>生产环境中这里会以 ATLLearnerRole 登录 AWS 控制台并打开：</p><p><code>${esc(destination)}</code></p><p>开发模式不连接 AWS（${esc(method)}）。</p>${back}</body></html>`,
      };
    }
    return json(400, { message: 'Action must be getSigninToken or login' });
  }
}
