// 管理后台（F12）与 /api/lab/*（§7.3、§8）
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import { ulid } from 'ulid';
import { hashPassword } from '../../src/adapters/auth/local/hash.js';
import { createUserWithDefaults } from '../../src/services/user-directory.js';
import { makeHarness, writeRuntime, type Harness } from '../helpers/identity-harness.js';

let h: Harness;
const PASSWORD = 'Correct-horse-42';

async function login(email: string, role: 'admin' | 'member' = 'member') {
  const user = await createUserWithDefaults(h.c.db, { email, displayName: email.split('@')[0]!, passwordHash: await hashPassword(PASSWORD), emailVerified: true, role });
  const agent = request.agent(h.app);
  await agent.post('/api/auth/login').send({ email, password: PASSWORD }).expect(200);
  return { agent, userId: user.id };
}

let admin: Awaited<ReturnType<typeof login>>;
let member: Awaited<ReturnType<typeof login>>;

beforeAll(async () => {
  h = await makeHarness();
  admin = await login('root@example.com', 'admin');
  member = await login('mallory@example.com');
});

afterAll(async () => {
  await h?.close();
});

describe('管理后台 /api/admin/*', () => {
  it('非管理员 403，未登录 401', async () => {
    await request(h.app).get('/api/admin/users').expect(401);
    const r = await member.agent.get('/api/admin/users').expect(403);
    expect(r.body.error).toBe('FORBIDDEN');
  });

  it('用户列表（搜索 + 分页）', async () => {
    const all = await admin.agent.get('/api/admin/users').expect(200);
    expect(all.body.items.length).toBeGreaterThanOrEqual(2);
    expect(all.body.items[0]).toHaveProperty('photoCount');
    const found = await admin.agent.get('/api/admin/users?q=mallory').expect(200);
    expect(found.body.items).toHaveLength(1);
    expect(found.body.items[0]).toMatchObject({ email: 'mallory@example.com', role: 'member', disabled: false, provider: 'local' });
    const page = await admin.agent.get('/api/admin/users?limit=1').expect(200);
    expect(page.body.nextCursor).toBeTruthy();
    const page2 = await admin.agent.get(`/api/admin/users?limit=1&cursor=${page.body.nextCursor}`).expect(200);
    expect(page2.body.items[0].id).not.toBe(page.body.items[0].id);
  });

  it('改角色立即生效（缓存失效）；禁用后该用户的令牌立即失效；不能降级自己', async () => {
    const target = await login('trent@example.com');
    await target.agent.get('/api/admin/users').expect(403);
    const promoted = await admin.agent.patch(`/api/admin/users/${target.userId}`).send({ role: 'admin' }).expect(200);
    expect(promoted.body.role).toBe('admin');
    await target.agent.get('/api/admin/users').expect(200);
    await admin.agent.patch(`/api/admin/users/${target.userId}`).send({ disabled: true }).expect(200);
    await target.agent.get('/api/notifications').expect(401);
    await request(h.app).post('/api/auth/login').send({ email: 'trent@example.com', password: PASSWORD }).expect(403);
    await admin.agent.patch(`/api/admin/users/${admin.userId}`).send({ role: 'member' }).expect(409);
    await admin.agent.patch('/api/admin/users/nope').send({ role: 'member' }).expect(404);
    const audit = await h.c.db('audit_log').whereIn('action', ['admin.user.role_change', 'admin.user.disable']);
    expect(audit).toHaveLength(2);
    expect(audit[0]).toMatchObject({ actor_type: 'admin', actor_id: admin.userId });
  });

  it('outbox：列表、筛选、正文预览与 .eml 下载', async () => {
    await request(h.app).post('/api/auth/register').send({ email: 'peggy@example.com', password: PASSWORD }).expect(201);
    const list = await admin.agent.get('/api/admin/outbox?to=peggy').expect(200);
    expect(list.body.items).toHaveLength(1);
    expect(list.body.items[0]).toMatchObject({ category: 'verification', transport: 'outbox', status: 'sent', to: ['peggy@example.com'] });
    const detail = await admin.agent.get(`/api/admin/outbox/${list.body.items[0].id}`).expect(200);
    expect(detail.body.html).toContain('<a href=');
    expect(detail.body.text).toContain('/verify?');
    expect(detail.headers['content-security-policy']).toContain("default-src 'none'");
    const eml = await admin.agent.get(detail.body.emlUrl).expect(200);
    expect(eml.headers['content-type']).toMatch(/message\/rfc822/);
    expect(eml.text).toMatch(/^From: /m);
    expect(eml.text).toMatch(/Content-Type: multipart\/alternative/);
    const none = await admin.agent.get('/api/admin/outbox?category=report').expect(200);
    expect(none.body.items).toEqual([]);
  });

  it('审计：列表与哈希链校验；篡改（伪造一行）被发现', async () => {
    const list = await admin.agent.get('/api/admin/audit?action=user.*').expect(200);
    expect(list.body.items.length).toBeGreaterThan(0);
    expect(list.body.items[0]).toHaveProperty('hash');
    const ok = await admin.agent.get('/api/admin/audit/verify').expect(200);
    expect(ok.body).toMatchObject({ ok: true, brokenAt: null, hashChain: 'on' });
    const csv = await admin.agent.get('/api/admin/audit.csv').expect(200);
    expect(csv.text.split('\r\n')[0]).toBe('id,ts,actor_type,actor_id,actor_email,action,target_type,target_id,result,source_ip,request_id,details');
    // 绕过应用直接写库（拥有数据库权限的人可以这样做）：哈希链只能发现、不能防止
    const last = await h.c.db('audit_log').orderBy('id', 'desc').first();
    await h.c.db('audit_log').insert({ ts: new Date().toISOString(), actor_type: 'system', action: 'forged', result: 'success', prev_hash: last.hash, hash: 'f'.repeat(64) });
    const broken = await admin.agent.get('/api/admin/audit/verify').expect(200);
    expect(broken.body.ok).toBe(false);
    expect(broken.body.brokenAt).toBeGreaterThan(last.id);
  });

  it('任务：总览、手动触发、运行记录', async () => {
    const run = await admin.agent.post('/api/admin/jobs/lab.heartbeat/run').expect(200);
    expect(run.body).toMatchObject({ name: 'lab.heartbeat', trigger: 'manual', status: 'ok' });
    await admin.agent.post('/api/admin/jobs/nope/run').expect(404);
    const overview = await admin.agent.get('/api/admin/jobs').expect(200);
    expect(overview.body.queue.driver).toBe('sync');
    expect(overview.body.scheduler.jobs).toHaveLength(8);
    expect(overview.body.scheduler.jobs.find((j: { name: string }) => j.name === 'lab.heartbeat').lastRun.runId).toBe(run.body.runId);
    const runs = await admin.agent.get('/api/admin/jobs/runs?name=lab.heartbeat').expect(200);
    expect(runs.body.items).toHaveLength(1);
    await admin.agent.get('/api/admin/nope').expect(404);
  });
});

describe('/api/lab/*', () => {
  it('仅管理员', async () => {
    await member.agent.get('/api/lab/self-check').expect(403);
    await request(h.app).get('/api/lab/runs').expect(401);
  });

  it('POST /api/lab/runs 后，带 X-Experiment-Run 的请求出现在 /api/lab/metrics?run= 与 requests/recent', async () => {
    const created = await admin.agent.post('/api/lab/runs').send({ module: 'cache', experiment: 'feed-read', label: 'before' }).expect(201);
    const runId = created.body.runId as string;
    expect(runId).toMatch(/^[0-9A-Z]{26}$/);
    await admin.agent.post('/api/lab/runs').send({ runId, module: 'cache', experiment: 'feed-read', label: 'before' }).expect(409);
    for (let i = 0; i < 3; i += 1) {
      await admin.agent.get('/api/albums').set('X-Experiment-Run', runId).set('X-Experiment-Label', 'before').expect(200);
    }
    // 非管理员携带实验头被拒绝（不静默忽略）
    await member.agent.get('/api/albums').set('X-Experiment-Run', runId).expect(403);
    const m = await admin.agent.get(`/api/lab/metrics?run=${runId}`).expect(200);
    expect(m.body.run).toMatchObject({ run_id: runId, module: 'cache', label: 'before' });
    // 按路径签名分组：第一次是 cache=memory:miss，之后两次是 memory:hit
    const albumRows = m.body.routes.filter((r: { group: string }) => r.group.includes('/api/albums'));
    expect(albumRows.map((r: { group: string }) => r.group.split(' | ')[1]).sort()).toEqual([
      expect.stringContaining('cache=memory:hit'), expect.stringContaining('cache=memory:miss'),
    ]);
    expect(albumRows.reduce((n: number, r: { count: number }) => n + r.count, 0)).toBe(3);
    expect(m.body.ports.length).toBeGreaterThan(0);
    expect(m.body.recent.reduce((n: number, r: { count: number }) => n + r.count, 0)).toBe(3);
    const recent = await admin.agent.get(`/api/lab/requests/recent?run=${runId}`).expect(200);
    expect(recent.body.items).toHaveLength(3);
    expect(recent.body.items[0]).toMatchObject({ method: 'GET', route: '/api/albums', status: 200, runId, label: 'before' });
    expect(recent.body.items[0].path).toContain('entry=direct');
    const fin = await admin.agent.post(`/api/lab/runs/${runId}/finish`).send({ notes: 'done' }).expect(200);
    expect(fin.body.finished_at).toBeTruthy();
    const runs = await admin.agent.get('/api/lab/runs?module=cache').expect(200);
    expect(runs.body.items[0].run_id).toBe(runId);
  });

  it('self-check：L0 进程中没有加载任何 @aws-sdk 模块；密钥指纹一致', async () => {
    // 首次启动时由 container 写入指纹（CFG-007）；这里模拟一次
    const { checkKeyFingerprint } = await import('../../src/config/key-fingerprint.js');
    await checkKeyFingerprint(h.c.db, h.c.secrets);
    const r = await admin.agent.get('/api/lab/self-check').expect(200);
    expect(r.body.ok).toBe(true);
    expect(r.body.awsSdk.loaded).toEqual([]);
    expect(r.body.keyFingerprint.match).toBe(true);
    expect(r.body.process.node).toMatch(/^v22\./);
  });

  it('echo 回显请求头', async () => {
    const r = await admin.agent.get('/api/lab/echo').set('X-Forwarded-Proto', 'https').expect(200);
    expect(r.body.headers['x-forwarded-proto']).toBe('https');
    expect(r.body.entry).toBe('direct');
  });

  it("故障注入：总开关 featureFlags['lab.faults'] 关闭时 403；打开后可添加、列出、撤销", async () => {
    await admin.agent.post('/api/lab/faults').send({ type: 'latency', target: 'database', ms: 1, durationSec: 30 }).expect(403);
    writeRuntime(h.envDir, { featureFlags: { 'lab.faults': true } });
    await h.adapters.runtime.refresh();
    const bad = await admin.agent.post('/api/lab/faults').send({ type: 'latency', durationSec: 30 }).expect(400);
    expect(bad.body.error).toBe('INVALID_FAULT');
    const f = await admin.agent.post('/api/lab/faults').send({ type: 'latency', target: 'database', ms: 1, rate: 1, durationSec: 30 }).expect(201);
    expect(f.body.id).toMatch(/^fault-/);
    const list = await admin.agent.get('/api/lab/faults').expect(200);
    expect(list.body).toMatchObject({ enabled: true, items: [{ id: f.body.id, type: 'latency', target: 'database' }] });
    await admin.agent.delete(`/api/lab/faults/${f.body.id}`).expect(204);
    await admin.agent.delete(`/api/lab/faults/${f.body.id}`).expect(404);
    expect((await admin.agent.get('/api/lab/faults')).body.items).toEqual([]);
    expect(await h.c.db('audit_log').where({ action: 'lab.fault' }).first()).toBeTruthy();
    writeRuntime(h.envDir, {});
    await h.adapters.runtime.refresh();
  });

  it('结果上传（幂等覆盖）、列表与详情', async () => {
    const runId = ulid();
    const result = {
      schemaVersion: 1, runId, module: 'queue', experiment: 'upload-burst', label: 'after', forced: false,
      startedAt: '2026-10-13T06:00:00Z', finishedAt: '2026-10-13T06:01:12Z', client: { requests: 10, errors: 0 },
    };
    await admin.agent.post('/api/lab/results').send(result).expect(201);
    await admin.agent.post('/api/lab/results').send({ ...result, notes: 'second upload' }).expect(201);
    await admin.agent.post('/api/lab/results').send({ runId }).expect(400);
    const list = await admin.agent.get('/api/lab/results?module=queue').expect(200);
    expect(list.body.items).toHaveLength(1);
    expect(list.body.items[0]).toMatchObject({ runId, module: 'queue', experiment: 'upload-burst', label: 'after', forced: false });
    const one = await admin.agent.get(`/api/lab/results/${runId}`).expect(200);
    expect(one.body.result).toMatchObject({ notes: 'second upload', client: { requests: 10 } });
    await admin.agent.get('/api/lab/results/NOPE').expect(404);
  });

  it('capability-events 与未实现的模块实验端点（501）', async () => {
    await admin.agent.get('/api/lab/capability-events').expect(200);
    const r = await admin.agent.post('/api/lab/email/compare').send({}).expect(501);
    expect(r.body.error).toBe('NOT_IMPLEMENTED');
  });
});
