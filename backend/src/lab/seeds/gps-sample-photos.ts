// backend/src/lab/seeds/gps-sample-photos.ts —— 种子 gps-sample-photos（06 PM-45）
//
// 资产：3 张合成的 JPEG（sharp 按固定算法生成的渐变图案，不使用第三方照片），EXIF 写入公开地标的近似 GPS 坐标与拍摄时间。
// 偏离：06 写的是“构建脚本生成、放进发布包 seed/photos/ 并带 manifest.json”；这里在实验机上按同一个确定性算法现场生成
// （sharp 是应用依赖，同一版本输出逐字节相同），输出里带每个文件的 SHA-256，效果等价且发布包更小。
// 导入：经应用的照片导入流程（与上传完成 complete 相同：StoragePort 写入、缩略图、EXIF 解析、需要时经 CryptoPort 加密位置字段），
// 所以 local 与 s3 存储、inline / worker / lambda 缩略图下都可用；photos.seed_id='gps-sample-photos'，seed_digest = 文件摘要。
// 幂等：seed_id + 文件摘要已存在则跳过。照片归属 atl-test-1（不存在时归属最早创建的管理员）。
import { createHash } from 'node:crypto';
import type { Container } from '../../container.js';
import { insertAlbum } from '../../repositories/albums.js';
import { getPhoto } from '../../repositories/photos.js';
import { completeUpload, createUpload, type Who } from '../../services/photo-pipeline.js';
import { notFound } from '../../cli/platform/common.js';

export const GPS_SEED = 'gps-sample-photos';
export const GPS_SEED_ALBUM = 'ATL 示例（含 GPS）';

export interface GpsSample { file: string; title: string; lat: number; lon: number; takenAt: string; hue: [number, number, number] }

/** 公开地标的近似坐标（东京站、东京塔、大阪城） */
export const GPS_SAMPLES: readonly GpsSample[] = [
  { file: 'gps-1.jpg', title: '东京站（示例）', lat: 35.6812, lon: 139.7671, takenAt: '2026:09:01 09:00:00', hue: [200, 80, 60] },
  { file: 'gps-2.jpg', title: '东京塔（示例）', lat: 35.6586, lon: 139.7454, takenAt: '2026:09:02 10:30:00', hue: [60, 120, 210] },
  { file: 'gps-3.jpg', title: '大阪城（示例）', lat: 34.6873, lon: 135.5262, takenAt: '2026:09:03 15:45:00', hue: [90, 170, 70] },
];

/** 十进制度 → EXIF 有理数三元组字符串（度/1 分/1 秒×100/100） */
export function toExifDms(deg: number): string {
  const a = Math.abs(deg);
  const d = Math.floor(a);
  const mFloat = (a - d) * 60;
  const m = Math.floor(mFloat);
  const s = Math.round((mFloat - m) * 60 * 100);
  return `${d}/1 ${m}/1 ${s}/100`;
}

/** 确定性生成一张 640×480 的 JPEG（同一 sharp 版本下逐字节相同） */
export async function renderGpsSample(s: GpsSample): Promise<Buffer> {
  const sharp = (await import('sharp')).default;
  const w = 640;
  const h = 480;
  const raw = Buffer.alloc(w * h * 3);
  for (let y = 0; y < h; y += 1) {
    for (let x = 0; x < w; x += 1) {
      const i = (y * w + x) * 3;
      const stripe = ((x >> 5) + (y >> 5)) % 2 === 0 ? 24 : 0;
      raw[i] = (s.hue[0] + (x * 96) / w + stripe) & 0xff;
      raw[i + 1] = (s.hue[1] + (y * 96) / h + stripe) & 0xff;
      raw[i + 2] = (s.hue[2] + ((x + y) * 48) / (w + h)) & 0xff;
    }
  }
  return sharp(raw, { raw: { width: w, height: h, channels: 3 } })
    .jpeg({ quality: 85, mozjpeg: false })
    .withExif({
      IFD0: { Make: 'CloudAlbum', Model: 'ATL Seed', ImageDescription: s.title },
      IFD2: { DateTimeOriginal: s.takenAt },
      IFD3: {
        GPSLatitudeRef: s.lat >= 0 ? 'N' : 'S', GPSLatitude: toExifDms(s.lat),
        GPSLongitudeRef: s.lon >= 0 ? 'E' : 'W', GPSLongitude: toExifDms(s.lon),
      },
    })
    .toBuffer();
}

export function sha256Hex(b: Buffer): string {
  return createHash('sha256').update(b).digest('hex');
}

/** 照片归属：--owner <用户名>（种子用户名或邮箱本地部分）；缺省 atl-test-1，不存在时最早创建的管理员 */
export async function resolveSeedOwner(c: Pick<Container, 'db'>, owner?: string): Promise<{ id: string; email: string; isAdmin: boolean }> {
  const db = c.db;
  const byName = async (name: string) => (await db('users').where({ display_name: name, seed_id: 'cognito-test-users' }).first()
    ?? await db('users').where({ email: `${name}@example.com` }).first()) as { id: string; email: string; role: string } | undefined;
  let u = owner ? await byName(owner) : await byName('atl-test-1');
  if (!u && owner) throw notFound('OWNER_NOT_FOUND', `owner ${owner} does not exist`);
  u ??= (await db('users').where({ role: 'admin' }).orderBy('created_at', 'asc').first()) as { id: string; email: string; role: string } | undefined;
  if (!u) throw notFound('OWNER_NOT_FOUND', 'no seed user (atl-test-1) and no administrator to own the sample photos');
  return { id: u.id, email: u.email, isAdmin: u.role === 'admin' };
}

export interface GpsSeedResult {
  seed: string;
  owner: string;
  albumId: string;
  imported: number;
  skipped: number;
  photos: Array<{ file: string; id: string; sha256: string; status: string; existing: boolean }>;
}

/** 经照片导入流程写入 3 张样例照片（幂等） */
export async function seedGpsPhotos(c: Container, opts: { owner?: string; album?: string; waitMs?: number } = {}): Promise<GpsSeedResult> {
  const owner = await resolveSeedOwner(c, opts.owner);
  const albumTitle = opts.album ?? GPS_SEED_ALBUM;
  let album = (await c.db('albums').where({ owner_id: owner.id, title: albumTitle }).first()) as { id: string } | undefined;
  if (!album) album = await insertAlbum(c.db, { ownerId: owner.id, title: albumTitle, visibility: 'private' });
  const who: Who = { userId: owner.id, isAdmin: owner.isAdmin };
  const result: GpsSeedResult = { seed: GPS_SEED, owner: owner.email, albumId: album.id, imported: 0, skipped: 0, photos: [] };
  for (const s of GPS_SAMPLES) {
    const buf = await renderGpsSample(s);
    const digest = sha256Hex(buf);
    const existing = (await c.db('photos').where({ seed_id: GPS_SEED, seed_digest: digest }).first()) as { id: string; status: string } | undefined;
    if (existing) {
      result.skipped += 1;
      result.photos.push({ file: s.file, id: existing.id, sha256: digest, status: existing.status, existing: true });
      continue;
    }
    const { photo } = await createUpload(c, who, { contentType: 'image/jpeg', filename: s.file, size: buf.length, albumId: album.id, visibility: 'private', title: s.title });
    await c.db('photos').where({ id: photo.id }).update({ seed_id: GPS_SEED, seed_digest: digest });
    await c.storage.putObject(photo.rawKey, buf, { contentType: 'image/jpeg' });
    const done = await completeUpload(c, who, photo.id);
    result.imported += 1;
    result.photos.push({ file: s.file, id: photo.id, sha256: digest, status: done.photo.status, existing: false });
  }
  // worker / lambda 档：后续步骤异步完成，等一会儿再读一次状态（不阻塞太久）
  const deadline = Date.now() + (opts.waitMs ?? 30_000);
  for (;;) {
    let pending = false;
    for (const p of result.photos) {
      if (p.status === 'READY' || p.status === 'FAILED' || p.status === 'BLOCKED') continue;
      const cur = await getPhoto(c.db, p.id);
      if (cur) p.status = cur.status;
      if (p.status !== 'READY' && p.status !== 'FAILED' && p.status !== 'BLOCKED') pending = true;
    }
    if (!pending || Date.now() > deadline) break;
    await new Promise((r) => setTimeout(r, 500));
  }
  return result;
}
