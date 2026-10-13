// storage=s3：端口契约（内存 S3）+ 驱动细节（预签名、桶路由、URL 复用、CopyObject、分片、探针、503 语义）
import { CopyObjectCommand, DeleteObjectsCommand, HeadBucketCommand, PutObjectCommand } from '@aws-sdk/client-s3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { S3Storage } from '../../../src/adapters/storage/s3.js';
import { HttpError } from '../../../src/errors.js';
import { createRequestContext, runWithContext } from '../../../src/observability/request-context.js';
import { ENABLE } from '../../helpers/config.js';
import { describeStoragePortContract } from './contracts/storage.contract.js';
import { FakeS3 } from './fake-s3.js';
import { awsError, makeDeps } from './helpers.js';

const RAW = 'cloudalbum-lab-raw';
const MEDIA = 'cloudalbum-lab-media';
const env = { ...ENABLE.iamRole, ...ENABLE.s3 };

let fake: FakeS3;
beforeEach(() => {
  fake = new FakeS3([RAW, MEDIA, 'cloudalbum-lab-staging']);
});
afterEach(() => fake.restore());

const newStorage = (extra: Record<string, string> = {}) => new S3Storage(makeDeps({ ...env, ...extra }));

describeStoragePortContract('s3（内存 S3，aws-sdk-client-mock）', {
  async create() {
    for (const b of fake.buckets.values()) b.clear();
    return newStorage();
  },
  async createPeer() {
    // 迁移目标：同一个内存 S3 中的另一对桶
    fake.buckets.set('peer-raw', new Map());
    fake.buckets.set('peer-media', new Map());
    return newStorage({ STORAGE_S3_RAW_BUCKET: 'peer-raw', STORAGE_S3_MEDIA_BUCKET: 'peer-media' });
  },
});

describe('S3Storage 驱动细节', () => {
  it('按前缀选桶：variants/、reports/ 在展示桶，其余在原图桶', async () => {
    const s = newStorage();
    await s.putObject('raw/u1/p.jpg', Buffer.from('r'), { contentType: 'image/jpeg' });
    await s.putObject('variants/p/thumb_200.webp', Buffer.from('v'), { contentType: 'image/webp' });
    await s.putObject('reports/daily/x.csv', Buffer.from('c'), { contentType: 'text/csv' });
    expect([...fake.buckets.get(RAW)!.keys()]).toEqual(['raw/u1/p.jpg']);
    expect([...fake.buckets.get(MEDIA)!.keys()].sort()).toEqual(['reports/daily/x.csv', 'variants/p/thumb_200.webp']);
    // 衍生图默认长期缓存（键里有 photoId，内容不会变）
    expect(fake.buckets.get(MEDIA)!.get('variants/p/thumb_200.webp')!.cacheControl).toBe('public, max-age=31536000, immutable');
  });

  it('预签名 PUT：Content-Type 与 x-amz-meta-* 纳入签名并留在请求头；路径头 storage=s3:presign', async () => {
    const s = newStorage();
    const ctx = createRequestContext();
    const t = await runWithContext(ctx, () => s.createUploadTarget({
      key: 'raw/u1/p1.jpg', contentType: 'image/jpeg', maxBytes: 1024, expiresInSec: 300, metadata: { uploader: 'u1' },
    }));
    const url = new URL(t.url);
    expect(url.hostname).toContain(RAW);
    expect(url.searchParams.get('X-Amz-Expires')).toBe('300');
    const signed = url.searchParams.get('X-Amz-SignedHeaders') ?? '';
    expect(signed).toContain('content-type');
    expect(signed).toContain('x-amz-meta-uploader');
    expect(url.searchParams.has('x-amz-meta-uploader')).toBe(false);
    expect(t.headers).toEqual({ 'Content-Type': 'image/jpeg', 'x-amz-meta-uploader': 'u1' });
    expect(ctx.path.get('storage')).toBe('s3:presign');
  });

  it('预签名 GET 在 STORAGE_S3_URL_REUSE_SEC 内复用同一个 URL，复用期为 0 时每次重签', async () => {
    const s = newStorage();
    const a = await s.createReadUrl('variants/p/thumb_200.webp', { visibility: 'public', expiresInSec: 600 });
    const b = await s.createReadUrl('variants/p/thumb_200.webp', { visibility: 'public', expiresInSec: 600 });
    expect(b).toBe(a);
    expect(new URL(a).hostname).toContain(MEDIA);
    const noReuse = newStorage({ STORAGE_S3_URL_REUSE_SEC: '0' });
    const c = await noReuse.createReadUrl('raw/u1/p.jpg', { visibility: 'private', expiresInSec: 600 });
    await new Promise((r) => setTimeout(r, 1100));
    const d = await noReuse.createReadUrl('raw/u1/p.jpg', { visibility: 'private', expiresInSec: 600 });
    expect(d).not.toBe(c);
  });

  it('internalRedirectPath 返回 null（/media 改为 302）', () => {
    expect(newStorage().internalRedirectPath('variants/p/thumb_200.webp', 'public')).toBeNull();
  });

  it('importObject：CopyObject 暂存桶 → 原图键（键做 URL 编码），路径头 storage=s3:import', async () => {
    const s = newStorage();
    fake.buckets.get('cloudalbum-lab-staging')!.set('private/ap-northeast-1:abc/p 1.jpg', {
      body: Buffer.from('staged'), metadata: {}, lastModified: new Date(), etag: '"e"', contentType: 'image/jpeg',
    });
    const ctx = createRequestContext();
    const info = await runWithContext(ctx, () => s.importObject({ bucket: 'cloudalbum-lab-staging', key: 'private/ap-northeast-1:abc/p 1.jpg' }, 'raw/u1/p1.jpg'));
    expect(info.size).toBe(6);
    expect(ctx.path.get('storage')).toBe('s3:import');
    const call = fake.mock.commandCalls(CopyObjectCommand)[0]!;
    expect((call.args[0].input as { CopySource: string }).CopySource).toBe('cloudalbum-lab-staging/private/ap-northeast-1%3Aabc/p%201.jpg');
    await expect(s.importObject({ bucket: 'cloudalbum-lab-staging', key: 'missing.jpg' }, 'raw/u1/x.jpg')).rejects.toMatchObject({ status: 404 });
  });

  it('分片辅助：Create → 预签名 UploadPart → ListParts → Complete；Abort 幂等', async () => {
    const s = newStorage();
    const { uploadId } = await s.createMultipartUpload('raw/u1/big.jpg', { contentType: 'image/jpeg' });
    const part = await s.presignUploadPart('raw/u1/big.jpg', uploadId, 1, 300);
    expect(new URL(part.url).searchParams.get('partNumber')).toBe('1');
    fake.putPart(uploadId, 1, Buffer.from('aaa'));
    fake.putPart(uploadId, 2, Buffer.from('bb'));
    const parts = await s.listParts('raw/u1/big.jpg', uploadId);
    expect(parts.map((p) => p.partNumber)).toEqual([1, 2]);
    const info = await s.completeMultipartUpload('raw/u1/big.jpg', uploadId, parts);
    expect(info.size).toBe(5);
    await expect(s.abortMultipartUpload('raw/u1/big.jpg', uploadId)).resolves.toBeUndefined();
    await expect(s.presignUploadPart('raw/u1/big.jpg', uploadId, 0, 300)).rejects.toMatchObject({ status: 400 });
  });

  it('S3 故障映射为 503（权威端口不回退）；403 的 HeadObject 不当作“不存在”', async () => {
    const s = newStorage();
    fake.mock.on(PutObjectCommand).rejects(awsError('ServiceUnavailable', 503));
    await expect(s.putObject('raw/u1/x.jpg', Buffer.from('x'), { contentType: 'image/jpeg' })).rejects.toBeInstanceOf(HttpError);
    await expect(s.putObject('raw/u1/x.jpg', Buffer.from('x'), { contentType: 'image/jpeg' })).rejects.toMatchObject({ status: 503, code: 'STORAGE_UNAVAILABLE' });
    const { HeadObjectCommand } = await import('@aws-sdk/client-s3');
    fake.mock.on(HeadObjectCommand).rejects(awsError('Forbidden', 403));
    await expect(s.headObject('raw/u1/none.jpg')).rejects.toMatchObject({ status: 503 });
  });

  it('deleteObjects 每批最多 1000 个键', async () => {
    const s = newStorage();
    const keys = Array.from({ length: 1001 }, (_, i) => `raw/u1/k${i}.jpg`);
    await s.deleteObjects(keys);
    expect(fake.mock.commandCalls(DeleteObjectsCommand)).toHaveLength(2);
  });

  describe('探针', () => {
    it('HeadBucket ×2 成功 → ok', async () => {
      const r = await newStorage().probe();
      expect(r.status).toBe('ok');
      expect(r.detail).toContain('HeadBucket 200 ×2');
      expect(fake.mock.commandCalls(HeadBucketCommand)).toHaveLength(2);
    });

    it('桶不存在 / 无权限 → error 并说明原因', async () => {
      fake.buckets.delete(MEDIA);
      const r = await newStorage().probe();
      expect(r.status).toBe('error');
      expect(r.detail).toContain('桶不存在');
      fake.mock.on(HeadBucketCommand).rejects(awsError('Forbidden', 403));
      const r2 = await newStorage().probe();
      expect(r2.detail).toContain('无权限');
    });

    it('深度探针：写-读-删 + 默认加密与 KMS_KEY_ID 比对', async () => {
      const ok = await newStorage().probe({ deep: true });
      expect(ok.status).toBe('ok');
      expect(ok.detail).toContain('写-读-删 1 KB 通过');
      expect([...fake.buckets.get(RAW)!.keys()].filter((k) => k.startsWith('_probe/'))).toEqual([]);
      const mismatch = await newStorage({ KMS_KEY_ID: 'alias/cloudalbum' }).probe({ deep: true });
      expect(mismatch.status).toBe('degraded');
      expect(mismatch.detail).toContain('不一致');
    });
  });
});
