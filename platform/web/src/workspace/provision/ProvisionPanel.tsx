/**
 * P04 准备模式的右侧（08 P04；02 §11.3）：ProvisionPanel（PhaseList × 6、细节行、慢资源提示、等级说明、计费提示、可以离开页面、
 * 浏览器通知开关、取消…）、就绪后的一行“✓ 环境已就绪（用时 12:40），倒计时 1:30:00 已开始”、取消中 / 补偿中的 CompensationProgress、
 * 启动失败的 FailurePanel 与“有资源未释放 [查看清单]”。不显示进度百分比；已用时间从 createdAt 起算（serverClock）。
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { announce } from '../../lib/announce';
import { copyText } from '../../lib/clipboard';
import { formatCountdown, formatSpan } from '../../lib/format';
import { redact } from '../../lib/redact';
import { Button, CommandBlock, Dialog, Icon, Shape, useSecondTick } from '../../ui';
import { MetricIcon, type ProvisionValue } from '../../ui/charts';
import { ArchDiagram, archInputFromLab } from '../../ui/diagram';
import { useWorkspace } from '../context';
import { formatRange, hourlyRangeOf } from '../model/cost';
import { diagnosticLines, diagnosticsText, failureMeta, preflightCommand } from '../model/failure';
import { PROVISION_CLASS, type LabDoc } from '../model/lab';
import { buildPhaseRows, nearBudget } from '../model/phases';
import { WsIcon } from '../visual/icons';
import { PhaseDiagram } from './PhaseDiagram';

import { t, useLocale } from '../../i18n';
import { W } from '../strings';
const WP = W.provision;

/** 卡片有起始模块或目标模块时，P04 画“开始时 → 完成后”的构成图（I6 b）。 */
function hasArchitecture(lab: LabDoc | null | undefined): lab is LabDoc {
  return !!lab && ((lab.targetModules?.length ?? 0) > 0 || (lab.startProfile?.provisions ?? []).some((p) => p.kind === 'module'));
}

export function ProvisionPanel({ onCancel }: { onCancel: () => void }) {
  const ws = useWorkspace();
  const v = ws.view;
  const render = ws.render;
  if (render.screen !== 'P04') return null;
  if (render.variant === 'failed' || render.variant === 'cleanup-failed') return <FailurePanel />;
  if (render.variant === 'compensating' || render.variant === 'ended') return <CompensationView />;
  return <PreparingView onCancel={onCancel} key={v.sessionId} />;
}

function PreparingView({ onCancel }: { onCancel: () => void }) {
  const ws = useWorkspace();
  useSecondTick(true);
  const v = ws.view;
  const lab = ws.data.lab.data;
  const pclass = lab?.provision?.class ?? (ws.data.index.data?.cards?.find((c) => c.id === v.labId)?.provisionClass ?? null);
  const cls = pclass ? PROVISION_CLASS[pclass] : null;
  // 行标题是当前语言的文案：语言变化时重算（原地重新渲染，09 §1.2）
  const locale = useLocale();
  const rows = useMemo(
    () => buildPhaseRows({ view: v as never, events: ws.data.events, targets: ws.data.workspace.data?.targets ?? null }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [v, ws.data.events, ws.data.workspace.data, locale],
  );
  const now = ws.now();
  const elapsed = now - Date.parse(v.createdAt);
  const hourly = hourlyRangeOf(v.env?.hourlyEstimate);
  const near = nearBudget(v.createdAt, now, cls?.budgetMinutes);
  // 阶段完成时播报“创建基础环境已完成，用时 4 分 5 秒”（同一阶段只播一次）
  const spoken = useRef<Set<string> | null>(null);
  useEffect(() => {
    if (!spoken.current) {
      // 首次渲染：已完成的历史阶段不播报
      spoken.current = new Set(rows.filter((r) => r.status === 'done').map((r) => r.key));
      return;
    }
    for (const r of rows) {
      if (r.status !== 'done' || spoken.current.has(r.key)) continue;
      spoken.current.add(r.key);
      const text = r.startedAt && r.endedAt ? t(WP.phaseDoneTook, { title: r.title, t: formatSpan(r.endedAt - r.startedAt) }) : t(WP.phaseDone, { title: r.title });
      announce(text, { topic: 'provision-phase' });
    }
  }, [rows]);
  const [notif, setNotif] = useState<NotificationPermission | 'unsupported'>(() => (typeof Notification === 'undefined' ? 'unsupported' : Notification.permission));
  const estimate = hourly ? t(WP.billingHourly, { range: formatRange(hourly, hourly.currency) }) : WP.billingQuote;
  return (
    <section className="rpane prov-pane" aria-label={WP.region} data-provision="">
      <div className="stack prov-body">
        <div className="row between prov-head">
          <h2>{WP.title}</h2>
          {pclass && /^[ABCD]$/.test(pclass) ? (
            <MetricIcon kind="provision" value={pclass as ProvisionValue} />
          ) : cls ? (
            <span className="small">{t(WP.class, { name: cls.name, cls: pclass })}</span>
          ) : null}
        </div>
        <div className="prov-clock" title={cls?.note ?? WP.defaultNote}>
          <Icon name="clock" large />
          <span className="sr">{WP.elapsedLabel}</span>
          <span className="mono prov-elapsed">{formatCountdown(elapsed)}</span>
          <span className="small muted">{cls?.note ?? WP.defaultNote}</span>
        </div>
        <PhaseDiagram rows={rows} now={now} near={near} />
        {hasArchitecture(lab) ? (
          <figure className="prov-arch">
            <figcaption className="small muted">{WP.archCaption}</figcaption>
            <ArchDiagram input={archInputFromLab(lab)} size="full" mode="pair" fit="scale" title={WP.archTitle} />
          </figure>
        ) : null}
        <ul className="prov-tiles" aria-label={WP.factsLabel}>
          <li data-tile="billing">
            <WsIcon name="billing" large />
            <span className="stack-4">
              <b className="small">{WP.tileBilling}</b>
              <span className="small muted">{estimate}</span>
            </span>
          </li>
          <li data-tile="countdown">
            <Icon name="clock" large />
            <b className="small">{WP.tileCountdown}</b>
          </li>
          <li data-tile="leave">
            <WsIcon name="leave" large />
            <b className="small">{WP.tileLeave}</b>
          </li>
        </ul>
        <details className="disc prov-more">
          <summary>{WP.more}</summary>
          <div className="stack-8 small">
            <p>{t(WP.billing, { estimate })}</p>
            <p>{WP.leave}</p>
          </div>
        </details>
        <div className="row">
          {ws.learner && notif !== 'unsupported' ? (
            notif === 'granted' ? (
              <span className="small st pass">
                <Shape name="check" /> {WP.notifOn}
              </span>
            ) : (
              <Button
                size="sm"
                icon="bell"
                onClick={async () => {
                  try {
                    const p = await Notification.requestPermission();
                    setNotif(p);
                    if (p === 'denied') announce(WP.notifDenied);
                  } catch {
                    setNotif('denied');
                  }
                }}
              >
                {WP.enableNotif}
              </Button>
            )
          ) : null}
          {notif === 'denied' ? <span className="small muted">{WP.reallow}</span> : null}
          <span className="spacer" />
          {ws.allowed.includes('cancel') ? (
            <Button size="sm" onClick={onCancel}>
              {WP.cancel}
            </Button>
          ) : null}
        </div>
      </div>
    </section>
  );
}

/** 就绪后 3 秒的一行（P04 → P05 的过渡）。 */
export function ReadyFlash() {
  const ws = useWorkspace();
  const v = ws.view;
  const took = v.readyAt ? Date.parse(v.readyAt) - Date.parse(v.createdAt) : null;
  const total = v.deadlineAt && v.readyAt ? Date.parse(v.deadlineAt) - Date.parse(v.readyAt) : null;
  return (
    <section className="rpane prov-pane" aria-label={WP.region}>
      <div className="resbar prov-ready" role="status">
        <Shape name="check" />
        <span>
          {WP.ready}
          {took !== null ? t(WP.readyTook, { t: formatCountdown(took) }) : ''}
          {total !== null ? t(WP.countdownStarted, { t: formatCountdown(total) }) : ''}
        </span>
      </div>
    </section>
  );
}

/** 取消中 / 启动失败的补偿（CompensationProgress，复用 P07 回收阶段的紧凑形态：已删除 n/m）。 */
function CompensationView() {
  const ws = useWorkspace();
  const navigate = useNavigate();
  const v = ws.view;
  const ended = v.state === 'ENDED';
  const c = v.cleanup ?? null;
  const cancelled = v.endReason === 'CANCELLED' || !v.failure;
  return (
    <section className="rpane prov-pane" aria-label={cancelled ? WP.cancelProgress : WP.startFailed} data-compensation="">
      <div className="stack prov-body">
        <h2>{ended ? (cancelled ? WP.cancelled : WP.failedReleased) : cancelled ? WP.cancelling : WP.failedReleasing}</h2>
        {!cancelled ? <FailureSummary /> : null}
        <div className="box stack-8" aria-live="off">
          <span className="row">
            {ended ? (
              <span className="st pass">
                <Shape name="check" />
                <span className="t">{WP.released}</span>
              </span>
            ) : (
              <span className="st pend">
                <Shape name="spin" spin />
                <span className="t">{WP.releasing}</span>
              </span>
            )}
            {c && typeof c.total === 'number' ? <span className="small tnum">{t(WP.deleted, { n: c.deleted ?? 0, m: c.total })}</span> : null}
          </span>
        </div>
        <p className="small muted">{ended ? WP.endedNote : WP.releasingNote}</p>
        <div className="row">
          {ws.learner && ended ? (
            <Button variant="primary" onClick={() => navigate(`/labs/${v.labId}?start=1`)}>
              {WP.restart}
            </Button>
          ) : null}
          <Button onClick={() => navigate(`/sessions/${ws.sid}/end`)}>{WP.viewReclaim}</Button>
          <Button variant="ghost" onClick={() => navigate('/labs')}>
            {WP.backToCatalog}
          </Button>
        </div>
      </div>
    </section>
  );
}

function FailureSummary() {
  const ws = useWorkspace();
  const f = ws.view.failure;
  const meta = failureMeta(f?.code);
  return (
    <div className="vres bad">
      <Shape name="xbox" />
      <div className="stack-4">
        <b>{meta.title}</b>
        <span className="small mono">failure.code = {f?.code ?? 'UNKNOWN'}</span>
      </div>
    </div>
  );
}

/** FailurePanel（P04 失败面板；§5.2）：标题 h2；“复制诊断信息”复制 code、phase、requestId、会话 id；启动失败不计入尝试次数。 */
export function FailurePanel() {
  const ws = useWorkspace();
  const navigate = useNavigate();
  const v = ws.view;
  const f = (v.failure ?? {}) as { code?: string; phase?: string; message?: string; diagnostics?: unknown[]; requestId?: string };
  const meta = failureMeta(f.code);
  const cf = v.state === 'CLEANUP_FAILED';
  const lines = diagnosticLines(f.diagnostics);
  const cmd = meta.actions.includes('copy-command') ? preflightCommand(f.code, ws.data.vars.data?.session?.region as string | undefined) : null;
  const [diagOpen, setDiagOpen] = useState(false);
  const diag = diagnosticsText(ws.sid, f);
  return (
    <section className="rpane prov-pane" aria-label={WP.startFailed} data-failure={f.code ?? 'UNKNOWN'}>
      <div className="stack prov-body">
        <div className="vres bad">
          <Shape name="xbox" />
          <div className="stack-4">
            <h2>{meta.title}</h2>
            <span className="small mono">failure.code = {f.code ?? 'UNKNOWN'}</span>
          </div>
        </div>
        <p>{meta.description}</p>
        {f.message ? <p className="wrap-any small mono">{redact(f.message)}</p> : null}
        {cmd ? <CommandBlock text={cmd} runsOn="local" copyOnly /> : null}
        {lines.length ? (
          <details className="disc">
            <summary>{WP.diagnostics}</summary>
            <ul className="small mono mlist">
              {lines.map((l, i) => (
                <li key={i}>{redact(l)}</li>
              ))}
            </ul>
          </details>
        ) : null}
        <div className="stack-4">
          <b className="small">{WP.compensation}</b>
          {cf ? (
            <span className="small">
              <span className="st fail">
                <Shape name="tri" />
                <span className="t">{WP.notReleased}</span>
              </span>{' '}
              <Button size="sm" onClick={() => navigate(`/sessions/${ws.sid}/end#manual`)}>
                {WP.viewList}
              </Button>
            </span>
          ) : v.state === 'FAILED' || v.state === 'ENDED' ? (
            <span className="small st pass">
              <Shape name="check" />
              <span className="t">{WP.released}</span>
            </span>
          ) : (
            <span className="small st pend">
              <Shape name="spin" spin />
              <span className="t">{WP.releasing}</span>
            </span>
          )}
        </div>
        <div className="row">
          {ws.learner && meta.actions.includes('restart') ? (
            <Button variant="primary" onClick={() => navigate(`/labs/${v.labId}?start=1`)}>
              {WP.restart}
            </Button>
          ) : null}
          {ws.learner && meta.actions.includes('fresh') ? <Button onClick={() => navigate(`/labs/${v.labId}?start=1`)}>{WP.fresh}</Button> : null}
          {meta.actions.includes('current') ? <Button onClick={() => navigate('/sessions')}>{WP.viewCurrent}</Button> : null}
          <Button icon="copy" onClick={() => setDiagOpen(true)}>
            {WP.copyDiag}
          </Button>
        </div>
        <p className="small muted">{WP.restartNote}</p>
      </div>
      {diagOpen ? (
        <Dialog
          open
          onClose={() => setDiagOpen(false)}
          title={WP.copyDiag}
          size="narrow"
          footer={
            <>
              <button type="button" className="btn" onClick={() => setDiagOpen(false)}>
                {WP.cancelDialog}
              </button>
              <button
                type="button"
                className="btn primary"
                onClick={async () => {
                  setDiagOpen(false);
                  announce((await copyText(diag)) ? WP.copiedDiag : WP.clipboardDenied);
                }}
              >
                <Icon name="copy" />
                {WP.copyRaw}
              </button>
            </>
          }
        >
          <p className="small">{WP.diagWarning}</p>
          <pre className="mono small evjson">{redact(diag)}</pre>
        </Dialog>
      ) : null}
    </section>
  );
}
