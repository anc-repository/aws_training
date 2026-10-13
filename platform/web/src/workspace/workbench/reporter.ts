/**
 * 工作台事件上报（03 §7.4；08 P05.11）：`workspace.command_pasted`、`workspace.command_finished`、`workspace.console_opened`、
 * `workspace.preview_opened`、`workspace.terminal_reconnected` 每 10 秒或页面隐藏时批量提交到 `POST /sessions/{sid}/workspace-events`。
 * 只上报命令摘要（`textSha256`），不上报命令原文与终端内容。只对学员（路由鉴权是 L）。上报失败不影响界面（尽力而为）。
 */
import type { ApiClient } from '../../api/client';

export interface WorkspaceEvent {
  type: string;
  data?: Record<string, unknown>;
  at?: string;
}

export const FLUSH_MS = 10_000;
const MAX_BATCH = 50;

export class WorkspaceReporter {
  private queue: WorkspaceEvent[] = [];
  private timer: ReturnType<typeof setInterval> | null = null;
  private readonly onHide = () => {
    if (document.visibilityState === 'hidden') void this.flush();
  };

  constructor(
    private readonly api: Pick<ApiClient, 'call'>,
    private readonly sid: string,
    private readonly now: () => number = () => Date.now(),
  ) {}

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => void this.flush(), FLUSH_MS);
    document.addEventListener('visibilitychange', this.onHide);
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    document.removeEventListener('visibilitychange', this.onHide);
    void this.flush();
  }

  push(type: string, data: Record<string, unknown> = {}): void {
    this.queue.push({ type, data, at: new Date(this.now()).toISOString() });
    if (this.queue.length > MAX_BATCH * 4) this.queue.splice(0, this.queue.length - MAX_BATCH * 4);
  }

  get pending(): number {
    return this.queue.length;
  }

  async flush(): Promise<void> {
    if (!this.queue.length) return;
    const batch = this.queue.splice(0, MAX_BATCH);
    try {
      await this.api.call('postWorkspaceEvents', { params: { sid: this.sid }, body: { events: batch } });
    } catch {
      /* 尽力而为：丢弃这一批（不重试，避免重复写入时间线） */
    }
  }
}
