/**
 * Deterministic archives for the release (01 §4.5): ustar .tar.gz (fixed mtime / owner, entries in the given order) and
 * ZIP (custom-resources/src/zip.ts). Stable bytes → stable SHA-256 in SHA256SUMS and in the template's embedded manifest.
 */
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';

export interface ArchiveEntry {
  name: string;
  data: Buffer;
  mode?: number;
}

/** 2020-01-01T00:00:00Z — fixed so that rebuilding identical inputs gives identical bytes. */
const MTIME = 1577836800;

function octal(n: number, width: number): string {
  return n.toString(8).padStart(width - 1, '0') + '\0';
}

function header(name: string, size: number, mode: number, type: '0' | '5'): Buffer {
  const h = Buffer.alloc(512, 0);
  let prefix = '';
  let base = name;
  if (Buffer.byteLength(name) > 100) {
    const cut = name.lastIndexOf('/', 155);
    if (cut <= 0 || Buffer.byteLength(name.slice(cut + 1)) > 100) throw new Error(`tar entry name too long: ${name}`);
    prefix = name.slice(0, cut);
    base = name.slice(cut + 1);
  }
  h.write(base, 0, 100, 'utf8');
  h.write(octal(mode & 0o7777, 8), 100, 8, 'ascii');
  h.write(octal(0, 8), 108, 8, 'ascii');
  h.write(octal(0, 8), 116, 8, 'ascii');
  h.write(octal(size, 12), 124, 12, 'ascii');
  h.write(octal(MTIME, 12), 136, 12, 'ascii');
  h.fill(' ', 148, 156);
  h.write(type, 156, 1, 'ascii');
  h.write('ustar\0', 257, 6, 'ascii');
  h.write('00', 263, 2, 'ascii');
  h.write('root', 265, 32, 'ascii');
  h.write('root', 297, 32, 'ascii');
  h.write(prefix, 345, 155, 'utf8');
  let sum = 0;
  for (const b of h) sum += b;
  h.write(sum.toString(8).padStart(6, '0') + '\0 ', 148, 8, 'ascii');
  return h;
}

export function writeTar(entries: ArchiveEntry[]): Buffer {
  const parts: Buffer[] = [];
  const dirs = new Set<string>();
  for (const e of entries) {
    const name = e.name.replace(/\\/g, '/');
    if (!name || name.startsWith('/') || name.split('/').includes('..')) throw new Error(`invalid tar entry name: ${e.name}`);
    const segs = name.split('/');
    for (let i = 1; i < segs.length; i++) {
      const d = segs.slice(0, i).join('/') + '/';
      if (!dirs.has(d)) {
        dirs.add(d);
        parts.push(header(d, 0, 0o755, '5'));
      }
    }
    parts.push(header(name, e.data.length, e.mode ?? 0o644, '0'), e.data);
    const pad = (512 - (e.data.length % 512)) % 512;
    if (pad) parts.push(Buffer.alloc(pad, 0));
  }
  parts.push(Buffer.alloc(1024, 0));
  return Buffer.concat(parts);
}

export function writeTarGz(entries: ArchiveEntry[]): Buffer {
  // gzip header mtime is 0 in zlib's output, so the result is deterministic
  return zlib.gzipSync(writeTar(entries), { level: 9 });
}

/** Reader for tests and for re-packing (regular files only). */
export function readTarGz(buf: Buffer): ArchiveEntry[] {
  const tar = zlib.gunzipSync(buf);
  const out: ArchiveEntry[] = [];
  let p = 0;
  while (p + 512 <= tar.length) {
    const h = tar.subarray(p, p + 512);
    if (h.every((b) => b === 0)) break;
    const base = h.subarray(0, 100).toString('utf8').replace(/\0.*$/s, '');
    const prefix = h.subarray(345, 500).toString('utf8').replace(/\0.*$/s, '');
    const size = parseInt(h.subarray(124, 136).toString('ascii').replace(/\0.*$/s, '').trim() || '0', 8);
    const mode = parseInt(h.subarray(100, 108).toString('ascii').replace(/\0.*$/s, '').trim() || '0', 8);
    const type = String.fromCharCode(h[156]!);
    const name = prefix ? `${prefix}/${base}` : base;
    p += 512;
    if (type === '0' || type === '\0') out.push({ name, data: Buffer.from(tar.subarray(p, p + size)), mode });
    p += Math.ceil(size / 512) * 512;
  }
  return out;
}

/** Collect files under `dir` (relative names with `/`, sorted), skipping names matched by `skip`. */
export function collectDir(dir: string, prefix = '', skip: (rel: string) => boolean = () => false): ArchiveEntry[] {
  const out: ArchiveEntry[] = [];
  const walk = (abs: string, rel: string) => {
    for (const name of fs.readdirSync(abs).sort()) {
      const a = path.join(abs, name);
      const r = rel ? `${rel}/${name}` : name;
      if (skip(r)) continue;
      const st = fs.statSync(a);
      if (st.isDirectory()) walk(a, r);
      else if (st.isFile()) out.push({ name: prefix + r, data: fs.readFileSync(a), mode: st.mode & 0o111 ? 0o755 : 0o644 });
    }
  };
  if (fs.existsSync(dir)) walk(dir, '');
  return out;
}
