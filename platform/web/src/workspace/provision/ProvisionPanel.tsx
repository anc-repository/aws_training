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
import { useWorkspace } from '../context';
import { formatRange, hourlyRangeOf } from '../model/cost';
import { diagnosticLines, diagnosticsText, failureMeta, preflightCommand } from '../model/failure';
import { PROVISION_CLASS } from '../model/lab';
import { buildPhaseRows, nearBudget, type PhaseRowModel } from '../model/phases';

const PHASE_SHAPE: Record<PhaseRowModel['status'], { shape: 'check' | 'spin' | 'ring' | 'retry' | 'clock' | 'xbox' | 'dash'; tone: string; text: string }> = {
  done: { shape: 'check', tone: 'pass', text: '完成' },
  running: { shape: 'spin', tone: 'pend', text: '进行中' },
  todo: { shape: 'ring', tone: 'faint', text: '未开始' },
  retrying: { shape: 'retry', tone: 'drift', text: '重试中' },
  queued: { shape: 'clock', tone: 'pend', text: '排队中' },
  failed: { shape: 'xbox', tone: 'fail', text: '失败' },
  skipped: { shape: 'dash', tone: 'mut', text: '跳过' },
};

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
  const rows = useMemo(() => buildPhaseRows({ view: v as never, events: ws.data.events, targets: ws.data.workspace.data?.targets ?? null }), [v, ws.data.events, ws.data.workspace.data]);
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
      const took = r.startedAt && r.endedAt ? `，用时 ${formatSpan(r.endedAt - r.startedAt)}` : '';
      announce(`${r.title}已完成${took}`, { topic: 'provision-phase' });
    }
  }, [rows]);
  const [notif, setNotif] = useState<NotificationPermission | 'unsupported'>(() => (typeof Notification === 'undefined' ? 'unsupported' : Notification.permission));
  return (
    <section className="rpane prov-pane" aria-label="准备进度" data-provision="">
      <div className="stack prov-body">
        <div className="row between">
          <h2>正在准备实验环境</h2>
          {cls ? (
            <span className="small">
              环境准备：{cls.name}（{pclass}）
            </span>
          ) : null}
        </div>
        <p className="small muted">
          已用 <span className="mono">{formatCountdown(elapsed)}</span> · {cls?.note ?? '起始状态包含的资源决定准备时间。'}
        </p>
        <ol className="prov" aria-label="准备阶段">
          {rows.map((r) => {
            const m = PHASE_SHAPE[r.status];
            const current = r.status === 'running' || r.status === 'retrying' || r.status === 'queued';
            const tm = r.status === 'done' && r.startedAt && r.endedAt ? formatCountdown(r.endedAt - r.startedAt) : current && r.startedAt ? formatCountdown(now - r.startedAt) : '';
            return (
              <li key={r.key} className={r.status === 'todo' ? 'phrow todo' : 'phrow'} aria-current={current ? 'step' : undefined} data-phase={r.key} data-status={r.status}>
                <span className={`st ${m.tone}`}>
                  <Shape name={m.shape} spin={m.shape === 'spin'} />
                  <span className="sr">{m.text}</span>
                </span>
                <span className="pt">{r.title}</span>
                <span className="tm mono small">{tm}</span>
                {r.details.length ? <span className="pd">{r.details.map((d) => redact(d)).join(' · ')}</span> : null}
                {r.status === 'queued' ? <span className="pd">运行器排队中（CodeBuild 并发已满）</span> : null}
                {r.slowHint ? <span className="pd">{r.slowHint}</span> : null}
                {current && near ? <span className="pd">比通常更久。平台会在超时前自动停止并释放已创建的资源。</span> : null}
              </li>
            );
          })}
        </ol>
        <div className="note">
          <Shape name="dot" />
          <span>计费：环境创建开始即计费（{hourly ? `${formatRange(hourly, hourly.currency)}/小时，估算` : '估算见开始时的报价'}），倒计时从“就绪”开始。</span>
        </div>
        <div className="note blue">
          <Shape name="clock" />
          <span>可以离开这个页面：准备在后台进行。就绪后顶栏会提示，也会发送邮件（需已确认订阅）。浏览器通知只能尽力送达。</span>
        </div>
        <div className="row">
          {ws.learner && notif !== 'unsupported' ? (
            notif === 'granted' ? (
              <span className="small st pass">
                <Shape name="check" /> 已开启浏览器通知
              </span>
            ) : (
              <Button
                size="sm"
                icon="bell"
                onClick={async () => {
                  try {
                    const p = await Notification.requestPermission();
                    setNotif(p);
                    if (p === 'denied') announce('浏览器拒绝了通知，可以在浏览器设置中重新允许');
                  } catch {
                    setNotif('denied');
                  }
                }}
              >
                开启浏览器通知
              </Button>
            )
          ) : null}
          {notif === 'denied' ? <span className="small muted">可以在浏览器设置中重新允许。</span> : null}
          <span className="spacer" />
          {ws.allowed.includes('cancel') ? (
            <Button size="sm" onClick={onCancel}>
              取消…
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
    <section className="rpane prov-pane" aria-label="准备进度">
      <div className="resbar prov-ready" role="status">
        <Shape name="check" />
        <span>
          环境已就绪{took !== null ? `（用时 ${formatCountdown(took)}）` : ''}
          {total !== null ? `，倒计时 ${formatCountdown(total)} 已开始` : ''}
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
    <section className="rpane prov-pane" aria-label={cancelled ? '取消进度' : '启动失败'} data-compensation="">
      <div className="stack prov-body">
        <h2>{ended ? (cancelled ? '已取消实验' : '启动失败，已释放已创建的资源') : cancelled ? '正在取消：释放已创建的资源' : '启动失败：正在释放已创建的资源'}</h2>
        {!cancelled ? <FailureSummary /> : null}
        <div className="box stack-8" aria-live="off">
          <span className="row">
            {ended ? (
              <span className="st pass">
                <Shape name="check" />
                <span className="t">已释放已创建的资源</span>
              </span>
            ) : (
              <span className="st pend">
                <Shape name="spin" spin />
                <span className="t">正在释放已创建的资源</span>
              </span>
            )}
            {c && typeof c.total === 'number' ? <span className="small tnum">已删除 {c.deleted ?? 0}/{c.total}</span> : null}
          </span>
        </div>
        <p className="small muted">{ended ? '这次尝试不计入次数。准备期间产生的费用不会退回。' : '释放在后台进行，可以离开这个页面。释放完成前不能开始新的实验。'}</p>
        <div className="row">
          {ws.learner && ended ? (
            <Button variant="primary" onClick={() => navigate(`/labs/${v.labId}?start=1`)}>
              重新开始
            </Button>
          ) : null}
          <Button onClick={() => navigate(`/sessions/${ws.sid}/end`)}>查看回收进度</Button>
          <Button variant="ghost" onClick={() => navigate('/labs')}>
            回到卡片目录
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
    <section className="rpane prov-pane" aria-label="启动失败" data-failure={f.code ?? 'UNKNOWN'}>
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
            <summary>诊断信息</summary>
            <ul className="small mono mlist">
              {lines.map((l, i) => (
                <li key={i}>{redact(l)}</li>
              ))}
            </ul>
          </details>
        ) : null}
        <div className="stack-4">
          <b className="small">补偿回收</b>
          {cf ? (
            <span className="small">
              <span className="st fail">
                <Shape name="tri" />
                <span className="t">有资源未释放</span>
              </span>{' '}
              <Button size="sm" onClick={() => navigate(`/sessions/${ws.sid}/end#manual`)}>
                查看清单
              </Button>
            </span>
          ) : v.state === 'FAILED' || v.state === 'ENDED' ? (
            <span className="small st pass">
              <Shape name="check" />
              <span className="t">已释放已创建的资源</span>
            </span>
          ) : (
            <span className="small st pend">
              <Shape name="spin" spin />
              <span className="t">正在释放已创建的资源</span>
            </span>
          )}
        </div>
        <div className="row">
          {ws.learner && meta.actions.includes('restart') ? (
            <Button variant="primary" onClick={() => navigate(`/labs/${v.labId}?start=1`)}>
              重新开始
            </Button>
          ) : null}
          {ws.learner && meta.actions.includes('fresh') ? <Button onClick={() => navigate(`/labs/${v.labId}?start=1`)}>全新开始</Button> : null}
          {meta.actions.includes('current') ? <Button onClick={() => navigate('/sessions')}>查看当前实验</Button> : null}
          <Button icon="copy" onClick={() => setDiagOpen(true)}>
            复制诊断信息
          </Button>
        </div>
        <p className="small muted">这次尝试不计入次数。重新开始会回到简介页并打开开始对话框（必须重新报价）。</p>
      </div>
      {diagOpen ? (
        <Dialog
          open
          onClose={() => setDiagOpen(false)}
          title="复制诊断信息"
          size="narrow"
          footer={
            <>
              <button type="button" className="btn" onClick={() => setDiagOpen(false)}>
                取消
              </button>
              <button
                type="button"
                className="btn primary"
                onClick={async () => {
                  setDiagOpen(false);
                  announce((await copyText(diag)) ? '已复制诊断信息' : '无法访问剪贴板');
                }}
              >
                <Icon name="copy" />
                复制原文
              </button>
            </>
          }
        >
          <p className="small">诊断信息包含 AWS 账号 ID、资源 ARN 等原文，便于排查；分享给他人前请自行打码。</p>
          <pre className="mono small evjson">{redact(diag)}</pre>
        </Dialog>
      ) : null}
    </section>
  );
}
