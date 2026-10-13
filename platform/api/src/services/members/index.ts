/**
 * `MemberDirectory` on Cognito `atl-users` (01 §5.1, §5.4): invite assistants / observers (`AdminCreateUser` — Cognito
 * mails the temporary password — then `AdminAddUserToGroup`), and remove them (`AdminDeleteUser`). The learner is never
 * touched: invitations only create `assistant` / `observer`, and removal refuses a user in the `learner` group.
 *
 * The pool uses `UsernameAttributes: [email]`, so the Cognito user name is the generated `sub` (UUID); the email is the
 * sign-in alias. `ATLApiFunctionRole` has `cognito-idp:Admin*` on the pool (01 §6.9) and `cognito-idp:ListUsers` for the
 * `sub` lookup fallback (platform-backend-gaps).
 */
import { AtlError } from '@atl/shared';
import type { MemberDirectory } from '../../routes/extensions.js';
import type { PlatformEnv } from '../../runtime/env.js';

function errName(e: unknown): string {
  return e && typeof e === 'object' && 'name' in e ? String((e as { name: unknown }).name) : '';
}

export function createCognitoMemberDirectory(env: PlatformEnv): MemberDirectory {
  const poolId = env.userPoolId;
  type Cip = typeof import('@aws-sdk/client-cognito-identity-provider');
  let client: { m: Cip; c: InstanceType<Cip['CognitoIdentityProviderClient']> } | null = null;
  const sdk = async () => {
    if (!poolId) throw Object.assign(new Error('ATL_USER_POOL_ID is not set (member directory)'), { name: 'Atl.NotImplemented' });
    if (!client) {
      const m = await import('@aws-sdk/client-cognito-identity-provider');
      client = { m, c: new m.CognitoIdentityProviderClient({ region: env.region }) };
    }
    return client;
  };

  async function usernameOf(sub: string): Promise<string | null> {
    const { m, c } = await sdk();
    const r = await c.send(new m.ListUsersCommand({ UserPoolId: poolId!, Filter: `sub = "${sub.replace(/["\\]/g, '')}"`, Limit: 1 }));
    return r.Users?.[0]?.Username ?? null;
  }

  return {
    async invite(input) {
      if (input.role !== 'assistant' && input.role !== 'observer') throw new AtlError('VALIDATION_FAILED', 'role must be assistant or observer');
      const { m, c } = await sdk();
      let created;
      try {
        created = await c.send(
          new m.AdminCreateUserCommand({
            UserPoolId: poolId!,
            Username: input.email,
            UserAttributes: [
              { Name: 'email', Value: input.email },
              { Name: 'email_verified', Value: 'true' },
            ],
            DesiredDeliveryMediums: ['EMAIL'],
          }),
        );
      } catch (e) {
        if (errName(e) === 'UsernameExistsException') throw new AtlError('VALIDATION_FAILED', `${input.email} already has an account in the user pool`, { reason: 'USER_EXISTS' });
        if (errName(e) === 'InvalidParameterException') throw new AtlError('VALIDATION_FAILED', `Cognito rejected the invitation: ${e instanceof Error ? e.message : String(e)}`);
        throw e;
      }
      const username = created.User?.Username;
      const sub = created.User?.Attributes?.find((a) => a.Name === 'sub')?.Value ?? username;
      if (!username || !sub) throw new AtlError('UPSTREAM_UNAVAILABLE', 'AdminCreateUser returned no user');
      try {
        await c.send(new m.AdminAddUserToGroupCommand({ UserPoolId: poolId!, Username: username, GroupName: input.role }));
      } catch (e) {
        // no half-invited user without a group (it could sign in but would see the “no role” page)
        await c.send(new m.AdminDeleteUserCommand({ UserPoolId: poolId!, Username: username })).catch(() => undefined);
        throw e;
      }
      return { sub };
    },

    async remove(sub) {
      const { m, c } = await sdk();
      let username: string | null = sub;
      const groups = async (u: string) => (await c.send(new m.AdminListGroupsForUserCommand({ UserPoolId: poolId!, Username: u }))).Groups?.map((g) => g.GroupName) ?? [];
      let g: (string | undefined)[];
      try {
        g = await groups(username);
      } catch (e) {
        if (errName(e) !== 'UserNotFoundException') throw e;
        username = await usernameOf(sub);
        if (!username) return; // already gone from the pool
        g = await groups(username);
      }
      if (g.includes('learner')) throw new AtlError('FORBIDDEN_ROLE', 'the learner cannot be removed (01 §5.4)');
      try {
        await c.send(new m.AdminDeleteUserCommand({ UserPoolId: poolId!, Username: username }));
      } catch (e) {
        if (errName(e) !== 'UserNotFoundException') throw e;
      }
    },
  };
}

/** Dev mode: no Cognito; the invited member signs in with the dev token `dev.<role>.<sub>` (DevAuth). */
export function createDevMemberDirectory(newSub: () => string = () => `dev-${globalThis.crypto.randomUUID()}`): MemberDirectory & { invited: { sub: string; email: string; role: string }[]; removed: string[] } {
  const invited: { sub: string; email: string; role: string }[] = [];
  const removed: string[] = [];
  return {
    invited,
    removed,
    async invite(input) {
      const sub = newSub();
      invited.push({ sub, ...input });
      return { sub };
    },
    async remove(sub) {
      removed.push(sub);
    },
  };
}
