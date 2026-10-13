// backend/src/http/routes/jwks.ts —— GET /.well-known/jwks.json：auth=local 的 ES256 公钥（当前与上一版本 kid，D8）；cognito 时 404
// （Cognito 的 JWKS 在 https://cognito-idp.<region>.amazonaws.com/<poolId>/.well-known/jwks.json，不经 EC2）
import type { Express } from 'express';
import type { Container } from '../../container.js';

export const PATHS = [
  '/.well-known/jwks.json',
] as const;

export function register(app: Express, c: Container): void {
  app.get('/.well-known/jwks.json', async (_req, res) => {
    const jwks = await c.auth.jwks();
    if (!jwks) {
      res.status(404).json({ error: 'NOT_FOUND', message: 'auth=cognito：公钥由 Cognito User Pool 发布' });
      return;
    }
    res.set('Cache-Control', 'public, max-age=300').json(jwks);
  });
  app.all('/.well-known/jwks.json', (_req, res) => {
    res.status(405).set('Allow', 'GET').json({ error: 'METHOD_NOT_ALLOWED' });
  });
}
