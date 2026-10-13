import sharp from 'sharp';
import { describe, expect, it } from 'vitest';
import {
  exifDateToIso, extensionFor, isPermanentImageError, makeTestImage, PermanentImageError, readExif, render, selfTest,
  sniffImageType, variantKey,
} from '../src/index.js';

describe('sniffImageType', () => {
  it('按魔数识别 JPEG / PNG / WebP', async () => {
    expect(sniffImageType(await makeTestImage({ format: 'jpeg' }))).toBe('image/jpeg');
    expect(sniffImageType(await makeTestImage({ format: 'png' }))).toBe('image/png');
    expect(sniffImageType(await makeTestImage({ format: 'webp' }))).toBe('image/webp');
  });

  it('拒绝 HEIC、GIF、文本与过短的输入', () => {
    const heic = Buffer.from([0, 0, 0, 0x18, 0x66, 0x74, 0x79, 0x70, 0x68, 0x65, 0x69, 0x63]);
    expect(sniffImageType(heic)).toBeNull();
    expect(sniffImageType(Buffer.from('GIF89a......'))).toBeNull();
    expect(sniffImageType(Buffer.from('hello world'))).toBeNull();
    expect(sniffImageType(new Uint8Array([0xff]))).toBeNull();
  });

  it('扩展名映射', () => {
    expect(extensionFor('image/jpeg')).toBe('jpg');
    expect(extensionFor('image/png')).toBe('png');
    expect(extensionFor('image/webp')).toBe('webp');
  });
});

describe('render', () => {
  it('生成 thumb_200 与 display_1080（WebP，长边不超过目标，不放大）', async () => {
    const input = await makeTestImage({ width: 1600, height: 1200, color: '#1e5ac8' });
    const out = await render(input, { photoId: 'p1' });
    expect(out.sourceType).toBe('image/jpeg');
    expect(out.variants.map((v) => v.name)).toEqual(['thumb_200', 'display_1080']);
    const [thumb, display] = out.variants;
    expect(thumb).toMatchObject({ key: variantKey('p1', 'thumb_200'), width: 200, height: 150, contentType: 'image/webp' });
    expect(display).toMatchObject({ key: 'variants/p1/display_1080.webp', width: 1080, height: 810 });
    expect((await sharp(thumb!.body).metadata()).format).toBe('webp');
    expect(thumb!.bytes).toBe(thumb!.body.length);
    expect(out.meta).toMatchObject({ width: 1600, height: 1200, format: 'jpeg' });
    expect(out.meta.dominantColor).toMatch(/^#[0-9a-f]{6}$/);
    // 主色接近输入色
    const r = parseInt(out.meta.dominantColor.slice(1, 3), 16);
    const b = parseInt(out.meta.dominantColor.slice(5, 7), 16);
    expect(b).toBeGreaterThan(r);
    expect(out.durationMs).toBeGreaterThanOrEqual(0);
  });

  it('小图不放大；sizes 只生成指定尺寸', async () => {
    const input = await makeTestImage({ width: 100, height: 60, format: 'png' });
    const out = await render(input, { photoId: 'p2', sizes: ['thumb_200'] });
    expect(out.variants).toHaveLength(1);
    expect(out.variants[0]).toMatchObject({ width: 100, height: 60 });
    expect(out.meta.format).toBe('png');
  });

  it('按 EXIF 方向旋转：宽高按旋转后的方向报告', async () => {
    const input = await makeTestImage({ width: 300, height: 200, orientation: 6 });
    const out = await render(input, { photoId: 'p3' });
    expect(out.meta).toMatchObject({ width: 200, height: 300 });
    expect(out.variants[0]).toMatchObject({ width: 133, height: 200 });
  });

  it('读取 EXIF：拍摄时间（带时区换算为 UTC）、相机、GPS；衍生图不含 EXIF', async () => {
    const input = await makeTestImage({
      width: 400, height: 300,
      exif: { make: 'Canon', model: 'EOS R5', takenAt: '2024:07:15 10:20:30', offset: '+09:00', gps: { lat: 35.6895, lon: 139.6917 } },
    });
    const out = await render(input, { photoId: 'p4' });
    expect(out.meta.takenAt).toBe('2024-07-15T01:20:30.000Z');
    expect(out.meta.camera).toBe('Canon');
    expect(out.exif.location?.lat).toBeCloseTo(35.6895, 3);
    expect(out.exif.location?.lon).toBeCloseTo(139.6917, 3);
    expect((out.meta as Record<string, unknown>).location).toBeUndefined();
    const md = await sharp(out.variants[1]!.body).metadata();
    expect(md.exif).toBeUndefined();
  });

  it('不支持的格式、损坏文件、超过像素上限都抛出 PermanentImageError', async () => {
    await expect(render(Buffer.from('not an image at all'), { photoId: 'x' })).rejects.toBeInstanceOf(PermanentImageError);
    const jpeg = await makeTestImage({ width: 400, height: 400 });
    const truncated = jpeg.subarray(0, 200);
    const e1 = await render(truncated, { photoId: 'x' }).catch((e: unknown) => e);
    expect(isPermanentImageError(e1)).toBe(true);
    const e2 = await render(jpeg, { photoId: 'x', maxPixels: 1000 }).catch((e: unknown) => e);
    expect(isPermanentImageError(e2)).toBe(true);
    expect((e2 as Error).message).toContain('超过上限');
  });

  it('selfTest 在内存中渲染探针图', async () => {
    const r = await selfTest();
    expect(r.variants).toBe(2);
  });
});

describe('EXIF 辅助', () => {
  it('exifDateToIso：无时区按 UTC；非法值返回 undefined', () => {
    expect(exifDateToIso('2023:01:02 03:04:05')).toBe('2023-01-02T03:04:05.000Z');
    expect(exifDateToIso('2023:01:02 03:04:05', '-05:00')).toBe('2023-01-02T08:04:05.000Z');
    expect(exifDateToIso('0000:00:00 00:00:00')).toBeUndefined();
    expect(exifDateToIso('garbage')).toBeUndefined();
    expect(exifDateToIso(42)).toBeUndefined();
  });

  it('readExif：没有 EXIF 时返回空对象', async () => {
    expect(await readExif(await makeTestImage({ format: 'png' }))).toEqual({});
    expect(await readExif(Buffer.from('nope'))).toEqual({});
  });
});
