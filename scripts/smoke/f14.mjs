// scripts/smoke/f14.mjs —— F14 多文件直传（identity-pool=none：应用自签的前缀令牌 + 分片 + 续传）
import { realJpeg } from './flow.mjs';
import { check, expectStatus, sleep } from './lib.mjs';

export async function f14Flow(t, env, profile, s) {
  t.section(`${profile.name}：F14 前缀令牌分片上传`);
  await t.step('POST /api/uploads/session → 前缀令牌（identity-pool=none:token）', async () => {
    const r = expectStatus(await s.a.post('/api/uploads/session', {}), 201);
    check(r.body.mode === 'token' && r.body.token && r.body.prefix === `raw/${s.aId}/`, `会话不对：${JSON.stringify(r.body)}`);
    check((r.headers.get('x-cloudalbum-path') ?? '').includes('identity-pool=none:token'), `路径头应有 identity-pool=none:token：${r.headers.get('x-cloudalbum-path')}`);
    s.f14 = r.body;
    const rb = expectStatus(await s.b.post('/api/uploads/session', {}), 201);
    s.f14b = rb.body;
    return `prefix=${r.body.prefix} · partSize=${r.body.partSize} · partUrl=${r.body.partUrl}`;
  });
  await t.step('建档 → 分两片 PUT（第 1 片后查询已收到的分片，模拟续传）→ complete → READY', async () => {
    const jpeg = s.jpeg ?? (await realJpeg());
    const created = expectStatus(await s.a.post('/api/photos', { contentType: 'image/jpeg', albumId: s.albumId, size: jpeg.length }), 201);
    const { photoId, rawKey, uploadId } = created.body;
    check(rawKey.startsWith(s.f14.prefix), `rawKey 应在令牌前缀之内：${rawKey}`);
    const half = Math.floor(jpeg.length / 2);
    const auth = (tok) => ({ authorization: `CA-Upload ${tok}`, 'content-type': 'application/octet-stream' });
    const partUrl = (n) => `/api/storage/upload?${new URLSearchParams({ key: rawKey, uploadId, part: String(n) })}`;
    if (s.f14.partUrl === '/api/storage/upload') {
      const denied = await s.b.req('PUT', partUrl(1), { body: jpeg.subarray(0, half), headers: auth(s.f14b.token) });
      check(denied.status === 403, `用户 B 的令牌写 A 的前缀应 403：${denied.status}`);
      const noTok = await s.a.req('PUT', partUrl(1), { body: jpeg.subarray(0, half), headers: { 'content-type': 'application/octet-stream' } });
      check(noTok.status === 401, `不带令牌应 401：${noTok.status}`);
      expectStatus(await s.a.req('PUT', partUrl(1), { body: jpeg.subarray(0, half), headers: auth(s.f14.token) }), 200);
      const parts = expectStatus(await s.a.get(`/api/storage/upload/parts?${new URLSearchParams({ key: rawKey, uploadId })}`, { headers: { authorization: `CA-Upload ${s.f14.token}` } }), 200);
      check(JSON.stringify(parts.body.parts.map((p) => p.part)) === '[1]', `已收到的分片应为 [1]：${JSON.stringify(parts.body.parts)}`);
      expectStatus(await s.a.req('PUT', partUrl(2), { body: jpeg.subarray(half), headers: auth(s.f14.token) }), 200);
    } else {
      // storage=s3：逐片换取预签名 UploadPart URL（小文件只有 1 片；S3 要求除最后一片外 ≥ 5 MiB）
      const signed = expectStatus(await s.a.req('POST', '/api/uploads/parts:sign', {
        json: { key: rawKey, uploadId, part: 1 }, headers: { authorization: `CA-Upload ${s.f14.token}` },
      }), 200);
      const put = await s.a.req('PUT', signed.body.url, { body: jpeg });
      check(put.status === 200, `PUT 预签名分片失败：${put.status}`);
    }
    const done = expectStatus(await s.a.post(`/api/photos/${photoId}/complete`, {}), 200, 202);
    let photo = done.body.photo;
    const t0 = Date.now();
    while (photo.status !== 'READY') {
      check(photo.status !== 'FAILED' && Date.now() - t0 < 60_000, `F14 照片未就绪：${photo.status} ${photo.failureReason ?? ''}`);
      await sleep(300);
      photo = expectStatus(await s.a.get(`/api/photos/${photoId}`), 200).body;
    }
    return `photoId=${photoId} · ${jpeg.length} 字节 · ${done.status}`;
  });
}
