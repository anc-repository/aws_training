// 内存版 S3：用 aws-sdk-client-mock 的 callsFake 模拟本项目用到的 S3 操作（端口契约测试用，不访问网络）。
import { createHash, randomUUID } from 'node:crypto';
import { Readable } from 'node:stream';
import {
  AbortMultipartUploadCommand, CompleteMultipartUploadCommand, CopyObjectCommand, CreateMultipartUploadCommand,
  DeleteObjectsCommand, GetBucketEncryptionCommand, GetObjectCommand, HeadBucketCommand, HeadObjectCommand,
  ListObjectsV2Command, ListPartsCommand, PutObjectCommand, S3Client,
} from '@aws-sdk/client-s3';
import { mockClient, type AwsStub } from 'aws-sdk-client-mock';
import { awsError } from './helpers.js';

interface StoredS3Object { body: Buffer; contentType?: string; metadata: Record<string, string>; lastModified: Date; etag: string; cacheControl?: string }

async function bodyToBuffer(body: unknown): Promise<Buffer> {
  if (Buffer.isBuffer(body)) return body;
  if (body instanceof Uint8Array) return Buffer.from(body);
  if (typeof body === 'string') return Buffer.from(body);
  if (body && typeof (body as AsyncIterable<unknown>)[Symbol.asyncIterator] === 'function') {
    const chunks: Buffer[] = [];
    for await (const c of body as AsyncIterable<Buffer | string>) chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(c));
    return Buffer.concat(chunks);
  }
  return Buffer.alloc(0);
}

export class FakeS3 {
  readonly buckets = new Map<string, Map<string, StoredS3Object>>();
  readonly uploads = new Map<string, { bucket: string; key: string; parts: Map<number, Buffer> }>();
  readonly mock: AwsStub<object, object, object>;
  encryption: Record<string, string> = {};

  constructor(bucketNames: string[]) {
    for (const b of bucketNames) this.buckets.set(b, new Map());
    this.mock = mockClient(S3Client) as unknown as AwsStub<object, object, object>;
    this.install();
  }

  private bucket(name: string | undefined): Map<string, StoredS3Object> {
    const b = name ? this.buckets.get(name) : undefined;
    if (!b) throw awsError('NoSuchBucket', 404);
    return b;
  }

  private install(): void {
    const m = this.mock as unknown as AwsStub<object, object, object> & { on: (cmd: unknown) => { callsFake: (fn: (input: never) => unknown) => void } };
    m.on(HeadBucketCommand).callsFake((input: { Bucket: string }) => {
      this.bucket(input.Bucket);
      return {};
    });
    m.on(PutObjectCommand).callsFake(async (input: { Bucket: string; Key: string; Body: unknown; ContentType?: string; Metadata?: Record<string, string>; CacheControl?: string }) => {
      const body = await bodyToBuffer(input.Body);
      const etag = `"${createHash('md5').update(body).digest('hex')}"`;
      this.bucket(input.Bucket).set(input.Key, {
        body, metadata: { ...(input.Metadata ?? {}) }, lastModified: new Date(), etag,
        ...(input.ContentType ? { contentType: input.ContentType } : {}), ...(input.CacheControl ? { cacheControl: input.CacheControl } : {}),
      });
      return { ETag: etag };
    });
    m.on(HeadObjectCommand).callsFake((input: { Bucket: string; Key: string }) => {
      const o = this.bucket(input.Bucket).get(input.Key);
      if (!o) throw awsError('NotFound', 404);
      return { ContentLength: o.body.length, ContentType: o.contentType, ETag: o.etag, LastModified: o.lastModified, Metadata: o.metadata };
    });
    m.on(GetObjectCommand).callsFake((input: { Bucket: string; Key: string }) => {
      const o = this.bucket(input.Bucket).get(input.Key);
      if (!o) throw awsError('NoSuchKey', 404);
      return { Body: Readable.from([o.body]), ContentLength: o.body.length, ContentType: o.contentType, ETag: o.etag, LastModified: o.lastModified, Metadata: o.metadata };
    });
    m.on(DeleteObjectsCommand).callsFake((input: { Bucket: string; Delete: { Objects: Array<{ Key: string }> } }) => {
      const b = this.bucket(input.Bucket);
      for (const o of input.Delete.Objects) b.delete(o.Key);
      return { Deleted: input.Delete.Objects.map((o) => ({ Key: o.Key })) };
    });
    m.on(ListObjectsV2Command).callsFake((input: { Bucket: string; Prefix?: string; MaxKeys?: number; ContinuationToken?: string }) => {
      const keys = [...this.bucket(input.Bucket).keys()].filter((k) => k.startsWith(input.Prefix ?? '')).sort();
      const start = input.ContinuationToken ? keys.findIndex((k) => k > input.ContinuationToken!) : 0;
      const from = start < 0 ? keys.length : start;
      const max = input.MaxKeys ?? 1000;
      const page = keys.slice(from, from + max);
      const truncated = from + max < keys.length;
      const b = this.bucket(input.Bucket);
      return {
        Contents: page.map((k) => ({ Key: k, Size: b.get(k)!.body.length, ETag: b.get(k)!.etag, LastModified: b.get(k)!.lastModified })),
        KeyCount: page.length, IsTruncated: truncated, ...(truncated ? { NextContinuationToken: page[page.length - 1] } : {}),
      };
    });
    m.on(CopyObjectCommand).callsFake((input: { Bucket: string; Key: string; CopySource: string }) => {
      const src = decodeURIComponent(input.CopySource);
      const slash = src.indexOf('/');
      const o = this.bucket(src.slice(0, slash)).get(src.slice(slash + 1));
      if (!o) throw awsError('NoSuchKey', 404);
      this.bucket(input.Bucket).set(input.Key, { ...o, lastModified: new Date() });
      return { CopyObjectResult: { ETag: o.etag } };
    });
    m.on(GetBucketEncryptionCommand).callsFake((input: { Bucket: string }) => {
      this.bucket(input.Bucket);
      return { ServerSideEncryptionConfiguration: { Rules: [{ ApplyServerSideEncryptionByDefault: { SSEAlgorithm: this.encryption[input.Bucket] ?? 'AES256' } }] } };
    });
    m.on(CreateMultipartUploadCommand).callsFake((input: { Bucket: string; Key: string }) => {
      this.bucket(input.Bucket);
      const id = randomUUID();
      this.uploads.set(id, { bucket: input.Bucket, key: input.Key, parts: new Map() });
      return { UploadId: id };
    });
    m.on(ListPartsCommand).callsFake((input: { UploadId: string }) => {
      const u = this.uploads.get(input.UploadId);
      if (!u) throw awsError('NoSuchUpload', 404);
      return { Parts: [...u.parts.entries()].map(([n, b]) => ({ PartNumber: n, ETag: `"p${n}"`, Size: b.length })), IsTruncated: false };
    });
    m.on(CompleteMultipartUploadCommand).callsFake((input: { Bucket: string; Key: string; UploadId: string }) => {
      const u = this.uploads.get(input.UploadId);
      if (!u) throw awsError('NoSuchUpload', 404);
      const body = Buffer.concat([...u.parts.entries()].sort((a, b) => a[0] - b[0]).map(([, b]) => b));
      this.bucket(input.Bucket).set(input.Key, { body, metadata: {}, lastModified: new Date(), etag: '"mpu"' });
      this.uploads.delete(input.UploadId);
      return {};
    });
    m.on(AbortMultipartUploadCommand).callsFake((input: { UploadId: string }) => {
      if (!this.uploads.delete(input.UploadId)) throw awsError('NoSuchUpload', 404);
      return {};
    });
  }

  /** 模拟浏览器 PUT 分片（UploadPart 的预签名 URL 由真实签名器生成，这里直接写入） */
  putPart(uploadId: string, partNumber: number, body: Buffer): void {
    this.uploads.get(uploadId)!.parts.set(partNumber, body);
  }

  restore(): void {
    this.mock.restore();
  }
}
