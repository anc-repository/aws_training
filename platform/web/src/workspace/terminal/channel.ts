/**
 * 终端协议层（03 §3.5）由 `platform/ssm-client`（`@atl/ssm-client`）提供：`SsmTerminalConnection` 负责
 * POST …/terminals 拿到的 StreamUrl / TokenValue 直连、OpenDataChannel、握手、序列号与重传、改尺寸、channel_closed、
 * 断线续连（POST …/resume）；dev 模式下它连接 ssm-client 提供的本地模拟服务器（ws://127.0.0.1，需 allowLoopback）。
 *
 * 加载方式：`@atl/ssm-client` 还不是 platform/web 的依赖（根 package.json 的 workspaces、web 的 tsconfig paths 与 vite alias
 * 都未登记），这里用 `import.meta.glob` 按相对路径按需加载它的源码入口——包不存在时得到空表，构建不受影响，终端显示
 * “终端组件不可用”。类型只按结构声明用到的部分（与 ssm-client 的 `XtermLike` 做法相同），不在 web 的 tsc 中检查它的源码。
 */

/** `SsmTerminalConnection` 的状态（ssm-client connection.ts）。 */
export type SsmState = 'idle' | 'requesting' | 'connecting' | 'authenticating' | 'handshaking' | 'ready' | 'reconnecting' | 'resuming' | 'failed' | 'closed';

export interface SsmStateChange {
  state: SsmState;
  previous: SsmState;
  failure?: { reason: string; message: string; error?: unknown; closeCode?: number };
  closed?: { reason: 'channel-closed' | 'user' | 'access-revoked'; output?: string };
  reconnect?: { attempt: number; maxAttempts: number; delayMs?: number; waitingForNetwork?: boolean };
  resumed?: boolean;
}

export interface StreamCredentials {
  streamUrl: string;
  tokenValue: string;
  connectBy?: string | number | Date | null;
}

export interface SsmConnectionOptions {
  open: () => Promise<StreamCredentials>;
  resume?: () => Promise<StreamCredentials>;
  clientId: string;
  clientVersion?: string;
  streamUrlPolicy?: { region?: string; additionalHosts?: readonly string[]; allowLoopback?: boolean };
  onOutput?: (data: Uint8Array, done: () => void) => void;
}

export interface SsmConnectionLike {
  readonly state: SsmState;
  readonly lastInputAt?: number | null;
  readonly readyAt?: number | null;
  on(type: 'state', fn: (e: SsmStateChange) => void): () => void;
  on(type: 'diagnostic', fn: (e: { type: string; [k: string]: unknown }) => void): () => void;
  setOutputSink(sink: ((data: Uint8Array, done: () => void) => void) | null): void;
  start(): Promise<void>;
  sendInput(data: string | Uint8Array): boolean;
  resize(cols: number, rows: number): void;
  retryNow(): void;
  close(reason?: 'user' | 'access-revoked'): void;
  dispose(): void;
}

export interface SsmClientModule {
  SsmTerminalConnection: new (opts: SsmConnectionOptions) => SsmConnectionLike;
  getTabClientId?: () => string;
}

const SSM_CLIENT = import.meta.glob('../../../../ssm-client/src/index.ts');

let override: SsmClientModule | null | undefined;
let loading: Promise<SsmClientModule | null> | null = null;

/** 测试与联调用：直接注入协议层（null = 不可用；undefined = 恢复按需加载）。 */
export function setSsmClient(m: SsmClientModule | null | undefined): void {
  override = m;
  loading = null;
}

function isModule(m: unknown): m is SsmClientModule {
  return !!m && typeof (m as SsmClientModule).SsmTerminalConnection === 'function';
}

export function loadSsmClient(): Promise<SsmClientModule | null> {
  if (override !== undefined) return Promise.resolve(override);
  if (!loading) {
    const load = Object.values(SSM_CLIENT)[0];
    loading = load
      ? load()
          .then((m) => (isModule(m) ? m : null))
          .catch(() => null)
      : Promise.resolve(null);
  }
  return loading;
}

/** 本标签页固定的 clientId（03 §3.5.1：UUID 存 sessionStorage；ssm-client 的 getTabClientId 不可用时自己生成）。 */
export function tabClientId(mod: SsmClientModule | null): string {
  if (mod?.getTabClientId) return mod.getTabClientId();
  const key = 'atl.terminal.clientId';
  try {
    const v = globalThis.sessionStorage?.getItem(key);
    if (v) return v;
    const id = globalThis.crypto?.randomUUID?.() ?? `${Date.now().toString(16)}-${Math.random().toString(16).slice(2)}`;
    globalThis.sessionStorage?.setItem(key, id);
    return id;
  } catch {
    return globalThis.crypto?.randomUUID?.() ?? String(Date.now());
  }
}
