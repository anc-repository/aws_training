/**
 * storage/ebs-growth —— 磁盘写满（03#storage 第 5 节步骤 6）。
 *
 *   npm run exp -- storage --label before --scenario ebs-growth --fault-via ssh --ssh ec2-user@<EIP>
 *
 * 运行器在第 0 秒经投递通道执行 `faults/balloon.sh fill <fillPct>`，本脚本等 settleSec（让 LabMetricsStore 采样到新的
 * 数据卷用量、让上传路由读到新的剩余空间）后，交替尝试上传与发表评论各 attempts 次，记录状态码；结束时运行器执行
 * `balloon.sh release`。local 档预期上传 507、继续压低后评论（SQLite 写）也失败；s3 档上传不受影响。
 */
import { ensureTargetPhoto, ROUTES, uploadPhoto } from '../_lib/app.js';
import { testJpeg } from '../_lib/images.js';
import { defineScenario, numParam } from '../_lib/scenario.js';
import { sleep } from '../_lib/util.js';

export default defineScenario({
  warmupWithRun: false,
  async run(ctx) {
    const image = await testJpeg({ width: 800, height: 600, targetBytes: 2 * 1024 * 1024 });
    // 先确定评论目标（占位前），避免占位后连“准备”都失败
    const photoId = await ensureTargetPhoto(ctx, await testJpeg({ width: 320, height: 240 }));
    await sleep(numParam(ctx, 'settleSec', 10) * 1000, ctx.signal);
    const attempts = numParam(ctx, 'attempts', 5);
    const uploadStatuses: number[] = [];
    const commentStatuses: number[] = [];
    for (let i = 0; i < attempts && !ctx.signal.aborted; i += 1) {
      const up = await uploadPhoto(ctx, { image, title: `ebs-growth ${i + 1}` });
      uploadStatuses.push(up.error ? Number(/^(?:upload|create|complete) (\d+)/.exec(up.error)?.[1] ?? 0) : up.completeStatus);
      if (photoId) {
        const c = await ctx.client.post(`/social/photos/${photoId}/comments`, {
          route: ROUTES.comments, json: { text: `ebs-growth ${ctx.runId.slice(-6)} #${i + 1}` }, expect: [201],
        });
        commentStatuses.push(c.status);
      }
      await sleep(500, ctx.signal);
    }
    ctx.finding('uploadStatuses', uploadStatuses);
    ctx.finding('commentStatuses', commentStatuses);
    ctx.finding('uploadOk', uploadStatuses.filter((s) => s >= 200 && s < 300).length);
    ctx.finding('uploadRejected507', uploadStatuses.filter((s) => s === 507).length);
    ctx.finding('commentFailures', commentStatuses.filter((s) => s !== 201).length);
    if (!photoId) ctx.note('没有可评论的照片：评论部分跳过');
  },
});
