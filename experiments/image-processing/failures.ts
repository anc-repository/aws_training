/**
 * image-processing/failures —— 失败路径（04#image-processing 第 5 节步骤 8 的“永久错误”部分）。
 *
 *   npm run exp -- image-processing --label after --scenario failures [--param count=3]
 *
 * 上传 count 张损坏的 JPEG（合法的文件头 + 随机字节）：应该很快变成 FAILED，没有重试、不进失败队列。
 * “暂时错误”部分（函数环境变量 FAULT_RATE=0.5）需要改 Lambda 配置，按 README 手工执行。
 */
import { uploadPhoto, waitReady } from '../_lib/app.js';
import { corruptJpeg } from '../_lib/images.js';
import { defineScenario, numParam } from '../_lib/scenario.js';
import { percentile, round1 } from '../_lib/util.js';

export default defineScenario({
  warmupWithRun: false,
  async run(ctx) {
    const count = numParam(ctx, 'count', 1);
    const image = { buffer: corruptJpeg(64 * 1024), contentType: 'image/jpeg' as const, width: 0, height: 0, generated: false };
    const uploads = [];
    for (let i = 0; i < count && !ctx.signal.aborted; i += 1) uploads.push(await uploadPhoto(ctx, { image, title: `corrupt ${i + 1}` }));
    const rejected = uploads.filter((u) => u.error);
    const ready = await waitReady(ctx, uploads, { timeoutMs: numParam(ctx, 'timeoutSec', 120) * 1000, intervalMs: 500 });
    const failed = ready.filter((r) => r.status === 'FAILED');
    const t = failed.map((r) => r.observedMs).filter((v): v is number => v !== undefined);
    ctx.finding('uploaded', uploads.length - rejected.length);
    // complete 当场拒绝（例如 422 不支持的格式）也算“没有重试的永久错误”
    ctx.finding('rejectedAtComplete', rejected.map((u) => u.error));
    ctx.finding('failed', failed.length + rejected.filter((u) => u.completeStatus >= 400 && u.completeStatus < 500).length);
    ctx.finding('notFailed', ready.filter((r) => r.status !== 'FAILED').length);
    ctx.finding('statuses', ready.map((r) => ({ status: r.status, reason: r.failureReason ?? null, processedBy: r.processedBy?.driver ?? null })));
    ctx.finding('timeToFailedMsP95', round1(percentile(t, 95)));
  },
});
