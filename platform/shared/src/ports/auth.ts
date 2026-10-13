import type { CognitoGroup } from '../roles.js';

/** Browser (JWT) authentication. Production: Cognito access tokens via aws-jwt-verify. Dev: `dev.<group>.<sub>` tokens. */
export interface JwtPrincipal {
  sub: string;
  username: string;
  email?: string;
  groups: CognitoGroup[];
  /** `auth_time` (epoch seconds): last real login; sensitive routes require ≤ 60 min (01 §5.3). */
  authTime: number;
  clientId?: string;
}

export interface AuthPort {
  /** Throws `AtlError('UNAUTHENTICATED')` for a missing / invalid / expired token. */
  verifyAccessToken(token: string): Promise<JwtPrincipal>;
}
