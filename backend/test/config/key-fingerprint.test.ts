// CFG-007 指纹：比对 / 首次记录；--regenerate-secrets 的恢复路径 resetKeyFingerprint（清空无法解密的字段 + 记录新指纹）
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import knexFactory from 'knex';
import type { Knex } from 'knex';
import { checkKeyFingerprint, keyFingerprint, resetKeyFingerprint } from '../../src/config/key-fingerprint.js';
import { migrateLatest } from '../../src/db/knex.js';
import { MIGRATION_SOURCE } from '../../src/db/migrations/index.js';
import { ConfigValidationError } from '../../src/errors.js';
import type { SecretsPort } from '../../src/ports/secrets.js';
import { insertPhoto } from '../../src/repositories/photos.js';
import { createUserWithDefaults } from '../../src/services/user-directory.js';

let db: Knex;

beforeAll(async () => {
  db = knexFactory({ client: 'better-sqlite3', connection: { filename: ':memory:' }, useNullAsDefault: true,
    migrations: { migrationSource: MIGRATION_SOURCE }, pool: { min: 1, max: 1 } });
  await migrateLatest(db);
});

afterAll(async () => {
  await db?.destroy();
});

const secretsWith = (key: string) => ({ get: async () => key }) as unknown as SecretsPort;

describe('resetKeyFingerprint（cli keys:reset-fingerprint --confirm-data-loss）', () => {
  it('新主密钥：清空 MFA 密钥（关闭 MFA）与照片位置、作废 MFA 挑战，记录新指纹；之后 CFG-007 比对通过；再次执行为 match', async () => {
    expect(await checkKeyFingerprint(db, secretsWith('old-key'))).toMatchObject({ status: 'recorded' });
    const u = await createUserWithDefaults(db, { email: 'mfa@example.com', displayName: 'm', passwordHash: 'x' });
    await db('users').where({ id: u.id }).update({ mfa_secret_enc: 'ca1.local.a.b.c.d', mfa_enabled: true });
    await insertPhoto(db, { id: '11111111-2222-4333-8444-555555555555', ownerId: u.id, albumId: null, rawKey: `raw/${u.id}/x.jpg`,
      filename: 'x.jpg', contentType: 'image/jpeg', sizeBytes: null, visibility: 'private', title: null, caption: null });
    await db('photos').update({ location_enc: 'ca1.local.a.b.c.d' });
    await db('auth_tokens').insert({ id: 't1', user_id: u.id, type: 'mfa_challenge', token_hash: 'h', expires_at: '2099-01-01T00:00:00.000Z',
      created_at: '2026-01-01T00:00:00.000Z' });

    await expect(checkKeyFingerprint(db, secretsWith('new-key'))).rejects.toBeInstanceOf(ConfigValidationError);
    const r = await resetKeyFingerprint(db, 'new-key');
    expect(r).toMatchObject({ status: 'reset', fingerprint: keyFingerprint('new-key'), previous: keyFingerprint('old-key'),
      cleared: { mfaUsers: 1, photoLocations: 1, mfaChallenges: 1 } });
    expect(await db('users').where({ id: u.id }).first()).toMatchObject({ mfa_secret_enc: null });
    expect(Boolean((await db('users').where({ id: u.id }).first()).mfa_enabled)).toBe(false);
    expect(await checkKeyFingerprint(db, secretsWith('new-key'))).toMatchObject({ status: 'match' });
    expect(await resetKeyFingerprint(db, 'new-key')).toMatchObject({ status: 'match', cleared: { mfaUsers: 0 } });
  });
});
