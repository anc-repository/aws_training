/**
 * identity-pool/resume —— 断点续传（02#identity-pool 第 5 节步骤 3）。
 *
 *   npm run exp -- identity-pool --label before --scenario resume --param users=<文件>            # 前缀令牌
 *   npm run exp -- identity-pool --label after  --scenario resume --param users=<文件> --upload   # STS 分片上传
 *
 * 上传一个 fileMb 的文件，在第 failAtPart 片之前中断（模拟断网；pauseSec > 0 时等待，可以真的断开再恢复网络），然后续传：
 *   token：storage=local 时 GET /api/storage/upload/parts 问服务端收到了哪些分片；storage=s3 时用客户端记录的已完成分片
 *          （S3 的 UploadId 在后端进程内存里，续传只需对缺失的分片重新 parts:sign）；
 *   sts：用同一组临时凭证 ListParts 直接问 S3。
 * 只补传缺失的分片 → onlyMissingResent = true。服务端证据：续传前服务端 / S3 报告的已收分片数，complete 之后照片在服务端的状态。
 */
import { testJpeg } from '../_lib/images.js';
import { defineScenario, numParam } from '../_lib/scenario.js';
import { sleep } from '../_lib/util.js';
import {
  completePhoto, continueMultipart, createPhoto, getCredentials, loadAccounts, loginUser, modeOf, openSession, ROUTES, serverPhotoStatus,
  stagingKeyOf, StsS3, tokenPart, type TokenSession,
} from './lib.js';

const MB = 1024 * 1024;

export default defineScenario({
  warmupWithRun: false,
  async run(ctx) {
    const mode = modeOf(ctx);
    const fileBytes = Math.round(numParam(ctx, 'fileMb', 24) * MB);
    const pauseSec = numParam(ctx, 'pauseSec', 0);
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
    const { session } = await openSession(u);
    const partSize = session.partSize > 0 ? session.partSize : 8 * MB;
    const total = Math.max(1, Math.ceil(jpeg.length / partSize));
    const failAt = Math.min(Math.max(2, Math.round(numParam(ctx, 'failAtPart', 2))), total);
    if (total < 2) {
      ctx.note(`文件只有 ${total} 片（分片 ${partSize} 字节）：加大 --param fileMb`);
      ctx.finding('error', 'single-part');
      return;
    }
    const p = await createPhoto(u, jpeg.length, `experiment identity-pool/resume ${ctx.label}`);
    ctx.cleanupLater('DELETE', `/api/photos/${p.photoId}`);
    const slice = (n: number) => jpeg.subarray((n - 1) * partSize, n * partSize);
    const before: number[] = [];
    const resent: number[] = [];
    let serverReported: number | null = null;
    let completeStatus = 0;

    if (mode === 'sts') {
      if (session.mode !== 'sts') throw new Error('会话不是 STS：identity-pool 未启用或暂时不可用');
      const c = await getCredentials(u);
      if (!c.creds) throw new Error(`GET /api/uploads/credentials 失败：HTTP ${c.res.status}`);
      const s3 = new StsS3(ctx, c.creds);
      const key = stagingKeyOf(c.creds, p.photoId, p.rawKey);
      const uploadId = await s3.createMultipart(key, 'image/jpeg');
      for (let n = 1; n < failAt; n += 1) {
        const r = await s3.uploadPart(key, uploadId, n, slice(n));
        if (!r.etag) throw new Error(`UploadPart ${n} 失败：HTTP ${r.res.status}`);
        before.push(n);
      }
      ctx.log(`模拟断网：第 ${failAt} 片之前中断${pauseSec ? `，等待 ${pauseSec} 秒` : ''}`);
      if (pauseSec) await sleep(pauseSec * 1000, ctx.signal);
      const received = await s3.listParts(key, uploadId);           // S3 自己记录的已收分片
      serverReported = received.size;
      const r = await continueMultipart(s3, key, uploadId, jpeg, partSize, { skip: received });
      resent.push(...r.partsSent);
      completeStatus = (await completePhoto(u, p.photoId)).status;
    } else {
      if (session.mode !== 'token') throw new Error('当前驱动发放的是 STS 会话：普通用户拿不到前缀令牌，改用 --param mode=sts');
      const t = session as TokenSession;
      const etags = new Map<number, string>();
      for (let n = 1; n < failAt; n += 1) {
        const r = await tokenPart(ctx, u, t, p, n, slice(n));
        if (!r.ok) throw new Error(`分片 ${n}：HTTP ${r.status}`);
        etags.set(n, r.etag ?? '');
        before.push(n);
      }
      ctx.log(`模拟断网：第 ${failAt} 片之前中断${pauseSec ? `，等待 ${pauseSec} 秒` : ''}`);
      if (pauseSec) await sleep(pauseSec * 1000, ctx.signal);
      let done = new Set(etags.keys());
      if (t.partUrl === ROUTES.upload) {
        // storage=local：问服务端（数据卷上的 .incoming/<uploadId>/）收到了哪些分片
        const r = await u.client.get(`${ROUTES.parts}?${new URLSearchParams({ uploadId: p.uploadId, key: p.rawKey })}`, {
          route: ROUTES.parts, headers: { authorization: `CA-Upload ${t.token}` }, expect: [200],
        });
        if (r.ok) {
          const list = r.json<{ parts?: Array<{ part: number }> }>().parts ?? [];
          serverReported = list.length;
          done = new Set(list.map((x) => x.part));
        }
      }
      for (let n = 1; n <= total; n += 1) {
        if (done.has(n)) continue;
        const r = await tokenPart(ctx, u, t, p, n, slice(n));
        if (!r.ok) throw new Error(`续传分片 ${n}：HTTP ${r.status}`);
        etags.set(n, r.etag ?? '');
        resent.push(n);
      }
      completeStatus = (await completePhoto(u, p.photoId, {
        uploadId: p.uploadId, parts: [...etags.entries()].sort((a, b) => a[0] - b[0]).map(([part, etag]) => ({ part, ...(etag ? { etag } : {}) })),
      })).status;
    }

    const expectedResent = total - before.length;
    ctx.finding('totalParts', total);
    ctx.finding('partSize', partSize);
    ctx.finding('partsBeforeInterruption', before.length);
    ctx.finding('partsResent', resent.length);
    ctx.finding('resentParts', resent);
    ctx.finding('onlyMissingResent', resent.length === expectedResent && resent.every((n) => !before.includes(n)));
    ctx.finding('completeStatus', completeStatus);
    ctx.finding('serverEvidence', {
      partsReportedBeforeResume: serverReported,
      reportedBy: mode === 'sts' ? 's3:ListParts' : serverReported === null ? 'client (storage=s3: UploadId kept by the API process)' : 'api:/api/storage/upload/parts',
      photoStatus: await serverPhotoStatus(ctx, p.photoId),
    });
    ctx.business('parts_resent', resent.length);
  },
});
