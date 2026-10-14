// backend/src/adapters/cost/lab-routes.ts —— cost 的 /lab 侧路端点（06#cost 第 2、5、11 节；仅管理员）
//
//   GET  /api/lab/cost            本地清单（立即）+ 两个预算的实际 / 预测 / 上限（budgets 档，滞后）+ 最近一次 Cost Explorer 结果（缓存）
//                                 + 当前的空开 / 资源小时预算提醒（/lab 顶部提示条）
//   POST /api/lab/cost/refresh    body { confirm: "ce-charges", force?: true }：调用一次 ce:GetCostAndUsage（本月按天、按 Module 标签分组），
//                                 结果缓存 12 小时。Cost Explorer API **按请求计费**：没有 confirm 时返回 428，不发请求；
//                                 COST_CE_QUERY=off 或 COST_MODE=local 时返回 409。
// 对比实验（experiments/cost）只经这些端点取数据，不在工作台上调用 AWS SDK。
// 注册：与 http/routes/*.ts 相同的 register(app, c) 形状；由集成阶段加入 http/app.ts 的 ROUTE_MODULES（先于 routes/lab.ts）。
import type { Express } from 'express';
import { z } from 'zod';
import type { Container } from '../../container.js';
import { HttpError } from '../../errors.js';
import { requireAdmin } from '../../http/middleware/admin.js';
import { requireAuth } from '../../http/middleware/auth.js';
import { parseBody } from '../../http/routes/auth.js';
import { CostDetector } from '../../modules/detectors/cost.js';
import { describeAwsError, isAwsAccessDenied } from '../aws/clients.js';
import { idleCandidates, lastLabActivity, startCostIdleLoop } from './idle.js';

export const PATHS = ['/api/lab/cost', '/api/lab/cost/refresh'] as const;

/** POST /api/lab/cost/refresh 的确认词：调用方必须原样带上，表示“知道这次调用按请求计费” */
export const CE_CONFIRM = 'ce-charges';

const RefreshBody = z.object({ confirm: z.string().optional(), force: z.boolean().optional() });

export function costDetectorOf(c: Pick<Container, 'detectors'>): CostDetector | undefined {
  return c.detectors.find((d): d is CostDetector => d instanceof CostDetector);
}

/** worker 装配用（集成阶段在 worker.ts 中调用）：空开提醒与资源小时预算提醒，与 COST_MODE 无关、始终开启 */
export function startCostIdle(c: Pick<Container, 'db' | 'lock' | 'email' | 'logger' | 'config' | 'detectors'>, signal: AbortSignal): (() => void) | undefined {
  const det = costDetectorOf(c);
  if (!det) return undefined;
  return startCostIdleLoop({
    db: c.db, estimate: () => det.estimate(), idleHours: c.config.cost.COST_LOCAL_IDLE_HOURS, lock: c.lock, email: c.email, logger: c.logger,
    appBaseUrl: c.config.core.APP_BASE_URL,
  }, signal);
}

export function register(app: Express, c: Container): void {
  const admin = [requireAuth, requireAdmin];

  app.get('/api/lab/cost', ...admin, async (_req, res) => {
    res.set('Cache-Control', 'no-store');
    const det = costDetectorOf(c);
    if (!det) throw new HttpError(503, 'COST_DETECTOR_MISSING', 'cost 感知器未登记');
    const cfg = c.config.cost;
    const est = det.estimate();
    const reminders = idleCandidates(est, { idleHours: cfg.COST_LOCAL_IDLE_HOURS, lastActivity: await lastLabActivity(c.db), now: new Date() });
    const body: Record<string, unknown> = {
      mode: cfg.COST_MODE, ceQuery: cfg.COST_CE_QUERY, tag: { key: cfg.COST_TAG_KEY, value: cfg.COST_TAG_VALUE },
      local: { ...est, note: '本地估算：registry 计费维度 × 模块启用时长；不是账单（看不到数据传输、请求类费用、手工资源与税费）' },
      reminders,
    };
    if (cfg.COST_MODE === 'budgets') {
      if (!det.reader) body.budgets = { error: 'IAM_CREDENTIALS=none：读不到 AWS Budgets（CRED-004）' };
      else {
        try {
          body.budgets = { items: await det.reader.budgets(), note: 'AWS Budgets：依据实际账单数据，滞后数小时到一天' };
        } catch (e) {
          body.budgets = { error: describeAwsError(e) };
        }
        body.subscriptions = await det.reader.subscriptions().catch((e: unknown) => ({ error: describeAwsError(e) }));
        const tag = det.reader.cachedTagStatus();
        if (tag) body.tagStatus = tag;
        const ce = det.reader.cachedCostAndUsage();
        if (ce) body.explorer = { ...ce, cached: true };
      }
    }
    res.json(body);
  });

  app.post('/api/lab/cost/refresh', ...admin, async (req, res) => {
    res.set('Cache-Control', 'no-store');
    const cfg = c.config.cost;
    if (cfg.COST_MODE !== 'budgets') throw new HttpError(409, 'COST_MODE_LOCAL', 'COST_MODE=local：Cost Explorer 需要先启用 cost（scripts/module enable cost）');
    if (cfg.COST_CE_QUERY === 'off') throw new HttpError(409, 'COST_CE_QUERY_OFF', 'COST_CE_QUERY=off：已关闭 Cost Explorer 查询');
    const body = parseBody(RefreshBody, req.body);
    if (body.confirm !== CE_CONFIRM) {
      throw new HttpError(428, 'CONFIRMATION_REQUIRED', `Cost Explorer API 按请求计费：确认后再调用（请求体 {"confirm":"${CE_CONFIRM}"}）；12 小时内的结果会直接复用缓存`);
    }
    const det = costDetectorOf(c);
    if (!det?.reader) throw new HttpError(409, 'AWS_CREDENTIALS_UNAVAILABLE', 'IAM_CREDENTIALS=none：无法调用 Cost Explorer');
    try {
      const r = await det.reader.costAndUsage({ confirmed: true, ...(body.force ? { force: true } : {}) });
      res.json({ ...r.result, cached: r.cached, note: r.cached ? '12 小时内的缓存结果（没有发出新的计费请求）' : '已调用 ce:GetCostAndUsage 一次（按请求计费）' });
    } catch (e) {
      if (isAwsAccessDenied(e)) throw new HttpError(403, 'CE_ACCESS_DENIED', describeAwsError(e));
      throw new HttpError(502, 'CE_FAILED', describeAwsError(e));
    }
  });
}
