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
 * 脚手架桩：类型与常量已定义，render() / sniffImageType() 由「L0 本地实现者」（image-processing 的 inline）填充，
 * Lambda 与 workflow 复用。注意：本包不得依赖 backend（Lambda 也要用它）。
 */

export const VARIANTS = [
  { name: 'thumb_200', longEdge: 200 },
  { name: 'display_1080', longEdge: 1080 },
] as const;

export type VariantName = (typeof VARIANTS)[number]['name'];

export const ACCEPTED_TYPES = ['image/jpeg', 'image/png', 'image/webp'] as const;
export type AcceptedType = (typeof ACCEPTED_TYPES)[number];

export interface ImageMeta {
  width: number;
  height: number;
  format: string;
  dominantColor: string;
  takenAt?: string;
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
}

export interface RenderOutput {
  meta: ImageMeta;
  variants: RenderedVariant[];
  durationMs: number;
}

/** 永久错误（格式不支持、超过像素上限、文件损坏）：不重试，直接写 FAILED */
export class PermanentImageError extends Error {
  readonly permanent = true;
  constructor(message: string) {
    super(message);
    this.name = 'PermanentImageError';
  }
}

export function variantKey(photoId: string, name: VariantName): string {
  return `variants/${photoId}/${name}.webp`;
}

export class ImageCoreNotImplementedError extends Error {
  readonly code = 'NOT_IMPLEMENTED';
  constructor(fn: string) {
    super(`@cloudalbum/image-core ${fn}() 尚未实现（脚手架桩）`);
    this.name = 'ImageCoreNotImplementedError';
  }
}

/** 按文件头魔数识别格式；不在白名单内返回 null */
export function sniffImageType(_head: Uint8Array): AcceptedType | null {
  throw new ImageCoreNotImplementedError('sniffImageType');
}

/** 渲染两种尺寸的 WebP 衍生图并读出元数据 */
export async function render(_input: Buffer, _opts: RenderOptions): Promise<RenderOutput> {
  throw new ImageCoreNotImplementedError('render');
}
