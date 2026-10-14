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

import { t } from '../../i18n';
import { W } from '../strings';
export function CostDrawer({ onClose }: { onClose: () => void }) {
  const ws = useWorkspace();
  const c = ws.data.cost.data;
  const cur = c?.currency ?? 'USD';
  const hourly = hourlyRangeOf(ws.view.env?.hourlyEstimate, cur) ?? hourlyRangeOf(c?.hourly ?? null, cur);
  const accrued = accruedOf(c);
  return (
    <Drawer open onClose={onClose} title={W.cost.title}>
      {!c && ws.data.cost.loading ? (
        <Skeleton lines={3} />
      ) : (
        <div className="stack" data-cost-drawer="">
          <dl className="kv">
            <dt>{W.cost.hourly}</dt>
            <dd>{t(W.cost.perHour, { range: formatRange(hourly, cur) })}</dd>
            <dt>{W.cost.accrued}</dt>
            <dd>{accrued ? formatRange(accrued, cur) : W.cost.notProvided}</dd>
            <dt>{W.cost.priceAsOf}</dt>
            <dd>{c?.priceAsOf ? formatDate(c.priceAsOf, ws.now()) : W.cost.notProvided}</dd>
          </dl>
          {c?.incomplete?.length ? <p className="small muted">{t(W.cost.incomplete, { n: c.incomplete.length })}</p> : null}
          <section className="stack-4">
            <b className="small">{W.cost.billable}</b>
            {c?.billable?.length ? (
              <ul className="small mlist">
                {c.billable.map((b, i) => (
                  <li key={b.resourceKey ?? i}>
                    {b.type ?? W.cost.resource} · <span className="mono">{redact(b.name ?? '')}</span> · {BILLING_TEXT[b.billing as keyof typeof BILLING_TEXT] ?? b.billing}
                    {b.createdBy === 'learner' ? W.cost.learnerCreated : ''}
                  </li>
                ))}
              </ul>
            ) : (
              <p className="small muted">{W.cost.noBillable}</p>
            )}
            {c?.unestimatedManualResources ? <p className="small">{t(W.cost.unestimated, { n: c.unestimatedManualResources })}</p> : null}
            <p className="small muted">{W.cost.consoleNote}</p>
          </section>
          <p className="small muted">
            {c?.disclaimer ?? W.cost.disclaimer}
            {W.cost.billNote}
          </p>
        </div>
      )}
    </Drawer>
  );
}

type ShortcutKey = keyof typeof W.shortcuts;
/** [按键, 说明的键, 是否只在手册聚焦时] */
const SHORTCUTS: readonly [string, ShortcutKey, boolean?][] = [
  ['⌃. 1 / 2 / 3 / 4', 'switchPane'],
  ['⌃. M', 'manual'],
  ['⌃. T', 'terminal'],
  ['⌃. R', 'check'],
  ['⌃. N / ⌃. P', 'nextPrev'],
  ['⌃. ← / ⌃. →', 'splitter'],
  ['⌃. 0', 'splitterReset'],
  ['⌃. [ / ⌃. ]', 'collapse'],
  ['⌃. S', 'screenReader'],
  ['⌃. ?', 'help'],
  ['⌃. ⌃.', 'passThrough'],
  ['J / K', 'nextPrev', true],
  ['R', 'check', true],
  ['Ctrl+Shift+C / V', 'copyPaste'],
];

export function ShortcutsDialog({ onClose, leader }: { onClose: () => void; leader: string }) {
  return (
    <Dialog
      open
      onClose={onClose}
      title={W.shortcuts.title}
      footer={
        <button type="button" className="btn" onClick={onClose}>
          {W.shortcuts.close}
        </button>
      }
    >
      <p className="small">{t(W.shortcuts.intro, { leader })}</p>
      <div className="tbl-wrap">
        <table className="tbl">
          <tbody>
            {SHORTCUTS.map(([k, d, focused]) => (
              <tr key={`${k}-${d}`}>
                <th scope="row" className="mono small">
                  {focused ? t(W.shortcuts.whenManualFocused, { key: k }) : k.replace(/⌃\./g, leader)}
                </th>
                <td className="small">{W.shortcuts[d]}</td>
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
      title={W.termSettings.title}
      size="narrow"
      footer={
        <>
          <button type="button" className="btn" onClick={onClose}>
            {W.termSettings.cancel}
          </button>
          <button type="button" className="btn primary" onClick={save}>
            {W.termSettings.save}
          </button>
        </>
      }
    >
      <div className="stack">
        <label className="row">
          {W.termSettings.fontSize}
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
          {W.termSettings.screenReader}
        </label>
        <label className="row">
          {W.termSettings.leader}
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
          {W.termSettings.execute}
        </label>
      </div>
    </Dialog>
  );
}
