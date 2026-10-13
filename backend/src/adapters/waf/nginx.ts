// backend/src/adapters/waf/nginx.ts —— BlocklistPort 的 `nginx` 驱动（本地实现，01#waf 第 1 节）
//
// 唯一一份封禁列表 CLOUDALBUM_DATA_DIR/security/denylist.conf，由 ec2 基础的 `geo $ca_denied { include …; }` 读取。
// 每行：`198.51.100.0/24 1;  # src=admin ts=<ISO> note=<说明>`（fail2ban 写入的行 src=fail2ban，可带 until=<ISO>）。
// 写入：进程内互斥 + 写临时文件 + rename（fail2ban 的动作另取 security/denylist.lock 的 flock；本驱动只在 api 进程写）；
// systemd path 单元 cloudalbum-denylist.path 监听该文件，校验格式后 `nginx -t && systemctl reload nginx`。
// 探针：文件可读写、最近一次校验 / reload 的结果（security/nginx-state.json，由 nginx-reload.sh 写入）。
import { isIP } from 'node:net';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { AdapterDeps } from '../types.js';
import type { AdapterMeta, ProbeResult } from '../../ports/common.js';
import type { BlocklistPort } from '../../ports/blocklist.js';
import { HttpError } from '../../errors.js';

export interface DenylistEntry { cidr: string; reason: string; addedAt: string; source: 'app' | 'fail2ban' | 'manual'; until?: string }

/** IPv4 / IPv6 地址或 CIDR */
export function isCidr(v: string): boolean {
  const [ip, bits, extra] = v.split('/');
  if (extra !== undefined || !ip) return false;
  const fam = isIP(ip);
  if (!fam) return false;
  if (bits === undefined) return true;
  if (!/^\d{1,3}$/.test(bits)) return false;
  const n = Number(bits);
  return fam === 4 ? n >= 0 && n <= 32 : n >= 0 && n <= 128;
}

const LINE_RE = /^\s*([0-9a-fA-F.:/]+)\s+1;\s*(?:#\s*(.*))?$/;

export function parseDenylist(text: string): DenylistEntry[] {
  const out: DenylistEntry[] = [];
  for (const line of text.split(/\r?\n/)) {
    const m = LINE_RE.exec(line);
    if (!m || !isCidr(m[1]!)) continue;
    const meta: Record<string, string> = {};
    const comment = m[2] ?? '';
    for (const part of comment.matchAll(/(\w+)=("[^"]*"|\S+)/g)) meta[part[1]!] = part[2]!.replace(/^"|"$/g, '');
    const src = meta.src === 'fail2ban' ? 'fail2ban' : meta.src === 'admin' || meta.src === 'app' ? 'app' : 'manual';
    out.push({
      cidr: m[1]!, reason: meta.note ?? '', addedAt: meta.ts ?? '', source: src,
      ...(meta.until ? { until: meta.until } : {}),
    });
  }
  return out;
}

function sanitizeNote(s: string): string {
  // 注释里不能出现换行与分号（防止注入 Nginx 指令）；引号包裹以便含空格
  return s.replace(/[\r\n;"#{}]/g, ' ').trim().slice(0, 200);
}

export function formatEntry(e: DenylistEntry): string {
  const src = e.source === 'app' ? 'admin' : e.source;
  return `${e.cidr} 1;  # src=${src} ts=${e.addedAt}${e.until ? ` until=${e.until}` : ''} note="${sanitizeNote(e.reason)}"`;
}

export class NginxBlocklist implements BlocklistPort {
  readonly meta: AdapterMeta = { module: 'waf', driver: 'nginx', awsService: null, authoritative: false };
  private chain: Promise<unknown> = Promise.resolve();

  constructor(protected readonly deps: AdapterDeps) {}

  get file(): string {
    return path.join(this.deps.cfg.core.CLOUDALBUM_DATA_DIR, 'security', 'denylist.conf');
  }

  private async read(): Promise<DenylistEntry[]> {
    try {
      return parseDenylist(await readFile(this.file, 'utf8'));
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw e;
    }
  }

  private async write(entries: DenylistEntry[]): Promise<void> {
    await mkdir(path.dirname(this.file), { recursive: true });
    const tmp = `${this.file}.${process.pid}.tmp`;
    const body = ['# CloudAlbum denylist（geo $ca_denied）；每行 <IP 或 CIDR> 1;  # 注释。由 BlocklistPort(nginx) 与 fail2ban 写入', ...entries.map(formatEntry), ''].join('\n');
    await writeFile(tmp, body, { encoding: 'utf8', mode: 0o640 });
    await rename(tmp, this.file);
  }

  /** 串行化本进程内的读改写 */
  private exclusive<T>(fn: () => Promise<T>): Promise<T> {
    const next = this.chain.then(fn, fn);
    this.chain = next.catch(() => undefined);
    return next;
  }

  async probe(_opts?: { deep?: boolean }): Promise<ProbeResult> {
    let entries: DenylistEntry[];
    try {
      entries = await this.read();
    } catch (e) {
      return { status: 'error', detail: `denylist.conf 不可读：${(e as Error).message}`, confidence: 'confirmed' };
    }
    let status: ProbeResult['status'] = 'ok';
    const notes: string[] = [];
    try {
      const st = JSON.parse(await readFile(path.join(this.deps.cfg.core.CLOUDALBUM_DATA_DIR, 'security', 'nginx-state.json'), 'utf8')) as
        { lastReloadOk?: boolean; lastReloadAt?: string; denylistRejectedLines?: number };
      if (st.lastReloadOk === false) {
        status = 'degraded';
        notes.push(`最近一次 Nginx reload 失败（${st.lastReloadAt ?? '?'}），仍在用上一个可用版本`);
      }
      if (st.denylistRejectedLines) {
        status = 'degraded';
        notes.push(`denylist 校验拒绝了 ${st.denylistRejectedLines} 行`);
      }
    } catch {
      /* 开发机上没有 nginx-state.json */
    }
    const bySrc = entries.reduce<Record<string, number>>((acc, e) => ({ ...acc, [e.source]: (acc[e.source] ?? 0) + 1 }), {});
    return {
      status,
      detail: `Nginx 限速 + 特征拦截 + 封禁列表（${entries.length} 条${Object.keys(bySrc).length ? `：${Object.entries(bySrc).map(([k, v]) => `${k} ${v}`).join('、')}` : ''}）${notes.length ? ` · ${notes.join('；')}` : ''}`,
      confidence: 'observed',
      data: { file: this.file, entries: entries.length, bySource: bySrc },
    };
  }

  async add(cidr: string, reason: string, ttlSec?: number): Promise<void> {
    const v = cidr.trim();
    if (!isCidr(v)) throw new HttpError(400, 'INVALID_CIDR', `不是合法的 IP 或 CIDR：${cidr}`);
    await this.exclusive(async () => {
      const entries = (await this.read()).filter((e) => e.cidr !== v);
      const now = new Date();
      entries.push({
        cidr: v, reason, addedAt: now.toISOString(), source: 'app',
        ...(ttlSec ? { until: new Date(now.getTime() + ttlSec * 1000).toISOString() } : {}),
      });
      await this.write(entries);
    });
  }

  async remove(cidr: string): Promise<void> {
    const v = cidr.trim();
    await this.exclusive(async () => {
      const entries = await this.read();
      const kept = entries.filter((e) => e.cidr !== v);
      if (kept.length !== entries.length) await this.write(kept);
    });
  }

  async list(): Promise<Array<{ cidr: string; reason: string; addedAt: string; source: 'app' | 'fail2ban' | 'manual' }>> {
    const now = Date.now();
    return (await this.read())
      .filter((e) => !e.until || Date.parse(e.until) > now)
      .map(({ cidr, reason, addedAt, source }) => ({ cidr, reason, addedAt, source }));
  }
}
