/**
 * 变量条 VariableStrip / VariableChip（08 P05.3；04 §4.4；03 §7.3）：
 * - 来源标签按命名空间（session、target、workstation、stack、cap、envfile、var）；
 * - 值变化时高亮 2 秒并显示“已更新”；未解析变量红色虚线框；
 * - 账号 ID 默认打码；服务端已打码时不提供“显示”（§9.2 #34 的降级）；
 * - `input` 变量可编辑（与 `::var-input` 同一组件），保存 `PUT /sessions/{sid}/vars/{name}`，不匹配 `pattern` 时不保存并显示示例。
 */
import { useEffect, useId, useMemo, useRef, useState } from 'react';
import { useServices } from '../../app/context';
import { isApiError } from '../../api/errors';
import { announce } from '../../lib/announce';
import { isMaskedAccountId, maskAccountId, redact } from '../../lib/redact';
import { Button, Icon } from '../../ui';
import { useWorkspace } from '../context';
import { changedKeys, variableChips, type VarChipModel } from '../model/vars';

import { t } from '../../i18n';
import { W } from '../strings';

const WV = W.vars;
export interface VariableStripHandle {
  reveal(names: readonly string[]): void;
}

export function VariableStrip({ used, revealRef }: { used: ReadonlySet<string>; revealRef?: { current: VariableStripHandle | null } }) {
  const ws = useWorkspace();
  const chips = useMemo(() => variableChips(ws.data.vars.data, used), [ws.data.vars.data, used]);
  const [all, setAll] = useState(false);
  const [updated, setUpdated] = useState<Record<string, number>>({});
  const [flash, setFlash] = useState<readonly string[]>([]);
  const prev = useRef<VarChipModel[]>([]);
  const rootRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const ch = changedKeys(prev.current, chips);
    prev.current = chips;
    if (!ch.length) return undefined;
    const at = Date.now();
    setUpdated((u) => ({ ...u, ...Object.fromEntries(ch.map((k) => [k, at])) }));
    const t = setTimeout(() => setUpdated((u) => Object.fromEntries(Object.entries(u).filter(([, v]) => Date.now() - v < 2000))), 2100);
    return () => clearTimeout(t);
  }, [chips]);
  useEffect(() => {
    if (!revealRef) return undefined;
    revealRef.current = {
      reveal(names) {
        setAll(true);
        setFlash(names);
        setTimeout(() => {
          const el = rootRef.current?.querySelector<HTMLElement>('.vchip.unset button, .vchip.unset');
          rootRef.current?.scrollIntoView({ block: 'nearest' });
          el?.focus?.();
        }, 0);
        setTimeout(() => setFlash([]), 2000);
      },
    };
    return () => {
      revealRef.current = null;
    };
  }, [revealRef]);
  if (!chips.length) return null;
  const important = chips.filter((c) => c.ns === 'var' || used.has(c.key) || c.value === null);
  const shown = all ? chips : important.length ? important.slice(0, 8) : chips.slice(0, 4);
  return (
    <div className="varstrip" aria-label={WV.label} ref={rootRef} data-varstrip="">
      {shown.map((c) => (
        <VariableChip key={c.key} chip={c} updated={!!updated[c.key]} flash={flash.includes(c.key)} />
      ))}
      {chips.length > shown.length || all ? (
        <button type="button" className="linkbtn vmore" aria-expanded={all} onClick={() => setAll((x) => !x)}>
          {all ? WV.collapse : t(WV.all, { n: chips.length })}
        </button>
      ) : null}
    </div>
  );
}

function VariableChip({ chip: c, updated, flash }: { chip: VarChipModel; updated: boolean; flash: boolean }) {
  const ws = useWorkspace();
  const [editing, setEditing] = useState(false);
  const shownValue = c.value === null ? WV.unresolved : c.account ? (isMaskedAccountId(c.value) || /\*/.test(c.value) ? maskAccountId(c.value) : maskAccountId(c.value)) : redact(c.value);
  const cls = ['vchip', updated ? 'upd' : '', c.value === null ? 'unset' : '', flash ? 'flash' : ''].filter(Boolean).join(' ');
  return (
    <span className={cls} data-var={c.key} tabIndex={c.value === null ? -1 : undefined}>
      <span className="ns">{c.ns}</span>
      <span>{c.name}=</span>
      <span className="v" title={c.value === null ? WV.unresolved : `${c.label}${c.value !== shownValue ? WV.masked : ''}`}>
        {shownValue}
      </span>
      {updated ? <span className="small faint">{WV.updated}</span> : null}
      {c.input && ws.learner && ws.live ? (
        <button type="button" className="linkbtn small" onClick={() => setEditing(true)} aria-label={t(WV.editLabel, { label: c.label })}>
          {WV.edit}
        </button>
      ) : null}
      {editing && c.input ? <VarEditor name={c.name} label={c.label} value={c.value} pattern={c.input.pattern} example={c.input.example} onClose={() => setEditing(false)} /> : null}
    </span>
  );
}

/** 变量输入（`::var-input` 与变量条的“编辑”共用）。 */
export function VarEditor({
  name,
  label,
  value,
  pattern,
  example,
  onClose,
  inline,
}: {
  name: string;
  label: string;
  value: string | null;
  pattern: string | null;
  example: string | null;
  onClose?: () => void;
  inline?: boolean;
}) {
  const ws = useWorkspace();
  const { api } = useServices();
  const id = useId();
  const [v, setV] = useState(value ?? '');
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const re = useMemo(() => {
    try {
      return pattern ? new RegExp(pattern) : null;
    } catch {
      return null;
    }
  }, [pattern]);
  const badFormat = example ? t(WV.badFormatExample, { example }) : WV.badFormat;
  const validate = (x: string) => (re && !re.test(x) ? badFormat : !x ? WV.required : null);
  const save = async () => {
    const e = validate(v);
    setErr(e);
    if (e) return;
    setBusy(true);
    try {
      await api.call('putVar', { params: { sid: ws.sid, name }, body: { value: v } });
      announce(t(WV.saved, { label }));
      await ws.data.vars.refresh();
      onClose?.();
    } catch (x) {
      setErr(isApiError(x) && x.code === 'VALIDATION_FAILED' ? badFormat : WV.saveFailed);
    } finally {
      setBusy(false);
    }
  };
  return (
    <span className={inline ? 'varin inline' : 'varin'} role="group" aria-label={t(WV.fill, { label })}>
      <label className="sr" htmlFor={id}>
        {label}
      </label>
      <input
        id={id}
        className="input mono"
        value={v}
        onChange={(e) => setV(e.target.value)}
        onBlur={() => setErr(validate(v))}
        onKeyDown={(e) => {
          if (e.key === 'Enter') void save();
          if (e.key === 'Escape') onClose?.();
        }}
        aria-invalid={err ? true : undefined}
        aria-describedby={err ? `${id}-err` : undefined}
        placeholder={example ?? undefined}
        disabled={!ws.learner || !ws.live}
      />
      <Button size="sm" onClick={() => void save()} busy={busy} busyText={WV.saving} disabledReason={!ws.learner ? WV.roleDenied : !ws.live ? WV.afterReady : null}>
        {WV.save}
      </Button>
      {onClose ? (
        <button type="button" className="btn sm ghost icon" aria-label={WV.cancelEdit} onClick={onClose}>
          <Icon name="x" />
        </button>
      ) : null}
      {err ? (
        <span id={`${id}-err`} className="small st fail" role="alert">
          {err}
        </span>
      ) : null}
    </span>
  );
}

/** `::var-input` 指令。 */
export function VarInputDirective({ name }: { name: string }) {
  const ws = useWorkspace();
  const decl = ws.data.vars.data?.vars?.find((x) => x.name === name);
  const labDecl = ws.data.lab.data?.variables?.[name];
  const label = decl?.label ?? labDecl?.label ?? name;
  const value = decl?.value === undefined || decl?.value === null ? null : String(decl.value);
  return (
    <div className="box inset stack-4 varinput" data-var-input={name}>
      <b className="small">{label}</b>
      {value ? <span className="small mono">{t(WV.current, { v: redact(value) })}</span> : <span className="small st fail">{WV.empty}</span>}
      <VarEditor inline name={name} label={label} value={value} pattern={decl?.pattern ?? labDecl?.pattern ?? null} example={decl?.example ?? labDecl?.example ?? null} />
    </div>
  );
}
