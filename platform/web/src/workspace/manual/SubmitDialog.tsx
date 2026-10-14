/**
 * 提交实验 SubmitDialog（08 P05.5“提交实验”；04 §8.5）：打开时先 `POST /sessions/{sid}/check-runs {scope: final-preview}` 生成“还差什么”，
 * 提交 `POST /sessions/{sid}/submit`。结果经 `attempt.state_changed` 到达（页内结果条，见 WorkspaceBanners）。
 */
import { useEffect, useState, useSyncExternalStore } from 'react';
import { useServices } from '../../app/context';
import { isApiError } from '../../api/errors';
import { announce } from '../../lib/announce';
import { Button, Dialog, Shape } from '../../ui';
import { useWorkbench, useWorkspace } from '../context';

import { t } from '../../i18n';
import { W } from '../strings';

const WSB = W.submit;
export function SubmitDialog({ onClose }: { onClose: () => void }) {
  const ws = useWorkspace();
  const wb = useWorkbench();
  const { api } = useServices();
  const [previewId, setPreviewId] = useState<string | null>(null);
  const [previewErr, setPreviewErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const rs = useSyncExternalStore(wb.checks.subscribe, wb.checks.getSnapshot);
  const previewing = !!previewId && rs.inflight.some((r) => r.runId === previewId);
  useEffect(() => {
    let alive = true;
    wb.checks.runScope('final-preview').then(
      (id) => alive && setPreviewId(id),
      (e) => alive && setPreviewErr(isApiError(e) ? (e.detail ?? e.title) : WSB.previewFailed),
    );
    return () => {
      alive = false;
    };
  }, [wb.checks]);
  useEffect(() => {
    if (previewId && !previewing) void ws.data.progress.refresh();
  }, [previewId, previewing, ws.data.progress]);
  const p = ws.data.progress.data;
  const steps = ws.data.lab.data?.steps ?? [];
  const titleOf = (id: string) => {
    const i = steps.findIndex((s) => s.id === id);
    return i >= 0 ? t(WSB.stepTitle, { n: i + 1, title: steps[i]!.title }) : id;
  };
  const submit = async () => {
    setBusy(true);
    setError(null);
    try {
      await api.call('submitSession', { params: { sid: ws.sid }, body: {} });
      announce(WSB.submitted);
      onClose();
    } catch (e) {
      setError(isApiError(e) ? (e.detail ?? e.title) : WSB.failed);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Dialog
      open
      onClose={onClose}
      title={WSB.title}
      footer={
        <>
          <button type="button" className="btn" onClick={onClose}>
            {WSB.cancel}
          </button>
          <Button variant="primary" onClick={() => void submit()} busy={busy} busyText={WSB.submitting}>
            {p && p.missing.length ? WSB.submitAnyway : WSB.submit}
          </Button>
        </>
      }
    >
      <div className="stack">
        <p>{WSB.intro}</p>
        {previewing || (!previewId && !previewErr) ? (
          <p className="small muted" role="status">
            <Shape name="spin" spin /> {WSB.generating}
          </p>
        ) : null}
        {previewErr ? <p className="small muted">{t(WSB.previewError, { error: previewErr })}</p> : null}
        {p ? (
          <div className="stack-4" data-precheck="">
            <span className="small">
              {t(WSB.precheck, { done: p.stepsDone, total: p.stepsTotal })}
              {p.drifted.length ? t(WSB.drifted, { n: p.drifted.length }) : ''}
            </span>
            {p.missing.length ? (
              <ul className="small mlist">
                {p.missing.map((m) => (
                  <li key={m}>{t(WSB.missing, { step: titleOf(m) })}</li>
                ))}
              </ul>
            ) : (
              <span className="small st pass">
                <Shape name="check" /> {WSB.allDone}
              </span>
            )}
          </div>
        ) : null}
        {error ? (
          <p className="small st fail" role="alert">
            {error}
          </p>
        ) : null}
      </div>
    </Dialog>
  );
}
