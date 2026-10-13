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
      (e) => alive && setPreviewErr(isApiError(e) ? (e.detail ?? e.title) : '预检查没有完成'),
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
    return i >= 0 ? `步骤 ${i + 1}“${steps[i]!.title}”` : id;
  };
  const submit = async () => {
    setBusy(true);
    setError(null);
    try {
      await api.call('submitSession', { params: { sid: ws.sid }, body: {} });
      announce('已提交，平台正在做最终复核');
      onClose();
    } catch (e) {
      setError(isApiError(e) ? (e.detail ?? e.title) : '提交失败，请稍后重试');
    } finally {
      setBusy(false);
    }
  };
  return (
    <Dialog
      open
      onClose={onClose}
      title="提交实验"
      footer={
        <>
          <button type="button" className="btn" onClick={onClose}>
            取消
          </button>
          <Button variant="primary" onClick={() => void submit()} busy={busy} busyText="正在提交…">
            {p && p.missing.length ? '仍然提交（可能不通过）' : '提交'}
          </Button>
        </>
      }
    >
      <div className="stack">
        <p>平台会对全部必需检查强制重测一次（最终复核），通过即完成并获得徽章。</p>
        {previewing || (!previewId && !previewErr) ? (
          <p className="small muted" role="status">
            <Shape name="spin" spin /> 正在生成预检查…
          </p>
        ) : null}
        {previewErr ? <p className="small muted">预检查没有完成（{previewErr}），可以直接提交。</p> : null}
        {p ? (
          <div className="stack-4" data-precheck="">
            <span className="small">
              当前预检查：必需步骤 {p.stepsDone}/{p.stepsTotal} 已达成{p.drifted.length ? ` · ${p.drifted.length} 项漂移` : ''}
            </span>
            {p.missing.length ? (
              <ul className="small mlist">
                {p.missing.map((m) => (
                  <li key={m}>还差：{titleOf(m)}</li>
                ))}
              </ul>
            ) : (
              <span className="small st pass">
                <Shape name="check" /> 必需步骤都已达成
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
