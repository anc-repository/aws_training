// backend/src/ports/tagger.ts （总纲 §4.2，照录）
import type { Adapter } from './common.js';
import type { ImageMeta } from './image-processor.js';

export interface TagResult {
  labels: Array<{ name: string; confidence: number; source: 'basic' | 'rekognition' }>;
  moderation: { verdict: 'pass' | 'review' | 'block'; labels: Array<{ name: string; confidence: number }> };
  analyzedBy: { driver: 'none' | 'rekognition'; durationMs: number; input: 'metadata' | 's3-object' | 'bytes' };
}
export interface TaggerPort extends Adapter {
  /** none：只用 meta 与 EXIF 启发式生成基础属性标签，审核恒为 pass；
   *  rekognition：同时输出基础标签（保证搜索不失效）；原图为 JPEG/PNG 且 storage=s3 时传 S3Object 引用，
   *  否则把 display_1080 转为 JPEG 后传 Bytes（Rekognition 不接受 WebP；大小与尺寸下限以官方文档为准）；
   *  故障时退回基础标签并标 degraded（路径头 tagging=rekognition:error-basic） */
  analyze(input: { photoId: string; storageKey: string; meta: ImageMeta; bytes: () => Promise<Buffer> }): Promise<TagResult>;
}
