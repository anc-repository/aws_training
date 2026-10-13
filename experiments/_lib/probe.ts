/**
 * experiments/_lib/probe.ts —— 单次“新建连接”的分阶段计时（替代 `curl -w '%{time_connect} %{time_appconnect} %{time_starttransfer}'`）。
 *
 * 每次请求不复用连接（agent: false），记录 DNS、TCP 连接、TLS 握手、首字节、总耗时（相对请求开始，毫秒），以及
 * X-Cache、X-Amz-Cf-Pop、Age、Content-Encoding、Server-Timing（含 CloudFront 的 cdn-* 项）。Node 的 http 模块只说 HTTP/1.1，
 * 协议对比（h2 / h3）请在浏览器 /lab 上看（README 有说明）。
 */
import http from 'node:http';
import https from 'node:https';
import { parseServerTiming, type ServerTimingMetric } from '@cloudalbum/contracts';
import type { Recorder } from './stats.js';
import { routeTemplate } from './stats.js';

export interface ProbeResult {
  url: string;
  status: number;
  httpVersion?: string;
  dnsMs?: number;
  connectMs?: number;
  tlsMs?: number;
  ttfbMs?: number;
  totalMs: number;
  bytes: number;
  headers: Record<string, string>;
  serverTiming: ServerTimingMetric[];
  error?: string;
}

export function timedGet(url: string, headers: Record<string, string> = {}, timeoutMs = 30_000): Promise<ProbeResult> {
  return new Promise((resolve) => {
    const u = new URL(url);
    const lib = u.protocol === 'https:' ? https : http;
    const start = performance.now();
    const t = () => Math.round((performance.now() - start) * 10) / 10;
    const out: ProbeResult = { url, status: 0, totalMs: 0, bytes: 0, headers: {}, serverTiming: [] };
    let done = false;
    const finish = (error?: string) => {
      if (done) return;
      done = true;
      out.totalMs = t();
      if (error) out.error = error;
      resolve(out);
    };
    const req = lib.request(u, {
      method: 'GET', agent: false, headers: { 'user-agent': 'cloudalbum-experiments/0.1', connection: 'close', ...headers },
      timeout: timeoutMs,
      // 自签名证书的直连入口（L0 的 443）也要能测；只用于计时，不传输任何机密
      ...(u.protocol === 'https:' ? { rejectUnauthorized: false } : {}),
    });
    req.on('socket', (s) => {
      s.once('lookup', () => { out.dnsMs = t(); });
      s.once('connect', () => { out.connectMs = t(); });
      s.once('secureConnect', () => { out.tlsMs = t(); });
    });
    req.on('response', (res) => {
      out.ttfbMs = t();
      out.status = res.statusCode ?? 0;
      out.httpVersion = res.httpVersion;
      for (const [k, v] of Object.entries(res.headers)) if (v !== undefined) out.headers[k] = Array.isArray(v) ? v.join(', ') : v;
      out.serverTiming = parseServerTiming(out.headers['server-timing']);
      res.on('data', (c: Buffer) => { out.bytes += c.length; });
      res.on('end', () => finish());
      res.on('error', (e) => finish(e.message));
    });
    req.on('timeout', () => { req.destroy(new Error('timeout')); });
    req.on('error', (e) => finish(e.message));
    req.end();
  });
}

/** 把探测结果写进采集器（目标标签 direct / cdn），让它出现在结果的 client.byTarget 中。 */
export function recordProbe(recorder: Recorder, r: ProbeResult, target: string, route?: string): void {
  const pathHeader = r.headers['x-cloudalbum-path'];
  recorder.record({
    method: 'GET', route: route ?? routeTemplate(new URL(r.url).pathname), status: r.status, ok: r.status >= 200 && r.status < 400,
    totalMs: r.totalMs, ...(r.ttfbMs !== undefined ? { ttfbMs: r.ttfbMs } : {}), bytes: r.bytes, target,
    ...(r.serverTiming.length ? { serverTiming: r.serverTiming } : {}),
    ...(pathHeader ? { pathHeader } : {}),
    ...(r.headers['x-cache'] ? { xCache: r.headers['x-cache'].split(' ')[0]! } : {}),
    ...(r.error ? { error: r.error } : {}),
  });
}

export function cdnPop(r: ProbeResult): string | undefined {
  return r.headers['x-amz-cf-pop'] ?? r.serverTiming.find((m) => m.name === 'cdn-pop')?.desc;
}

