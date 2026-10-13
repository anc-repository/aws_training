// backend/src/http/routes/internal-hooks.ts —— registry internalEndpoints 声明的内部端点（总纲 2.5 第 4 组 location）
//
// - POST /internal/hooks/image-processed：image-processing（lambda 档 + IMAGE_RESULT_CHANNEL=callback），公网可达 + HMAC
//   （callback-hmac-key；请求头 X-CloudAlbum-Timestamp: <unix 秒>、X-CloudAlbum-Signature: v1=<hex>，±300 秒）。
//   签名校验与载荷解析在 lambda 适配器的 acceptCallback(rawBody, headers)（原始请求体在 req.rawBody）；
//   写回与后续步骤（打标签、审核、通知）统一交给 PhotoPipeline.handleImageOutcome（幂等：重复或迟到的回调被忽略）。
//   对应模块或变体未启用时返回 404。
// - POST /internal/legacy-auth：auth 的 lazy 迁移变体（只放行 VPC CIDR + internal-hmac-key）；本轮未实现，一律 404。
// - 其余 /internal/* 一律 404。
import type { Express, RequestHandler } from 'express';
import type { Container } from '../../container.js';
import { HttpError } from '../../errors.js';
import { handleImageOutcome, pipelineDeps } from '../../services/photo-pipeline.js';

export const CALLBACK_HEADERS = { timestamp: 'X-CloudAlbum-Timestamp', signature: 'X-CloudAlbum-Signature' } as const;

export function register(app: Express, c: Container): void {
  const notFound: RequestHandler = (_req, res) => {
    res.status(404).json({ error: 'NOT_FOUND' });
  };
  const image = c.config.image;
  const imageCallbackEnabled = image.IMAGE_PROCESSOR === 'lambda' && image.IMAGE_RESULT_CHANNEL === 'callback';

  const imageProcessed: RequestHandler = async (req, res) => {
    if (typeof c.images.acceptCallback !== 'function') throw new HttpError(404, 'NOT_FOUND', '当前图片处理驱动不接受回调');
    const signature = req.get(CALLBACK_HEADERS.signature) ?? '';
    const timestamp = req.get(CALLBACK_HEADERS.timestamp) ?? '';
    if (!signature || !timestamp) throw new HttpError(401, 'SIGNATURE_REQUIRED', `缺少 ${CALLBACK_HEADERS.signature} / ${CALLBACK_HEADERS.timestamp}`);
    const outcome = await c.images.acceptCallback(req.rawBody ?? Buffer.alloc(0), { signature, timestamp });
    const applied = await handleImageOutcome(pipelineDeps(c), outcome);
    res.set('Cache-Control', 'no-store').json({ photoId: outcome.photoId, applied });
  };

  app.post('/internal/hooks/image-processed', imageCallbackEnabled ? imageProcessed : notFound);
  app.all('/internal/*rest', notFound);
}
