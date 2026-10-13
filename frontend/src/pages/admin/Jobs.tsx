// 管理后台 · 任务（/admin/jobs）：顶部是 queue 徽章（任务在请求内执行 / 内存中排队 / 经 SQS 排队 · DLQ n）；
// 定时任务显示触发来源（cron / eventbridge）与最近一次 job_runs；本地死信 failed_jobs 可重放。
import { useCallback, useState } from 'react';
import { describeError } from '../../api/client';
import { adminApi } from '../../api/endpoints';
import { ModuleBadge } from '../../capabilities/ModuleBadge';
import { useCaps } from '../../capabilities/useCapability';
import { useAsync } from '../../hooks/useAsync';
import { fmtTime, timeAgo } from '../../util/format';

const QUEUE_TEXT: Record<string, string> = {
  sync: '任务在请求内执行',
  memory: '任务在 api 进程内存中排队（重启即丢）',
  sqs: '任务经 Amazon SQS 排队',
};

export function AdminJobs() {
  const caps = useCaps();
  const loadOverview = useCallback(() => adminApi.jobs(), []);
  const overview = useAsync(loadOverview);
  const [name, setName] = useState('');
  const loadRuns = useCallback(() => adminApi.jobRuns(name ? { name } : {}), [name]);
  const runs = useAsync(loadRuns);
  const [msg, setMsg] = useState<string | null>(null);
  const queueDriver = caps.modules.queue?.driver ?? 'sync';

  const runNow = async (job: string) => {
    setMsg(null);
    try {
      const r = await adminApi.runJob(job);
      setMsg(`已手动触发 ${job}：${r.status}`);
      void runs.reload();
      void overview.reload();
    } catch (e) {
      setMsg(describeError(e));
    }
  };
  const replay = async (id: string) => {
    setMsg(null);
    try {
      await adminApi.replayFailed(id);
      setMsg('已重新入队');
      void overview.reload();
    } catch (e) {
      setMsg(describeError(e));
    }
  };

  const ov = overview.data;
  return (
    <section aria-label="任务" className="stack">
      <div className="row">
        <ModuleBadge module="queue" />
        <ModuleBadge module="scheduler" />
        <span className="subtle">
          {QUEUE_TEXT[queueDriver] ?? queueDriver}
          {ov?.queue.dlqDepth !== undefined ? ` · DLQ ${ov.queue.dlqDepth}` : ''}
          {ov?.queue.depth !== undefined ? ` · 积压 ${ov.queue.depth}` : ''}
          {ov?.queue.inFlight !== undefined ? ` · 处理中 ${ov.queue.inFlight}` : ''}
        </span>
      </div>
      {msg && <p className="notice">{msg}</p>}
      {overview.error && <p className="notice notice-error" role="alert">{overview.error}</p>}

      <h2>定时任务</h2>
      <div className="table-scroll">
        <table className="table">
          <thead><tr><th>任务</th><th>计划</th><th>触发来源</th><th>最近一次</th><th>结果</th><th>下次</th><th /></tr></thead>
          <tbody>
            {ov?.scheduler.jobs.map((j) => (
              <tr key={j.name}>
                <td className="mono">{j.name}{j.description ? <div className="subtle">{j.description}</div> : null}</td>
                <td className="mono">{j.schedule}</td>
                <td>{j.lastRun?.trigger ?? ov.scheduler.driver}</td>
                <td className="num">{j.lastRun ? timeAgo(j.lastRun.startedAt) : '—'}</td>
                <td className={j.lastRun?.status === 'failed' ? 'status-err' : ''}>{j.lastRun?.status ?? '—'}</td>
                <td className="num">{j.nextRunAt ? fmtTime(j.nextRunAt) : '—'}</td>
                <td><button type="button" className="btn btn-sm" onClick={() => void runNow(j.name)}>立即执行</button></td>
              </tr>
            ))}
            {ov && ov.scheduler.jobs.length === 0 && <tr><td colSpan={7} className="muted">没有定时任务。</td></tr>}
          </tbody>
        </table>
      </div>

      <h2>失败的任务（本地死信 failed_jobs）</h2>
      {ov && ov.failed.length === 0 && <p className="muted">没有失败的任务。</p>}
      {ov && ov.failed.length > 0 && (
        <div className="table-scroll">
          <table className="table">
            <thead><tr><th>任务</th><th>尝试次数</th><th>首次入队</th><th>失败时间</th><th>最后一次错误</th><th /></tr></thead>
            <tbody>
              {ov.failed.map((f) => (
                <tr key={f.id}>
                  <td className="mono">{f.name}</td>
                  <td className="num">{f.attempts}</td>
                  <td className="num">{fmtTime(f.firstEnqueuedAt)}</td>
                  <td className="num">{fmtTime(f.failedAt)}</td>
                  <td className="wrap-any">{f.lastError ?? '—'}</td>
                  <td><button type="button" className="btn btn-sm" onClick={() => void replay(f.id)}>重放</button></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <div className="row spread">
        <h2>执行记录（job_runs）</h2>
        <form className="row" onSubmit={(e) => { e.preventDefault(); const fd = new FormData(e.currentTarget); setName(String(fd.get('name') ?? '').trim()); }}>
          <label className="visually-hidden" htmlFor="jr-name">任务名</label>
          <input id="jr-name" name="name" className="input" style={{ width: 200 }} placeholder="任务名，例如 report.daily" defaultValue={name} />
          <button type="submit" className="btn btn-sm">筛选</button>
        </form>
      </div>
      {runs.error && <p className="notice notice-error" role="alert">{runs.error}</p>}
      <div className="table-scroll">
        <table className="table">
          <thead><tr><th>开始</th><th>任务</th><th>触发</th><th>执行者</th><th>主机</th><th>尝试</th><th>状态</th><th>耗时</th><th>错误</th></tr></thead>
          <tbody>
            {runs.data?.items.map((r) => (
              <tr key={r.runId}>
                <td className="num">{fmtTime(r.startedAt)}</td>
                <td className="mono">{r.name}{r.subjectId ? <div className="subtle">{r.subjectId}</div> : null}</td>
                <td>{r.trigger}</td>
                <td>{r.executor ?? '—'}</td>
                <td className="mono">{r.host}</td>
                <td className="num">{r.attempt ?? 1}</td>
                <td className={r.status === 'failed' ? 'status-err' : ''}>{r.status}</td>
                <td className="num">{r.finishedAt ? `${Math.max(0, Date.parse(r.finishedAt) - Date.parse(r.startedAt))} ms` : '—'}</td>
                <td className="wrap-any">{r.error ?? ''}</td>
              </tr>
            ))}
            {runs.data && runs.data.items.length === 0 && <tr><td colSpan={9} className="muted">没有记录。</td></tr>}
          </tbody>
        </table>
      </div>
    </section>
  );
}
