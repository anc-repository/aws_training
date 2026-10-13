/**
 * 导出回收报告 / 待人工处理清单（08 P07“导出回收报告 ▾”、P07-M“导出”）：Markdown（`?format=md`，带令牌取回后保存）与 JSON。
 * 只对学员与助教（01 §8.2 getCleanup 为 L A）。
 */
import { useState } from 'react';
import { isApiError, type ApiError } from '../../api/errors';
import { useServices } from '../../app/context';
import { announce } from '../../lib/announce';
import { Disclosure, Icon } from '../../ui';
import { InlineProblem } from '../errors/InlineProblem';
import { downloadFromApi, saveText } from '../sessions/download';

export function CleanupExport({ sid, label = '导出回收报告', compact }: { sid: string; label?: string; compact?: boolean }) {
  const services = useServices();
  const [error, setError] = useState<ApiError | null>(null);
  const [busy, setBusy] = useState(false);
  const run = async (format: 'md' | 'json') => {
    setBusy(true);
    setError(null);
    try {
      if (format === 'md') await downloadFromApi(services, 'getCleanup', { sid }, { format: 'md' }, `cleanup-${sid}.md`);
      else {
        const r = await services.api.call<unknown>('getCleanup', { params: { sid }, query: { format: 'json' }, conditional: false });
        saveText(`${JSON.stringify(r.data, null, 2)}\n`, `cleanup-${sid}.json`, 'application/json');
      }
      announce('已开始下载');
    } catch (e) {
      if (isApiError(e)) setError(e);
      else throw e;
    } finally {
      setBusy(false);
    }
  };
  return (
    <span className="stack-4">
      <Disclosure
        label={
          <>
            {busy ? '正在导出…' : label} <Icon name="chev" />
          </>
        }
        buttonClassName={compact ? 'linkbtn' : 'btn ghost'}
        ariaLabel={`${label}（Markdown 或 JSON）`}
      >
        {(close) => (
          <>
            <button
              type="button"
              className="mi"
              onClick={() => {
                close();
                void run('md');
              }}
            >
              Markdown（含 CLI 删除命令）
            </button>
            <button
              type="button"
              className="mi"
              onClick={() => {
                close();
                void run('json');
              }}
            >
              JSON
            </button>
          </>
        )}
      </Disclosure>
      {error ? <InlineProblem error={error} onRetry={() => setError(null)} /> : null}
    </span>
  );
}
