// 种子 gps-sample-photos（06 PM-45）：经应用的照片导入流程（L0：local 存储 + inline 缩略图），幂等，EXIF 位置可被应用读出
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildContainer, type Container } from '../../src/container.js';
import { seedGpsPhotos } from '../../src/lab/seeds/gps-sample-photos.js';
import { decryptPhotoLocation } from '../../src/services/photo-pipeline.js';
import { getPhoto } from '../../src/repositories/photos.js';
import { l0EnvDir } from '../helpers/identity-harness.js';
import { seedUser } from '../helpers/media-fixtures.js';

let c: Container;

beforeAll(async () => {
  const { envDir } = l0EnvDir({ base: { STORAGE_LOCAL_MIN_FREE_PCT: '1' } });
  c = await buildContainer('cli', { envDir, processEnv: { NODE_ENV: 'test' }, autoMigrate: true });
});

afterAll(async () => {
  await c?.close();
});

describe('seed gps-sample-photos', () => {
  it('没有 atl-test-1 时归属管理员；3 张照片 READY 且带加密位置；重复执行不重复导入', async () => {
    await expect(seedGpsPhotos(c)).rejects.toMatchObject({ exitCode: 4 });
    const adminId = await seedUser(c.db, { role: 'admin', email: 'atl-admin@example.com' });
    const r = await seedGpsPhotos(c);
    expect(r).toMatchObject({ seed: 'gps-sample-photos', owner: 'atl-admin@example.com', imported: 3, skipped: 0 });
    expect(r.photos.map((p) => p.status)).toEqual(['READY', 'READY', 'READY']);
    const first = await getPhoto(c.db, r.photos[0]!.id);
    expect(first?.ownerId).toBe(adminId);
    const loc = await decryptPhotoLocation(c, first!);
    expect(loc?.lat).toBeCloseTo(35.6812, 3);
    expect(loc?.lon).toBeCloseTo(139.7671, 3);
    const again = await seedGpsPhotos(c);
    expect(again).toMatchObject({ imported: 0, skipped: 3, albumId: r.albumId });
    expect((await c.db('photos').where({ seed_id: 'gps-sample-photos' })).length).toBe(3);
  });

  it('atl-test-1 存在时照片归属它（cognito-test-users 之后执行）', async () => {
    const id = await seedUser(c.db, { email: 'atl-test-1@example.com', name: 'atl-test-1' });
    await c.db('users').where({ id }).update({ seed_id: 'cognito-test-users' });
    const r = await seedGpsPhotos(c, { album: 'other album' });
    // 同一摘要已经导入过（按 seed_id + 摘要幂等）：不重复导入，也不改归属
    expect(r).toMatchObject({ owner: 'atl-test-1@example.com', imported: 0, skipped: 3 });
  });
});
