/** HTTP header names used across CloudAlbum (modular-design.md §7, §8.3). */
export const HEADERS = {
  /** 路径头（§7.2）：本次请求走了哪条路径 */
  path: 'X-CloudAlbum-Path',
  /** W3C Server Timing（§7.1） */
  serverTiming: 'Server-Timing',
  /** 请求 ID（ULID 或 Nginx $request_id） */
  requestId: 'X-CloudAlbum-Request-Id',
  /** 被旁路的请求在响应中带这个头（§8.3） */
  bypass: 'X-CloudAlbum-Bypass',
  /** 管理员请求旁路（§8.3） */
  compareBypass: 'X-Compare-Bypass',
  /** 实验归属（§7.3，仅管理员有效） */
  experimentRun: 'X-Experiment-Run',
  experimentLabel: 'X-Experiment-Label',
  /** Nginx 计算的入口链 `$ca_entry`，由 cloudalbum_proxy.conf 传给 Node（`proxy_set_header X-CloudAlbum-Entry $ca_entry;`） */
  entry: 'X-CloudAlbum-Entry',
  /** Nginx 的 $request_id（cloudalbum_proxy.conf: `proxy_set_header X-Request-Id $request_id;`） */
  upstreamRequestId: 'X-Request-Id',
  timingAllowOrigin: 'Timing-Allow-Origin',
} as const;

/** 跨域响应需要暴露的头（social-api 的跨域响应，§7.1）。 */
export const EXPOSED_OBSERVABILITY_HEADERS = [
  HEADERS.serverTiming,
  HEADERS.path,
  HEADERS.requestId,
  HEADERS.bypass,
] as const;
