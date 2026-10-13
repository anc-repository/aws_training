/**
 * BroadcastChannel 的薄包装：不支持（或构造抛异常，例如部分隐私模式）时返回 null，调用方退化为每个标签页各自工作
 * （08 P13 #30）。测试中可用 setBroadcastFactory 注入内存实现。
 */
export interface Channel {
  postMessage(msg: unknown): void;
  onmessage: ((ev: MessageEvent) => void) | null;
  close(): void;
}

type Factory = (name: string) => Channel | null;

const defaultFactory: Factory = (name) => {
  try {
    if (typeof globalThis.BroadcastChannel !== 'function') return null;
    return new globalThis.BroadcastChannel(name) as unknown as Channel;
  } catch {
    return null;
  }
};

let factory: Factory = defaultFactory;

export function openChannel(name: string): Channel | null {
  return factory(name);
}

export function setBroadcastFactory(f: Factory | null): void {
  factory = f ?? defaultFactory;
}

/** 同进程内的内存广播（测试与不支持 BroadcastChannel 的环境模拟多标签页）。 */
export function createMemoryBroadcast(): Factory {
  const peers = new Map<string, Set<Channel>>();
  return (name) => {
    const set = peers.get(name) ?? new Set<Channel>();
    peers.set(name, set);
    const ch: Channel = {
      onmessage: null,
      postMessage(msg) {
        for (const p of set) if (p !== ch) queueMicrotask(() => p.onmessage?.({ data: structuredClone(msg) } as MessageEvent));
      },
      close() {
        set.delete(ch);
      },
    };
    set.add(ch);
    return ch;
  };
}
