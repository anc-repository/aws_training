/**
 * “粘贴到终端”的确认与拒绝说明（03 §7.1；08 P05.4 确认矩阵）：
 * - 确认浮层：完整命令（显示经打码器）、目标主机、Linux 用户、AWS 身份；多行“将粘贴 N 行”；危险命令红色并列出影响，需点“我了解，粘贴”；
 *   终端正忙：“终端正在运行命令（例如 tail -f），粘贴的内容会成为该程序的输入”[仍然粘贴][在新的终端子标签中粘贴][取消]；
 *   目标与 runsOn 不一致：“这条命令本应在 实验机 上执行”；粘贴并执行的单行普通命令可勾选“本卡片内不再询问”；
 * - 拒绝：未解析变量（已定位到变量条）、密钥占位（给出在实例上读取的命令）、超过 16KB、多行但终端不支持安全粘贴、危险命令不允许执行。
 * 危险操作的确认按钮不是默认焦点（默认焦点在“取消”）。
 */
import { useState } from 'react';
import { redact } from '../../lib/redact';
import { CommandBlock, Dialog, Shape } from '../../ui';
import { TARGET_TEXT, type ConfirmNote, type PasteRejection, type TerminalTarget } from '../model/paste';

export type ConfirmChoice = { action: 'paste' | 'newtab' | 'cancel'; dontAsk: boolean };

export interface ConfirmRequest {
  text: string;
  target: TerminalTarget;
  expected: TerminalTarget | null;
  notes: ConfirmNote[];
  severe: boolean;
  lines: number;
  offerNewTab: boolean;
  offerDontAsk: boolean;
  execute: boolean;
  host: string | null;
  user: string;
  identity: string;
}

export function PasteConfirmDialog({ req, onDone }: { req: ConfirmRequest; onDone: (c: ConfirmChoice) => void }) {
  const [dontAsk, setDontAsk] = useState(false);
  const has = (n: ConfirmNote) => req.notes.includes(n);
  const title = req.severe ? '粘贴危险命令' : has('busy') ? '终端正在运行命令' : req.execute ? '粘贴并执行' : has('multiline') ? `将粘贴 ${req.lines} 行` : '确认粘贴';
  return (
    <Dialog
      open
      onClose={() => onDone({ action: 'cancel', dontAsk: false })}
      title={title}
      alert={req.severe}
      initialFocus="[data-cancel]"
      footer={
        <>
          <button type="button" className="btn" data-cancel="" onClick={() => onDone({ action: 'cancel', dontAsk: false })}>
            取消
          </button>
          {req.offerNewTab ? (
            <button type="button" className="btn" onClick={() => onDone({ action: 'newtab', dontAsk })}>
              在新的终端子标签中粘贴
            </button>
          ) : null}
          <button type="button" className={req.severe ? 'btn danger' : 'btn primary'} onClick={() => onDone({ action: 'paste', dontAsk })} data-paste-confirm="">
            {req.severe ? '我了解，粘贴' : has('busy') ? '仍然粘贴' : req.execute ? '粘贴并执行' : '粘贴'}
          </button>
        </>
      }
    >
      <div className="stack-8" data-paste-dialog={req.notes.join(' ')}>
        {req.severe ? (
          <div className="note red">
            <Shape name="tri" />
            <span>这条命令会删除或停用资源，影响无法撤销。粘贴后请检查，再自己按 Enter；危险命令不允许“粘贴并执行”。</span>
          </div>
        ) : null}
        {has('busy') ? (
          <div className="note amber">
            <Shape name="tri" />
            <span>终端正在运行命令（例如 tail -f），粘贴的内容会成为该程序的输入。</span>
          </div>
        ) : null}
        {has('mismatch') && req.expected ? (
          <div className="note amber">
            <Shape name="tri" />
            <span>这条命令本应在 {TARGET_TEXT[req.expected]} 上执行。</span>
          </div>
        ) : null}
        {has('multiline') ? <p className="small">将向 {TARGET_TEXT[req.target]}终端粘贴 {req.lines} 行（安全粘贴，不会立即执行）。</p> : null}
        <pre className="mono small evjson">{redact(req.text)}</pre>
        <dl className="kv">
          <dt>目标主机</dt>
          <dd className="mono">
            {TARGET_TEXT[req.target]} {req.host ?? ''}
          </dd>
          <dt>Linux 用户</dt>
          <dd className="mono">{req.user}</dd>
          <dt>AWS 身份</dt>
          <dd className="mono">{req.identity}</dd>
        </dl>
        {req.offerDontAsk ? (
          <label className="row small">
            <input type="checkbox" checked={dontAsk} onChange={(e) => setDontAsk(e.target.checked)} />
            本卡片内不再询问（仅普通命令）
          </label>
        ) : null}
      </div>
    </Dialog>
  );
}

/** `copied`：命令已复制到剪贴板（多行但终端不支持安全粘贴时自动复制，03 §7.1）。 */
export function PasteRejectDialog({ rejection, copied = false, onClose }: { rejection: PasteRejection; copied?: boolean; onClose: () => void }) {
  return (
    <Dialog open onClose={onClose} title="不能粘贴" size="narrow" footer={<button type="button" className="btn" onClick={onClose}>知道了</button>}>
      <div className="stack-8" data-paste-reject={rejection.reason}>
        <p>{rejection.message}</p>
        {rejection.reason === 'secret' && rejection.readCommand ? (
          <>
            <p className="small">在实验机终端中读取：</p>
            <CommandBlock text={rejection.readCommand} runsOn="lab" copyOnly />
          </>
        ) : null}
        {copied ? (
          <p className="small" data-paste-copied="">
            命令已复制到剪贴板，检查后可以在终端里手动粘贴。
          </p>
        ) : rejection.reason === 'multiline-unsafe' || rejection.reason === 'too-large' ? (
          <p className="small muted">可以先复制命令，再在终端里手动粘贴。</p>
        ) : null}
      </div>
    </Dialog>
  );
}
