// backend/src/adapters/waf/lab-routes.ts —— waf 的管理端点与 /lab 侧路端点（01#waf 第 2、5、11 节；仅管理员；wave1-waf）
//
//   GET    /api/admin/security/blocklist             封禁列表（denylist.conf 的有效条目）、驱动、生效方式、最近一次 IP 集合同步
//   POST   /api/admin/security/blocklist             {cidr, note?, ttlSec?} → BlocklistPort.add；aws 驱动返回 {effective: propagating}
//   DELETE /api/admin/security/blocklist?cidr=<CIDR>  → BlocklistPort.remove
//   POST   /api/lab/waf/sync                         立即把 denylist 同步到 IP 集合（只在 WAF_MODE=aws；nginx 返回 409）
//   GET    /api/lab/waf/origin?run=<ULID>[&nonce=]   源站 Nginx 访问日志中带该实验运行 ID（X-Experiment-Run → 日志 run 字段）的行：
//                                                    总数、按状态码、按端口（8080 = 经 CloudFront 回源）、是否带 X-Amz-Cf-Id；
//                                                    nonce 另按查询串 atlprobe=<nonce> 计数（与检查包 nginx-log-summary 同一规则）
// 对比实验（experiments/waf）用 /api/lab/waf/origin 取服务端证据：被 AWS WAF 拦截的请求根本不会出现在源站日志里，
// 被 Nginx 拦截的请求会以 429 / 403 出现——只看客户端收到的响应头无法区分两者。
// 注册：与 http/routes/*.ts 相同的 register(app, c) 形状；由集成阶段加入 http/app.ts 的 ROUTE_MODULES（先于 routes/lab.ts）。
// register() 顺带把登记表中的 waf 感知器交给 aws 驱动（attachDetector），这样 api 进程的探针有被动比例。
import path from 'node:path';
import type { Express } from 'express';
import { z } from 'zod';
import type { Container } from '../../container.js';
import { HttpError } from '../../errors.js';
import { requireAdmin } from '../../http/middleware/admin.js';
import { audit } from '../../http/middleware/audit.js';
import { requireAuth } from '../../http/middleware/auth.js';
import { parseBody } from '../../http/routes/auth.js';
import { WafDetector } from '../../modules/detectors/waf.js';
import { scanNginxLog, type NginxLogLine } from '../../observability/nginx-log.js';
import { describeAwsError } from '../aws/clients.js';
import type { AwsBlocklist, BlockEffect } from './aws.js';
import { isCidr } from './nginx.js';

export const PATHS = ['/api/admin/security/blocklist', '/api/lab/waf/sync', '/api/lab/waf/origin'] as const;

const AddBody = z.object({
  cidr: z.string().trim().min(2).max(64).refine(isCidr, '不是合法的 IP 或 CIDR'),
  note: z.string().max(200).optional(),
  ttlSec: z.number().int().min(60).max(30 * 86_400).optional(),
});

const RUN_RE = /^[0-9A-HJKMNP-TV-Z]{26}$/;
const NONCE_RE = /^[A-Za-z0-9_-]{8,64}$/;

export interface OriginSummary {
  logPresent: boolean;
  run: string;
  requests: number;
  byStatus: Record<string, number>;
  byPort: Record<string, number>;
  viaCloudfront: number;
  direct: number;
  nonce?: { value: string; count: number; ports: number[] };
}

function argsHas(args: string | undefined, key: string, value: string): boolean {
  if (!args) return false;
  return args.split('&').some((kv) => {
    const i = kv.indexOf('=');
    if (i <= 0 || kv.slice(0, i) !== key) return false;
    try {
      return decodeURIComponent(kv.slice(i + 1)) === value;
    } catch {
      return false;
    }
  });
}

/** 按运行 ID 汇总源站 Nginx 日志（纯函数部分，测试直接调用） */
export function summarizeOriginLines(lines: Iterable<NginxLogLine>, run: string, nonce?: string): Omit<OriginSummary, 'logPresent'> {
  const out: Omit<OriginSummary, 'logPresent'> = { run, requests: 0, byStatus: {}, byPort: {}, viaCloudfront: 0, direct: 0 };
  const n = nonce ? { value: nonce, count: 0, ports: [] as number[] } : undefined;
  for (const l of lines) {
    if (n && argsHas(l.args, 'atlprobe', n.value)) {
      n.count += 1;
      const p = Number(l.port);
      if (Number.isFinite(p) && !n.ports.includes(p)) n.ports.push(p);
    }
    if (!l.run || l.run.toUpperCase() !== run) continue;
    out.requests += 1;
    out.byStatus[String(l.status)] = (out.byStatus[String(l.status)] ?? 0) + 1;
    const port = l.port ?? 'unknown';
    out.byPort[port] = (out.byPort[port] ?? 0) + 1;
    if (l.cfId || port === '8080') out.viaCloudfront += 1;
    else out.direct += 1;
  }
  return { ...out, ...(n ? { nonce: n } : {}) };
}

export async function originSummary(dataDir: string, run: string, nonce?: string, files?: string[]): Promise<OriginSummary> {
  const logDir = path.join(dataDir, 'logs');
  const list = files ?? [path.join(logDir, 'nginx-access.json.1'), path.join(logDir, 'nginx-access.json')];
  const lines: NginxLogLine[] = [];
  const n = await scanNginxLog(list, (l) => {
    if ((l.run && l.run.toUpperCase() === run) || (nonce && l.args?.includes(nonce))) lines.push(l);
  });
  return { logPresent: n > 0, ...summarizeOriginLines(lines, run, nonce) };
}

const LOCAL_EFFECT: BlockEffect = { effective: 'after-reload', synced: false, detail: '已写入 denylist（Nginx reload 后生效，实例上）' };

export function register(app: Express, c: Container): void {
  const admin = [requireAuth, requireAdmin];
  const aws = c.blocklist.meta.driver === 'aws' ? (c.blocklist as unknown as AwsBlocklist) : undefined;
  const det = c.detectors.find((d): d is WafDetector => d instanceof WafDetector);
  if (det) (c.blocklist as Partial<{ attachDetector(d: WafDetector): void }>).attachDetector?.(det);

  app.get('/api/admin/security/blocklist', ...admin, async (_req, res) => {
    res.set('Cache-Control', 'no-store');
    const entries = await c.blocklist.list();
    res.json({
      driver: c.blocklist.meta.driver,
      effective: aws ? 'propagating' : 'after-reload',
      badge: aws ? '封禁 IP：正在传播到 AWS WAF（全局）' : '封禁 IP：reload 后生效（本机）',
      ...(aws ? { ipSet: c.config.waf.WAF_IP_SET_NAME ?? null, scope: c.config.waf.WAF_SCOPE ?? null, lastSync: (await aws.syncState()) ?? null } : {}),
      entries,
    });
  });

  app.post('/api/admin/security/blocklist', ...admin, async (req, res) => {
    const body = parseBody(AddBody, req.body);
    let effect = LOCAL_EFFECT;
    if (aws) effect = await aws.block(body.cidr, body.note ?? '', body.ttlSec);
    else await c.blocklist.add(body.cidr, body.note ?? '', body.ttlSec);
    await audit(c, { action: 'admin.security.block', targetType: 'ip', targetId: body.cidr, details: { driver: c.blocklist.meta.driver, ...effect, ttlSec: body.ttlSec ?? null } });
    res.status(201).json({ cidr: body.cidr, driver: c.blocklist.meta.driver, ...effect });
  });

  app.delete('/api/admin/security/blocklist', ...admin, async (req, res) => {
    const cidr = String(req.query.cidr ?? '').trim();
    if (!isCidr(cidr)) throw new HttpError(400, 'VALIDATION_FAILED', 'cidr 必须是 IP 或 CIDR');
    let effect = LOCAL_EFFECT;
    if (aws) effect = await aws.unblock(cidr);
    else await c.blocklist.remove(cidr);
    await audit(c, { action: 'admin.security.unblock', targetType: 'ip', targetId: cidr, details: { driver: c.blocklist.meta.driver, ...effect } });
    res.json({ cidr, driver: c.blocklist.meta.driver, ...effect });
  });

  app.post('/api/lab/waf/sync', ...admin, async (_req, res) => {
    if (!aws) throw new HttpError(409, 'WAF_MODE_NGINX', 'WAF_MODE=nginx：没有 IP 集合可同步（denylist 只在本机 Nginx 生效）');
    try {
      res.json({ ok: true, ...(await aws.sync()), lastSync: await aws.syncState() });
    } catch (e) {
      throw new HttpError(502, 'WAF_SYNC_FAILED', `同步到 IP 集合失败：${describeAwsError(e)}`);
    }
  });

  app.get('/api/lab/waf/origin', ...admin, async (req, res) => {
    res.set('Cache-Control', 'no-store');
    const run = String(req.query.run ?? '').trim().toUpperCase();
    if (!RUN_RE.test(run)) throw new HttpError(400, 'VALIDATION_FAILED', 'run 必须是实验运行 ID（ULID）');
    const nonce = typeof req.query.nonce === 'string' && req.query.nonce ? req.query.nonce : undefined;
    if (nonce && !NONCE_RE.test(nonce)) throw new HttpError(400, 'VALIDATION_FAILED', 'nonce 只能是 8～64 个字母、数字、_ 或 -');
    res.json({ mode: c.config.waf.WAF_MODE, ...(await originSummary(c.config.core.CLOUDALBUM_DATA_DIR, run, nonce)) });
  });
}
