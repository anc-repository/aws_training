/**
 * Reclaim report and manual list (02 §7.9: `GET /sessions/{sid}/cleanup?format=json|md`), the cross-environment
 * manual list (`GET /resources/manual`), the session's resources (AP15) and the running cost estimate
 * (`GET /sessions/{sid}/cost`, 01 §11.3, 02 §10.2 — dimensions and estimates only, “以账单为准”).
 */
import { apiPath } from '../../http/responses.js';
import type { Item, QuoteItem, ResourceItem, SessionItem } from '../../repositories/index.js';
import type { ServiceContext } from './types.js';

const SEVERITY_ORDER: Record<string, number> = { BLOCKING: 0, REVIEW: 1, INFO: 2 };
const OPEN_STATES = ['MANUAL_REQUIRED', 'FAILED', 'REVIEW'];

export function resourceView(r: ResourceItem): Record<string, unknown> {
  const hint = (r.manualHint ?? null) as { consoleUrl?: string; cli?: string; note?: string } | null;
  return {
    resourceKey: r.resourceKey ?? String(r.SK ?? '').replace(/^RES#/, ''),
    severity: r.severity ?? null,
    type: r.resourceType ?? null,
    region: r.region ?? null,
    id: r.name ?? r.arn ?? null,
    arn: r.arn ?? null,
    source: r.discoveredBy ?? null,
    createdBy: r.creatorSessionName ?? r.createdBy ?? null,
    sessionId: r.sessionId ?? null,
    billing: r.billing ?? null,
    stage: r.stage ?? null,
    cleanupState: r.cleanupState ?? null,
    reason: r.lastError ?? r.reason ?? null,
    hint,
    attempts: r.attempts ?? 0,
    lastTriedAt: r.lastTriedAt ?? r.updatedAt ?? null,
  };
}

export async function cleanupReport(ctx: ServiceContext, s: SessionItem): Promise<Record<string, unknown>> {
  const envId = typeof s.envId === 'string' ? s.envId : null;
  const [ledger, passes] = envId ? await Promise.all([ctx.repos.environments.resources(envId), ctx.repos.environments.passes(envId)]) : [[], []];
  const items = ledger
    .filter((r) => OPEN_STATES.includes(String(r.cleanupState)))
    .sort((a, b) => (SEVERITY_ORDER[String(a.severity)] ?? 9) - (SEVERITY_ORDER[String(b.severity)] ?? 9))
    .map(resourceView);
  const counts: Record<string, number> = {};
  for (const r of ledger) counts[String(r.cleanupState ?? 'TRACKED')] = (counts[String(r.cleanupState ?? 'TRACKED')] ?? 0) + 1;
  return {
    sessionId: s.sid,
    envId,
    status: s.state,
    endReason: s.endReason ?? null,
    cleanup: s.cleanup ?? null,
    reclaim: s.reclaim ?? null,
    passes: passes.map((p: Item) => ({
      passNo: p.passNo ?? null,
      mode: p.mode ?? null,
      startedAt: p.startedAt ?? null,
      finishedAt: p.finishedAt ?? null,
      found: p.found ?? null,
      deleted: p.deleted ?? null,
      manual: p.manual ?? null,
    })),
    counts,
    hourlyBlocking: items.filter((i) => i.severity === 'BLOCKING' && i.billing === 'hourly').length,
    items,
    exports: {
      markdown: `${apiPath('/sessions', s.sid, '/cleanup')}?format=md`,
      json: `${apiPath('/sessions', s.sid, '/cleanup')}?format=json`,
    },
  };
}

const mdEscape = (v: unknown) => String(v ?? '').replace(/\|/g, '\\|').replace(/\r?\n/g, ' ');

/** Markdown export of the manual list (02 §7.9 “支持导出 Markdown”). */
export function cleanupMarkdown(report: Record<string, unknown>): string {
  const items = report.items as Record<string, unknown>[];
  const lines = [
    `# 回收报告：会话 ${String(report.sessionId)}`,
    '',
    `- 环境：${String(report.envId ?? '—')}`,
    `- 状态：${String(report.status)}`,
    `- 待人工处理：${items.length} 项（按小时计费的阻塞项 ${String(report.hourlyBlocking)} 项）`,
    '',
    '| 严重级别 | 类型 | 区域 | 资源 | 计费 | 原因 |',
    '|---|---|---|---|---|---|',
    ...items.map((i) => `| ${mdEscape(i.severity)} | ${mdEscape(i.type)} | ${mdEscape(i.region)} | ${mdEscape(i.id)} | ${mdEscape(i.billing)} | ${mdEscape(i.reason)} |`),
    '',
  ];
  for (const i of items) {
    const hint = i.hint as { consoleUrl?: string; cli?: string; note?: string } | null;
    if (!hint) continue;
    lines.push(`## ${mdEscape(i.type)} ${mdEscape(i.id)}`, '');
    if (hint.consoleUrl) lines.push(`- 控制台：${hint.consoleUrl}`);
    if (hint.note) lines.push(`- 说明：${hint.note}`);
    if (hint.cli) lines.push('', '```bash', hint.cli, '```');
    lines.push('');
  }
  return lines.join('\n');
}

export async function manualResources(ctx: ServiceContext): Promise<Record<string, unknown>> {
  const items = (await ctx.repos.environments.manualItems()).sort(
    (a, b) => (SEVERITY_ORDER[String(a.severity)] ?? 9) - (SEVERITY_ORDER[String(b.severity)] ?? 9),
  );
  const views: Record<string, unknown>[] = items.map((r) => ({ ...resourceView(r), envId: String(r.PK ?? '').replace(/^ENV#/, '') }));
  return {
    items: views,
    total: views.length,
    hourlyBlocking: views.filter((i) => i.severity === 'BLOCKING' && i.billing === 'hourly').length,
  };
}

/** Running cost estimate: billable resources of the session and the quote's hourly range × elapsed time. */
export async function sessionCost(ctx: ServiceContext, s: SessionItem, quote: QuoteItem | null): Promise<Record<string, unknown>> {
  const resources = await ctx.repos.environments.resourcesBySession(s.sid);
  const live = resources.filter((r) => r.cleanupState !== 'DELETED' && r.cleanupState !== 'RESOLVED_BY_LEARNER');
  const start = Date.parse(s.createdAt);
  const end = typeof s.endedAt === 'string' ? Date.parse(s.endedAt) : ctx.nowMs;
  const elapsedHours = Math.max(0, (end - start) / 3_600_000);
  const hourly = (quote?.hourly ?? null) as { completed?: { low?: number; high?: number } | null; start?: { low?: number; high?: number } | null } | null;
  const range = hourly?.completed ?? hourly?.start ?? null;
  const unpriced = live.filter((r) => r.billing === 'hourly' && r.createdBy === 'learner').length;
  return {
    sessionId: s.sid,
    currency: quote?.currency ?? 'USD',
    priceAsOf: quote?.priceAsOf ?? null,
    elapsedHours: Number(elapsedHours.toFixed(2)),
    hourly: range ? { low: range.low ?? null, high: range.high ?? null } : null,
    estimate: range && typeof range.low === 'number' && typeof range.high === 'number' ? { low: Number((range.low * elapsedHours).toFixed(2)), high: Number((range.high * elapsedHours).toFixed(2)) } : null,
    incomplete: (quote?.incomplete as string[] | undefined) ?? [],
    billable: live
      .filter((r) => r.billing && r.billing !== 'none')
      .map((r) => ({ resourceKey: r.resourceKey ?? null, type: r.resourceType ?? null, name: r.name ?? null, billing: r.billing, since: r.createdAt ?? null, createdBy: r.createdBy ?? null })),
    unestimatedManualResources: unpriced,
    disclaimer: '估算值，只含计费维度与按报价折算的金额，以 AWS 账单为准',
  };
}
