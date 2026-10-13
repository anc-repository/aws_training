/**
 * 全局框架的订阅（08 §3.3、§3.8、§7.5、§8.4）：
 * - useExpiryAnnouncements：倒计时到达 15、5、1 分钟与 0 时由全局 LiveRegion 各播报一次（按 sid + deadlineVersion 去重）；
 * - useEnvDegraded：env.degraded 之后、env.recovered 之前为 true（横幅 5）；
 * - useGlobalShortcuts：`G` `W`/`L`/`T`/`M`/`S` 单键序列（输入框外；可在设置中关闭，WCAG 2.1.4）；工作台内不生效。
 */
import { useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useServices, useSessionEvents, useSessionSync } from '../app/context';
import { pillTarget } from '../app/sessionRouting';
import { announce } from '../lib/announce';
import { lsGet, STORAGE_KEYS } from '../lib/storage';
import { URGENCY_META, urgencyOf, type Urgency } from '../ui';

const ORDER: Urgency[] = ['U0', 'U1', 'U2', 'U3', 'U4'];

export function useExpiryAnnouncements(): void {
  const { clock } = useServices();
  const { current } = useSessionSync();
  const last = useRef<{ key: string; level: Urgency } | null>(null);
  useEffect(() => {
    if (!current?.deadlineAt || !['READY', 'RUNNING', 'EXPIRING'].includes(current.state)) return undefined;
    const key = `${current.sessionId}:${current.deadlineVersion ?? 0}`;
    const check = () => {
      const u = urgencyOf(Date.parse(current.deadlineAt!) - clock.now());
      const prev = last.current?.key === key ? last.current.level : null;
      // 第一次看到这个截止时间：只记下当前等级，不补播（避免刷新页面时重复播报）
      if (prev === null) {
        last.current = { key, level: u };
        return;
      }
      if (ORDER.indexOf(u) > ORDER.indexOf(prev)) {
        last.current = { key, level: u };
        const text = URGENCY_META[u].announce;
        if (text) announce(text, { politeness: u === 'U4' ? 'assertive' : 'polite' });
      } else if (ORDER.indexOf(u) < ORDER.indexOf(prev)) {
        last.current = { key, level: u };
      }
    };
    check();
    const id = setInterval(check, 1000);
    return () => clearInterval(id);
  }, [clock, current?.sessionId, current?.deadlineAt, current?.deadlineVersion, current?.state, current]);
}

export function useEnvDegraded(): boolean {
  const { current } = useSessionSync();
  const [degraded, setDegraded] = useState<{ sid: string; on: boolean } | null>(null);
  useSessionEvents(
    (sid, events) => {
      const lastEnv = [...events].reverse().find((e) => e.type === 'env.degraded' || e.type === 'env.recovered');
      if (lastEnv) setDegraded({ sid, on: lastEnv.type === 'env.degraded' });
    },
    { types: ['env.degraded', 'env.recovered'] },
  );
  return !!current && degraded?.sid === current.sessionId && degraded.on;
}

const SEQUENCES: Record<string, string | 'session'> = {
  w: 'session',
  l: '/labs',
  m: '/learning',
  s: '/sessions',
};

function typingTarget(el: EventTarget | null): boolean {
  if (!(el instanceof HTMLElement)) return false;
  return el.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(el.tagName) || !!el.closest('[role="dialog"],[role="alertdialog"],.xterm');
}

export function shortcutsEnabled(): boolean {
  return lsGet<boolean>(STORAGE_KEYS.shortcuts, true);
}

export function useGlobalShortcuts(opts: { enabled: boolean; currentTrackId: string }): void {
  const navigate = useNavigate();
  const { current } = useSessionSync();
  const pending = useRef<number>(0);
  useEffect(() => {
    if (!opts.enabled) return undefined;
    const onKey = (e: KeyboardEvent) => {
      if (e.ctrlKey || e.metaKey || e.altKey || typingTarget(e.target) || !shortcutsEnabled()) return;
      const k = e.key.toLowerCase();
      const now = Date.now();
      if (k === 'g') {
        pending.current = now;
        return;
      }
      if (!pending.current || now - pending.current > 1500) return;
      pending.current = 0;
      if (k === 't') {
        e.preventDefault();
        navigate(`/tracks/${opts.currentTrackId}`);
        return;
      }
      const dest = SEQUENCES[k];
      if (!dest) return;
      e.preventDefault();
      if (dest === 'session') {
        const to = current ? pillTarget(current) : null;
        if (to) navigate(to);
      } else navigate(dest);
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [opts.enabled, opts.currentTrackId, navigate, current]);
}
