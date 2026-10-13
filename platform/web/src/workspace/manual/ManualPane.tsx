/**
 * 左侧手册 ManualPane（08 P05.3；03 §2.4）：手册头（卡片标题、尝试状态、进度、[提交实验]）→ 变量条 → 步骤导航（“步骤 ▾”下拉的紧凑 StepRail）
 * → 当前步骤卡 → 底栏（上一步 / 检测 / 下一步，高 48px）。手册聚焦时单键 J / K（切换步骤）、R（检测）；任何位置的前导键由工作台处理。
 * 准备模式（P04）与只读状态下手册照常可读，“粘贴到终端”“检测”禁用并说明原因。
 */
import { useEffect, useMemo, useRef, type KeyboardEvent, type RefObject } from 'react';
import { ATTEMPT_STATUS_META, Button, Disclosure, EmptyState, Icon, Shape, Skeleton, Status, STEP_STATE_META, type AttemptStatus } from '../../ui';
import { formatClock } from '../../lib/format';
import { useWorkbench, useWorkspace } from '../context';
import { isOptional, sectionManual, type LabStep } from '../model/lab';
import { indexCodeBlocks, Nodes } from './Mdast';
import { StepCard, stepStateOf, usedVariablePaths } from './StepCard';
import { VariableStrip, type VariableStripHandle } from './VariableStrip';

export interface ManualPaneProps {
  stepIndex: number;
  onStep: (index: number) => void;
  onSubmit: () => void;
  revealRef: RefObject<VariableStripHandle | null>;
}

function typing(t: EventTarget | null): boolean {
  return t instanceof HTMLElement && (t.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(t.tagName));
}

export function ManualPane({ stepIndex, onStep, onSubmit, revealRef }: ManualPaneProps) {
  const ws = useWorkspace();
  const wb = useWorkbench();
  const lab = ws.data.lab.data;
  const steps = lab?.steps ?? [];
  const step = steps[stepIndex] ?? null;
  const used = useMemo(() => usedVariablePaths(lab), [lab]);
  const progress = ws.data.progress.data;
  const attempt = (progress?.status ?? ws.view.progress?.status ?? (ws.preparing ? 'active' : null)) as AttemptStatus | null;
  const done = progress?.stepsDone ?? ws.view.progress?.stepsDone ?? 0;
  const total = progress?.stepsTotal ?? ws.view.progress?.stepsTotal ?? steps.filter((s) => !isOptional(s)).length;
  const scrollRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    scrollRef.current?.scrollTo?.({ top: 0 });
  }, [stepIndex]);

  const onKey = (e: KeyboardEvent<HTMLElement>) => {
    if (e.ctrlKey || e.metaKey || e.altKey || typing(e.target) || (e.target as HTMLElement).closest('[role="dialog"]')) return;
    const k = e.key.toLowerCase();
    if (k === 'j') {
      e.preventDefault();
      onStep(Math.min(steps.length - 1, stepIndex + 1));
    } else if (k === 'k') {
      e.preventDefault();
      onStep(Math.max(0, stepIndex - 1));
    } else if (k === 'r' && step && (ws.role === 'L' || ws.role === 'A') && ws.live) {
      e.preventDefault();
      wb.runStepCheck(step.id);
    }
  };

  const overview = lab ? sectionManual(lab, 'overview') : null;
  const overviewIdx = useMemo(() => indexCodeBlocks(overview?.ast), [overview]);

  return (
    <section className="mpane" id="mpane" aria-label="实验手册" onKeyDown={onKey}>
      <div className="mhead">
        <div className="row between mhead-row">
          <b>实验手册</b>
          {attempt && ATTEMPT_STATUS_META[attempt] ? (
            <span className="small">
              尝试：<Status meta={ATTEMPT_STATUS_META[attempt]} />
            </span>
          ) : null}
          <span className="small">
            进度 <span className="tnum">{done}/{total}</span>
            <span className="sr"> 个必需步骤已达成</span>
          </span>
          {steps.length ? <StepRail steps={steps} current={stepIndex} onPick={onStep} /> : null}
          {ws.learner && ws.live && steps.length ? (
            <Button size="sm" onClick={onSubmit} data-submit="">
              提交实验
            </Button>
          ) : null}
        </div>
        {lab ? <VariableStrip used={used} revealRef={revealRef as { current: VariableStripHandle | null }} /> : null}
      </div>
      <div className="mscroll" ref={scrollRef} data-keep="manual">
        {ws.preparing ? (
          <div className="note blue" role="note">
            <Shape name="clock" />
            <span>环境准备中：可以先读手册；“粘贴到终端”与检测会在就绪后可用。</span>
          </div>
        ) : null}
        {!ws.learner ? (
          <div className="note" role="note">
            <Icon name="eye" />
            <span>只读：你的角色可以查看手册与检测结果{ws.role === 'A' ? '、运行检测并复核手动确认' : ''}。</span>
          </div>
        ) : null}
        {!lab ? (
          ws.data.lab.error ? (
            <EmptyState title="手册内容缺失">请在 设置 › 内容版本 中检查。</EmptyState>
          ) : (
            <Skeleton lines={6} block />
          )
        ) : !steps.length ? (
          <EmptyState title="手册内容缺失">请在 设置 › 内容版本 中检查。</EmptyState>
        ) : (
          <>
            {stepIndex === 0 && overview ? (
              <details className="disc overview">
                <summary>卡片概览</summary>
                <div className="stack-8 small">
                  <Nodes nodes={overview.ast.children ?? []} env={{ lab, step: null, vars: ws.data.vars.data, blockIndex: overviewIdx }} />
                </div>
              </details>
            ) : null}
            {step ? <StepCard key={step.id} step={step} index={stepIndex} /> : null}
          </>
        )}
      </div>
      <div className="mfoot">
        <Button size="sm" onClick={() => onStep(stepIndex - 1)} disabledReason={stepIndex <= 0 ? null : null} disabled={stepIndex <= 0}>
          ← 上一步
        </Button>
        <span className="spacer" />
        {(ws.role === 'L' || ws.role === 'A') && step ? (
          <Button size="sm" onClick={(e) => (e.shiftKey ? wb.runLabCheck() : wb.runStepCheck(step.id))} aria-disabled={!ws.live ? true : undefined} title={!ws.live ? (ws.preparing ? '环境就绪后可用' : '实验已结束') : undefined} data-foot-check="">
            检测
            <span className="kbd-hint">
              {' '}
              <kbd>⌃.</kbd>
              <kbd>R</kbd>
            </span>
          </Button>
        ) : null}
        <span className="spacer" />
        <Button size="sm" onClick={() => onStep(stepIndex + 1)} disabled={stepIndex >= steps.length - 1}>
          下一步 →
        </Button>
      </div>
    </section>
  );
}

/** 步骤下拉（紧凑 StepRail）：`<ol>` + `<li><button>`，当前步骤 aria-current="step"；↑↓ 切换焦点，Enter 打开。 */
function StepRail({ steps, current, onPick }: { steps: readonly LabStep[]; current: number; onPick: (i: number) => void }) {
  const ws = useWorkspace();
  const onKey = (e: KeyboardEvent<HTMLOListElement>) => {
    if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
    e.preventDefault();
    const btns = Array.from(e.currentTarget.querySelectorAll<HTMLButtonElement>('button'));
    const i = btns.indexOf(document.activeElement as HTMLButtonElement);
    btns[(i + (e.key === 'ArrowDown' ? 1 : -1) + btns.length) % btns.length]?.focus();
  };
  return (
    <Disclosure
      label={
        <>
          步骤 <Icon name="chev" />
        </>
      }
      ariaLabel="全部步骤"
      buttonClassName="btn sm"
      className="railpop"
    >
      {(close) => (
        <ol className="steprail" aria-label="全部步骤" onKeyDown={onKey}>
          {steps.map((s, i) => {
            const { state, at } = stepStateOf(ws, s.id);
            const m = STEP_STATE_META[state];
            return (
              <li key={s.id}>
                <button
                  type="button"
                  aria-current={i === current ? 'step' : undefined}
                  onClick={() => {
                    close();
                    onPick(i);
                  }}
                >
                  <span className={`st ${m.tone}`}>
                    <Shape name={m.shape} />
                  </span>
                  <span className="mono small">{i + 1}</span>
                  <span className="wrap-any small">
                    {s.title}
                    {isOptional(s) ? <span className="tag">选做</span> : null}
                    {s.wait ? <span className="tag">等待</span> : null}
                    {s.expectedOutage ? <span className="tag">预期中断</span> : null}
                    {s.startsBilling ? <span className="tag">开始计费</span> : null}
                  </span>
                  <span className="small faint">
                    {m.text}
                    {at ? ` ${formatClock(at)}` : ''}
                  </span>
                </button>
              </li>
            );
          })}
        </ol>
      )}
    </Disclosure>
  );
}
