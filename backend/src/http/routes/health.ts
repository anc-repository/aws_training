// backend/src/http/routes/health.ts —— 健康检查（总纲 5.3 第 4 条、6.3）与本机 Prometheus 指标
//
// - GET /api/health/live：进程存活，始终 200；
// - GET /api/health/ready：所有权威端口不为 error（含共享依赖，供人和 capabilities 使用），否则 503；
// - GET /api/health/ready?scope=instance：只检查本实例条件（进程、配置、未 draining、本机数据目录可写）——
//   ALB 目标组、ASG（HealthCheckType=ELB）与 Route 53 健康检查一律用它；
// - GET /metrics：LabMetricsStore 的 Prometheus 文本格式，仅允许本机访问（Nginx 同样只放行 127.0.0.1）。
import type { Express } from 'express';
import type { Container } from '../../container.js';
import { unregisteredRunHeaders } from '../../observability/bypass.js';
import { probeCounters } from '../middleware/atl-probe.js';
import { isLoopback } from '../../config/net.js';

export function register(app: Express, c: Container): void {
  app.get('/api/health/live', (_req, res) => {
    res.set('Cache-Control', 'no-store').json({ status: 'live', role: c.role });
  });

  app.get('/api/health', (_req, res) => {
    res.set('Cache-Control', 'no-store').json({ status: 'live', role: c.role, modules: c.capabilities.summary() });
  });

  app.get('/api/health/ready', (req, res) => {
    const scope = req.query.scope === 'instance' ? 'instance' : 'all';
    const r = c.capabilities.readiness(scope);
    res.status(r.ok ? 200 : 503).set('Cache-Control', 'no-store').json({ status: r.ok ? 'ready' : 'not-ready', scope, failing: r.failing });
  });

  app.get('/metrics', (req, res) => {
    if (!isLoopback(req.socket.remoteAddress ?? '')) {
      res.status(403).json({ error: 'FORBIDDEN' });
      return;
    }
    // ATL 平台模式的计数器（06 PM-10、PM-40）：只在出现过时输出，独立模式下与原来逐字节一致
    const extra = [...probeCounters.prometheus(c.role)];
    if (unregisteredRunHeaders.total > 0) {
      extra.push('# TYPE cloudalbum_lab_unregistered_run_header_total counter',
        `cloudalbum_lab_unregistered_run_header_total{role="${c.role}"} ${unregisteredRunHeaders.total}`);
    }
    res.type('text/plain; version=0.0.4').send(`${c.labMetrics.toPrometheus()}${extra.length ? `${extra.join('\n')}\n` : ''}`);
  });
}
