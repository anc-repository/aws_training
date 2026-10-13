/**
 * @cloudalbum/image-core —— sharp 渲染核心（04#image-processing 第 1 节）
 *
 * inline / worker（EC2）、Lambda（lambdas/image-thumbnail）与 workflow 的缩略图任务都调用同一个 render()，
 * 保证对比只体现“在哪里算”，不体现“算法不同”：
 *   - sharp(input, { limitInputPixels: IMAGE_MAX_PIXELS })：防解压炸弹；
 *   - .rotate()：按 EXIF 方向自动旋转；输出不保留元数据（衍生图里没有 GPS）；
 *   - 生成 thumb_200（长边 200px）与 display_1080（长边 1080px），都输出 WebP；
 *   - 读出 ImageMeta：宽高、格式、主色（sharp.stats().dominant）、拍摄时间（exifr 解析 DateTimeOriginal）；
 *   - 格式白名单 JPEG / PNG / WebP：先检查文件头魔数，不只看扩展名；HEIC 直接拒绝。
 *
 * 本包不得依赖 backend（Lambda 也要用它）。
 */
import { performance } from 'node:perf_hooks';
import exifr from 'exifr';
import sharp from 'sharp';

export const VARIANTS = [
  { name: 'thumb_200', longEdge: 200 },
  { name: 'display_1080', longEdge: 1080 },
] as const;

export type VariantName = (typeof VARIANTS)[number]['name'];

export const ACCEPTED_TYPES = ['image/jpeg', 'image/png', 'image/webp'] as const;
export type AcceptedType = (typeof ACCEPTED_TYPES)[number];

/** 默认像素上限（与 IMAGE_MAX_PIXELS 的 zod 默认值一致） */
export const DEFAULT_MAX_PIXELS = 40_000_000;
/** WebP 输出质量（两种尺寸相同） */
export const WEBP_QUALITY = 82;
/** 衍生图的 Cache-Control（键里有 photoId，内容不会变） */
export const VARIANT_CACHE_CONTROL = 'public, max-age=31536000, immutable';

export interface ImageMeta {
  width: number;
  height: number;
  format: string;
  dominantColor: string;
  takenAt?: string;
  /** EXIF 的相机品牌（Make），tagging 的 none 驱动据此生成 camera:<品牌> 标签 */
  camera?: string;
}

/** EXIF 中读出的信息。location（GPS）只交给调用方加密存储，不进入 ImageMeta，也不写进衍生图 */
export interface ExifInfo {
  takenAt?: string;
  camera?: string;
  model?: string;
  location?: { lat: number; lon: number };
}

export interface RenderedVariant {
  name: VariantName;
  /** 逻辑键 variants/<photoId>/<name>.webp */
  key: string;
  width: number;
  height: number;
  bytes: number;
  contentType: 'image/webp';
  body: Buffer;
}

export interface RenderOptions {
  photoId: string;
  /** sharp limitInputPixels（默认 40,000,000） */
  maxPixels?: number;
  /** 只生成这些尺寸（IMAGE_SIZES）；默认全部 */
  sizes?: readonly VariantName[];
}

export interface RenderOutput {
  meta: ImageMeta;
  variants: RenderedVariant[];
  durationMs: number;
  /** 源图格式（魔数识别的结果） */
  sourceType: AcceptedType;
  exif: ExifInfo;
}

/** 永久错误（格式不支持、超过像素上限、文件损坏）：不重试，直接写 FAILED */
export class PermanentImageError extends Error {
  readonly permanent = true;
  constructor(message: string) {
    super(message);
    this.name = 'PermanentImageError';
  }
}

export function isPermanentImageError(e: unknown): e is PermanentImageError {
  return e instanceof PermanentImageError || (typeof e === 'object' && e !== null && (e as { permanent?: unknown }).permanent === true);
}

export function variantKey(photoId: string, name: VariantName): string {
  return `variants/${photoId}/${name}.webp`;
}

/** 保留给旧调用方的错误类型（脚手架阶段的桩使用过） */
export class ImageCoreNotImplementedError extends Error {
  readonly code = 'NOT_IMPLEMENTED';
  constructor(fn: string) {
    super(`@cloudalbum/image-core ${fn}() 尚未实现`);
    this.name = 'ImageCoreNotImplementedError';
  }
}

const startsWith = (head: Uint8Array, bytes: readonly number[], offset = 0): boolean =>
  head.length >= offset + bytes.length && bytes.every((b, i) => head[offset + i] === b);

/** 按文件头魔数识别格式；不在白名单内（含 HEIC、GIF）返回 null。至少需要前 12 个字节 */
export function sniffImageType(head: Uint8Array): AcceptedType | null {
  if (startsWith(head, [0xff, 0xd8, 0xff])) return 'image/jpeg';
  if (startsWith(head, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return 'image/png';
  // RIFF....WEBP
  if (startsWith(head, [0x52, 0x49, 0x46, 0x46]) && startsWith(head, [0x57, 0x45, 0x42, 0x50], 8)) return 'image/webp';
  return null;
}

export function isAcceptedType(ct: string): ct is AcceptedType {
  return (ACCEPTED_TYPES as readonly string[]).includes(ct.toLowerCase());
}

/** 原图键的扩展名 */
export function extensionFor(type: AcceptedType): 'jpg' | 'png' | 'webp' {
  return type === 'image/jpeg' ? 'jpg' : type === 'image/png' ? 'png' : 'webp';
}

/** sharp 的线程池大小（libvips 全局设置）；EC2 上 inline / worker 每个任务用 1 个线程（04#image-processing） */
export function setRenderConcurrency(threads: number): void {
  sharp.concurrency(Math.max(1, Math.floor(threads)));
}

function toHex(n: number): string {
  return Math.max(0, Math.min(255, Math.round(n))).toString(16).padStart(2, '0');
}

/** EXIF 时间 "YYYY:MM:DD HH:MM:SS"（可带 OffsetTimeOriginal）→ ISO 8601 UTC。没有时区时按 UTC 解释（见 implementation-notes） */
export function exifDateToIso(raw: unknown, offset?: unknown): string | undefined {
  if (raw instanceof Date) return Number.isNaN(raw.getTime()) ? undefined : raw.toISOString();
  if (typeof raw !== 'string') return undefined;
  const m = /^(\d{4})[:-](\d{2})[:-](\d{2})[ T](\d{2}):(\d{2}):(\d{2})/.exec(raw.trim());
  if (!m) return undefined;
  const [, y, mo, d, h, mi, s] = m;
  if (y === '0000') return undefined;
  const off = typeof offset === 'string' && /^[+-]\d{2}:\d{2}$/.test(offset.trim()) ? offset.trim() : 'Z';
  const date = new Date(`${y}-${mo}-${d}T${h}:${mi}:${s}${off}`);
  return Number.isNaN(date.getTime()) ? undefined : date.toISOString();
}

/** 解析 EXIF（拍摄时间、相机、GPS）。没有 EXIF 或解析失败时返回空对象（EXIF 不是必需的） */
export async function readExif(input: Buffer): Promise<ExifInfo> {
  try {
    const tags = (await exifr.parse(input, {
      reviveValues: false,
      gps: true,
      pick: ['Make', 'Model', 'DateTimeOriginal', 'CreateDate', 'OffsetTimeOriginal', 'OffsetTime',
        'GPSLatitude', 'GPSLatitudeRef', 'GPSLongitude', 'GPSLongitudeRef', 'latitude', 'longitude'],
    })) as Record<string, unknown> | undefined;
    if (!tags) return {};
    const out: ExifInfo = {};
    const takenAt = exifDateToIso(tags.DateTimeOriginal ?? tags.CreateDate, tags.OffsetTimeOriginal ?? tags.OffsetTime);
    if (takenAt) out.takenAt = takenAt;
    if (typeof tags.Make === 'string' && tags.Make.trim()) out.camera = tags.Make.trim().replace(/\0/g, '');
    if (typeof tags.Model === 'string' && tags.Model.trim()) out.model = tags.Model.trim().replace(/\0/g, '');
    const lat = Number(tags.latitude);
    const lon = Number(tags.longitude);
    if (Number.isFinite(lat) && Number.isFinite(lon) && Math.abs(lat) <= 90 && Math.abs(lon) <= 180 && !(lat === 0 && lon === 0)) {
      out.location = { lat: Math.round(lat * 1e6) / 1e6, lon: Math.round(lon * 1e6) / 1e6 };
    }
    return out;
  } catch {
    return {};
  }
}

/** 渲染两种尺寸的 WebP 衍生图并读出元数据。输入不合格时抛出 PermanentImageError */
export async function render(input: Buffer, opts: RenderOptions): Promise<RenderOutput> {
  const t0 = performance.now();
  const maxPixels = opts.maxPixels ?? DEFAULT_MAX_PIXELS;
  const sourceType = sniffImageType(input.subarray(0, 16));
  if (!sourceType) throw new PermanentImageError('不支持的图片格式（只接受 JPEG / PNG / WebP，按文件头识别）');

  let width: number;
  let height: number;
  let format: string;
  try {
    const md = await sharp(input, { limitInputPixels: false }).metadata();   // 只读文件头；像素上限在下一行自行比较
    if (!md.width || !md.height) throw new Error('无法读取图片尺寸');
    if (md.width * md.height > maxPixels) throw new PermanentImageError(`图片像素数 ${md.width}×${md.height} 超过上限 ${maxPixels}`);
    width = md.autoOrient?.width ?? md.width;
    height = md.autoOrient?.height ?? md.height;
    format = md.format ?? sourceType.split('/')[1]!;
  } catch (e) {
    if (isPermanentImageError(e)) throw e;
    throw new PermanentImageError(`图片无法解码：${(e as Error).message}`);
  }

  const sizes = opts.sizes?.length ? VARIANTS.filter((v) => opts.sizes!.includes(v.name)) : VARIANTS;
  const base = sharp(input, { limitInputPixels: maxPixels }).rotate();
  const variants: RenderedVariant[] = [];
  try {
    for (const v of sizes) {
      const { data, info } = await base.clone()
        .resize({ width: v.longEdge, height: v.longEdge, fit: 'inside', withoutEnlargement: true })
        .webp({ quality: WEBP_QUALITY })
        .toBuffer({ resolveWithObject: true });
      variants.push({
        name: v.name, key: variantKey(opts.photoId, v.name), width: info.width, height: info.height,
        bytes: data.length, contentType: 'image/webp', body: data,
      });
    }
  } catch (e) {
    throw new PermanentImageError(`图片无法解码：${(e as Error).message}`);
  }

  // 主色：在最小的衍生图上统计（与原图统计结果接近，开销小得多）
  let dominantColor = '#808080';
  const smallest = variants[0];
  if (smallest) {
    try {
      const { dominant } = await sharp(smallest.body).stats();
      dominantColor = `#${toHex(dominant.r)}${toHex(dominant.g)}${toHex(dominant.b)}`;
    } catch {
      /* 主色不是必需的 */
    }
  }

  const exif = await readExif(input);
  const meta: ImageMeta = {
    width, height, format: format === 'jpg' ? 'jpeg' : format, dominantColor,
    ...(exif.takenAt ? { takenAt: exif.takenAt } : {}),
    ...(exif.camera ? { camera: exif.camera } : {}),
  };
  return { meta, variants, durationMs: Math.round((performance.now() - t0) * 10) / 10, sourceType, exif };
}

/** 生成测试 / 探针用的图片（内存中，纯色，可带 EXIF）。探针用 128×128 的 JPEG */
export async function makeTestImage(opts: {
  width?: number; height?: number; format?: 'jpeg' | 'png' | 'webp'; color?: string;
  exif?: { make?: string; model?: string; takenAt?: string; offset?: string; gps?: { lat: number; lon: number } };
  orientation?: number;
} = {}): Promise<Buffer> {
  const img = sharp({ create: { width: opts.width ?? 128, height: opts.height ?? 128, channels: 3, background: opts.color ?? '#3366cc' } });
  let pipeline = opts.format === 'png' ? img.png() : opts.format === 'webp' ? img.webp() : img.jpeg({ quality: 90 });
  if (opts.exif && (opts.format ?? 'jpeg') === 'jpeg') {
    const toDms = (v: number) => {
      const a = Math.abs(v);
      const d = Math.floor(a);
      const m = Math.floor((a - d) * 60);
      const s = Math.round(((a - d) * 60 - m) * 60 * 100);
      return `${d}/1 ${m}/1 ${s}/100`;
    };
    const e = opts.exif;
    pipeline = pipeline.withExif({
      IFD0: { ...(e.make ? { Make: e.make } : {}), ...(e.model ? { Model: e.model } : {}) },
      IFD2: { ...(e.takenAt ? { DateTimeOriginal: e.takenAt } : {}), ...(e.offset ? { OffsetTimeOriginal: e.offset } : {}) },
      ...(e.gps ? {
        IFD3: {
          GPSLatitudeRef: e.gps.lat >= 0 ? 'N' : 'S', GPSLatitude: toDms(e.gps.lat),
          GPSLongitudeRef: e.gps.lon >= 0 ? 'E' : 'W', GPSLongitude: toDms(e.gps.lon),
        },
      } : {}),
    });
  }
  if (opts.orientation) pipeline = pipeline.withMetadata({ orientation: opts.orientation });
  return pipeline.toBuffer();
}

/** 探针：在内存中渲染一张 128×128 JPEG（不落盘），返回耗时；sharp 无法加载时抛出 */
export async function selfTest(): Promise<{ durationMs: number; variants: number }> {
  const input = await makeTestImage({ width: 128, height: 128 });
  const out = await render(input, { photoId: '_probe' });
  return { durationMs: out.durationMs, variants: out.variants.length };
}
