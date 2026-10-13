/** Dev S3: one directory per bucket under `<dataDir>/buckets/`. Presigned URLs are `file://` URLs. */
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { PortError, type ObjectStorePort } from '@atl/shared';

export class FsObjectStore implements ObjectStorePort {
  constructor(private readonly root: string) {}

  private file(bucket: string, key: string): string {
    if (!/^[a-z0-9][a-z0-9.-]{1,62}$/.test(bucket)) throw new PortError('InvalidInput', `invalid bucket name: ${bucket}`);
    const base = path.join(this.root, bucket);
    const f = path.resolve(base, key);
    if (!f.startsWith(path.resolve(base) + path.sep)) throw new PortError('InvalidInput', `key escapes the bucket: ${key}`);
    return f;
  }

  async put(bucket: string, key: string, body: Uint8Array | string): Promise<void> {
    const f = this.file(bucket, key);
    fs.mkdirSync(path.dirname(f), { recursive: true });
    fs.writeFileSync(f, body);
  }

  async get(bucket: string, key: string): Promise<Uint8Array | null> {
    const f = this.file(bucket, key);
    return fs.existsSync(f) ? new Uint8Array(fs.readFileSync(f)) : null;
  }

  async delete(bucket: string, key: string): Promise<void> {
    fs.rmSync(this.file(bucket, key), { force: true });
  }

  async list(bucket: string, prefix: string): Promise<string[]> {
    const base = path.join(this.root, bucket);
    if (!fs.existsSync(base)) return [];
    const out: string[] = [];
    const walk = (dir: string) => {
      for (const d of fs.readdirSync(dir, { withFileTypes: true })) {
        const p = path.join(dir, d.name);
        if (d.isDirectory()) walk(p);
        else {
          const key = path.relative(base, p).split(path.sep).join('/');
          if (key.startsWith(prefix)) out.push(key);
        }
      }
    };
    walk(base);
    return out.sort();
  }

  async presign(bucket: string, key: string): Promise<string> {
    return pathToFileURL(this.file(bucket, key)).href;
  }
}
