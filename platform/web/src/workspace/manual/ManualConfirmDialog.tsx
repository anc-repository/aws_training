/**
 * 手动确认 ManualConfirmDialog（08 P05.5；04 §8.8；沿用 ui-design §4.8）：
 * - 必须填写看到的值（选项或按 pattern 输入）；只有选中期望值才能提交，选了其他值直接显示修复提示；
 * - 备注必填、至少 6 个字；可粘贴 `evidence.command` 的输出（EvidencePaste，只解析 JSON），后端用同一套断言校验，通过记为“带证据的手动”；
 * - 提交 `POST /sessions/{sid}/steps/{stepId}/manual-confirmations {checkId, observed, note, evidence?}`；没有批量确认；
 * - 草稿存 sessionStorage（登录过期返回后恢复，§8.6）；降级的手动确认在有助教时显示“等待助教复核”。
 */
import { useEffect, useId, useMemo, useState } from 'react';
import { useServices } from '../../app/context';
import { isApiError } from '../../api/errors';
import { announce } from '../../lib/announce';
import { ssGet, ssSet } from '../../lib/storage';
import { Button, Dialog, Field, Shape } from '../../ui';
import { useWorkspace } from '../context';
import type { ManualSpec } from '../model/lab';
import { resolveTemplate } from '../model/vars';
import { ManualCommand } from './ManualCommand';

import { t, useLocale } from '../../i18n';
import { W } from '../strings';

const MC = W.manualConfirm;
export const EVIDENCE_MAX_CHARS = 4096;

interface Draft {
  observed: string;
  note: string;
  evidence: string;
}

export function draftKey(sid: string, stepId: string, checkId: string): string {
  return `atl.ws.manual.${sid}.${stepId}.${checkId}.v1`;
}

export function ManualConfirmDialog({ stepId, checkId, onClose }: { stepId: string; checkId: string; onClose: () => void }) {
  const ws = useWorkspace();
  const { api } = useServices();
  const lab = ws.data.lab.data;
  const decl = lab?.checks?.[checkId] ?? null;
  const native = decl?.type === 'manual';
  const spec: ManualSpec = (native ? decl?.spec : decl?.manualFallback) ?? {};
  const key = draftKey(ws.sid, stepId, checkId);
  const [d, setD] = useState<Draft>(() => ssGet<Draft>(key, { observed: '', note: '', evidence: '' }));
  useEffect(() => {
    ssSet(key, d);
  }, [key, d]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<{ reviewPending: boolean; result: string } | null>(null);
  const qid = useId();
  const options = spec.observed?.options ?? [];
  const chosen = options.find((o) => o.value === d.observed) ?? null;
  const inputRe = useMemo(() => {
    try {
      return spec.input?.pattern ? new RegExp(spec.input.pattern) : null;
    } catch {
      return null;
    }
  }, [spec.input?.pattern]);
  const observedOk = options.length ? !!chosen?.expected : d.observed.trim() !== '' && (!inputRe || inputRe.test(d.observed.trim()));
  const noteOk = d.note.trim().length >= 6;
  const locale = useLocale();
  const evidenceErr = useMemo(() => {
    if (!d.evidence.trim()) return null;
    if (d.evidence.length > EVIDENCE_MAX_CHARS) return t(MC.evidenceTooLong, { n: EVIDENCE_MAX_CHARS });
    try {
      JSON.parse(d.evidence);
      return null;
    } catch {
      return MC.evidenceJson;
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [d.evidence, locale]);
  const canSubmit = observedOk && noteOk && !evidenceErr && !busy;
  const where = spec.where as { breadcrumb?: string[]; region?: string } | undefined;

  const submit = async () => {
    if (!canSubmit) return;
    setBusy(true);
    setError(null);
    try {
      const r = await api.call<{ reviewPending?: boolean; result?: string }>('createManualConfirmation', {
        params: { sid: ws.sid, stepId },
        body: { checkId, observed: d.observed.trim(), note: d.note.trim(), ...(d.evidence.trim() ? { evidence: d.evidence.trim() } : {}) },
      });
      ssSet(key, undefined);
      setDone({ reviewPending: !!r.data?.reviewPending, result: r.data?.result ?? 'manual' });
      announce(r.data?.reviewPending ? MC.submittedReview : MC.submitted);
      void ws.data.steps.refresh();
      void ws.data.progress.refresh();
    } catch (e) {
      setError(isApiError(e) ? (e.code === 'VALIDATION_FAILED' ? t(MC.invalid, { detail: e.detail ?? '' }) : (e.detail ?? e.title)) : MC.failed);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog
      open
      onClose={onClose}
      title={t(MC.title, { name: decl?.title ?? checkId })}
      footer={
        done ? (
          <button type="button" className="btn primary" onClick={onClose}>
            {MC.done}
          </button>
        ) : (
          <>
            <button type="button" className="btn" onClick={onClose}>
              {MC.cancel}
            </button>
            <Button variant="primary" onClick={() => void submit()} busy={busy} busyText={MC.submitting} disabled={!canSubmit} data-mc-submit="">
              {MC.submit}
            </Button>
          </>
        )
      }
    >
      {done ? (
        <div className="note green" role="status">
          <Shape name={done.result === 'manual_evidence' ? 'manp' : 'man'} />
          <span>{done.reviewPending ? MC.doneReview : done.result === 'manual_evidence' ? MC.doneEvidence : MC.doneManual}</span>
        </div>
      ) : (
        <div className="stack">
          <p className="small muted">
            {native ? MC.native : MC.degraded}
          </p>
          {where?.breadcrumb?.length ? (
            <p className="small">
              {t(MC.where, { path: where.breadcrumb.map((b) => resolveTemplate(b, ws.data.vars.data).text).join(' › ') })}
              {where.region ? t(MC.whereRegion, { region: where.region === 'app' ? ((ws.data.vars.data?.session?.region as string | undefined) ?? MC.labRegion) : where.region }) : ''}
            </p>
          ) : null}
          {spec.confirm ? <p className="small">{resolveTemplate(spec.confirm, ws.data.vars.data).text}</p> : null}
          {options.length ? (
            <fieldset className="stack-4">
              <legend id={qid}>{spec.observed?.question ?? MC.question}</legend>
              {options.map((o) => (
                <label key={o.value} className="row">
                  <input type="radio" name={qid} value={o.value} checked={d.observed === o.value} onChange={() => setD({ ...d, observed: o.value })} />
                  {o.label}
                </label>
              ))}
              {chosen && !chosen.expected ? (
                <div className="note amber" role="alert">
                  <Shape name="tri" />
                  <span>
                    {MC.notExpected}
                    {chosen.fixHint ?? MC.fixDefault}
                  </span>
                </div>
              ) : null}
            </fieldset>
          ) : (
            <Field label={spec.observed?.question ?? spec.input?.label ?? MC.valueLabel} hint={spec.input?.example ? t(MC.example, { v: spec.input.example }) : undefined} error={d.observed && !observedOk ? MC.badFormat : null}>
              <input className="input mono" value={d.observed} onChange={(e) => setD({ ...d, observed: e.target.value })} />
            </Field>
          )}
          <Field label={MC.note} error={d.note && !noteOk ? MC.noteShort : null}>
            <textarea className="input" rows={3} value={d.note} onChange={(e) => setD({ ...d, note: e.target.value })} />
          </Field>
          {spec.evidence?.command ? (
            <div className="stack-8">
              <b className="small">{MC.evidenceOptional}</b>
              {lab ? (
                <ManualCommand node={{ type: 'code', lang: 'bash', attributes: { runsOn: spec.evidence.command.runsOn }, value: spec.evidence.command.run }} env={{ lab, step: null, vars: ws.data.vars.data, blockIndex: new WeakMap() }} />
              ) : null}
              <Field label={MC.evidenceLabel} error={evidenceErr}>
                <textarea className="input mono" rows={4} value={d.evidence} onChange={(e) => setD({ ...d, evidence: e.target.value })} />
              </Field>
            </div>
          ) : null}
          {error ? (
            <p className="small st fail" role="alert">
              {error}
            </p>
          ) : null}
        </div>
      )}
    </Dialog>
  );
}
