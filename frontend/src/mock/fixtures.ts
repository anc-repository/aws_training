// 开发用模拟后端的固定数据：L0 的 /api/capabilities（除 ec2 外全部 off、localHealth=ok）与示例图片。
// 只在开发模式（vite dev）或测试中加载；生产构建不包含 src/mock（main.tsx 以 import.meta.env.DEV 守卫动态 import）。
import {
  CAPABILITIES_SCHEMA_VERSION, MODULE_IDS, isParamSwitch,
  type CapabilitiesResponse, type ModuleCapability, type ModuleId, type RegistryDocument,
} from '@cloudalbum/contracts';

/** 参数型模块由参数推导出的本地驱动名（总纲 6.1） */
const PARAM_LOCAL_DRIVER: Partial<Record<ModuleId, string>> = {
  cdn: 'direct', 'identity-pool': 'none', autoscaling: 'single', 'social-api': 'express', kms: 'local',
};

const LOCAL_DETAIL: Partial<Record<ModuleId, string>> = {
  ec2: 'mock · 本机开发 · 数据目录可写',
  iam: '不访问 AWS（IAM_CREDENTIALS=none）',
  storage: '本地磁盘 uploads/ 可写 · 剩余 81%',
  cdn: '未启用：媒体由 EC2 上的 Nginx 直出（X-Accel-Redirect）',
  auth: '本地账号：ES256 JWKS 含当前与上一版本 kid',
  'identity-pool': '本地前缀上传令牌（应用自签 HMAC，前缀 raw/<userId>/）',
  database: 'SQLite（EBS 文件）select 1 = 0.2ms',
  cache: '未启用缓存：每次时间线请求都查库',
  queue: 'sync：任务在请求内当场执行',
  'image-processing': 'inline：complete 请求内调用 sharp',
  'social-store': '点赞、评论、分享链接存于关系库（likes / comments / share_links）',
  'social-api': '点赞/评论由 EC2 上的 Express /social 路由提供',
  email: 'outbox：邮件写入本地 .eml 与 outbox_emails 表，未真正发出',
  notification: '站内信 + 逐个调用 EmailPort',
  scheduler: 'node-cron（worker 进程内）',
  cost: '当前没有按小时计费的模块资源（只有 EC2 实例与公网 IPv4）；未填写 cost-rates.yaml，不显示金额',
};

export function localDriverOf(reg: RegistryDocument, id: ModuleId): string {
  if (id === 'ec2') return 'single';
  const sw = reg.modules[id]?.switch;
  if (!sw) return 'none';
  if (isParamSwitch(sw)) return PARAM_LOCAL_DRIVER[id] ?? 'none';
  return sw.values[0] ?? 'none';
}

export function buildL0Capabilities(reg: RegistryDocument, view: 'public' | 'admin' = 'public'): CapabilitiesResponse {
  const now = new Date().toISOString();
  const modules = {} as Record<ModuleId, ModuleCapability>;
  for (const id of MODULE_IDS) {
    const r = reg.modules[id];
    const driver = localDriverOf(reg, id);
    const sw = r?.switch;
    const cap: ModuleCapability = {
      driver,
      awsService: r?.awsService ?? id,
      type: r?.type ?? 'adapter',
      status: id === 'ec2' ? 'ok' : 'off',
      ...(id === 'ec2' ? {} : { localHealth: 'ok' as const }),
      detail: LOCAL_DETAIL[id] ?? `未启用：${r?.function ?? id}由本地实现提供`,
      since: now,
      lastProbeAt: now,
      ...(sw ? { switch: { var: sw.var, value: isParamSwitch(sw) ? '' : driver, localValue: isParamSwitch(sw) ? '' : driver } } : {}),
      ...(id !== 'ec2' ? { deps: { requires: [], credentials: r?.credentials ?? 'none', satisfied: true } } : {}),
      ...(r?.bypass?.length ? { bypass: [...r.bypass] } : {}),
      ...(view === 'admin' ? { probeHistory: [{ at: now, status: 'ok' as const, latencyMs: 1, detail: LOCAL_DETAIL[id] ?? 'ok' }] } : {}),
    };
    modules[id] = cap;
  }
  modules.auth.public = {
    driver: 'local', mfa: 'optional',
    passwordPolicy: { minLength: 8, requireUpper: false, requireDigit: true, requireSymbol: false },
  };
  modules.cdn.public = { baseUrl: '' };
  modules['social-api'].public = { baseUrl: '' };
  return {
    schemaVersion: CAPABILITIES_SCHEMA_VERSION,
    generatedAt: now,
    view,
    app: {
      version: '0.1.0-mock',
      profile: 'l0-ec2',
      deployMode: 'single',
      region: 'ap-northeast-1',
      instance: { id: 'i-0mock0000000000001', az: 'ap-northeast-1a', type: 't4g.small', role: 'api' },
      entry: { baseUrl: globalThis.location?.origin ?? 'http://localhost:5173', source: 'base' },
      configHash: 'sha256:mock',
      startedAt: now,
    },
    https: { trusted: false, via: 'none' },
    validation: { errors: [], warnings: [], overridden: [] },
    modules,
    features: {
      'F6.upload': { enabled: true, via: ['storage:local'] },
      'F12.albAuth': { enabled: false, reason: '组合子功能：需要 load-balancer + auth(cognito) + HTTPS 监听器（DEP-011）' },
      'F14.directUpload': { enabled: true, via: ['identity-pool:none'], detail: '本地前缀令牌；启用 identity-pool 后改为 STS 临时凭证' },
    },
    lab: { bypassEnabled: true, bypassKeys: ['cache', 'cdn', 'queue', 'image', 'tagger', 'tracing', 'analytics', 'replica', 'kms', 'identity-pool'] },
  };
}

const PALETTE = ['#0f6e6e', '#a8380a', '#1f5fad', '#6a3ea1', '#1b703f', '#8a6100', '#5a606b', '#b3261e'];

/** 示例照片：内联 SVG（不依赖网络） */
export function sampleImage(i: number, label: string): { url: string; color: string } {
  const c1 = PALETTE[i % PALETTE.length]!;
  const c2 = PALETTE[(i + 3) % PALETTE.length]!;
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="1080" height="810" viewBox="0 0 1080 810">`
    + `<defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="${c1}"/><stop offset="1" stop-color="${c2}"/></linearGradient></defs>`
    + `<rect width="1080" height="810" fill="url(#g)"/>`
    + `<circle cx="${300 + (i * 97) % 500}" cy="${250 + (i * 53) % 300}" r="${120 + (i * 31) % 90}" fill="rgba(255,255,255,0.18)"/>`
    + `<text x="40" y="770" font-family="sans-serif" font-size="44" fill="rgba(255,255,255,0.85)">${label}</text></svg>`;
  return { url: `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`, color: c1 };
}
