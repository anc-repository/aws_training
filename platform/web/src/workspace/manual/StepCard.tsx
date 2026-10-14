/**
 * 步骤卡 StepCard（08 P05.3、§5.3；04 §4）：标题与预计耗时 → 计费提示（startsBilling）→ 预期中断提示 → 手册正文（做什么、为什么、
 * 做法标签页、代码块、控制台深链、预期结果、等待、提示）→ 常见错误 → 对比实验卡 → 选做步骤的跳过 → 本步检测。
 * 只读状态（准备中、只读角色、已结束）下正文照常可读，粘贴与检测禁用。
 */
import { useMemo, useState } from 'react';
import { useServices } from '../../app/context';
import { announce } from '../../lib/announce';
import { formatClock } from '../../lib/format';
import { Button, Shape, Status, STEP_STATE_META, type StepState } from '../../ui';
import { useWorkbench, useWorkspace } from '../context';
import { checkLocalId, isOptional, stepManual, STEP_TYPE_TEXT, type LabStep } from '../model/lab';
import { collectPaths } from '../model/vars';
import { ExperimentCard } from './ExperimentCard';
import { collectTexts, hasChecksDirective, indexCodeBlocks, Nodes, type RenderEnv } from './Mdast';
import { PlatformActionButton } from './PlatformAction';
import { StepCheckPanel } from './StepCheckPanel';
import { VarInputDirective } from './VariableStrip';

import { t } from '../../i18n';
import { W } from '../strings';
import { manualUntranslated } from '../../i18n/content';
import { UntranslatedIf } from '../../i18n/Untranslated';

const WSC = W.step;
export function stepStateOf(ws: ReturnType<typeof useWorkspace>, stepId: string): { state: StepState; at: string | null } {
  const p = ws.data.progress.data?.steps.find((s) => s.stepId === stepId);
  const r = ws.data.stepMap.get(stepId);
  const st = (p?.state ?? r?.state ?? 'available') as StepState;
  return { state: STEP_STATE_META[st] ? st : 'available', at: p?.firstPassedAt ?? r?.firstPassedAt ?? null };
}

export function usedVariablePaths(lab: ReturnType<typeof useWorkspace>['data']['lab']['data']): Set<string> {
  if (!lab) return new Set();
  const texts: string[] = [];
  for (const m of Object.values(lab.manuals ?? {})) collectTexts(m.ast, texts);
  return collectPaths(texts);
}

export function StepCard({ step, index }: { step: LabStep; index: number }) {
  const ws = useWorkspace();
  const wb = useWorkbench();
  const { api } = useServices();
  const lab = ws.data.lab.data!;
  const manual = stepManual(lab, step);
  const blockIndex = useMemo(() => indexCodeBlocks(manual?.ast), [manual]);
  const { state, at } = stepStateOf(ws, step.id);
  const env: RenderEnv = {
    lab,
    step,
    vars: ws.data.vars.data,
    blockIndex,
    renderChecks: (checkId) => <StepCheckPanel step={step} only={checkId} />,
    renderExperiment: (a) => <ExperimentCard module={a.module} id={a.id} label={a.label} />,
    renderPlatformAction: (id) => <PlatformActionButton actionId={id} />,
    renderVarInput: (name) => <VarInputDirective name={name} />,
    onConsoleLink: (linkId, params) => wb.openConsole({ linkId, params }),
    onOpenTab: (tab) => wb.focusTab(tab as never, { user: true }),
  };
  const autoChecks = !hasChecksDirective(manual?.ast);
  const expHere = !!manual && JSON.stringify(manual.ast).includes('"name":"experiment"');
  const optional = isOptional(step);
  const [skipBusy, setSkipBusy] = useState(false);
  const [readBusy, setReadBusy] = useState(false);
  const canAct = ws.learner && ws.live;
  const eo = step.expectedOutage;
  const windowOpen = ws.outage && (!ws.outage.stepId || ws.outage.stepId === step.id) ? ws.outage : null;
  const pitfalls = usePitfalls(step);

  return (
    <article className="stepcard" data-step={step.id} aria-labelledby={`step-h-${step.id}`}>
      <div className="row between small">
        <span>
          <Status meta={STEP_STATE_META[state]} />
          {at ? <span className="faint"> · {formatClock(at)}</span> : null}
        </span>
        <span className="muted">
          {step.estMinutes ? t(WSC.est, { n: step.estMinutes }) : ''}
          {STEP_TYPE_TEXT[step.type] ?? step.type}
          {optional ? WSC.optional : ''}
        </span>
      </div>
      <h2 id={`step-h-${step.id}`} tabIndex={-1} data-step-heading="">
        <span className="no">{index + 1}</span>
        {step.title}
        <UntranslatedIf show={!!manual && manualUntranslated(manual)} />
      </h2>
      {step.startsBilling ? (
        <div className="note" role="note" data-billing="">
          <Shape name="dot" />
          <span>
            {t(WSC.billing, {
              what: step.startsBilling.note ? `${step.startsBilling.note}` : WSC.billingDefault,
              keys: step.startsBilling.pricingKeys?.length ? t(WSC.billingKeys, { list: step.startsBilling.pricingKeys.join(WSC.listSep) }) : '',
            })}
          </span>
        </div>
      ) : null}
      {eo ? (
        windowOpen ? (
          <div className="note" role="note" data-outage="open">
            <Shape name="hg" />
            <span>
              {t(WSC.outageOpen, { reason: eo.reason ? t(WSC.reasonParen, { reason: eo.reason }) : '', t: formatClock(windowOpen.until) })}
            </span>
          </div>
        ) : (
          <div className="note" role="note" data-outage="notice">
            <Shape name="hg" />
            <span>
              {t(WSC.outageNotice, { n: eo.maxMinutes ?? WSC.several })}
            </span>
          </div>
        )
      ) : null}
      {manual ? (
        <div className="mbody stack-8">
          <Nodes nodes={manual.ast.children ?? []} env={env} />
        </div>
      ) : (
        <p className="small muted">{WSC.noBody}</p>
      )}
      {pitfalls.list.length ? (
        <details className="disc" data-pitfalls="" open={pitfalls.hit.length > 0 && (state === 'failed' || state === 'drifted') ? true : undefined}>
          <summary>{t(WSC.pitfalls, { n: pitfalls.list.length })}</summary>
          <ul className="small mlist">
            {pitfalls.list.map((p) => (
              <li key={p.id} data-hit={pitfalls.hit.includes(p.id) ? '' : undefined}>
                {pitfalls.hit.includes(p.id) ? <b>{WSC.hit}</b> : null}
                <b>{p.title ?? p.id}</b>
                {p.cause ? t(WSC.cause, { cause: p.cause }) : ''}
                {p.fix ? <span className="muted">{t(WSC.fix, { fix: p.fix })}</span> : null}
              </li>
            ))}
          </ul>
        </details>
      ) : null}
      {step.experiment && !expHere ? <ExperimentCard module={step.experiment.module} id={step.experiment.id} label={step.experiment.label} /> : null}
      {optional && canAct ? (
        <div>
          <Button
            size="sm"
            variant="ghost"
            busy={skipBusy}
            onClick={async () => {
              setSkipBusy(true);
              try {
                await api.call(state === 'skipped' ? 'unskipStep' : 'skipStep', { params: { sid: ws.sid, stepId: step.id }, body: state === 'skipped' ? undefined : {} });
                announce(state === 'skipped' ? WSC.unskipped : WSC.skipped);
              } catch {
                announce(WSC.failed);
              } finally {
                setSkipBusy(false);
              }
            }}
          >
            {state === 'skipped' ? WSC.unskip : WSC.skip}
          </Button>
        </div>
      ) : null}
      {!(step.checks ?? []).length && canAct && state !== 'done' ? (
        <div>
          <Button
            size="sm"
            busy={readBusy}
            onClick={async () => {
              setReadBusy(true);
              try {
                await api.call('markStepRead', { params: { sid: ws.sid, stepId: step.id }, body: {} });
                announce(WSC.readDone);
              } catch {
                announce(WSC.readFailed);
              } finally {
                setReadBusy(false);
              }
            }}
          >
            {WSC.read}
          </Button>
        </div>
      ) : null}
      {autoChecks && (step.checks ?? []).length ? <StepCheckPanel step={step} /> : null}
    </article>
  );
}

function usePitfalls(step: LabStep) {
  const ws = useWorkspace();
  const lab = ws.data.lab.data!;
  return useMemo(() => {
    const ids = new Set<string>();
    for (const ref of step.checks ?? []) for (const p of lab.checks?.[checkLocalId(ref)]?.pitfalls ?? []) ids.add(p);
    const list = [...ids].map((id) => ({ id, ...(lab.pitfalls?.[id] ?? {}) }));
    const hit = new Set<string>();
    for (const p of list) {
      const m = (lab.pitfalls?.[p.id] as { match?: { checkId?: string; result?: string }[] } | undefined)?.match ?? [];
      const ok =
        m.length > 0 &&
        m.every((x) => {
          const st = x.checkId ? ws.data.stepMap.get(step.id)?.checks?.[x.checkId] : null;
          return !!st && (!x.result || st.effective === x.result || st.lastAuto?.result === x.result);
        });
      if (ok) hit.add(p.id);
    }
    return { list, hit: [...hit] };
  }, [step, lab, ws.data.stepMap]);
}
