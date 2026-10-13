/**
 * Cognito MemberDirectory (01 §5.4) against a mocked CognitoIdentityProviderClient, and the member routes using it.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mockClient } from 'aws-sdk-client-mock';
import {
  AdminAddUserToGroupCommand,
  AdminCreateUserCommand,
  AdminDeleteUserCommand,
  AdminListGroupsForUserCommand,
  CognitoIdentityProviderClient,
  ListUsersCommand,
} from '@aws-sdk/client-cognito-identity-provider';
import { loadPlatformEnv } from '../src/runtime/env.js';
import { createCognitoMemberDirectory, createDevMemberDirectory } from '../src/services/members/index.js';
import { body, createApiTestRuntime, ev, LEARNER, ASSISTANT, type ApiTestRuntime } from './api-support/api-runtime.js';

const env = { ...loadPlatformEnv({ AWS_REGION: 'ap-northeast-1', ATL_ACCOUNT_ID: '111122223333', ATL_USER_POOL_ID: 'ap-northeast-1_AbCdEf123' }) };
const SUB = '0d6a8f2e-1111-4c1e-9a2b-123456789abc';

function named(name: string): Error {
  return Object.assign(new Error(name), { name });
}

let cip: ReturnType<typeof mockClient>;
beforeEach(() => {
  cip = mockClient(CognitoIdentityProviderClient);
  cip.on(AdminCreateUserCommand).resolves({ User: { Username: SUB, Attributes: [{ Name: 'sub', Value: SUB }, { Name: 'email', Value: 'ta@example.com' }] } });
  cip.on(AdminAddUserToGroupCommand).resolves({});
  cip.on(AdminDeleteUserCommand).resolves({});
  cip.on(AdminListGroupsForUserCommand).resolves({ Groups: [{ GroupName: 'assistant' }] });
});
afterEach(() => cip.restore());

describe('createCognitoMemberDirectory', () => {
  it('invites: AdminCreateUser (email as user name, Cognito mails the temporary password) + AdminAddUserToGroup with the generated user name', async () => {
    const d = createCognitoMemberDirectory(env);
    expect(await d.invite({ email: 'ta@example.com', role: 'assistant' })).toEqual({ sub: SUB });
    expect(cip.commandCalls(AdminCreateUserCommand)[0]!.args[0].input).toEqual({
      UserPoolId: 'ap-northeast-1_AbCdEf123',
      Username: 'ta@example.com',
      UserAttributes: [
        { Name: 'email', Value: 'ta@example.com' },
        { Name: 'email_verified', Value: 'true' },
      ],
      DesiredDeliveryMediums: ['EMAIL'],
    });
    expect(cip.commandCalls(AdminAddUserToGroupCommand)[0]!.args[0].input).toEqual({ UserPoolId: 'ap-northeast-1_AbCdEf123', Username: SUB, GroupName: 'assistant' });
  });

  it('rolls the user back when the group cannot be set; existing users are a validation error', async () => {
    cip.on(AdminAddUserToGroupCommand).rejects(named('ResourceNotFoundException'));
    const d = createCognitoMemberDirectory(env);
    await expect(d.invite({ email: 'ta@example.com', role: 'observer' })).rejects.toMatchObject({ name: 'ResourceNotFoundException' });
    expect(cip.commandCalls(AdminDeleteUserCommand)[0]!.args[0].input).toEqual({ UserPoolId: 'ap-northeast-1_AbCdEf123', Username: SUB });
    cip.on(AdminCreateUserCommand).rejects(named('UsernameExistsException'));
    await expect(d.invite({ email: 'ta@example.com', role: 'observer' })).rejects.toMatchObject({ code: 'VALIDATION_FAILED', extra: { reason: 'USER_EXISTS' } });
    await expect(d.invite({ email: 'x@example.com', role: 'learner' as never })).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
  });

  it('removes by sub (the pool user name); falls back to ListUsers; never removes the learner', async () => {
    const d = createCognitoMemberDirectory(env);
    await d.remove(SUB);
    expect(cip.commandCalls(AdminDeleteUserCommand)[0]!.args[0].input).toEqual({ UserPoolId: 'ap-northeast-1_AbCdEf123', Username: SUB });
    cip.reset();
    cip.on(AdminListGroupsForUserCommand).callsFake((i: { Username: string }) => {
      if (i.Username === SUB) throw named('UserNotFoundException');
      return { Groups: [{ GroupName: 'observer' }] };
    });
    cip.on(ListUsersCommand).resolves({ Users: [{ Username: 'legacy-name' }] });
    cip.on(AdminDeleteUserCommand).resolves({});
    await d.remove(SUB);
    expect(cip.commandCalls(ListUsersCommand)[0]!.args[0].input).toMatchObject({ Filter: `sub = "${SUB}"` });
    expect(cip.commandCalls(AdminDeleteUserCommand)[0]!.args[0].input.Username).toBe('legacy-name');
    cip.on(ListUsersCommand).resolves({ Users: [] });
    await expect(d.remove(SUB)).resolves.toBeUndefined();
    cip.reset();
    cip.on(AdminListGroupsForUserCommand).resolves({ Groups: [{ GroupName: 'learner' }] });
    await expect(d.remove(SUB)).rejects.toMatchObject({ code: 'FORBIDDEN_ROLE' });
    expect(cip.commandCalls(AdminDeleteUserCommand)).toHaveLength(0);
  });

  it('without a user pool the directory is not implemented (501 at the route)', async () => {
    const d = createCognitoMemberDirectory({ ...env, userPoolId: null });
    await expect(d.invite({ email: 'a@example.com', role: 'observer' })).rejects.toMatchObject({ name: 'Atl.NotImplemented' });
  });
});

describe('member routes with the Cognito directory', () => {
  let rt: ApiTestRuntime;
  beforeEach(async () => {
    rt = await createApiTestRuntime({ ext: { memberDirectory: createCognitoMemberDirectory(env) } });
  });

  it('POST /members → 201 and a member profile; DELETE /members/{sub} → 204; assistants may not invite', async () => {
    const r = await rt.api(ev('POST', '/api/v1/members', { token: LEARNER, body: { email: 'ta@example.com', role: 'assistant' } }));
    expect(r.statusCode, r.body).toBe(201);
    expect(body(r)).toEqual({ sub: SUB, email: 'ta@example.com', role: 'assistant' });
    const list = body(await rt.api(ev('GET', '/api/v1/members', { token: LEARNER })));
    expect((list.items as { sub: string }[]).some((i) => i.sub === SUB)).toBe(true);
    expect((await rt.api(ev('POST', '/api/v1/members', { token: ASSISTANT, body: { email: 'o@example.com', role: 'observer' } }))).statusCode).toBe(403);
    const del = await rt.api(ev('DELETE', `/api/v1/members/${SUB}`, { token: LEARNER }));
    expect(del.statusCode, del.body).toBe(204);
    expect(cip.commandCalls(AdminDeleteUserCommand)).toHaveLength(1);
    expect(body(await rt.api(ev('GET', '/api/v1/members', { token: LEARNER }))).items).toEqual([]);
  });
});

describe('dev member directory', () => {
  it('returns dev subs usable with dev tokens', async () => {
    const d = createDevMemberDirectory(() => 'dev-1');
    expect(await d.invite({ email: 'a@example.com', role: 'observer' })).toEqual({ sub: 'dev-1' });
    await d.remove('dev-1');
    expect(d.invited).toHaveLength(1);
    expect(d.removed).toEqual(['dev-1']);
  });
});
