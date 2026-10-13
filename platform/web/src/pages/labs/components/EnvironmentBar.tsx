/**
 * 目录页当前环境条 EnvironmentBar（08 P02“环境条随会话状态”表、§3.7；05 §2.2）：
 * 卡片标题、状态、剩余时间或保留截止、档位、按小时计费资源数、主操作。倒计时由 SessionSync 驱动（与顶栏胶囊同源），
 * 不重复显示 T-15 横幅；窄屏吸底只留 id、状态、剩余与“回到工作台”（CSS）。观察者不显示计数与残留（§1.5）。
 */
import { Link } from 'react-router-dom';
import type { SessionView } from '../../../api/types';
import { useAuth, useServices } from '../../../app/context';
import { useGlobalStatus } from '../../../app/globalStatus';
import { allowedActionsOf, extendBlockReason, pillTarget } from '../../../app/sessionRouting';
import { useSessionActions } from '../../../components/SessionActions';
import { t, zhCN } from '../../../i18n/zh-CN';
import { formatClock, formatCountdown, formatDate } from '../../../lib/format';
import { Button, CostTierMark, displayState, SESSION_STATE_META, Shape, urgencyOf, useSecondTick } from '../../../ui';
import { PROVISION_TEXT, S } from '../strings';
import type { CatalogCard } from '../types';

export interface EnvironmentBarProps {
  /** 当前会话视图（SessionSync；A、O 没有时由 GET /labs 的 environment 拼出最小视图）。 */
  view: SessionView | null;
  cards: ReadonlyMap<string, CatalogCard>;
  /** 推荐的下一张卡片（保留中的环境“在下一张卡片中复用”）。 */
  nextLabId?: string | null;
}

export function EnvironmentBar({ view, cards, nextLabId }: EnvironmentBarProps) {
  const { clock } = useServices();
  const auth = useAuth();
  const status = useGlobalStatus();
  const actions = useSessionActions();
  const live = !!view && ['REQUESTED', 'PROVISIONING', 'READY', 'RUNNING', 'EXPIRING'].includes(view.state);
  useSecondTick(live);
  const role = auth.principal?.role ?? null;
  const L = role === 'L';
  const platform = status.platform.data;
  const uninstalling = platform?.mode === 'UNINSTALLING';
  if (uninstalling || platform?.maintenance) {
    return (
      <div className="envbar wind" role="region" aria-label={S.env.region} data-envbar="blocked">
        <Shape name="hg" />
        <span className="eb-main">{uninstalling ? S.env.uninstalling : S.env.maintenance}</span>
      </div>
    );
  }
  const manualItems = (status.manual?.items ?? []).filter((i) => i.cleanupState !== 'RESOLVED_BY_LEARNER' && i.cleanupState !== 'DELETED');
  const residualBar = (labId: string | null, at: string | null | undefined) => {
    if (role === 'O' || !manualItems.length) return null;
    const hourly = manualItems.filter((i) => i.billing === 'hourly').length;
    const what = labId ? t(S.env.residualOf, { labId, at: at ? formatDate(at, clock.now()) : '—' }) : S.env.residualPrevious;
    return (
      <div className="envbar red" role="region" aria-label={S.env.region} data-envbar="residual">
        <Shape name="tri" />
        <span className="eb-main">
          {t(S.env.residual, { what, n: manualItems.length, hourly: hourly ? t(S.env.residualHourly, { n: hourly }) : '' })}
        </span>
        <span className="eb-btns">
          <Link className="btn sm" to="/resources/manual">
            {S.env.viewList}
          </Link>
        </span>
      </div>
    );
  };
  if (!view || view.state === 'ENDED' || view.state === 'FAILED') {
    const first = manualItems[0];
    return residualBar(first?.labId ?? null, first?.sessionCreatedAt ?? null);
  }
  const card = cards.get(view.labId);
  const nowMs = clock.now();
  const sid = view.sessionId;
  const tier = card ? <CostTierMark tier={card.costTier.required} withOptional={card.costTier.withOptional} /> : null;
  const ctx = {
    role,
    nowMs,
    uninstalling,
    budgetExceeded: status.guardrails?.budget?.state === 'EXCEEDED',
    envHealthy: true,
  };
  const allowed = allowedActionsOf(view, ctx);
  const remaining = view.deadlineAt ? Date.parse(view.deadlineAt) - nowMs : null;
  const ds = displayState(view.state, remaining);
  const title = card?.title ?? '';
  const target = pillTarget(view) ?? `/sessions/${sid}`;
  const idEl = <b className="mono">{view.labId}</b>;

  if (ds === 'REQUESTED' || ds === 'PROVISIONING') {
    return (
      <div className="envbar" role="region" aria-label={S.env.region} data-envbar={ds}>
        <span className="eb-main">
          <Shape name="clock" /> {idEl}
          <span className="hide-sm"> · {title}</span> · {SESSION_STATE_META[ds].text}
          {view.createdAt ? (
            <>
              {' · '}
              <span className="cd-inline">{t(S.env.elapsed, { t: formatCountdown(nowMs - Date.parse(view.createdAt)) })}</span>
            </>
          ) : null}
          {card ? <span className="hide-sm"> · {t(S.env.provision, { t: PROVISION_TEXT[card.provisionClass] })}</span> : null}
        </span>
        <span className="eb-btns">
          <Link className="btn sm primary" to={`/workspace/${sid}`}>
            {S.env.toWorkspace}
          </Link>
          {L && allowed.includes('cancel') ? (
            <Button size="sm" className="hide-sm" onClick={() => actions.open('cancel', sid)}>
              {S.env.cancel}
            </Button>
          ) : null}
        </span>
      </div>
    );
  }
  if (ds === 'READY' || ds === 'RUNNING' || ds === 'EXPIRING') {
    const u = urgencyOf(remaining ?? Number.POSITIVE_INFINITY);
    const warn = u !== 'U0';
    const hourly = view.resources?.hourlyBilled;
    const extendWhy = allowed.includes('end') && !allowed.includes('extend') ? extendBlockReason(view, ctx) : null;
    return (
      <div className={warn ? 'envbar warn' : 'envbar'} role="region" aria-label={S.env.region} data-envbar={ds}>
        <span className="eb-main">
          <Shape name={warn ? 'tri' : 'dot'} /> {idEl}
          <span className="hide-sm"> · {title}</span> · {warn ? SESSION_STATE_META.EXPIRING.text : SESSION_STATE_META[ds].text} ·{' '}
          <span className="cd-inline" role="timer" aria-live="off">
            {remaining !== null ? t(S.env.remaining, { t: formatCountdown(remaining) }) : zhCN.session.countdownNotStarted}
          </span>
          <span className="hide-sm">
            {tier ? <> · {tier}</> : null}
            {typeof hourly === 'number' && role !== 'O' ? ` · ${t(S.env.hourly, { n: hourly })}` : null}
          </span>
        </span>
        <span className="eb-btns">
          <Link className="btn sm primary" to={`/workspace/${sid}`}>
            {S.env.toWorkspace}
          </Link>
          {L && ds === 'EXPIRING' && allowed.includes('end') ? (
            <Button
              size="sm"
              className="hide-sm"
              disabledReason={extendWhy ? zhCN.session.extendBlocked[extendWhy] : null}
              onClick={() => actions.open('extend', sid)}
            >
              {S.env.extend}
            </Button>
          ) : null}
          {L && allowed.includes('end') ? (
            <Button size="sm" className="hide-sm" onClick={() => actions.open('end', sid)}>
              {S.env.end}
            </Button>
          ) : null}
        </span>
      </div>
    );
  }
  if (ds === 'OVERDUE' || ds === 'ENDING' || ds === 'CLEANING') {
    const c = view.cleanup;
    const count = ds === 'CLEANING' && role !== 'O' && c && typeof c.deleted === 'number' && typeof c.total === 'number' ? ` · ${t(S.env.deleted, { n: c.deleted, m: c.total })}` : '';
    return (
      <div className="envbar wind" role="region" aria-label={S.env.region} data-envbar={ds}>
        <span className="eb-main">
          <Shape name="hg" /> {idEl} · {SESSION_STATE_META[ds].text}
          {count}
        </span>
        <span className="eb-btns">
          <Link className="btn sm" to={ds === 'OVERDUE' ? `/workspace/${sid}` : `/sessions/${sid}/end`}>
            {S.env.reclaim}
          </Link>
        </span>
      </div>
    );
  }
  if (ds === 'KEPT') {
    const until = view.keep?.until ?? view.env?.keepUntil ?? null;
    return (
      <div className="envbar kept" role="region" aria-label={S.env.region} data-envbar="KEPT">
        <span className="eb-main">
          <Shape name="dia" /> {idEl} · {SESSION_STATE_META.KEPT.text}
          {until ? ` · ${t(S.env.until, { t: formatClock(until) })}` : ''}
          {view.keep?.saveMode ? ` · ${S.env.saveMode}` : ''}
          {tier ? <> · {tier}</> : null}
        </span>
        <span className="eb-btns">
          <Link className="btn sm" to={target}>
            {S.env.manageKeep}
          </Link>
          {L && nextLabId ? (
            <Link className="btn sm" to={`/labs/${nextLabId}${view.env?.envId ? `?reuse=${encodeURIComponent(view.env.envId)}` : ''}`}>
              {S.env.reuseNext}
            </Link>
          ) : null}
        </span>
      </div>
    );
  }
  if (ds === 'CLEANUP_FAILED') {
    if (role === 'O') return null;
    return (
      residualBar(view.labId, view.createdAt) ?? (
        <div className="envbar red" role="region" aria-label={S.env.region} data-envbar="CLEANUP_FAILED">
          <span className="eb-main">
            <Shape name="tri" /> {idEl} · {SESSION_STATE_META.CLEANUP_FAILED.text}
          </span>
          <span className="eb-btns">
            <Link className="btn sm" to={`/sessions/${sid}/end#manual`}>
              {S.env.viewList}
            </Link>
          </span>
        </div>
      )
    );
  }
  return null;
}
