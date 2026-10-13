/**
 * Minimal ZIP reader / writer (stored and deflated entries, no ZIP64, no encryption) on top of node:zlib.
 * The writer is deterministic (fixed timestamps, sorted input order preserved) so release archives have stable SHA-256
 * digests (build/package.ts); the reader is used by WebDeploy in Lambda (no third-party packages, 01 §4.5).
 */
import zlib from 'node:zlib';

export interface ZipEntry {
  name: string;
  data: Buffer;
  /** Unix mode (e.g. 0o755 for scripts); stored in the external attributes. */
  mode?: number;
}

const DOS_TIME = 0; // 00:00:00
const DOS_DATE = (1 << 5) | 1; // 1980-01-01

export function crc32(buf: Buffer): number {
  return zlib.crc32(buf) >>> 0;
}

export function writeZip(entries: ZipEntry[], opts: { deflate?: boolean } = {}): Buffer {
  const deflate = opts.deflate ?? true;
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  const seen = new Set<string>();
  for (const e of entries) {
    const name = e.name.replace(/\\/g, '/');
    if (!name || name.startsWith('/') || name.split('/').includes('..')) throw new Error(`invalid zip entry name: ${e.name}`);
    if (seen.has(name)) throw new Error(`duplicate zip entry: ${name}`);
    seen.add(name);
    const nameBuf = Buffer.from(name, 'utf8');
    const compressed = deflate ? zlib.deflateRawSync(e.data, { level: 9 }) : e.data;
    const useDeflate = deflate && compressed.length < e.data.length;
    const body = useDeflate ? compressed : e.data;
    const method = useDeflate ? 8 : 0;
    const crc = crc32(e.data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x0800, 6); // UTF-8 names
    local.writeUInt16LE(method, 8);
    local.writeUInt16LE(DOS_TIME, 10);
    local.writeUInt16LE(DOS_DATE, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(body.length, 18);
    local.writeUInt32LE(e.data.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    local.writeUInt16LE(0, 28);
    locals.push(local, nameBuf, body);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE((3 << 8) | 20, 4); // made by Unix
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0x0800, 8);
    central.writeUInt16LE(method, 10);
    central.writeUInt16LE(DOS_TIME, 12);
    central.writeUInt16LE(DOS_DATE, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(body.length, 20);
    central.writeUInt32LE(e.data.length, 24);
    central.writeUInt16LE(nameBuf.length, 28);
    central.writeUInt16LE(0, 30);
    central.writeUInt16LE(0, 32);
    central.writeUInt16LE(0, 34);
    central.writeUInt16LE(0, 36);
    central.writeUInt32LE((((e.mode ?? 0o644) | 0o100000) << 16) >>> 0, 38);
    central.writeUInt32LE(offset, 42);
    centrals.push(central, nameBuf);
    offset += local.length + nameBuf.length + body.length;
  }
  const centralSize = centrals.reduce((n, b) => n + b.length, 0);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralSize, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, ...centrals, end]);
}

export function readZip(zip: Buffer): ZipEntry[] {
  let eocd = -1;
  for (let i = zip.length - 22; i >= Math.max(0, zip.length - 65557); i--) {
    if (zip.readUInt32LE(i) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new Error('not a zip archive (no end of central directory)');
  const count = zip.readUInt16LE(eocd + 10);
  let p = zip.readUInt32LE(eocd + 16);
  const out: ZipEntry[] = [];
  for (let n = 0; n < count; n++) {
    if (zip.readUInt32LE(p) !== 0x02014b50) throw new Error('corrupt zip central directory');
    const method = zip.readUInt16LE(p + 10);
    const crc = zip.readUInt32LE(p + 16);
    const compSize = zip.readUInt32LE(p + 20);
    const size = zip.readUInt32LE(p + 24);
    const nameLen = zip.readUInt16LE(p + 28);
    const extraLen = zip.readUInt16LE(p + 30);
    const commentLen = zip.readUInt16LE(p + 32);
    const attrs = zip.readUInt32LE(p + 38);
    const localOffset = zip.readUInt32LE(p + 42);
    const name = zip.subarray(p + 46, p + 46 + nameLen).toString('utf8');
    p += 46 + nameLen + extraLen + commentLen;
    if (name.endsWith('/')) continue; // directory
    if (name.startsWith('/') || name.split('/').includes('..')) throw new Error(`unsafe zip entry name: ${name}`);
    const lNameLen = zip.readUInt16LE(localOffset + 26);
    const lExtraLen = zip.readUInt16LE(localOffset + 28);
    const start = localOffset + 30 + lNameLen + lExtraLen;
    const raw = zip.subarray(start, start + compSize);
    let data: Buffer;
    if (method === 0) data = Buffer.from(raw);
    else if (method === 8) data = zlib.inflateRawSync(raw);
    else throw new Error(`unsupported zip compression method ${method} for ${name}`);
    if (data.length !== size || crc32(data) !== crc) throw new Error(`zip entry ${name} failed its CRC / size check`);
    const mode = (attrs >>> 16) & 0o777;
    out.push({ name, data, ...(mode ? { mode } : {}) });
  }
  return out;
}
