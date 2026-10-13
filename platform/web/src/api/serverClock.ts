/**
 * 服务端时钟 serverClock（02 §5.5、08 §2.6“时间”、P13 #20）：倒计时与剩余时间一律经它换算，组件不得直接用 Date.now()。
 *
 * - 偏差 = serverNow −（发出时刻 + 收到时刻）/ 2（本地时钟），每个带 serverNow 的响应都可以喂给 observe()；
 *   往返时间越短的样本越可信：只在新样本的往返不比当前样本差太多（或当前样本已过期 5 分钟）时替换；
 * - 偏差 > 2 分钟时 `skewMinutes` 非空，页脚提示“本机时钟与服务器相差约 n 分钟”；
 * - 睡眠检测：Date.now() 与 performance.now() 的增量相差 > 5 秒，视为睡眠或时钟跳变，触发 onResync（立即重新对时）。
 */

export interface ClockSample {
  offsetMs: number;
  rttMs: number;
  at: number;
}

type Listener = () => void;

export class ServerClock {
  private sample: ClockSample | null = null;
  private readonly listeners = new Set<Listener>();
  private lastWall = 0;
  private lastMono = 0;

  constructor(
    private readonly wall: () => number = () => Date.now(),
    private readonly mono: () => number = () => (globalThis.performance ? globalThis.performance.now() : Date.now()),
  ) {
    this.lastWall = this.wall();
    this.lastMono = this.mono();
  }

  /** 服务端当前时间（毫秒）。 */
  now = (): number => this.wall() + (this.sample?.offsetMs ?? 0);

  get offsetMs(): number {
    return this.sample?.offsetMs ?? 0;
  }

  get synced(): boolean {
    return this.sample !== null;
  }

  /** 偏差超过 2 分钟时返回约数（分钟），否则 null。 */
  get skewMinutes(): number | null {
    const o = Math.abs(this.offsetMs);
    return o > 120_000 ? Math.round(o / 60_000) : null;
  }

  /** 喂入一个带 serverNow 的响应：sentAt / receivedAt 是本地 Date.now()。 */
  observe(serverNowIso: string | null | undefined, sentAt: number, receivedAt: number = this.wall()): void {
    if (!serverNowIso) return;
    const server = Date.parse(serverNowIso);
    if (!Number.isFinite(server)) return;
    const rtt = Math.max(0, receivedAt - sentAt);
    const offset = server - (sentAt + receivedAt) / 2;
    const cur = this.sample;
    const stale = !cur || receivedAt - cur.at > 5 * 60_000;
    if (stale || rtt <= cur.rttMs * 1.5 + 50) {
      this.sample = { offsetMs: offset, rttMs: rtt, at: receivedAt };
      for (const l of this.listeners) l();
    }
  }

  /** 丢弃样本（睡眠唤醒、回到前台后重新对时）。 */
  reset(): void {
    this.sample = null;
  }

  /**
   * 睡眠检测：两次调用之间墙钟与单调时钟的增量相差 > 5 秒时返回 true（02 §5.5、P13 #20）。
   * 调用方定期（例如每秒的 tick 或 visibilitychange）调用。
   */
  detectJump(thresholdMs = 5_000): boolean {
    const w = this.wall();
    const m = this.mono();
    const jumped = Math.abs(w - this.lastWall - (m - this.lastMono)) > thresholdMs;
    this.lastWall = w;
    this.lastMono = m;
    return jumped;
  }

  subscribe(l: Listener): () => void {
    this.listeners.add(l);
    return () => this.listeners.delete(l);
  }
}

/** 全站唯一的服务端时钟。 */
export const serverClock = new ServerClock();
