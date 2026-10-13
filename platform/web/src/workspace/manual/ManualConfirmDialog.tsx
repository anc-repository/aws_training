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
  const evidenceErr = useMemo(() => {
    if (!d.evidence.trim()) return null;
    if (d.evidence.length > EVIDENCE_MAX_CHARS) return `证据超过 ${EVIDENCE_MAX_CHARS} 个字符，请只粘贴命令输出中的相关部分`;
    try {
      JSON.parse(d.evidence);
      return null;
    } catch {
      return '只能粘贴 JSON 格式的命令输出';
    }
  }, [d.evidence]);
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
      announce(r.data?.reviewPending ? '已提交手动确认，等待助教复核' : '已提交手动确认');
      void ws.data.steps.refresh();
      void ws.data.progress.refresh();
    } catch (e) {
      setError(isApiError(e) ? (e.code === 'VALIDATION_FAILED' ? `输入不符合要求：${e.detail ?? ''}` : (e.detail ?? e.title)) : '提交失败，可以重试');
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog
      open
      onClose={onClose}
      title={`手动确认：${decl?.title ?? checkId}`}
      footer={
        done ? (
          <button type="button" className="btn primary" onClick={onClose}>
            完成
          </button>
        ) : (
          <>
            <button type="button" className="btn" onClick={onClose}>
              取消
            </button>
            <Button variant="primary" onClick={() => void submit()} busy={busy} busyText="正在提交…" disabled={!canSubmit} data-mc-submit="">
              提交确认
            </Button>
          </>
        )
      }
    >
      {done ? (
        <div className="note green" role="status">
          <Shape name={done.result === 'manual_evidence' ? 'manp' : 'man'} />
          <span>{done.reviewPending ? '已提交。安装中有助教时，复核前会显示“等待助教复核”。' : done.result === 'manual_evidence' ? '已手动确认（带证据）。' : '已手动确认。'}</span>
        </div>
      ) : (
        <div className="stack">
          <p className="small muted">
            {native ? '这项检查需要你确认看到的结果（手动·原生）。' : '自动检测暂时无法判定，你可以按下面的位置查看后手动确认（手动·降级）。手动确认不能覆盖自动检测的“未通过”。'}
          </p>
          {where?.breadcrumb?.length ? (
            <p className="small">
              位置：{where.breadcrumb.map((b) => resolveTemplate(b, ws.data.vars.data).text).join(' › ')}
              {where.region ? `（区域：${where.region === 'app' ? (ws.data.vars.data?.session?.region as string | undefined) ?? '实验区域' : where.region}）` : ''}
            </p>
          ) : null}
          {spec.confirm ? <p className="small">{resolveTemplate(spec.confirm, ws.data.vars.data).text}</p> : null}
          {options.length ? (
            <fieldset className="stack-4">
              <legend id={qid}>{spec.observed?.question ?? '你看到的是什么？'}</legend>
              {options.map((o) => (
                <label key={o.value} className="row">
                  <input type="radio" name={qid} value={o.value} checked={d.observed === o.value} onChange={() => setD({ ...d, observed: o.value })} />
                  {o.label}
                </label>
              ))}
              {chosen && !chosen.expected ? (
                <div className="note amber" role="alert">
                  <Shape name="tri" />
                  <span>这不是期望的结果，不能提交。{chosen.fixHint ?? '先修正配置，再重新检测。'}</span>
                </div>
              ) : null}
            </fieldset>
          ) : (
            <Field label={spec.observed?.question ?? spec.input?.label ?? '你看到的值'} hint={spec.input?.example ? `例如 ${spec.input.example}` : undefined} error={d.observed && !observedOk ? '格式不符合要求' : null}>
              <input className="input mono" value={d.observed} onChange={(e) => setD({ ...d, observed: e.target.value })} />
            </Field>
          )}
          <Field label="备注（至少 6 个字）" error={d.note && !noteOk ? '备注至少 6 个字' : null}>
            <textarea className="input" rows={3} value={d.note} onChange={(e) => setD({ ...d, note: e.target.value })} />
          </Field>
          {spec.evidence?.command ? (
            <div className="stack-8">
              <b className="small">可选：粘贴命令输出作为证据（平台会用同一套断言校验，通过记为“带证据的手动”）</b>
              {lab ? (
                <ManualCommand node={{ type: 'code', lang: 'bash', attributes: { runsOn: spec.evidence.command.runsOn }, value: spec.evidence.command.run }} env={{ lab, step: null, vars: ws.data.vars.data, blockIndex: new WeakMap() }} />
              ) : null}
              <Field label="命令输出（JSON）" error={evidenceErr}>
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
