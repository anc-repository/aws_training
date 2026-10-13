/**
 * experiments/_lib/scenarios/upload-burst.ts —— 上传突发（storage / queue / image-processing 共用）。
 *
 * 每个 VU 循环“建档 → PUT → complete”；可选以固定速率读 `GET /api/feed` 作为邻居流量；负载结束后轮询所有照片直到
 * READY / FAILED 或超过排空时限（未就绪的计为 jobsLost）。complete 可参与 A/B（queue 的 bypass=queue、image-processing 的 bypass=image）。
 */
import { ROUTES, uploadBusiness, uploadPhoto, waitReady, type ReadyResult, type UploadedPhoto } from '../app.js';
import { testJpeg } from '../images.js';
import { runRate, runVus } from '../load.js';
import type { ScenarioContext } from '../scenario.js';

export interface UploadBurstOptions {
  width: number;
  height: number;
  /** 文件补齐到的字节数（storage 的 fileMb） */
  targetBytes?: number;
  /** 总上传张数上限（缺省：直到时长用尽） */
  count?: number;
  /** 背景时间线读取速率（次 / 秒，0 = 不读） */
  feedRps?: number;
  /** complete 参与 A/B */
  abComplete?: boolean;
  /** 负载结束后等待就绪（缺省 true） */
  waitReady?: boolean;
  drainTimeoutMs: number;
  pollIntervalMs?: number;
  visibility?: 'public' | 'private';
}

export interface UploadBurstOutcome {
  uploads: UploadedPhoto[];
  ready: ReadyResult[];
  feedRequests: number;
}

export async function runUploadBurst(ctx: ScenarioContext, o: UploadBurstOptions): Promise<UploadBurstOutcome> {
  const image = await testJpeg({ width: o.width, height: o.height, ...(o.targetBytes ? { targetBytes: o.targetBytes } : {}) });
  if (!image.generated) ctx.note('sharp 不可用：使用内置 16×16 JPEG（处理成本不代表真实照片）');
  const uploads: UploadedPhoto[] = [];
  let loadDone = false;
  let feedRequests = 0;
  const feed = (o.feedRps ?? 0) > 0 && ctx.phase === 'measure'
    ? runRate({ ratePerSec: o.feedRps!, durationMs: ctx.durationMs, signal: ctx.signal, until: () => loadDone, maxInFlight: 16 }, async () => {
      feedRequests += 1;
      await ctx.client.get(`${ROUTES.feed}?scope=mine&limit=24`, { route: ROUTES.feed });
    })
    : Promise.resolve();

  const load = await runVus({
    vus: ctx.vus, durationMs: ctx.durationMs, signal: ctx.signal, ...(o.count ? { iterations: o.count } : {}),
    onError: (e) => ctx.log(`上传迭代出错：${(e as Error).message}`),
  }, async () => {
    const up = await uploadPhoto(ctx, { image, abComplete: o.abComplete === true && ctx.ab, ...(o.visibility ? { visibility: o.visibility } : {}) });
    uploads.push(up);
  });
  loadDone = true;
  await feed;

  const errors = uploads.filter((u) => u.error);
  if (errors.length) ctx.log(`${errors.length} 次上传失败，例如：${errors[0]!.error}`);
  let ready: ReadyResult[] = [];
  if (o.waitReady !== false) {
    const pending = uploads.filter((u) => !u.error && u.status !== 'READY');
    ctx.log(`负载结束：${uploads.length} 次上传（${load.elapsedMs.toFixed(0)} ms），等待 ${pending.length} 张就绪（上限 ${Math.round(o.drainTimeoutMs / 1000)}s）`);
    ready = await waitReady(ctx, uploads, { timeoutMs: o.drainTimeoutMs, intervalMs: o.pollIntervalMs ?? 1000 });
  }
  if (ctx.phase === 'measure') {
    uploadBusiness(ctx, uploads, ready);
    ctx.finding('uploads', uploads.length);
    ctx.finding('image', { width: image.width, height: image.height, bytes: image.buffer.length });
    if (feedRequests) ctx.finding('feedRequests', feedRequests);
    const byVariant: Record<string, { n: number; ready: number; lost: number }> = {};
    for (const u of uploads) {
      const v = u.variant ?? '-';
      const r = ready.find((x) => x.id === u.id);
      const b = byVariant[v] ?? (byVariant[v] = { n: 0, ready: 0, lost: 0 });
      b.n += 1;
      if (r?.status === 'READY') b.ready += 1;
      if (r?.status === 'TIMEOUT') b.lost += 1;
    }
    if (Object.keys(byVariant).length > 1) ctx.finding('completeByVariant', byVariant);
  }
  return { uploads, ready, feedRequests };
}
