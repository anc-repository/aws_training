/**
 * 工作台横幅（08 P05.9、P05.12；顶栏下方，不遮挡终端）：T-15 即将到期（琥珀，延长 / 到期后保留 / 现在结束）、到期预检的“还差什么”、
 * 保留中、释放未完成、只读存档、环境异常（窗口外；窗口内追加“属预期”说明）、预算 end-active、平台动作进行中、提交结果条。
 * 横幅只在内容变化时重绘；T-15 的读屏播报由全局 useExpiryAnnouncements 负责（15、5、1 分钟与 0 各一次），这里不重复。
 */
import { useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import type { SessionEvent } from '../../api/types';
import { formatClock } from '../../lib/format';
import { Button, Icon, Shape } from '../../ui';
import { useWorkspace } from '../context';
import { expiryPhase, showT15Banner } from '../model/expiry';
import { actionTitle } from '../manual/PlatformAction';

import { t } from '../../i18n';
import { W } from '../strings';

const WB = W.banners;
export interface BannerProps {
  onExtend: () => void;
  onEnd: (when: 'now' | 'at-expiry') => void;
  onRepair: () => void;
  extendBlocked: string | null;
}

interface AttemptResult {
  to: string;
  missing?: number;
  at: string;
}

function lastAttempt(events: readonly SessionEvent[]): AttemptResult | null {
  const e = [...events].reverse().find((x) => x.type === 'attempt.state_changed');
  if (!e) return null;
  const d = e.data as { from?: string; to?: string; missing?: number };
  return d.to ? { to: d.to, ...(typeof d.missing === 'number' ? { missing: d.missing } : {}), at: e.id } : null;
}

export function WorkspaceBanners({ onExtend, onEnd, onRepair, extendBlocked }: BannerProps) {
  const ws = useWorkspace();
  const navigate = useNavigate();
  const v = ws.view;
  const phase = expiryPhase(v, ws.now());
  const out: React.ReactNode[] = [];
  const canEnd = ws.allowed.includes('end');
  const [dismissedResult, setDismissedResult] = useState<string | null>(null);
  const result = useMemo(() => lastAttempt(ws.data.events), [ws.data.events]);
  const [, force] = useState(0);
  useEffect(() => {
    const t = setInterval(() => force((x) => x + 1), 30_000);
    return () => clearInterval(t);
  }, []);

  if (ws.live && showT15Banner(phase) && v.deadlineAt) {
    const mins = Math.max(1, Math.ceil((Date.parse(v.deadlineAt) - ws.now()) / 60_000));
    out.push(
      <div key="t15" className="wsban amber" data-banner="t15">
        <Shape name="tri" />
        <span className="b-body">
          {t(WB.t15, { n: mins, t: formatClock(v.deadlineAt) })}
        </span>
        {canEnd ? (
          <>
            <button type="button" className="btn sm" aria-disabled={extendBlocked ? true : undefined} aria-describedby="ws-ban-ext" onClick={() => (extendBlocked ? undefined : onExtend())}>
              {t(WB.extend, { n: v.limits?.extensionMinutes ?? 30 })}
            </button>
            <span id="ws-ban-ext" className="sr">
              {extendBlocked ?? WB.canExtend}
            </span>
            {ws.allowed.includes('end-keep') ? (
              <button type="button" className="btn sm" onClick={() => onEnd('at-expiry')}>
                {WB.keepAtExpiry}
              </button>
            ) : null}
            <button type="button" className="btn sm" onClick={() => onEnd('now')}>
              {WB.endNow}
            </button>
          </>
        ) : null}
      </div>,
    );
    const p = ws.data.progress.data;
    const steps = ws.data.lab.data?.steps ?? [];
    if (p?.missing.length) {
      out.push(
        <div key="precheck" className="wsban grey" data-banner="precheck">
          <Shape name="clock" />
          <span className="b-body small">
            {t(WB.precheck, { list: p.missing.map((m) => t(WB.stepNo, { n: steps.findIndex((s) => s.id === m) + 1 })).join(WB.listSep) })}
          </span>
        </div>,
      );
    }
  }
  if (v.state === 'KEPT') {
    out.push(
      <div key="kept" className="wsban amber" data-banner="kept">
        <Shape name="dia" />
        <span className="b-body">{v.keep?.until ? t(WB.keptUntil, { t: formatClock(v.keep.until) }) : WB.kept}</span>
        <Button size="sm" onClick={() => navigate(`/sessions/${ws.sid}/end`)}>
          {WB.manageKeep}
        </Button>
      </div>,
    );
  }
  if (v.state === 'CLEANUP_FAILED' && ws.render.screen === 'P05') {
    out.push(
      <div key="cf" className="wsban red" role="alert" data-banner="cleanup-failed">
        <Shape name="tri" />
        <span className="b-body">{WB.cleanupFailed}</span>
        <Button size="sm" onClick={() => navigate(`/sessions/${ws.sid}/end#manual`)}>
          {WB.viewList}
        </Button>
      </div>,
    );
  }
  if (v.state === 'ENDED' && ws.render.screen === 'P05') {
    out.push(
      <div key="ended" className="wsban grey" data-banner="archive">
        <Shape name="sq" />
        <span className="b-body">{WB.archive}</span>
        <Button size="sm" onClick={() => navigate(`/sessions/${ws.sid}/report`)}>
          {WB.viewReport}
        </Button>
      </div>,
    );
  }
  if (ws.live && ws.guard.envDegraded) {
    out.push(
      <div key="deg" className="wsban amber" role="alert" data-banner="env-degraded">
        <Shape name="tri" />
        <span className="b-body">
          {WB.degraded}
          {ws.outage ? t(WB.degradedOutage, { t: formatClock(ws.outage.until) }) : ''}
          <details className="small">
            <summary>{WB.causes}</summary>
            {WB.causesText}
          </details>
        </span>
        {ws.learner ? (
          <>
            <Button size="sm" onClick={onRepair}>
              {WB.repair}
            </Button>
            {canEnd ? (
              <Button size="sm" onClick={() => onEnd('now')}>
                {WB.end}
              </Button>
            ) : null}
          </>
        ) : null}
      </div>,
    );
  }
  if (ws.live && ws.guard.budgetEndActive) {
    out.push(
      <div key="budget" className="wsban red" role="alert" data-banner="budget">
        <Shape name="sq" />
        <span className="b-body">{WB.budget}</span>
      </div>,
    );
  }
  const running = (ws.data.moduleOps.data?.items ?? []).find((o) => o.source === 'platform' && !o.finishedAt && !['succeeded', 'failed'].includes((o.status ?? o.state ?? '').toLowerCase()));
  if (ws.live && running) {
    out.push(
      <div key="op" className="wsban blue" role="status" data-banner="module-op">
        <Shape name="spin" spin />
        <span className="b-body">
          {t(WB.moduleOp, { action: actionTitle(running.actionId ?? running.op ?? WB.platformAction) })}
          {running.runId ? t(WB.runner, { id: running.runId }) : ''}
        </span>
      </div>,
    );
  }
  if (result && dismissedResult !== result.at && (ws.live || v.state === 'ENDED')) {
    if (result.to === 'completed' || result.to === 'completed_manual') {
      const badge = ws.data.lab.data?.badge?.title;
      out.push(
        <div key="res" className="wsban green" role="status" data-banner="result">
          <Shape name="check" />
          <span className="b-body">
            {result.to === 'completed' ? WB.completed : WB.completedManual}
            {badge ? t(WB.badge, { badge }) : ''}
            {WB.completedTail}
          </span>
          {canEnd ? (
            <Button size="sm" variant="primary" onClick={() => onEnd('now')}>
              {WB.endAndClean}
            </Button>
          ) : null}
          <Button size="sm" onClick={() => setDismissedResult(result.at)}>
            {WB.keepExploring}
          </Button>
        </div>,
      );
    } else if (result.to === 'active' && result.missing) {
      out.push(
        <div key="res" className="wsban amber" role="status" data-banner="result">
          <Shape name="tri" />
          <span className="b-body">{t(WB.submitFailed, { n: result.missing })}</span>
          <button type="button" className="btn sm ghost icon" aria-label={WB.dismiss} onClick={() => setDismissedResult(result.at)}>
            <Icon name="x" />
          </button>
        </div>,
      );
    }
  }
  if (!out.length) return null;
  return (
    <div className="wsbans" role="region" aria-label={WB.region}>
      {out}
    </div>
  );
}
