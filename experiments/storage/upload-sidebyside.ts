/**
 * storage/upload-sidebyside —— 同部署侧路对比（03#storage 第 5 节步骤 5；总纲 §8.3 lab.sideBySide）。
 *
 *   npm run exp -- storage --label after --scenario upload-sidebyside
 *
 * 交替调用 `POST /api/lab/storage/upload-target?driver=local|s3`（仅管理员，返回 lab/ 命名空间下的 UploadTarget），
 * 再 PUT 同样大小的文件。两条路径同时运行，只看方向与数量级。端点由 storage 模块实现；不存在（404 / 501）时记录并结束。
 */
import { putUpload, type UploadTarget } from '../_lib/app.js';
import { testJpeg } from '../_lib/images.js';
import { runVus } from '../_lib/load.js';
import { defineScenario, numParam } from '../_lib/scenario.js';
import { percentile, round1 } from '../_lib/util.js';

const ENDPOINT = '/api/lab/storage/upload-target';

export default defineScenario({
  warmupWithRun: false,
  async run(ctx) {
    const fileMb = numParam(ctx, 'fileMb', 5);
    const image = await testJpeg({ width: 1200, height: 900, ...(fileMb > 0 ? { targetBytes: Math.round(fileMb * 1024 * 1024) } : {}) });
    const probe = await ctx.client.post(`${ENDPOINT}?driver=local`, { route: ENDPOINT, json: { contentType: image.contentType, size: image.buffer.length }, record: false });
    if (probe.status === 404 || probe.status === 501) {
      ctx.note(`${ENDPOINT} 不可用（${probe.status}）：侧路对比端点尚未实现，改用 upload-burst 做切换前后对比`);
      ctx.finding('endpointAvailable', false);
      return;
    }
    ctx.finding('endpointAvailable', true);
    const durations: Record<'local' | 's3', number[]> = { local: [], s3: [] };
    const errors: Record<'local' | 's3', number> = { local: 0, s3: 0 };
    let n = 0;
    await runVus({ vus: ctx.vus, durationMs: ctx.durationMs, signal: ctx.signal }, async () => {
      n += 1;
      const driver = n % 2 === 0 ? 's3' : 'local';
      const t = await ctx.client.post(`${ENDPOINT}?driver=${driver}`, { route: `${ENDPOINT}?driver=${driver}`, json: { contentType: image.contentType, size: image.buffer.length } });
      if (!t.ok) {
        errors[driver] += 1;
        return;
      }
      const body = t.json<{ uploadTarget?: UploadTarget } & Partial<UploadTarget>>();
      const target = body.uploadTarget ?? (body.url ? { method: 'PUT' as const, url: body.url, headers: body.headers ?? {} } : undefined);
      if (!target) {
        errors[driver] += 1;
        return;
      }
      const put = await putUpload(ctx, target, image.buffer);
      if (put.ok) durations[driver].push(put.totalMs);
      else errors[driver] += 1;
    });
    for (const d of ['local', 's3'] as const) {
      ctx.finding(d, { uploads: durations[d].length, errors: errors[d], p50: round1(percentile(durations[d], 50)), p95: round1(percentile(durations[d], 95)) });
    }
  },
});
