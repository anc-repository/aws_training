/**
 * S3 buckets of the platform (atl-data, atl-web, atl-artifacts, the lab state bucket). Production: `@aws-sdk/client-s3`.
 * Dev: one directory per bucket.
 */
export interface ObjectStorePort {
  put(bucket: string, key: string, body: Uint8Array | string, opts?: { contentType?: string }): Promise<void>;
  /** `null` when the object does not exist. */
  get(bucket: string, key: string): Promise<Uint8Array | null>;
  delete(bucket: string, key: string): Promise<void>;
  list(bucket: string, prefix: string): Promise<string[]>;
  /** Pre-signed GET / PUT URL (dev: a `file://` URL). */
  presign(bucket: string, key: string, opts: { method: 'GET' | 'PUT'; expiresInSeconds: number }): Promise<string>;
}
