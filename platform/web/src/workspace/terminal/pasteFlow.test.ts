/**
 * “粘贴到终端”的终端侧流程（pasteFlow.ts，03 §7.1）：判定对象必须是要粘贴进去的那个终端；新子标签先等 shell 提示符再重新判定。
 */
import { describe, expect, it, vi } from 'vitest';
import type { ConfirmChoice } from '../workbench/PasteDialogs';
import { runPaste, type ConfirmDecision, type PasteFlowInput, type PasteTerminal } from './pasteFlow';

class FakeTerm implements PasteTerminal {
  pasted: { text: string; execute: boolean }[] = [];
  phase: 'ready' | 'connecting' | 'closed' = 'ready';
  busy = false;
  bracketedPaste = false;
  /** 等提示符时发生的事（例如 shell 打开 bracketed paste）。 */
  onPrompt: (() => void) | null = null;
  constructor(
    public readonly name: string,
    o: Partial<Pick<FakeTerm, 'busy' | 'bracketedPaste' | 'phase'>> = {},
    private readonly ready = true,
  ) {
    Object.assign(this, o);
  }
  ensureReady = vi.fn(async () => this.ready);
  waitForPrompt = vi.fn(async () => {
    this.onPrompt?.();
    return this.bracketedPaste;
  });
  getSnapshot() {
    return { phase: this.phase, busy: this.busy, instanceId: 'i-0abc1234def567890', runAs: 'labuser' };
  }
  paste(text: string, execute = false) {
    this.pasted.push({ text, execute });
    return true;
  }
}

const MULTI = 'cat <<EOF > /tmp/x\nhello\nEOF\n';
const DANGER = 'aws s3 rb s3://bucket --force\naws s3 ls';

function input(text: string, o: Partial<PasteFlowInput> = {}): PasteFlowInput {
  return { text, mode: 'paste', target: 'workstation', expected: 'workstation', tmux: false, dontAskExecute: () => false, ...o };
}

function deps(terminal: FakeTerm, next: FakeTerm | null, choices: ConfirmChoice['action'][]) {
  const confirms: { decision: ConfirmDecision; into: string }[] = [];
  const copy = vi.fn(async () => true);
  return {
    confirms,
    copy,
    d: {
      terminal,
      newSubTab: vi.fn(() => next),
      copy,
      confirm: async (decision: ConfirmDecision, into: FakeTerm) => {
        confirms.push({ decision, into: into.name });
        return { action: choices.shift() ?? 'cancel', dontAsk: false } satisfies ConfirmChoice;
      },
    },
  };
}

describe('runPaste (03 §7.1)', () => {
  it('busy terminal + multi-line → “在新的终端子标签中粘贴” re-evaluates the new tab: not bracketed after the prompt → rejected and copied, nothing pasted', async () => {
    const busy = new FakeTerm('busy', { busy: true, bracketedPaste: true });
    // the new tab is Ready but its shell has not printed a prompt yet (no ESC[?2004h) — and never turns bracketed paste on
    const fresh = new FakeTerm('new', { bracketedPaste: false });
    const { d, confirms, copy } = deps(busy, fresh, ['newtab']);
    const r = await runPaste(input(MULTI), d);
    expect(confirms.map((c) => [c.into, c.decision.notes])).toEqual([['busy', ['busy', 'multiline']]]);
    expect(fresh.ensureReady).toHaveBeenCalled();
    expect(fresh.waitForPrompt).toHaveBeenCalled();
    expect(r).toMatchObject({ kind: 'rejected', rejection: { reason: 'multiline-unsafe' }, copied: true });
    expect(copy).toHaveBeenCalledWith(MULTI);
    expect(fresh.pasted).toEqual([]);
    expect(busy.pasted).toEqual([]);
  });

  it('the new tab turns bracketed paste on at its first prompt → confirmed again for that tab, then pasted there', async () => {
    const busy = new FakeTerm('busy', { busy: true, bracketedPaste: true });
    const fresh = new FakeTerm('new');
    fresh.onPrompt = () => {
      fresh.bracketedPaste = true;
    };
    const { d, confirms } = deps(busy, fresh, ['newtab', 'paste']);
    const r = await runPaste(input(DANGER, { danger: true }), d);
    // the second dialog is about the new tab (not busy, still dangerous), not the old decision
    expect(confirms.map((c) => [c.into, c.decision.notes, c.decision.severe, c.decision.offerNewTab])).toEqual([
      ['busy', ['busy', 'danger'], true, true],
      ['new', ['danger'], true, false],
    ]);
    expect(r).toMatchObject({ kind: 'pasted' });
    expect(fresh.pasted).toEqual([{ text: DANGER, execute: false }]);
    expect(busy.pasted).toEqual([]);
  });

  it('cancelling the second dialog pastes nothing', async () => {
    const busy = new FakeTerm('busy', { busy: true, bracketedPaste: true });
    const fresh = new FakeTerm('new', { bracketedPaste: true });
    const { d } = deps(busy, fresh, ['newtab', 'cancel']);
    expect(await runPaste(input(MULTI), d)).toEqual({ kind: 'cancelled' });
    expect(fresh.pasted).toEqual([]);
  });

  it('a target terminal that was not open waits for the prompt before judging (multi-line is not rejected by mistake)', async () => {
    const t = new FakeTerm('first');
    t.onPrompt = () => {
      t.bracketedPaste = true;
    };
    const { d, confirms } = deps(t, null, ['paste']);
    const r = await runPaste(input(MULTI), d);
    expect(t.waitForPrompt).toHaveBeenCalledTimes(1);
    expect(confirms.map((c) => c.decision.notes)).toEqual([['multiline']]);
    expect(r).toMatchObject({ kind: 'pasted' });
    expect(t.pasted).toHaveLength(1);
  });

  it('single-line commands still paste without a prompt signal (nothing is executed: no newline)', async () => {
    const t = new FakeTerm('first');
    const { d, confirms } = deps(t, null, []);
    expect(await runPaste(input('ls -la\n'), d)).toMatchObject({ kind: 'pasted' });
    expect(confirms).toEqual([]);
    expect(t.pasted).toEqual([{ text: 'ls -la', execute: false }]);
  });

  it('not connected → copied; the new tab not connecting → copied, nothing pasted', async () => {
    const down = new FakeTerm('down', {}, false);
    const a = deps(down, null, []);
    expect(await runPaste(input('ls'), a.d)).toEqual({ kind: 'not-connected', newTab: false, copied: true });
    const busy = new FakeTerm('busy', { busy: true, bracketedPaste: true });
    const b = deps(busy, new FakeTerm('new', {}, false), ['newtab']);
    expect(await runPaste(input(MULTI), b.d)).toEqual({ kind: 'not-connected', newTab: true, copied: true });
    expect(busy.pasted).toEqual([]);
    const c = deps(busy, null, ['newtab']);
    expect(await runPaste(input(MULTI), c.d)).toMatchObject({ kind: 'not-connected', newTab: true });
  });

  it('a connection lost while waiting for the prompt does not paste', async () => {
    const t = new FakeTerm('first');
    t.onPrompt = () => {
      t.phase = 'closed';
    };
    const { d } = deps(t, null, []);
    expect(await runPaste(input('ls'), d)).toMatchObject({ kind: 'not-connected' });
    expect(t.pasted).toEqual([]);
  });
});
