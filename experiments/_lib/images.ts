/**
 * experiments/_lib/images.ts —— 生成测试图片（替代 k6 的 `_lib/k6/common.js`）。
 *
 * - 用 sharp 生成带噪声的 JPEG（噪声让编码与缩略图处理的成本接近真实照片）；sharp 不可用时退回内置的 16×16 JPEG。
 * - `targetBytes`：在 SOI 之后插入若干 COM（注释）段把文件补到指定大小——仍是合法 JPEG，像素数不变，
 *   便于 storage 实验在“上传字节数”与“处理成本”之间独立取值（例如 20 MB 的文件只有 1600×1200 像素）。
 * - `corruptJpeg()`：只有 JPEG 文件头、随后是乱码（image-processing 的“永久错误”实验）。
 */
import { randomBytes } from 'node:crypto';

const FALLBACK_JPEG_B64 =
  '/9j/2wBDAAoHBwgHBgoICAgLCgoLDhgQDg0NDh0VFhEYIx8lJCIfIiEmKzcvJik0KSEiMEExNDk7Pj4+JS5ESUM8SDc9Pjv/2wBDAQoLCw4NDhwQEBw7KCIoOzs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozv/wAARCAAQABADASIAAhEBAxEB/8QAFQABAQAAAAAAAAAAAAAAAAAAAAP/xAAUEAEAAAAAAAAAAAAAAAAAAAAA/8QAFAEBAAAAAAAAAAAAAAAAAAAABv/EABQRAQAAAAAAAAAAAAAAAAAAAAD/2gAMAwEAAhEDEQA/ALACpM//2Q==';

export interface ImageSpec {
  width: number;
  height: number;
  /** 补齐到的字节数（0 / 缺省 = 不补） */
  targetBytes?: number;
  quality?: number;
}

export interface TestImage {
  buffer: Buffer;
  contentType: 'image/jpeg';
  width: number;
  height: number;
  /** 是否由 sharp 生成（false = 内置小图） */
  generated: boolean;
}

const cache = new Map<string, Promise<TestImage>>();

/** 在 SOI（FFD8）之后插入 COM 段（FFFE + 2 字节长度），把 JPEG 补到 targetBytes。 */
export function padJpeg(jpeg: Buffer, targetBytes: number): Buffer {
  if (jpeg.length >= targetBytes || jpeg[0] !== 0xff || jpeg[1] !== 0xd8) return jpeg;
  const chunks: Buffer[] = [jpeg.subarray(0, 2)];
  let need = targetBytes - jpeg.length;
  const MAX_PAYLOAD = 65_533; // 长度字段含自身 2 字节，上限 65535
  while (need > 4) {
    const payload = Math.min(MAX_PAYLOAD, need - 4);
    const seg = Buffer.alloc(payload + 4, 0x20);
    seg[0] = 0xff;
    seg[1] = 0xfe;
    seg.writeUInt16BE(payload + 2, 2);
    chunks.push(seg);
    need -= payload + 4;
  }
  chunks.push(jpeg.subarray(2));
  return Buffer.concat(chunks);
}

async function render(spec: ImageSpec): Promise<TestImage> {
  const quality = spec.quality ?? 85;
  try {
    const sharp = (await import('sharp')).default;
    const { width, height } = spec;
    // 噪声 + 渐变：纯噪声在 4000×3000 时 raw 缓冲 36 MB，可接受；更大时降采样再放大
    const scale = width * height > 12_000_000 ? 2 : 1;
    const w = Math.max(1, Math.round(width / scale));
    const h = Math.max(1, Math.round(height / scale));
    const raw = randomBytes(w * h * 3);
    for (let y = 0; y < h; y += 1) {
      for (let x = 0; x < w; x += 1) {
        const i = (y * w + x) * 3;
        raw[i] = ((raw[i] as number) >> 2) + Math.round((x / w) * 190);
        raw[i + 1] = ((raw[i + 1] as number) >> 2) + Math.round((y / h) * 190);
        raw[i + 2] = ((raw[i + 2] as number) >> 2) + 96;
      }
    }
    let img = sharp(raw, { raw: { width: w, height: h, channels: 3 } });
    if (scale !== 1) img = img.resize(width, height, { kernel: 'nearest' });
    let buffer: Buffer = await img.jpeg({ quality, mozjpeg: false }).toBuffer();
    if (spec.targetBytes) buffer = padJpeg(buffer, spec.targetBytes);
    return { buffer, contentType: 'image/jpeg', width, height, generated: true };
  } catch {
    let buffer: Buffer = Buffer.from(FALLBACK_JPEG_B64, 'base64');
    if (spec.targetBytes) buffer = padJpeg(buffer, spec.targetBytes);
    return { buffer, contentType: 'image/jpeg', width: 16, height: 16, generated: false };
  }
}

/** 生成（并缓存）一张测试 JPEG；同一规格在一次运行中复用同一份字节。 */
export function testJpeg(spec: ImageSpec): Promise<TestImage> {
  const key = `${spec.width}x${spec.height}:${spec.targetBytes ?? 0}:${spec.quality ?? 85}`;
  let p = cache.get(key);
  if (!p) {
    p = render(spec);
    cache.set(key, p);
  }
  return p;
}

/** 损坏的 JPEG：合法的 SOI + APP0 开头，之后是随机字节（服务端嗅探为 JPEG，解码失败 → 永久错误）。 */
export function corruptJpeg(bytes = 4096): Buffer {
  const head = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01, 0x01, 0x00, 0x00, 0x01, 0x00, 0x01, 0x00, 0x00]);
  return Buffer.concat([head, randomBytes(Math.max(0, bytes - head.length))]);
}

export function fallbackJpeg(): Buffer {
  return Buffer.from(FALLBACK_JPEG_B64, 'base64');
}
