import { act, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CommandBlock } from './CommandBlock';

let writeText: ReturnType<typeof vi.fn>;

function setClipboard(available: boolean) {
  writeText = vi.fn().mockResolvedValue(undefined);
  Object.defineProperty(navigator, 'clipboard', { configurable: true, value: available ? { writeText } : undefined });
}

beforeEach(() => setClipboard(true));
afterEach(() => setClipboard(true));

async function click(el: HTMLElement) {
  await act(async () => {
    fireEvent.click(el);
  });
}

describe('CommandBlock (08 P05.4)', () => {
  it('displays the masked command but copies the original text', async () => {
    render(<CommandBlock text="aws s3 ls s3://album-111122223333" />);
    expect(screen.getByText(/album-••••3333/)).toBeTruthy();
    expect(screen.getByText(/显示已打码，复制为完整命令/)).toBeTruthy();
    await click(screen.getByRole('button', { name: /^复制命令/ }));
    expect(writeText).toHaveBeenCalledWith('aws s3 ls s3://album-111122223333');
    expect(screen.getByRole('button', { name: /^复制命令/ }).textContent).toContain('已复制');
  });

  it('unresolved variables: red placeholder, copy button marked (!) and refuses to copy', async () => {
    const onUnresolved = vi.fn();
    render(
      <CommandBlock
        parts={['aws cloudfront get-distribution --id ', { name: 'var.distributionId', placeholder: '‹分配 ID›' }]}
        onUnresolved={onUnresolved}
        onPaste={vi.fn()}
      />,
    );
    expect(screen.getByText('‹分配 ID›').className).toBe('unres');
    const copy = screen.getByRole('button', { name: /有未填写的变量/ });
    expect(copy.textContent).toContain('(!)');
    await click(copy);
    expect(writeText).not.toHaveBeenCalled();
    expect(onUnresolved).toHaveBeenCalledWith(['var.distributionId']);
    // 粘贴同样被拒绝
    const paste = screen.getByRole('button', { name: '粘贴到工作台终端' });
    expect(paste.getAttribute('aria-disabled')).toBe('true');
  });

  it('danger blocks ask for confirmation before copying; default focus is 取消', async () => {
    render(<CommandBlock text="scripts/module disable cdn" danger />);
    await click(screen.getByRole('button', { name: /^复制命令/ }));
    const dlg = screen.getByRole('alertdialog', { name: '复制危险命令' });
    expect(document.activeElement?.textContent).toBe('取消');
    expect(writeText).not.toHaveBeenCalled();
    await click(within(dlg).getByRole('button', { name: '我了解，复制' }));
    expect(writeText).toHaveBeenCalledWith('scripts/module disable cdn');
  });

  it('without the Clipboard API, selects the <code> text (or shows a preselected read-only box when masked)', async () => {
    setClipboard(false);
    const { unmount } = render(<CommandBlock text="echo hello" />);
    await click(screen.getByRole('button', { name: /^复制命令/ }));
    expect(screen.getByText('已选中命令，按 Ctrl+C 复制。')).toBeTruthy();
    expect(window.getSelection()?.toString()).toBe('echo hello');
    unmount();
    render(<CommandBlock text="echo 111122223333" />);
    await click(screen.getByRole('button', { name: /^复制命令/ }));
    const box = screen.getByRole('textbox', { name: /命令原文/ }) as HTMLTextAreaElement;
    expect(box.value).toBe('echo 111122223333');
    expect(box.readOnly).toBe(true);
  });

  it('paste buttons follow runsOn; more options sit behind ▾', async () => {
    const onPaste = vi.fn();
    render(<CommandBlock text="sudo systemctl status cloudalbum" runsOn="lab" onPaste={onPaste} observe />);
    expect(screen.getByText(/观察用，不计入结果/)).toBeTruthy();
    await click(screen.getByRole('button', { name: '粘贴到实验机终端' }));
    expect(onPaste).toHaveBeenLastCalledWith('lab', {});
    await click(screen.getByRole('button', { name: '更多粘贴方式' }));
    await click(screen.getByRole('button', { name: '粘贴到 工作台' }));
    expect(onPaste).toHaveBeenLastCalledWith('workstation', {});
    expect(screen.queryByRole('button', { name: '粘贴并执行' })).toBeNull();
  });

  it('local / browser commands and copyOnly blocks have no paste buttons; pasteDisabledReason blocks paste', async () => {
    const onPaste = vi.fn();
    const { unmount } = render(<CommandBlock text="open https://example.test" runsOn="browser" onPaste={onPaste} />);
    expect(screen.queryByRole('button', { name: /粘贴/ })).toBeNull();
    unmount();
    render(<CommandBlock text="ls" onPaste={onPaste} pasteDisabledReason="环境就绪后可用" />);
    const paste = screen.getByRole('button', { name: '粘贴到工作台终端' });
    expect(paste.getAttribute('title')).toBe('环境就绪后可用');
    await click(paste);
    expect(onPaste).not.toHaveBeenCalled();
  });

  it('commands over 16KB can only be copied', () => {
    render(<CommandBlock text={'x'.repeat(17 * 1024)} onPaste={vi.fn()} />);
    expect(screen.getByRole('button', { name: '粘贴到工作台终端' }).getAttribute('title')).toBe('命令超过 16KB，只能复制');
  });
});
