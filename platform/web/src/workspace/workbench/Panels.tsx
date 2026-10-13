/**
 * 顶栏打开的小面板：费用计明细 CostDrawer（08 P05.2、§5.2；02 §10.2）、快捷键帮助、终端设置（字号、读屏模式、粘贴并执行、前导键）。
 */
import { useState } from 'react';
import { formatDate } from '../../lib/format';
import { redact } from '../../lib/redact';
import { lsGet, lsSet } from '../../lib/storage';
import { BILLING_TEXT, Dialog, Drawer, Skeleton } from '../../ui';
import { useWorkspace } from '../context';
import { EXECUTE_PREF_KEY, executeEnabled } from '../manual/ManualCommand';
import { accruedOf, formatRange, hourlyRangeOf } from '../model/cost';

export function CostDrawer({ onClose }: { onClose: () => void }) {
  const ws = useWorkspace();
  const c = ws.data.cost.data;
  const cur = c?.currency ?? 'USD';
  const hourly = hourlyRangeOf(ws.view.env?.hourlyEstimate, cur) ?? hourlyRangeOf(c?.hourly ?? null, cur);
  const accrued = accruedOf(c);
  return (
    <Drawer open onClose={onClose} title="费用计（估算）">
      {!c && ws.data.cost.loading ? (
        <Skeleton lines={3} />
      ) : (
        <div className="stack" data-cost-drawer="">
          <dl className="kv">
            <dt>每小时</dt>
            <dd>{formatRange(hourly, cur)}/小时</dd>
            <dt>已产生</dt>
            <dd>{accrued ? formatRange(accrued, cur) : '未提供'}</dd>
            <dt>取价时间</dt>
            <dd>{c?.priceAsOf ? formatDate(c.priceAsOf, ws.now()) : '未提供'}</dd>
          </dl>
          {c?.incomplete?.length ? <p className="small muted">估算不完整：{c.incomplete.length} 项单价不可得。</p> : null}
          <section className="stack-4">
            <b className="small">当前计费的资源</b>
            {c?.billable?.length ? (
              <ul className="small mlist">
                {c.billable.map((b, i) => (
                  <li key={b.resourceKey ?? i}>
                    {b.type ?? '资源'} · <span className="mono">{redact(b.name ?? '')}</span> · {BILLING_TEXT[b.billing as keyof typeof BILLING_TEXT] ?? b.billing}
                    {b.createdBy === 'learner' ? ' · 你手动创建' : ''}
                  </li>
                ))}
              </ul>
            ) : (
              <p className="small muted">没有记录到按小时或按量计费的资源。</p>
            )}
            {c?.unestimatedManualResources ? <p className="small">+ 未估算的手工资源 {c.unestimatedManualResources} 项</p> : null}
            <p className="small muted">控制台中新建、尚未经检测确认的资源可能不在此列。</p>
          </section>
          <p className="small muted">{c?.disclaimer ?? '估算值，以 AWS 账单为准。'}以 AWS 账单为准。</p>
        </div>
      )}
    </Drawer>
  );
}

const SHORTCUTS: readonly [string, string][] = [
  ['⌃. 1 / 2 / 3 / 4', '切换到 实验机终端 / 工作台终端 / AWS 控制台 / 应用预览'],
  ['⌃. M', '回到手册当前步骤（离开终端）'],
  ['⌃. T', '焦点到当前终端'],
  ['⌃. R', '检测当前步骤'],
  ['⌃. N / ⌃. P', '下一步 / 上一步'],
  ['⌃. ← / ⌃. →', '分隔条左移 / 右移 64px'],
  ['⌃. 0', '分隔条复位'],
  ['⌃. [ / ⌃. ]', '折叠 / 展开手册'],
  ['⌃. S', '切换终端读屏模式'],
  ['⌃. ?', '快捷键帮助'],
  ['⌃. ⌃.', '把 Ctrl+. 原样交给终端'],
  ['J / K（手册聚焦时）', '下一步 / 上一步'],
  ['R（手册聚焦时）', '检测当前步骤'],
  ['Ctrl+Shift+C / V', '终端中复制 / 粘贴'],
];

export function ShortcutsDialog({ onClose, leader }: { onClose: () => void; leader: string }) {
  return (
    <Dialog open onClose={onClose} title="工作台快捷键" footer={<button type="button" className="btn" onClick={onClose}>关闭</button>}>
      <p className="small">先按前导键 {leader}，1.5 秒内再按第二个键。前导键在终端中同样生效；可以在“终端设置”中更换。</p>
      <div className="tbl-wrap">
        <table className="tbl">
          <tbody>
            {SHORTCUTS.map(([k, d]) => (
              <tr key={k}>
                <th scope="row" className="mono small">
                  {k.replace(/⌃\./g, leader)}
                </th>
                <td className="small">{d}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </Dialog>
  );
}

export interface TermPrefs {
  fontSize: number;
  screenReader: boolean;
  leader: 'ctrl-period' | 'ctrl-backquote' | 'ctrl-shift-period';
}

export const TERM_PREFS_KEY = 'atl.ws.terminal.v1';

export function loadTermPrefs(): TermPrefs {
  const p = lsGet<Partial<TermPrefs>>(TERM_PREFS_KEY, {});
  return {
    fontSize: typeof p.fontSize === 'number' && p.fontSize >= 12 && p.fontSize <= 18 ? p.fontSize : 13,
    screenReader: p.screenReader === true,
    leader: p.leader === 'ctrl-backquote' || p.leader === 'ctrl-shift-period' ? p.leader : 'ctrl-period',
  };
}

export const LEADER_TEXT: Record<TermPrefs['leader'], string> = { 'ctrl-period': 'Ctrl+.', 'ctrl-backquote': 'Ctrl+`', 'ctrl-shift-period': 'Ctrl+Shift+.' };

export function TermSettingsDialog({ prefs, onChange, onClose }: { prefs: TermPrefs; onChange: (p: TermPrefs) => void; onClose: () => void }) {
  const [p, setP] = useState(prefs);
  const [exec, setExec] = useState(executeEnabled);
  const save = () => {
    lsSet(TERM_PREFS_KEY, p);
    try {
      globalThis.localStorage?.setItem(EXECUTE_PREF_KEY, exec ? 'true' : 'false');
    } catch {
      /* 忽略 */
    }
    onChange(p);
    onClose();
  };
  return (
    <Dialog
      open
      onClose={onClose}
      title="终端设置"
      size="narrow"
      footer={
        <>
          <button type="button" className="btn" onClick={onClose}>
            取消
          </button>
          <button type="button" className="btn primary" onClick={save}>
            保存
          </button>
        </>
      }
    >
      <div className="stack">
        <label className="row">
          字号
          <select className="input" value={p.fontSize} onChange={(e) => setP({ ...p, fontSize: Number(e.target.value) })}>
            {[12, 13, 14, 15, 16, 17, 18].map((n) => (
              <option key={n} value={n}>
                {n}px
              </option>
            ))}
          </select>
        </label>
        <label className="row">
          <input type="checkbox" checked={p.screenReader} onChange={(e) => setP({ ...p, screenReader: e.target.checked })} />
          读屏模式（为终端输出维护可访问的行缓冲，有渲染开销）
        </label>
        <label className="row">
          前导键
          <select className="input" value={p.leader} onChange={(e) => setP({ ...p, leader: e.target.value as TermPrefs['leader'] })}>
            {(Object.keys(LEADER_TEXT) as TermPrefs['leader'][]).map((k) => (
              <option key={k} value={k}>
                {LEADER_TEXT[k]}
              </option>
            ))}
          </select>
        </label>
        <label className="row">
          <input type="checkbox" checked={exec} onChange={(e) => setExec(e.target.checked)} />
          在“粘贴到终端”的菜单中提供“粘贴并执行”（每次都会确认；危险命令不允许）
        </label>
      </div>
    </Dialog>
  );
}
