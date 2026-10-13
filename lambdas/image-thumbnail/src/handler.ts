/**
 * lambdas/image-thumbnail —— image-processing=lambda（04#image-processing 第 2 节）
 *
 * EventBridge（S3 Object Created，含 Copy）→ 读原图桶 raw/<userId>/<photoId>.<ext> → @cloudalbum/image-core render()
 * → 写媒体桶 variants/<photoId>/*.webp → 回写：IMAGE_RESULT_CHANNEL=callback 时带时间戳 HMAC 调用
 * POST /internal/hooks/image-processed；queue 时发到模块自带的结果队列。nodejs22.x、arm64，用 esbuild 打包（build.mjs）。
 *
 * 脚手架桩：由「image-processing 模块实现者」填充。注意 sharp 需要 linux-arm64 预编译包（打包时单独安装，见 build.mjs）。
 */
import type { EventBridgeEvent } from 'aws-lambda';

export interface S3ObjectCreatedDetail {
  bucket: { name: string };
  object: { key: string; size?: number; etag?: string };
  reason?: string;
}

export async function handler(_event: EventBridgeEvent<'Object Created', S3ObjectCreatedDetail>): Promise<void> {
  throw new Error('lambdas/image-thumbnail: handler 尚未实现（脚手架桩）');
}
