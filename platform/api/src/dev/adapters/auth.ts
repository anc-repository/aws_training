/**
 * Dev tokens instead of Cognito: `Authorization: Bearer dev.<group>.<sub>[.<authTimeEpochSeconds>]`, e.g.
 * `dev.learner.u1`, `dev.assistant.ta1`. Without an auth time the token counts as a fresh login. Only the dev runtime
 * constructs this adapter.
 */
import { AtlError, COGNITO_GROUPS, type AuthPort, type ClockPort, type CognitoGroup, type JwtPrincipal } from '@atl/shared';

export function devToken(group: CognitoGroup, sub: string, authTimeEpochSeconds?: number): string {
  return `dev.${group}.${sub}${authTimeEpochSeconds === undefined ? '' : `.${authTimeEpochSeconds}`}`;
}

export class DevAuth implements AuthPort {
  constructor(private readonly clock: ClockPort) {}

  async verifyAccessToken(token: string): Promise<JwtPrincipal> {
    const m = /^dev\.(learner|assistant|observer)\.([A-Za-z0-9_-]{1,64})(?:\.(\d{9,11}))?$/.exec(token);
    if (!m) throw new AtlError('UNAUTHENTICATED', 'dev mode expects tokens of the form dev.<group>.<sub>[.<authTime>]');
    const group = m[1] as CognitoGroup;
    if (!(COGNITO_GROUPS as readonly string[]).includes(group)) throw new AtlError('UNAUTHENTICATED', 'unknown group');
    return {
      sub: m[2]!,
      username: m[2]!,
      email: `${m[2]}@dev.invalid`,
      groups: [group],
      authTime: m[3] ? Number(m[3]) : Math.floor(this.clock.nowMs() / 1000),
      clientId: 'dev',
    };
  }
}
