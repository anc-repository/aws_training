/**
 * 手册中的实验卡 ExperimentCard（`::experiment`，08 §5.4、P05.3）：运行命令（可粘贴到工作台）、各变体最近一次记录与有效性、[查看对比]
 * （打开 P06 抽屉 `?exp=<module>/<id>`）。
 */
import { useMemo } from 'react';
import { formatClock } from '../../lib/format';
import { Button, Status, VALIDITY_META, type StatusMeta } from '../../ui';
import { useWorkbench, useWorkspace } from '../context';
import { variantColumns, VARIANT_STATUS_TEXT, runCommand, type VariantStatus } from '../model/experiments';
import { findExperiment } from '../model/lab';
import { ManualCommand } from './ManualCommand';
import type { RenderEnv } from './Mdast';

import { t } from '../../i18n';
import { W } from '../strings';
export function variantMeta(s: VariantStatus): StatusMeta {
  if (s === 'valid' || s === 'simulated' || s === 'invalid' || s === 'pending-crosscheck') return { ...VALIDITY_META[s], text: VARIANT_STATUS_TEXT[s] };
  if (s === 'none') return { text: VARIANT_STATUS_TEXT.none, shape: 'ring', tone: 'faint' };
  if (s === 'stale-registered') return { text: VARIANT_STATUS_TEXT['stale-registered'], shape: 'tri', tone: 'drift' };
  return { text: VARIANT_STATUS_TEXT[s], shape: 'clock', tone: 'pend' };
}

export function ExperimentCard({ module, id, label }: { module: string; id: string; label?: string }) {
  const ws = useWorkspace();
  const wb = useWorkbench();
  const exp = findExperiment(ws.data.lab.data, `${module}/${id}`);
  const runsData = ws.data.experiments.data;
  const now = ws.now;
  const cols = useMemo(() => (exp ? variantColumns(exp, runsData?.items ?? [], {}, now()) : []), [exp, runsData, now]);
  const key = `${module}/${id}`;
  const env: RenderEnv = { lab: ws.data.lab.data!, step: null, vars: ws.data.vars.data, blockIndex: new WeakMap() };
  const cmdLabel = label ?? cols.find((c) => c.status === 'none')?.label.id ?? cols[0]?.label.id ?? 'before';
  return (
    <div className="box stack-8 expcard" data-experiment={key}>
      <div className="row between">
        <b className="small">
          {t(W.expCard.title, { key })}
          {exp?.required ? W.expCard.required : exp ? W.expCard.optional : ''}
        </b>
        <Button size="sm" onClick={() => wb.openExperiment(key)}>
          {W.expCard.view}
        </Button>
      </div>
      {cols.length ? (
        <ul className="explines small">
          {cols.map((c) => (
            <li key={c.label.id}>
              <span className="mono">{c.label.id}</span> <Status meta={variantMeta(c.status)} />
              {c.selected?.finishedAt || c.selected?.registeredAt ? <span className="faint"> · {formatClock((c.selected.finishedAt ?? c.selected.registeredAt)!)}</span> : null}
            </li>
          ))}
        </ul>
      ) : (
        <p className="small muted">{W.expCard.notDeclared}</p>
      )}
      {ws.learner && exp ? (
        <ManualCommand node={{ type: 'code', lang: 'bash', attributes: { runsOn: 'workstation' }, value: runCommand(exp, cmdLabel) }} env={env} />
      ) : null}
    </div>
  );
}
