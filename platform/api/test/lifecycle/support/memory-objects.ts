/** In-memory ObjectStorePort (buckets → key → bytes) for the lifecycle tests. */
import type { ObjectStorePort } from '@atl/shared';

export class MemoryObjectStore implements ObjectStorePort {
  readonly buckets = new Map<string, Map<string, Uint8Array>>();

  private b(bucket: string): Map<string, Uint8Array> {
    let m = this.buckets.get(bucket);
    if (!m) this.buckets.set(bucket, (m = new Map()));
    return m;
  }

  async put(bucket: string, key: string, body: Uint8Array | string): Promise<void> {
    this.b(bucket).set(key, typeof body === 'string' ? new TextEncoder().encode(body) : new Uint8Array(body));
  }

  async get(bucket: string, key: string): Promise<Uint8Array | null> {
    return this.b(bucket).get(key) ?? null;
  }

  async delete(bucket: string, key: string): Promise<void> {
    this.b(bucket).delete(key);
  }

  async list(bucket: string, prefix: string): Promise<string[]> {
    return [...this.b(bucket).keys()].filter((k) => k.startsWith(prefix)).sort();
  }

  async presign(bucket: string, key: string): Promise<string> {
    return `memory://${bucket}/${key}`;
  }

  json(bucket: string, key: string): unknown {
    const v = this.b(bucket).get(key);
    return v ? JSON.parse(new TextDecoder().decode(v)) : null;
  }
}
