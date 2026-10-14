/**
 * TerminalView（08 §5.3；03 §3.7）：xterm.js 6 + ssm-client。按需加载 xterm（不进入首屏包，`./xterm.ts`），
 * Fit 插件按容器计算 cols × rows：ResizeObserver 去抖 150ms，分隔条拖动中不发送、拖动结束后发一次（03 §3.5.6）。
 * 容器 `role="region"` + `aria-label="实验机终端 #1，i-0abc…，labuser"`；获得焦点时 2px 焦点环（--term-cursor）。
 */
import { useEffect, useRef, useState } from 'react';
import { createXterm, terminalOptions } from './xterm';
import type { TerminalController, XtermLike } from './controller';

import { W } from '../strings';
export interface TermHandle {
  term: XtermLike & { clear?(): void; getSelection?(): string; hasSelection?(): boolean; options: Record<string, unknown> };
  fit(): void;
  dispose(): void;
}

export type TermFactory = (container: HTMLElement, opts: { fontSize: number; screenReaderMode: boolean }) => Promise<TermHandle>;

const defaultFactory: TermFactory = async (container, o) => {
  const reduced = typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;
  const h = await createXterm(container, { ...terminalOptions(o.fontSize), screenReaderMode: o.screenReaderMode, cursorBlink: !reduced, macOptionIsMeta: true, rightClickSelectsWord: false });
  return { term: h.term as unknown as TermHandle['term'], fit: () => h.fit.fit(), dispose: h.dispose };
};

let factory: TermFactory = defaultFactory;

/** 测试用：替换 xterm 的创建（jsdom 中无法渲染 xterm）。 */
export function setTermFactory(f: TermFactory | null): void {
  factory = f ?? defaultFactory;
}

/** 分隔条拖动中（03 §3.5.6）：工作台在 <html> 上设 data-ws-drag，拖动结束派发 atl:ws-drag-end。 */
function dragging(): boolean {
  return typeof document !== 'undefined' && document.documentElement.dataset.wsDrag === '1';
}

/** 等到元素有宽度（下一帧起检查；隐藏时由 ResizeObserver 在显示后唤醒）。 */
function waitForSize(el: HTMLElement, alive: () => boolean): Promise<void> {
  return new Promise((resolve) => {
    const ok = () => el.getBoundingClientRect().width > 0;
    const raf = typeof requestAnimationFrame === 'function' ? requestAnimationFrame : (f: () => void) => setTimeout(f, 16);
    raf(() => {
      if (ok() || !alive()) return resolve();
      const RO = (globalThis as { ResizeObserver?: typeof ResizeObserver }).ResizeObserver;
      if (!RO) return resolve();
      const ro = new RO(() => {
        if (ok() || !alive()) {
          ro.disconnect();
          resolve();
        }
      });
      ro.observe(el);
    });
  });
}

export interface TerminalViewProps {
  controller: TerminalController;
  label: string;
  fontSize: number;
  screenReaderMode: boolean;
  /** 可见时才计算尺寸（隐藏的标签页不 fit）。 */
  visible: boolean;
  onHandle?: (h: TermHandle | null) => void;
}

export function TerminalView({ controller, label, fontSize, screenReaderMode, visible, onHandle }: TerminalViewProps) {
  const ref = useRef<HTMLDivElement>(null);
  const handle = useRef<TermHandle | null>(null);
  const [failed, setFailed] = useState(false);
  const onHandleRef = useRef(onHandle);
  onHandleRef.current = onHandle;

  useEffect(() => {
    let alive = true;
    const el = ref.current;
    if (!el) return undefined;
    // 每次创建一个独立的挂载点：React StrictMode 下效果会执行两次，旧的 xterm 不能与新的共用同一个容器
    const mount = document.createElement('div');
    mount.className = 'xterm-mount-inner';
    el.appendChild(mount);
    factory(mount, { fontSize, screenReaderMode })
      .then(async (h) => {
        // 等布局就绪（隐藏的标签页宽度为 0）再按容器算出 cols × rows，之后才把尺寸与输出交给连接——避免先发出一个过小的尺寸
        await waitForSize(mount, () => alive);
        if (!alive) {
          h.dispose();
          return;
        }
        h.fit();
        handle.current = h;
        controller.attach(h.term);
        onHandleRef.current?.(h);
      })
      .catch(() => alive && setFailed(true));
    return () => {
      alive = false;
      onHandleRef.current?.(null);
      handle.current?.dispose();
      handle.current = null;
      mount.remove();
    };
    // xterm 实例只随控制器重建；字号与读屏模式在下面单独更新
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [controller]);

  useEffect(() => {
    const t = handle.current?.term;
    if (!t) return;
    t.options.fontSize = fontSize;
    t.options.screenReaderMode = screenReaderMode;
    handle.current?.fit();
  }, [fontSize, screenReaderMode]);

  useEffect(() => {
    const el = ref.current;
    if (!el || !visible) return undefined;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const fit = () => {
      if (dragging()) return;
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => handle.current?.fit(), 150);
    };
    const RO = (globalThis as { ResizeObserver?: typeof ResizeObserver }).ResizeObserver;
    const ro = RO ? new RO(fit) : null;
    ro?.observe(el);
    const onDragEnd = () => handle.current?.fit();
    window.addEventListener('atl:ws-drag-end', onDragEnd);
    // 软键盘弹出时随 visualViewport 缩小（03 §8.6）
    const vv = (globalThis as { visualViewport?: VisualViewport }).visualViewport;
    vv?.addEventListener('resize', fit);
    handle.current?.fit();
    return () => {
      if (timer) clearTimeout(timer);
      ro?.disconnect();
      window.removeEventListener('atl:ws-drag-end', onDragEnd);
      vv?.removeEventListener('resize', fit);
    };
  }, [visible]);

  return (
    <div className="xterm-host" role="region" aria-label={label} data-term-host="">
      <div ref={ref} className="xterm-mount" />
      {failed ? <p className="small term-fail">{W.terminal.loadFailed}</p> : null}
    </div>
  );
}
