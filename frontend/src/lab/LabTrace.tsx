// /lab/trace：路径追踪的全屏版（总纲 8.1、7.4）。
import { TracePanel } from '../trace/TraceDrawer';
import { LabTabs } from './LabHome';

export function LabTrace() {
  return (
    <>
      <div className="page-head"><h1>路径追踪</h1></div>
      <LabTabs />
      <p className="subtle">本页列出这个浏览器标签页里发出的最近 100 个 API 请求。打开其他页面后回来，可以看到它们各自经过的路径与各段耗时。</p>
      <section className="card" style={{ padding: 0, overflow: 'hidden' }} aria-label="路径追踪">
        <TracePanel full />
      </section>
    </>
  );
}
