import { describe, expect, it } from 'vitest';
import type { ModuleCapability } from '@cloudalbum/contracts';
import { capsWith, l0Caps, registry } from '../test/helpers';
import { badgeFor, fillTemplate, outcomeLabel, processedByText } from './badges';

const cap = (patch: Partial<ModuleCapability> = {}, id: keyof ReturnType<typeof l0Caps>['modules'] = 'cdn'): ModuleCapability =>
  ({ ...l0Caps().modules[id], ...patch });

describe('fillTemplate', () => {
  it('替换占位符；缺值时连同分隔符一起去掉', () => {
    expect(fillTemplate('图片由 CloudFront 提供 · {cacheState}', { cacheState: 'HIT' })).toBe('图片由 CloudFront 提供 · HIT');
    expect(fillTemplate('图片由 CloudFront 提供 · {cacheState}', {})).toBe('图片由 CloudFront 提供');
    expect(fillTemplate('时间线 · ElastiCache {outcome}', {})).toBe('时间线 · ElastiCache');
    expect(fillTemplate('Multi-AZ {multiAz}', { multiAz: true })).toBe('Multi-AZ 开');
  });

  it('outcomeLabel 统一大小写', () => {
    expect(outcomeLabel('hit')).toBe('HIT');
    expect(outcomeLabel('miss')).toBe('MISS');
    expect(outcomeLabel('refreshhit')).toBe('RefreshHit');
    expect(outcomeLabel(undefined)).toBeUndefined();
  });
});

describe('badgeFor（文案全部来自 registry 的 lab.badges）', () => {
  it('未启用 = 本地实现文案，灰色', () => {
    const b = badgeFor('cdn', l0Caps().modules.cdn, registry);
    expect(b).toMatchObject({ text: '图片由 EC2 Nginx 直出', tone: 'local' });
    expect(b.title).toContain('off');
  });

  it('cache=none 用与驱动同名的键', () => {
    expect(badgeFor('cache', l0Caps().modules.cache, registry).text).toBe('时间线 · 未缓存');
  });

  it('cache 本地档 memory：local 文案 + 请求级结果；HIT 为绿色', () => {
    const c = cap({ driver: 'memory' }, 'cache');
    expect(badgeFor('cache', c, registry, { outcome: 'hit' })).toMatchObject({ text: '时间线 · 进程内缓存 · HIT', tone: 'hit' });
    expect(badgeFor('cache', c, registry, { outcome: 'miss' })).toMatchObject({ text: '时间线 · 进程内缓存 · MISS', tone: 'local' });
  });

  it('已启用 = AWS 文案，橙色；CDN 有缓存状态时用 awsWithCache', () => {
    const c = cap({ driver: 'cloudfront', status: 'ok' });
    expect(badgeFor('cdn', c, registry)).toMatchObject({ text: '图片由 CloudFront 提供', tone: 'aws' });
    expect(badgeFor('cdn', c, registry, { outcome: 'hit' })).toMatchObject({ text: '图片由 CloudFront 提供 · HIT', tone: 'hit' });
    expect(badgeFor('cdn', c, registry, { outcome: 'unknown' })).toMatchObject({ text: '由 CloudFront 提供 · 状态未知', tone: 'unknown' });
  });

  it('管理员旁路为紫色；error-bypass 为黄色降级', () => {
    const c = cap({ driver: 'redis', status: 'ok' }, 'cache');
    expect(badgeFor('cache', c, registry, { outcome: 'bypass' }).tone).toBe('bypass');
    expect(badgeFor('cache', c, registry, { outcome: 'error-bypass' })).toMatchObject({ tone: 'degraded', text: '缓存降级（按未命中处理）' });
  });

  it('degraded / error 状态覆盖请求级结果，与 capabilities 一致', () => {
    expect(badgeFor('cdn', cap({ driver: 'cloudfront', status: 'degraded' }), registry, { outcome: 'hit' })).toMatchObject({ tone: 'degraded', text: 'CDN 降级' });
    expect(badgeFor('cdn', cap({ driver: 'cloudfront', status: 'error' }), registry)).toMatchObject({ tone: 'error', text: 'CDN 故障' });
    // 本地实现自身降级：沿用本地文案并附“降级”
    expect(badgeFor('storage', cap({ localHealth: 'degraded' }, 'storage'), registry)).toMatchObject({ tone: 'degraded', text: '存储于 EC2 本地磁盘（EBS） · 降级' });
  });

  it('variant：storage 的上传按钮', () => {
    const caps = l0Caps();
    expect(badgeFor('storage', caps.modules.storage, registry, { variant: 'upload' }).text).toBe('上传到 EC2（签名 URL）');
    const s3 = capsWith({ storage: { driver: 's3', status: 'ok' } }).modules.storage;
    expect(badgeFor('storage', s3, registry, { variant: 'upload' })).toMatchObject({ text: '直传 Amazon S3（预签名 URL）', tone: 'aws' });
  });

  it('iam=keys 用与驱动同名的反面教材文案；database 自建档用 selfHosted', () => {
    expect(badgeFor('iam', cap({ driver: 'keys', status: 'degraded' }, 'iam'), registry).tone).toBe('degraded');
    expect(badgeFor('iam', cap({ driver: 'keys', status: 'ok' }, 'iam'), registry).text).toBe('长期访问密钥（AKIA…，反面教材）');
    expect(badgeFor('database', cap({ driver: 'postgres' }, 'database'), registry).text).toBe('PostgreSQL（EC2 自建）');
    expect(badgeFor('database', cap({ driver: 'postgres', status: 'ok' }, 'database'), registry).text).toBe('Amazon RDS for PostgreSQL · Multi-AZ 未知');
  });

  it('registry 没有 badges 的模块退回通用文案', () => {
    const b = badgeFor('social-store', l0Caps().modules['social-store'], registry);
    expect(b.text).toContain('db');
    expect(b.tone).toBe('local');
  });

  it('ec2 页脚文案带实例变量', () => {
    const b = badgeFor('ec2', l0Caps().modules.ec2, registry, { variant: 'footer', vars: { instanceId: 'i-1', instanceType: 't4g.small', az: 'ap-northeast-1a', deployMode: 'single' } });
    expect(b.text).toBe('运行在 EC2 · i-1 · t4g.small · ap-northeast-1a · single');
  });

  it('processedByText：Lambda 冷启动', () => {
    expect(processedByText(registry, { driver: 'lambda', durationMs: 812.4, coldStart: true })).toEqual({ text: '缩略图由 AWS Lambda 生成 · 812 ms · 冷启动', tone: 'aws' });
    expect(processedByText(registry, { driver: 'inline', durationMs: 95 })).toEqual({ text: '缩略图由 EC2 生成 · 95 ms（inline）', tone: 'local' });
  });
});
