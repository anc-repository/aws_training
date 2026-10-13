/**
 * 顶栏当前会话胶囊 SessionPill（08 §3.3、§5.2）：工作台以外的全部登录后画面常驻，一次点击回到正确的去处。
 * - 整体是链接（去向按 §2.4 表 2 最后一列），aria-label 写全；右侧 ▾ 是独立的 disclosure 按钮（会话菜单）；
 * - 倒计时每秒刷新显示，但文字在 aria-live="off" 区域；阈值播报由 useExpiryAnnouncements 负责；
 * - 轮询更新只替换胶囊内文字，不重建链接（焦点不丢）；没有会话时不渲染。
 */
import { Link } from 'react-router-dom';
import { useAuth, useCurrentSession, useServices } from '../app/context';
import { useGlobalStatus } from '../app/globalStatus';
import { allowedActionsOf, extendBlockReason } from '../app/sessionRouting';
import { t, zhCN } from '../i18n/zh-CN';
import { Icon, Shape, SessionStatePill, useDisclosure, useSecondTick, type CostTier } from '../ui';
import { useSessionActions } from './SessionActions';
import { pillModel } from './sessionPillModel';

export function SessionPill({ costTier }: { costTier?: CostTier | null } = {}) {
  const { clock } = useServices();
  const { current } = useCurrentSession();
  const auth = useAuth();
  const status = useGlobalStatus();
  const actions = useSessionActions();
  const menu = useDisclosure();
  useSecondTick(!!current);
  if (!current) return null;
  const role = auth.principal?.role ?? null;
  const nowMs = clock.now();
  const m = pillModel({ view: current, nowMs, role, costTier: costTier ?? status.costTiers[current.labId] ?? null });
  if (!m) return null;
  const ctx = {
    role,
    nowMs,
    uninstalling: status.platform.data?.mode === 'UNINSTALLING',
    budgetExceeded: status.guardrails?.budget?.state === 'EXCEEDED',
    envHealthy: true,
  };
  const allowed = allowedActionsOf(current, ctx);
  const sid = current.sessionId;
  const st = current.state;
  const s = zhCN.session;
  const extendWhy = allowed.includes('end') && !allowed.includes('extend') ? extendBlockReason(current, ctx) : null;
  const extendMinutes = current.limits?.extensionMinutes ?? 30;
  return (
    <div className="pop-anchor" ref={menu.anchorRef} data-session-pill={st}>
      <span className={`spill ${m.cls}`}>
        <Link to={m.target} aria-label={m.aria} data-k="pill-link">
          <span aria-live="off">
            <Shape name={m.shape} spin={m.spin} /> {m.label}
            {m.detail.length ? <span className="hide-sm"> · {m.detail.join(' · ')}</span> : null}
            {m.clock ? (
              <>
                {' · '}
                <span className="cd">{m.clock}</span>
              </>
            ) : null}
            {m.tail.length ? <span className="hide-sm"> · {m.tail.join(' · ')}</span> : null}
          </span>
        </Link>
        <button {...menu.buttonProps} aria-label={s.menu}>
          <Icon name="chev" />
        </button>
      </span>
      <div {...menu.panelProps} className="popover">
        {menu.open ? (
          <>
            <div className="small muted">
              会话 <span className="mono">{sid}</span> · <SessionStatePill state={st} size="sm" />
            </div>
            {['REQUESTED', 'PROVISIONING', 'READY', 'RUNNING', 'EXPIRING'].includes(st) ? (
              <Link className="mi" to={`/workspace/${sid}`} onClick={() => menu.close()}>
                {s.menuBackToWorkspace}
              </Link>
            ) : null}
            {['ENDING', 'CLEANING', 'CLEANUP_FAILED'].includes(st) ? (
              <Link className="mi" to={`/sessions/${sid}/end`} onClick={() => menu.close()}>
                {s.menuReclaim}
              </Link>
            ) : null}
            {st === 'KEPT' ? (
              <Link className="mi" to={`/sessions/${sid}/end`} onClick={() => menu.close()}>
                {s.menuKeep}
              </Link>
            ) : null}
            {allowed.includes('cancel') ? (
              <button
                type="button"
                className="mi"
                onClick={() => {
                  menu.close(true);
                  actions.open('cancel', sid);
                }}
              >
                {s.menuCancel}
              </button>
            ) : null}
            {allowed.includes('end') ? (
              <>
                <button
                  type="button"
                  className="mi"
                  aria-disabled={allowed.includes('extend') ? undefined : true}
                  title={extendWhy ? s.extendBlocked[extendWhy] : undefined}
                  onClick={() => {
                    if (!allowed.includes('extend')) return;
                    menu.close(true);
                    actions.open('extend', sid);
                  }}
                >
                  {t(s.menuExtend, { minutes: extendMinutes, n: current.limits?.extensionsLeft ?? 0 })}
                </button>
                {extendWhy ? <span className="small muted">{s.extendBlocked[extendWhy]}</span> : null}
                <button
                  type="button"
                  className="mi"
                  onClick={() => {
                    menu.close(true);
                    actions.open('end', sid);
                  }}
                >
                  {s.menuEnd}
                </button>
              </>
            ) : null}
            <Link className="mi" to={`/sessions/${sid}`} onClick={() => menu.close()}>
              {s.menuDetail}
            </Link>
          </>
        ) : null}
      </div>
    </div>
  );
}
