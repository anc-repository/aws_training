/**
 * 待人工处理条目列表（08 P07“待人工处理清单”、P07-M；§5.4 ManualItemCard）：
 * - 每项：严重级别、计费、类型、名称（打码）、区域、原因、来源、创建者会话名、尝试次数、最后尝试时间、控制台链接（学员自己的登录，
 *   新标签页）、CLI 命令（只复制：显示打码、复制原文）、说明；安全类条目带“安全”标记；
 * - “我已处理，重新核对”（只对学员）：POST …/cleanup/items/{resourceKey}/resolve（202）→ 行内“正在核对…”→ 轮询回收报告：
 *   条目不再待处理 → “已确认：资源已不存在”；仍在且已复核过 → “资源仍然存在…”；超时 → “核对仍在进行”。
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import type { ApiError } from '../../api/errors';
import { isApiError } from '../../api/errors';
import { useServices } from '../../app/context';
import { announce } from '../../lib/announce';
import { ManualItemCard, Shape } from '../../ui';
import { InlineProblem } from '../errors/InlineProblem';
import { isOpen, normalizeResource, sortManual, type LedgerItem } from '../end/resources';

import { msg, rich } from '../../i18n';
export type CheckState = { kind: 'verifying'; since: number; before: string | null } | { kind: 'confirmed' } | { kind: 'still' } | { kind: 'slow' } | { kind: 'error'; error: ApiError };

/** 核对的轮询节奏（测试可调）。 */
export const resolveTiming = { pollMs: 4_000, timeoutMs: 90_000 };

interface CleanupItems {
  items?: Record<string, unknown>[];
}

/** “我已处理”的核对流程（按 resourceKey）。onChanged：清单或会话状态可能变化，调用方刷新。 */
export function useResolve(onChanged?: () => void) {
  const { api, sync } = useServices();
  const [checks, setChecks] = useState<Record<string, CheckState>>({});
  const timers = useRef(new Map<string, ReturnType<typeof setTimeout>>());
  const changed = useRef(onChanged);
  changed.current = onChanged;
  useEffect(() => {
    const map = timers.current;
    return () => {
      for (const t of map.values()) clearTimeout(t);
      map.clear();
    };
  }, []);
  const set = (k: string, s: CheckState) => setChecks((c) => ({ ...c, [k]: s }));

  const poll = useCallback(
    (sid: string, item: LedgerItem, since: number) => {
      const tick = async () => {
        timers.current.delete(item.resourceKey);
        let data: CleanupItems | null = null;
        try {
          data = (await api.call<CleanupItems>('getCleanup', { params: { sid }, query: { format: 'json' }, conditional: false })).data;
        } catch {
          data = null;
        }
        const hit = data?.items?.map(normalizeResource).find((r) => r.resourceKey === item.resourceKey) ?? null;
        if (data && (!hit || !isOpen(hit))) {
          set(item.resourceKey, { kind: 'confirmed' });
          announce(msg.frame.manualPage.confirmed);
          void sync.refreshView(sid);
          changed.current?.();
          return;
        }
        if (hit && hit.lastAttemptAt && hit.lastAttemptAt !== item.lastAttemptAt && Date.parse(hit.lastAttemptAt) >= since - 5_000) {
          set(item.resourceKey, { kind: 'still' });
          announce(msg.frame.manualPage.still);
          changed.current?.();
          return;
        }
        if (Date.now() - since > resolveTiming.timeoutMs) {
          set(item.resourceKey, { kind: 'slow' });
          changed.current?.();
          return;
        }
        timers.current.set(item.resourceKey, setTimeout(() => void tick(), resolveTiming.pollMs));
      };
      timers.current.set(item.resourceKey, setTimeout(() => void tick(), resolveTiming.pollMs));
    },
    [api, sync],
  );

  const resolve = useCallback(
    async (sid: string, item: LedgerItem) => {
      const since = Date.now();
      set(item.resourceKey, { kind: 'verifying', since, before: item.lastAttemptAt ?? null });
      announce(msg.frame.manualPage.verifying);
      try {
        await api.call('resolveCleanupItem', { params: { sid, resourceKey: item.resourceKey }, body: {} });
        poll(sid, item, since);
      } catch (e) {
        if (!isApiError(e)) throw e;
        set(item.resourceKey, { kind: 'error', error: e });
        if (e.code === 'INVALID_STATE') changed.current?.();
      }
    },
    [api, poll],
  );

  return { checks, resolve };
}

export interface ManualListProps {
  items: readonly LedgerItem[];
  /** 条目没有 sessionId 时使用的会话。 */
  sid?: string;
  /** 学员：显示“我已处理，重新核对”。 */
  canAct: boolean;
  unmasked?: boolean;
  onChanged?: () => void;
}

export function ManualList({ items, sid, canAct, unmasked, onChanged }: ManualListProps) {
  const { checks, resolve } = useResolve(onChanged);
  // 已确认的条目在清单刷新后会消失：保留到下次进入页面，让“已确认”的结果留在原处
  const seen = useRef(new Map<string, LedgerItem>());
  for (const r of items) seen.current.set(r.resourceKey, r);
  const kept = Object.entries(checks)
    .filter(([k, c]) => c.kind === 'confirmed' && !items.some((r) => r.resourceKey === k))
    .map(([k]) => seen.current.get(k))
    .filter((r): r is LedgerItem => !!r);
  const sorted = sortManual([...items, ...kept]);
  return (
    <div className="stack" data-manual-list="">
      {sorted.map((r) => {
        const c = checks[r.resourceKey];
        const owner = r.sessionId ?? sid ?? null;
        const confirmed = c?.kind === 'confirmed';
        const shown = confirmed ? { ...r, cleanupState: 'RESOLVED_BY_LEARNER' as const } : r;
        return (
          <div key={r.resourceKey} className="stack-4" data-k={r.resourceKey}>
            {r.security ? (
              <div className="note blue">
                <Shape name="dot" />
                <span>
                  {rich(msg.frame.manualPage.safeNote, { safe: <b>{msg.frame.manualPage.safe}</b> })}
                </span>
              </div>
            ) : null}
            <ManualItemCard
              resource={shown}
              verifying={c?.kind === 'verifying'}
              unmasked={unmasked}
              onResolve={canAct && owner && !confirmed ? () => void resolve(owner, r) : undefined}
            />
            {c?.kind === 'confirmed' ? (
              <div className="note green" role="status">
                <Shape name="check" />
                <span>{msg.frame.manualPage.confirmedNote}</span>
              </div>
            ) : c?.kind === 'still' ? (
              <div className="note amber" role="status">
                <Shape name="tri" />
                <span>{msg.frame.manualPage.stillNote}</span>
              </div>
            ) : c?.kind === 'slow' ? (
              <div className="note" role="status">
                <Shape name="clock" />
                <span>{msg.frame.manualPage.slowNote}</span>
              </div>
            ) : c?.kind === 'error' ? (
              <InlineProblem error={c.error} onRetry={owner ? () => void resolve(owner, r) : undefined} />
            ) : null}
          </div>
        );
      })}
    </div>
  );
}
