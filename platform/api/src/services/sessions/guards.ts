/**
 * Platform-wide start guards (02 §3.3 step 2 “快速预判”, §3.4, §9.2, §10.4, §10.5): read the platform config and the
 * active-environment lock (strongly consistent), the lock holder, sessions still in `REQUESTED`, and hourly-billed
 * `BLOCKING` residues. Non-authoritative — `AcquireLock` in `atl-session-start` decides — but it gives the learner an
 * immediate 409 and feeds `startability` (05 §8.8) and the environment strip of `GET /labs`.
 */
import { AtlError, isTerminal, STATE_TIMEOUT_MINUTES, type ErrorCode } from '@atl/shared';
import type { LockItem, PlatformConfig, Repositories, ResourceItem, SessionItem } from '../../repositories/index.js';
import { budgetBlocks } from './view.js';

export interface PlatformState {
  config: PlatformConfig | null;
  lock: LockItem | null;
  holder: SessionItem | null;
  /** A reuse reservation that is still valid (02 §3.4). */
  reservation: { sessionId: string; until: string } | null;
  /** Sessions in REQUESTED younger than the REQUESTED timeout (they may be about to take the lock). */
  requested: SessionItem[];
  /** Hourly-billed BLOCKING residues of CLEANUP_FAILED environments (02 §9.2). */
  residues: ResourceItem[];
}

export async function loadPlatformState(repos: Repositories, nowMs: number, opts: { residues?: boolean } = {}): Promise<PlatformState> {
  const [config, lock, requestedRaw, manual] = await Promise.all([
    repos.platform.config(true),
    repos.platform.lock(),
    repos.sessions.listByState('REQUESTED', 20).catch(() => [] as SessionItem[]),
    opts.residues === false ? Promise.resolve([] as ResourceItem[]) : repos.environments.manualItems().catch(() => [] as ResourceItem[]),
  ]);
  const holder = lock?.holderSessionId ? await repos.sessions.get(lock.holderSessionId, true) : null;
  const reservation =
    lock?.pendingSessionId && lock.pendingUntil && Date.parse(lock.pendingUntil) > nowMs ? { sessionId: lock.pendingSessionId, until: lock.pendingUntil } : null;
  const requestedTimeoutMs = (STATE_TIMEOUT_MINUTES.REQUESTED ?? 5) * 60_000;
  const requested = requestedRaw.filter((s) => s.state === 'REQUESTED' && nowMs - Date.parse(s.stateEnteredAt) < requestedTimeoutMs);
  const residues = manual.filter(
    (r) => r.severity === 'BLOCKING' && r.billing === 'hourly' && ['MANUAL_REQUIRED', 'FAILED', 'REVIEW'].includes(String(r.cleanupState)),
  );
  return { config, lock, holder, reservation, requested, residues };
}

export interface Blocker {
  code: ErrorCode | 'TARGET_ALREADY_SATISFIED' | 'LAB_DEPRECATED' | 'HARD_PREREQ_UNMET';
  detail: string;
  /** Can be overridden by the request (residualAck). */
  ackable?: boolean;
  [k: string]: unknown;
}

/**
 * Reasons why a new session cannot start now, most important first. `reuseEnvId`: the learner asked to reuse that
 * kept environment; `sid`: the session that holds a reservation is not blocked by it.
 */
export function startBlockers(st: PlatformState, opts: { reuseEnvId?: string | null; residualAck?: boolean; nowMs: number }): Blocker[] {
  const out: Blocker[] = [];
  const cfg = st.config;
  if (cfg?.mode === 'UNINSTALLING') out.push({ code: 'PLATFORM_UNINSTALLING', detail: '平台正在卸载，不能开始新实验' });
  if (cfg?.maintenance) out.push({ code: 'MAINTENANCE_MODE', detail: '平台处于维护模式' });
  if (budgetBlocks(cfg)) out.push({ code: 'BUDGET_BLOCKED', detail: '月度预算已超出，按 BudgetEnforcement 拒绝开始' });
  const h = st.holder;
  if (h && !isTerminal(h.state) && h.state !== 'CLEANUP_FAILED') {
    if (h.state === 'KEPT') {
      if (!opts.reuseEnvId || opts.reuseEnvId !== st.lock?.holderEnvId) {
        out.push({ code: 'ENV_KEPT_EXISTS', detail: `保留中的环境（${h.labId}，会话 ${h.sid}）：先释放或复用`, sessionId: h.sid, envId: st.lock?.holderEnvId ?? null });
      } else if (st.reservation) {
        out.push({ code: 'REUSE_IN_PROGRESS', detail: `保留环境已被会话 ${st.reservation.sessionId} 预留复用`, sessionId: st.reservation.sessionId });
      }
    } else if (h.state === 'CLEANING') {
      out.push({ code: 'CLEANUP_IN_PROGRESS', detail: `上一个环境正在回收（会话 ${h.sid}）`, sessionId: h.sid });
    } else {
      const until = typeof h.deadlineAt === 'string' ? `，${h.deadlineAt} 到期` : '';
      out.push({ code: 'SESSION_ACTIVE_EXISTS', detail: `会话 ${h.sid}（${h.labId}）处于 ${h.state}${until}。`, sessionId: h.sid, state: h.state });
    }
  } else if (opts.reuseEnvId) {
    out.push({ code: 'VALIDATION_FAILED', detail: `环境 ${opts.reuseEnvId} 不是保留中的环境，不能复用` });
  }
  const pending = st.requested.filter((s) => s.sid !== h?.sid);
  if (pending.length && !out.some((b) => b.code === 'SESSION_ACTIVE_EXISTS')) {
    const s = pending[0]!;
    out.push({ code: 'SESSION_ACTIVE_EXISTS', detail: `会话 ${s.sid}（${s.labId}）正在开始`, sessionId: s.sid, state: s.state });
  }
  const policy = (cfg?.reclaim as { blockStartOnResidual?: string } | undefined)?.blockStartOnResidual ?? 'ack';
  if (st.residues.length && policy !== 'ignore' && !(policy === 'ack' && opts.residualAck)) {
    out.push({
      code: 'RESIDUAL_ACK_REQUIRED',
      detail: `存在 ${st.residues.length} 项按小时计费的未释放资源${policy === 'block' ? '，平台设置要求先处理' : '，需要确认（residualAck）'}`,
      ackable: policy === 'ack',
      residues: st.residues.slice(0, 20).map((r) => ({ resourceKey: r.resourceKey ?? null, type: r.resourceType ?? null, name: r.name ?? null, sessionId: r.sessionId ?? null })),
    });
  }
  return out;
}

/** Throw the first blocker as problem+json. */
export function throwBlocker(b: Blocker): never {
  const { code, detail, ...extra } = b;
  if (code === 'TARGET_ALREADY_SATISFIED' || code === 'LAB_DEPRECATED' || code === 'HARD_PREREQ_UNMET') {
    // not registered in 01 §8.6 yet (08 §9.2 #1): carried as `reason` on a registered code
    throw new AtlError(code === 'TARGET_ALREADY_SATISFIED' ? 'INVALID_STATE' : 'VALIDATION_FAILED', detail, { reason: code, ...extra });
  }
  throw new AtlError(code, detail, extra);
}
