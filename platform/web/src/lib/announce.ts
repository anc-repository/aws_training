/**
 * 读屏播报（08 §8.4、§5.5 LiveRegion）：polite 与 assertive 两个通道；同一主题（topic）3 秒内合并为一条
 * （例如同一步骤的检测结果），由 <LiveRegion> 渲染。组件只调用 announce()，不各自放 aria-live 区域。
 */
export type Politeness = 'polite' | 'assertive';

export interface Announcement {
  id: number;
  text: string;
  politeness: Politeness;
}

type Listener = (a: Announcement) => void;

const listeners = new Set<Listener>();
const pending = new Map<string, { timer: ReturnType<typeof setTimeout>; text: string; politeness: Politeness }>();
let seq = 0;
export const MERGE_WINDOW_MS = 3_000;

function emit(text: string, politeness: Politeness): void {
  const a = { id: ++seq, text, politeness };
  for (const l of listeners) l(a);
}

/** 播报；带 topic 时，同一 topic 在 3 秒窗口内只播报最后一条。 */
export function announce(text: string, opts: { politeness?: Politeness; topic?: string } = {}): void {
  const politeness = opts.politeness ?? 'polite';
  if (!opts.topic) {
    emit(text, politeness);
    return;
  }
  const cur = pending.get(opts.topic);
  if (cur) clearTimeout(cur.timer);
  const timer = setTimeout(() => {
    pending.delete(opts.topic!);
    emit(text, politeness);
  }, MERGE_WINDOW_MS);
  pending.set(opts.topic, { timer, text, politeness });
}

export function subscribeAnnouncements(l: Listener): () => void {
  listeners.add(l);
  return () => listeners.delete(l);
}

/** 测试用：清空合并中的播报。 */
export function resetAnnouncements(): void {
  for (const p of pending.values()) clearTimeout(p.timer);
  pending.clear();
}
