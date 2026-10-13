/**
 * 复扫时间线 RescanTimeline（08 P07 状态表“ENDED（复扫窗口内）”、§5.4；02 §7.7）：收回访问后 +20 分钟、+60 分钟、+6 小时各复扫一次。
 * 时间取会话视图 `reclaim.rescanAt[]`；完成情况取回收报告 `passes[]` 中 mode = RESCAN 的轮次（L A）；`reclaim.followUp = DONE` 时全部完成。
 * 观察者读不到回收报告，只按时间显示“未到 / 已到计划时间”。
 */
export interface ReclaimPass {
  passNo?: number | null;
  mode?: string | null;
  startedAt?: string | null;
  finishedAt?: string | null;
  found?: number | null;
  deleted?: number | null;
  manual?: number | null;
}

export type RescanStatus = 'pending' | 'due' | 'running' | 'done' | 'found';

export interface RescanItem {
  index: number;
  at: string;
  offset: string;
  status: RescanStatus;
  doneAt: string | null;
}

export function offsetText(fromIso: string | null | undefined, atIso: string): string {
  if (!fromIso) return '';
  const min = Math.round((Date.parse(atIso) - Date.parse(fromIso)) / 60_000);
  if (!Number.isFinite(min) || min <= 0) return '';
  if (min <= 60) return `+${min} 分钟`;
  const h = min / 60;
  return `+${Number.isInteger(h) ? h : h.toFixed(1)} 小时`;
}

export function rescanTimeline(
  reclaim: { followUp?: string | null; rescanAt?: string[] | null } | null | undefined,
  revokedAt: string | null | undefined,
  passes: readonly ReclaimPass[] | null,
  nowMs: number,
): RescanItem[] {
  const times = (reclaim?.rescanAt ?? []).filter((t) => typeof t === 'string' && Number.isFinite(Date.parse(t)));
  const allDone = reclaim?.followUp === 'DONE';
  const rescans = (passes ?? []).filter((p) => p.mode === 'RESCAN').sort((a, b) => String(a.startedAt ?? '').localeCompare(String(b.startedAt ?? '')));
  const finished = rescans.filter((p) => p.finishedAt);
  return times.map((at, i) => {
    const p = finished[i];
    let status: RescanStatus;
    if (p) status = (p.manual ?? 0) > 0 ? 'found' : 'done';
    else if (allDone) status = 'done';
    else if (passes && rescans.length > finished.length && i === finished.length) status = 'running';
    else status = Date.parse(at) <= nowMs ? (passes ? 'running' : 'due') : 'pending';
    return { index: i + 1, at, offset: offsetText(revokedAt, at), status, doneAt: p?.finishedAt ?? null };
  });
}
