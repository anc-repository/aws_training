/**
 * storage/upload-burst —— 批量上传（03#storage 第 5 节步骤 2、4）。
 *
 *   npm run exp -- storage --label before --scenario upload-burst --vus 10 --duration 120s
 *   scripts/module enable storage
 *   npm run exp -- storage --label after  --scenario upload-burst --vus 10 --duration 120s
 *   npm run exp:report -- storage
 *
 * 每个文件 fileMb（默认 20 MB）：1600×1200 的噪声 JPEG 用 COM 段补齐到目标大小，像素数不变——这样两档的差别只在
 * “字节经不经过 EC2”，而不在缩略图成本。上传目标是相对 URL（local，经 Nginx → Node 写 EBS）还是 S3 预签名 URL
 * 由服务端决定；客户端分别记在 `PUT /api/storage/upload` 与 `PUT s3:upload` 下。主机网卡字节、CPU、事件循环延迟、
 * RSS 来自 /api/lab/metrics 的主机采样（host.*）。
 */
import { defineScenario, numParam } from '../_lib/scenario.js';
import { runUploadBurst } from '../_lib/scenarios/upload-burst.js';

const MB = 1024 * 1024;

export default defineScenario({
  async run(ctx) {
    const fileMb = numParam(ctx, 'fileMb', 20);
    const { uploads } = await runUploadBurst(ctx, {
      width: numParam(ctx, 'width', 1600),
      height: numParam(ctx, 'height', 1200),
      ...(fileMb > 0 ? { targetBytes: Math.round(fileMb * MB) } : {}),
      ...(ctx.phase === 'warmup' ? { count: Math.max(1, Math.min(ctx.vus, 3)) } : {}),
      feedRps: numParam(ctx, 'feedRps', 2),
      drainTimeoutMs: numParam(ctx, 'drainTimeoutSec', 180) * 1000,
    });
    if (ctx.phase !== 'measure') return;
    const s3 = ctx.recorder.all().filter((s) => s.route === 's3:upload').length;
    const local = ctx.recorder.all().filter((s) => s.route === '/api/storage/upload').length;
    ctx.finding('uploadPath', s3 && !local ? 's3-direct' : local && !s3 ? 'via-ec2' : s3 && local ? 'mixed' : 'none');
    const okUploads = uploads.filter((u) => !u.error).length;
    ctx.finding('uploadedBytes', okUploads * Math.round(fileMb * MB));
    ctx.business('uploadedBytes', okUploads * Math.round(fileMb * MB));
  },
});
