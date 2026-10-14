/**
 * identity-pool/upload-bench —— 批量分片上传的对比（02#identity-pool 第 5 节步骤 2）。
 *
 *   npm run exp -- identity-pool --label before --scenario upload-bench --param users=<文件> --param files=50
 *   scripts/module enable identity-pool
 *   npm run exp -- identity-pool --label after  --scenario upload-bench --param users=<文件> --param files=50 --upload
 *
 * 同一个测试用户上传 files 个文件，记录：每个文件对后端（EC2）的请求数、对 S3 的请求数、总耗时与单文件耗时、EC2 入站字节（host.*）。
 *   token：会话一次 + 每个文件（建档 + 每片一次 + complete）；storage=s3 时每片先 parts:sign 再 PUT 预签名 URL；
 *   sts：会话一次 + 凭证一次 + 每个文件（建档 + complete），分片直传暂存桶。
 * 服务端证据（管理员）：每张照片在服务端的状态（complete 之后为 PROCESSING / READY）；sts 另抽查暂存对象已在导入后删除。
 */
import { testJpeg } from '../_lib/images.js';
import { defineScenario } from '../_lib/scenario.js';
import { numParam } from '../_lib/scenario.js';
import { mapLimit, percentile, round1 } from '../_lib/util.js';
import {
  completePhoto, createPhoto, getCredentials, loadAccounts, loginUser, modeOf, openSession, serverPhotoStatus, stagingExists, stagingKeyOf,
  StsS3, stsMultipart, tokenPart, type TokenSession,
} from './lib.js';

const MB = 1024 * 1024;

export interface FileResult { photoId: string; ms: number; backend: number; s3: number; ok: boolean; status?: number; error?: string; stagingKey?: string }

export default defineScenario({
  warmupWithRun: false,
  async run(ctx) {
    const mode = modeOf(ctx);
    const files = Math.round(numParam(ctx, 'files', 10));
    const fileBytes = Math.round(numParam(ctx, 'fileMb', 12) * MB);
    const concurrency = Math.max(1, Math.round(numParam(ctx, 'concurrency', 2)));
    const { accounts, source } = loadAccounts(ctx);
    ctx.finding('mode', mode);
    ctx.finding('usersSource', source);
    if (!accounts.length) {
      ctx.note('需要一个测试用户：--param users=<文件>，或平台工作台的 CLOUDALBUM_TEST_USERS_PARAM');
      ctx.finding('error', 'need-a-user');
      return;
    }
    const u = await loginUser(ctx, accounts[0]!);
    const jpeg = (await testJpeg({ width: 1600, height: 1200, targetBytes: fileBytes })).buffer;
    const started = Date.now();
    let sessionRequests = 1;
    const { session } = await openSession(u);
    const partSize = session.partSize > 0 ? session.partSize : 8 * MB;
    const partsPerFile = Math.max(1, Math.ceil(jpeg.length / partSize));
    let s3: StsS3 | undefined;
    if (mode === 'sts') {
      if (session.mode !== 'sts') throw new Error(`会话是 ${session.mode}（${(session as TokenSession).fallback ? '故障回退' : 'none 驱动'}）：identity-pool 未启用或暂时不可用`);
      const c = await getCredentials(u);
      sessionRequests += 1;
      if (!c.creds) throw new Error(`GET /api/uploads/credentials 失败：HTTP ${c.res.status}`);
      s3 = new StsS3(ctx, c.creds);
    } else if (session.mode !== 'token') {
      throw new Error('当前驱动发放的是 STS 会话：普通用户拿不到前缀令牌，改用 --param mode=sts');
    }

    const title = `experiment identity-pool/upload-bench ${ctx.label}`;
    const results = await mapLimit(Array.from({ length: files }, (_, i) => i), concurrency, async (): Promise<FileResult> => {
      const t0 = Date.now();
      let backend = 0;
      let s3n = 0;
      let photoId = '';
      try {
        const p = await createPhoto(u, jpeg.length, title);
        photoId = p.photoId;
        backend += 1;
        ctx.cleanupLater('DELETE', `/api/photos/${p.photoId}`);
        let stagingKey: string | undefined;
        let completeBody: Record<string, unknown> = {};
        if (s3) {
          stagingKey = stagingKeyOf(s3.creds, p.photoId, p.rawKey);
          const r = await stsMultipart(s3, stagingKey, jpeg, partSize);
          s3n += r.s3Requests;
        } else {
          const t = session as TokenSession;
          const parts: Array<{ part: number; etag?: string }> = [];
          for (let n = 1; n <= partsPerFile; n += 1) {
            const r = await tokenPart(ctx, u, t, p, n, jpeg.subarray((n - 1) * partSize, n * partSize));
            backend += r.backend;
            if (t.partUrl !== '/api/storage/upload') s3n += 1;
            if (!r.ok) throw new Error(`分片 ${n}：HTTP ${r.status}${r.code ? ` ${r.code}` : ''}`);
            parts.push({ part: n, ...(r.etag ? { etag: r.etag } : {}) });
          }
          completeBody = { uploadId: p.uploadId, parts };
        }
        const c = await completePhoto(u, p.photoId, completeBody);
        backend += 1;
        return { photoId: p.photoId, ms: Date.now() - t0, backend, s3: s3n, ok: c.ok, status: c.status, ...(stagingKey ? { stagingKey } : {}) };
      } catch (e) {
        return { photoId, ms: Date.now() - t0, backend, s3: s3n, ok: false, error: (e as Error).message };
      }
    });
    const totalMs = Date.now() - started;
    const ok = results.filter((r) => r.ok);
    const backendTotal = results.reduce((s, r) => s + r.backend, 0) + sessionRequests;
    const s3Total = results.reduce((s, r) => s + r.s3, 0);

    // 服务端证据：照片在服务端的状态；sts 抽查暂存对象已删除（complete 之后服务端 CopyObject + DeleteObject）
    const statuses: Record<string, number> = {};
    for (const r of ok) {
      const st = (await serverPhotoStatus(ctx, r.photoId)) ?? 'unknown';
      statuses[st] = (statuses[st] ?? 0) + 1;
    }
    const sample = ok.filter((r) => r.stagingKey).slice(0, 3);
    const leftovers = (await Promise.all(sample.map((r) => stagingExists(ctx, r.stagingKey!)))).filter((x) => x === true).length;

    ctx.finding('files', files);
    ctx.finding('fileBytes', jpeg.length);
    ctx.finding('partSize', partSize);
    ctx.finding('partsPerFile', partsPerFile);
    ctx.finding('completed', ok.length);
    ctx.finding('failed', results.length - ok.length);
    ctx.finding('errors', results.filter((r) => r.error).slice(0, 5).map((r) => r.error));
    ctx.finding('backendRequests', backendTotal);
    ctx.finding('backendRequestsPerFile', round1(backendTotal / Math.max(1, files)));
    ctx.finding('s3Requests', s3Total);
    ctx.finding('s3RequestsPerFile', round1(s3Total / Math.max(1, files)));
    ctx.finding('totalMs', totalMs);
    ctx.finding('perFileMsP50', percentile(ok.map((r) => r.ms), 50));
    ctx.finding('perFileMsP95', percentile(ok.map((r) => r.ms), 95));
    ctx.finding('serverEvidence', {
      photoStatuses: statuses,
      ...(sample.length ? { stagingChecked: sample.length, stagingLeftovers: leftovers } : {}),
      bytesThroughEc2: mode === 'token' && (session as TokenSession).partUrl === '/api/storage/upload' ? jpeg.length * ok.length : 0,
    });
    ctx.business('backend_requests_per_file', round1(backendTotal / Math.max(1, files)));
    ctx.business('s3_requests_per_file', round1(s3Total / Math.max(1, files)));
    ctx.business('upload_total_ms', totalMs);
  },
});
