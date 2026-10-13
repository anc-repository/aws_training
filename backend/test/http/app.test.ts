// http/app.ts 冒烟：用临时配置目录与 SQLite 文件装配完整的 L0 容器，验证中间件、能力接口、可观测性头与未实现路由的 501
import { mkdtempSync, statfsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import { MODULE_IDS, parsePathHeader, parseServerTiming, type CapabilitiesResponse } from '@cloudalbum/contracts';
import { awsSdkLoadReport } from '../../src/adapters/aws/clients.js';
import { buildContainer, type Container } from '../../src/container.js';
import { createApp } from '../../src/http/app.js';
import { ConfigValidationError } from '../../src/errors.js';
import { tempEnvDir } from '../helpers/config.js';

let c: Container;
let app: ReturnType<typeof createApp>;
let dataDir: string;

beforeAll(async () => {
  const data = mkdtempSync(path.join(os.tmpdir(), 'cloudalbum-data-'));
  dataDir = data;
  const envDir = tempEnvDir({ base: { APP_BASE_URL: 'http://localhost:3000', CLOUDALBUM_DATA_DIR: data.replace(/\\/g, '/') } });
  c = await buildContainer('api', { envDir, processEnv: { NODE_ENV: 'test' } });
  app = createApp(c);
});

afterAll(async () => {
  await c?.close();
});

describe('L0 容器 + HTTP 骨架', () => {
  it('GET /api/health/live 返回 200，并带可观测性头', async () => {
    const res = await request(app).get('/api/health/live').expect(200);
    expect(res.body.status).toBe('live');
    expect(res.headers['x-cloudalbum-request-id']).toBeTruthy();
    expect(parsePathHeader(res.headers['x-cloudalbum-path']).entry).toBe('direct');
    expect(parseServerTiming(res.headers['server-timing'])[0]?.name).toBe('total');
  });

  it('GET /api/capabilities：40 个模块；L0 下除 ec2 外全部 off；validation 为空', async () => {
    const res = await request(app).get('/api/capabilities').expect(200);
    const body = res.body as CapabilitiesResponse;
    expect(res.headers['cache-control']).toBe('no-store');
    expect(res.headers.etag).toBeTruthy();
    expect(body.schemaVersion).toBe(2);
    expect(body.view).toBe('public');
    expect(Object.keys(body.modules)).toEqual([...MODULE_IDS]);
    expect(body.modules.ec2.status).not.toBe('off');
    expect(body.modules.ec2.localHealth).toBeUndefined();
    for (const id of MODULE_IDS.filter((m) => m !== 'ec2')) {
      expect(body.modules[id].status, id).toBe('off');
      expect(body.modules[id].localHealth, id).toBeDefined();
    }
    expect(body.modules.storage.driver).toBe('local');
    expect(body.modules.cdn.driver).toBe('direct');
    expect(body.modules.iam.switch).toEqual({ var: 'IAM_CREDENTIALS', value: 'none', localValue: 'none' });
    expect(body.validation).toEqual({ errors: [], warnings: [], overridden: [] });
    expect(body.app.profile).toBe('l0-ec2');
    expect(body.https).toEqual({ trusted: false, via: 'none' });
    expect(body.features['F14.directUpload']?.via).toEqual(['identity-pool:none']);
    expect(body.lab.bypassKeys).toHaveLength(10);
    await request(app).get('/api/capabilities').set('If-None-Match', res.headers.etag as string).expect(304);
  });

  it('database 探针真实运行（SQLite），并计入请求的 Server-Timing', async () => {
    const res = await request(app).get('/api/capabilities').expect(200);
    const db = (res.body as CapabilitiesResponse).modules.database;
    // 03#database 第 10 节：SQLite 数据卷剩余 < 15% 时 degraded——断言跟随本机磁盘水位，不与开发机的系统盘耦合
    const st = statfsSync(dataDir);
    const freePct = (Number(st.bavail) / Number(st.blocks)) * 100;
    expect(db.localHealth).toBe(freePct < 15 ? 'degraded' : 'ok');
    expect(db.detail).toContain('SQLite');
  });

  it('需要登录的接口返回 401；未登记的 /internal/* 与未知 API 返回 404', async () => {
    const r1 = await request(app).get('/api/albums').expect(401);   // albums 已实现（local-identity）：匿名访问需要登录
    expect(r1.body).toMatchObject({ error: 'UNAUTHENTICATED' });
    await request(app).post('/api/photos/abc/complete').expect(401);           // photos 已实现（local-media）
    await request(app).get('/api/me').expect(401);                             // me 已实现（integration）
    const jwks = await request(app).get('/.well-known/jwks.json');            // auth=local 发布 JWKS；本测试的配置目录没有签名密钥 → 503
    expect([200, 503]).toContain(jwks.status);
    await request(app).post('/internal/hooks/image-processed').expect(404);   // IMAGE_PROCESSOR=inline：端点未启用
    await request(app).get('/internal/anything').expect(404);
    await request(app).get('/api/nope').expect(404);
  });

  it('非管理员携带 X-Compare-Bypass 返回 403 BYPASS_FORBIDDEN（不静默忽略）', async () => {
    const res = await request(app).get('/api/feed').set('X-Compare-Bypass', 'cache').expect(403);
    expect(res.body.error).toBe('BYPASS_FORBIDDEN');
  });

  it('/api/health/ready?scope=instance 只看本实例条件', async () => {
    await request(app).get('/api/health/ready?scope=instance').expect(200);
  });

  it('L0 进程中没有加载任何 @aws-sdk 模块', () => {
    expect(awsSdkLoadReport()).toEqual({ viaFactory: [], inRequireCache: [] });
  });

  it('配置错误时 buildContainer 抛出 ConfigValidationError（入口以 78 退出）', async () => {
    const envDir = tempEnvDir({ modules: { storage: { STORAGE_DRIVER: 's3', STORAGE_S3_RAW_BUCKET: 'r', STORAGE_S3_MEDIA_BUCKET: 'm' } } });
    await expect(buildContainer('api', { envDir, processEnv: { NODE_ENV: 'test' } })).rejects.toBeInstanceOf(ConfigValidationError);
  });
});
