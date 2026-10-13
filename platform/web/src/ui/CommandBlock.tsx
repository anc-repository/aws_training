/**
 * 命令块 CommandBlock（08 §5.3、P05.4；改造 ui-design CommandBlock，原型 cmdBlock / doCopy / copy-danger）。
 *
 * - 显示经过界面打码器（账号 ID、公网 IP），复制与粘贴用原文；两者不一致时注明“显示已打码，复制为完整命令”；
 * - 未解析变量渲染为红色虚线占位 `‹标签›`，复制按钮带 `(!)`，点击时提示“有 N 个变量未填写”并交给调用方定位变量条（04 §4.2）；
 * - `danger` 的命令块复制前也要二次确认（默认焦点在“取消”）；
 * - 剪贴板 API 不可用时真正选中 <code> 文本并提示按 Ctrl+C；显示与原文不一致时弹出预先选中的只读文本框；
 * - 粘贴按钮按 runsOn 出现（工作台 / 实验机），`▾` 中有其他粘贴方式；粘贴本身（确认矩阵、终端状态）由工作台实现，经 onPaste 回调。
 */
import { useEffect, useRef, useState } from 'react';
import { announce } from '../lib/announce';
import { copyText, selectNodeText } from '../lib/clipboard';
import { redact } from '../lib/redact';
import { Button } from './Button';
import { Disclosure } from './Disclosure';
import { Icon } from './Icon';
import { Dialog } from './Overlay';
import { Shape } from './Shape';

export type RunsOn = 'workstation' | 'ops' | 'cloudshell' | 'lab' | 'ec2' | 'local' | 'browser';
export type PasteTarget = 'workstation' | 'lab';

/** 命令的一段：纯文本，或一个变量（value 为空即未解析）。 */
export type CommandPart = string | { name: string; value?: string | null; placeholder: string; secret?: boolean };

export interface PasteOptions {
  newTab?: boolean;
  execute?: boolean;
}

export interface CommandBlockProps {
  /** 纯文本命令（没有变量时用它）。 */
  text?: string;
  /** 带变量的命令。 */
  parts?: readonly CommandPart[];
  runsOn?: RunsOn;
  danger?: boolean;
  /** 实验类命令旁标注“观察用，不计入结果”（03 §7.1）。 */
  observe?: boolean;
  /** 只提供复制（P00、P07 的清理命令）。 */
  copyOnly?: boolean;
  /** 显示是否经过打码器（默认是）。 */
  mask?: boolean;
  onPaste?: (target: PasteTarget, opts: PasteOptions) => void;
  /** 粘贴暂不可用的原因（准备阶段、终端未连接……）。 */
  pasteDisabledReason?: string | null;
  /** 设置中开启“粘贴并执行”后才出现（危险命令不允许）。 */
  allowExecute?: boolean;
  onUnresolved?: (names: string[]) => void;
  /** 复制按钮的 aria-label 用的简短名称（默认取第一行）。 */
  label?: string;
}

export const PASTE_LIMIT_BYTES = 16 * 1024;

const RUNS_ON_TEXT: Record<RunsOn, string> = {
  workstation: '工作台',
  ops: '工作台',
  cloudshell: 'CloudShell',
  lab: '实验机',
  ec2: '实验机',
  local: '本机',
  browser: '浏览器',
};

function pasteTargetOf(runsOn: RunsOn): PasteTarget | null {
  if (runsOn === 'workstation' || runsOn === 'ops' || runsOn === 'cloudshell') return 'workstation';
  if (runsOn === 'lab' || runsOn === 'ec2') return 'lab';
  return null;
}

const TARGET_TEXT: Record<PasteTarget, string> = { workstation: '工作台', lab: '实验机' };

export function CommandBlock({
  text,
  parts,
  runsOn = 'workstation',
  danger,
  observe,
  copyOnly,
  mask = true,
  onPaste,
  pasteDisabledReason,
  allowExecute,
  onUnresolved,
  label,
}: CommandBlockProps) {
  const segs: readonly CommandPart[] = parts ?? [text ?? ''];
  const raw = segs.map((p) => (typeof p === 'string' ? p : (p.value ?? p.placeholder))).join('');
  const unresolved = segs.filter((p): p is Exclude<CommandPart, string> => typeof p !== 'string' && !p.value).map((p) => p.name);
  const hasSecret = segs.some((p) => typeof p !== 'string' && p.secret);
  const display = (s: string) => (mask ? redact(s) : s);
  const shown = segs.map((p) => (typeof p === 'string' ? display(p) : p.value ? display(p.value) : p.placeholder)).join('');
  const maskedDiffers = shown !== raw;

  const codeRef = useRef<HTMLElement>(null);
  const fallbackRef = useRef<HTMLTextAreaElement>(null);
  const [copied, setCopied] = useState(false);
  const [confirm, setConfirm] = useState(false);
  const [fallback, setFallback] = useState<'select' | 'textarea' | null>(null);

  useEffect(() => {
    if (!copied) return undefined;
    const timer = setTimeout(() => setCopied(false), 1500);
    return () => clearTimeout(timer);
  }, [copied]);
  useEffect(() => {
    if (fallback === 'textarea') fallbackRef.current?.select();
  }, [fallback]);

  const doCopy = async () => {
    if (await copyText(raw)) {
      setFallback(null);
      setCopied(true);
      announce('已复制');
      return;
    }
    if (!maskedDiffers && !unresolved.length && selectNodeText(codeRef.current)) {
      setFallback('select');
      announce('已选中命令，按 Ctrl+C 复制');
    } else {
      setFallback('textarea');
      announce('请在文本框中按 Ctrl+C 复制');
    }
  };

  const onCopyClick = () => {
    if (unresolved.length) {
      announce(`有 ${unresolved.length} 个变量未填写`);
      onUnresolved?.(unresolved);
      return;
    }
    if (danger) {
      setConfirm(true);
      return;
    }
    void doCopy();
  };

  const firstLine = (label ?? shown.split('\n')[0] ?? '').slice(0, 80);
  const target = copyOnly ? null : pasteTargetOf(runsOn);
  const tooLarge = new TextEncoder().encode(raw).length > PASTE_LIMIT_BYTES;
  const pasteBlock =
    pasteDisabledReason ??
    (unresolved.length ? `有 ${unresolved.length} 个变量未填写` : hasSecret ? '命令含密钥占位，不能粘贴' : tooLarge ? '命令超过 16KB，只能复制' : null);
  const other: PasteTarget | null = target === 'lab' ? 'workstation' : target === 'workstation' ? 'lab' : null;

  return (
    <div className={danger ? 'cmd danger' : 'cmd'} data-runs-on={runsOn}>
      <pre>
        <code ref={codeRef}>
          {segs.map((p, i) =>
            typeof p === 'string' ? (
              display(p)
            ) : p.value ? (
              <span key={i} className="var" title={p.name}>
                {display(p.value)}
              </span>
            ) : (
              <span key={i} className="unres" title={`未填写：${p.name}`}>
                {p.placeholder}
              </span>
            ),
          )}
        </code>
      </pre>
      <div className="cbar">
        <span>
          运行于：{RUNS_ON_TEXT[runsOn]}
          {observe ? ' · 观察用，不计入结果' : ''}
          {maskedDiffers && !unresolved.length ? <span className="faint"> · 显示已打码，复制为完整命令</span> : null}
          {danger ? (
            <span className="st fail">
              {' '}
              <Shape name="tri" />
              <span className="t">会删除或停用资源</span>
            </span>
          ) : null}
        </span>
        <span className="spacer" />
        <Button size="sm" icon="copy" onClick={onCopyClick} aria-label={`复制命令：${firstLine}${unresolved.length ? '（有未填写的变量）' : ''}`}>
          {copied ? '已复制' : unresolved.length ? '复制 (!)' : '复制'}
        </Button>
        {target && onPaste ? (
          <span className="row" data-paste="">
            <Button
              size="sm"
              icon="paste"
              aria-disabled={pasteBlock ? true : undefined}
              title={pasteBlock ?? undefined}
              aria-label={`粘贴到${TARGET_TEXT[target]}终端`}
              onClick={() => {
                if (pasteBlock) {
                  announce(pasteBlock);
                  if (unresolved.length) onUnresolved?.(unresolved);
                  return;
                }
                onPaste(target, {});
              }}
            >
              粘贴到 {TARGET_TEXT[target]}
            </Button>
            {!pasteBlock ? (
              <Disclosure label={<Icon name="chev" />} ariaLabel="更多粘贴方式" buttonClassName="btn sm icon">
                {(close) => (
                  <>
                    {other ? (
                      <button
                        type="button"
                        className="mi"
                        onClick={() => {
                          close();
                          onPaste(other, {});
                        }}
                      >
                        粘贴到 {TARGET_TEXT[other]}
                      </button>
                    ) : null}
                    <button
                      type="button"
                      className="mi"
                      onClick={() => {
                        close();
                        onPaste(target, { newTab: true });
                      }}
                    >
                      在新的终端子标签中粘贴
                    </button>
                    {allowExecute && !danger ? (
                      <button
                        type="button"
                        className="mi"
                        onClick={() => {
                          close();
                          onPaste(target, { execute: true });
                        }}
                      >
                        粘贴并执行
                      </button>
                    ) : null}
                  </>
                )}
              </Disclosure>
            ) : null}
          </span>
        ) : null}
      </div>
      {fallback === 'select' ? <div className="cbar">已选中命令，按 Ctrl+C 复制。</div> : null}
      {fallback === 'textarea' ? (
        <textarea ref={fallbackRef} className="fallback" readOnly value={raw} aria-label="命令原文（按 Ctrl+C 复制）" />
      ) : null}
      <Dialog
        open={confirm}
        onClose={() => setConfirm(false)}
        title="复制危险命令"
        size="narrow"
        alert
        initialFocus="[data-cancel]"
        footer={
          <>
            <button type="button" className="btn" data-cancel="" onClick={() => setConfirm(false)}>
              取消
            </button>
            <button
              type="button"
              className="btn danger"
              onClick={() => {
                setConfirm(false);
                void doCopy();
              }}
            >
              我了解，复制
            </button>
          </>
        }
      >
        <div className="note red">
          <Shape name="tri" />
          <span>这条命令会删除或停用资源，影响无法撤销。确认后才会复制到剪贴板。</span>
        </div>
        <pre className="mono small">{shown}</pre>
      </Dialog>
    </div>
  );
}
