import { createHash } from 'node:crypto';
import { open } from 'node:fs/promises';
import {
  DeleteObjectCommand, GetObjectCommand, HeadObjectCommand, PutObjectCommand,
  type HeadObjectCommandOutput, type S3Client,
} from '@aws-sdk/client-s3';
import { createRetainedObjectClient } from '../s3.js';
import { PREPARED_OUTPUT_MAX_BYTES } from './video-preparation-outputs.js';

export interface RetainedVideoObject {
  appId: string; organizationId: string; ownerId: string; attemptId: string; objectId: string; index: number;
  bucket: string; key: string; sizeBytes: number; sha256: string; contentType: 'video/mp4' | 'video/webm';
}
export class VideoOutputStorageError extends Error {
  constructor(public readonly code: string, public readonly permanent: boolean, public readonly statusCode = 503) {
    super(code); this.name = 'VideoOutputStorageError';
  }
}
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
let defaultClient: S3Client | undefined;
const fail = (code: string, permanent = true, statusCode = 503) => new VideoOutputStorageError(code, permanent, statusCode);
const status = (e: unknown) => (e as { $metadata?: { httpStatusCode?: number } })?.$metadata?.httpStatusCode;
function safeError(e: unknown): VideoOutputStorageError {
  if (e instanceof VideoOutputStorageError) return e;
  if (status(e) === 404) return fail('OUTPUT_NOT_FOUND', true, 410);
  if (status(e) === 416) return fail('OUTPUT_INVALID_RANGE', true, 416);
  return fail('OUTPUT_STORAGE_TRANSIENT', false);
}
function metadata(o: RetainedVideoObject): Record<string, string> {
  return { scope: 'prepared-video-v1', app: o.appId, organization: o.organizationId, owner: o.ownerId,
    attempt: o.attemptId, object: o.objectId, index: String(o.index), sha256: o.sha256 };
}
function validate(o: RetainedVideoObject, maxBytes: number): void {
  if (!/^[a-zA-Z0-9_-]+$/.test(o.appId) || ![o.organizationId, o.ownerId, o.attemptId, o.objectId].every(v => uuid.test(v))
    || !Number.isInteger(o.index) || o.index < 0 || o.index > 7
    || !/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,254}$/.test(o.bucket)
    || o.key !== `${o.appId}/${o.ownerId}/${o.objectId}_generated-video-${o.index}`) throw fail('OUTPUT_INVALID_IDENTITY');
  if (!Number.isSafeInteger(o.sizeBytes) || o.sizeBytes <= 0 || o.sizeBytes > maxBytes
    || !/^[0-9a-f]{64}$/.test(o.sha256) || !['video/mp4', 'video/webm'].includes(o.contentType)) throw fail('OUTPUT_INVALID_MEDIA');
}
function checkHead(o: RetainedVideoObject, head: HeadObjectCommandOutput): void {
  if (head.ContentLength !== o.sizeBytes || head.ContentType !== o.contentType || !head.ETag
    || Object.entries(metadata(o)).some(([key, value]) => head.Metadata?.[key] !== value)) throw fail('OUTPUT_FOREIGN_OBJECT');
}
function byteRange(value: string | undefined, size: number): { start: number; end: number } | null {
  if (value === undefined) return null;
  const match = /^bytes=(\d*)-(\d*)$/.exec(value);
  if (!match || (!match[1] && !match[2])) throw fail('OUTPUT_INVALID_RANGE', true, 416);
  let start: number, end: number;
  if (!match[1]) {
    const suffix = Number(match[2]);
    if (!Number.isSafeInteger(suffix) || suffix <= 0) throw fail('OUTPUT_INVALID_RANGE', true, 416);
    start = Math.max(0, size - suffix); end = size - 1;
  } else {
    start = Number(match[1]); end = match[2] ? Number(match[2]) : size - 1;
    if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start >= size || end < start) throw fail('OUTPUT_INVALID_RANGE', true, 416);
    end = Math.min(size - 1, end);
  }
  return { start, end };
}

/** Streams only immutable, measured, owned objects; never returns bucket/provider URLs. */
export function createRetainedVideoStore(options: { client?: S3Client; maxBytes?: number; timeoutMs?: number; signal?: AbortSignal } = {}) {
  const client = options.client ?? (defaultClient ??= createRetainedObjectClient());
  const maxBytes = options.maxBytes ?? PREPARED_OUTPUT_MAX_BYTES, timeoutMs = options.timeoutMs ?? 20_000;
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1 || maxBytes > PREPARED_OUTPUT_MAX_BYTES
    || !Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 120_000) throw fail('OUTPUT_INVALID_LIMIT');
  const deadline = () => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs); timer.unref();
    return { signal: options.signal ? AbortSignal.any([controller.signal, options.signal]) : controller.signal,
      close: () => clearTimeout(timer), abort: () => controller.abort() };
  };
  async function inspect(o: RetainedVideoObject) {
    validate(o, maxBytes);
    const scope = deadline();
    try {
      const head = await client.send(new HeadObjectCommand({ Bucket: o.bucket, Key: o.key }), { abortSignal: scope.signal });
      checkHead(o, head);
      return { sizeBytes: head.ContentLength!, contentType: o.contentType, etag: head.ETag!, versionId: head.VersionId };
    } catch (error) {
      if (status(error) === 404 && (error as { name?: string }).name !== 'NoSuchBucket') return null;
      throw safeError(error);
    } finally { scope.close(); }
  }
  return {
    inspect,
    async putFile(o: RetainedVideoObject, path: string): Promise<{ adopted: boolean }> {
      validate(o, maxBytes);
      const scope = deadline();
      let file: Awaited<ReturnType<typeof open>> | undefined;
      let body: ReturnType<Awaited<ReturnType<typeof open>>['createReadStream']> | undefined;
      try {
        file = await open(path, 'r');
        const info = await file.stat();
        if (!info.isFile() || info.size !== o.sizeBytes) throw fail('OUTPUT_INVALID_MEDIA');
        const hash = createHash('sha256'); let read = 0;
        body = file.createReadStream({ autoClose: false, start: 0 });
        for await (const chunk of body) {
          if (scope.signal.aborted) throw fail('OUTPUT_STORAGE_TRANSIENT', false);
          read += chunk.length;
          if (read > o.sizeBytes) throw fail('OUTPUT_INVALID_MEDIA');
          hash.update(chunk);
        }
        if (read !== o.sizeBytes || hash.digest('hex') !== o.sha256) throw fail('OUTPUT_INVALID_MEDIA');
        body = file.createReadStream({ autoClose: false, start: 0, end: o.sizeBytes - 1 });
        try {
          await client.send(new PutObjectCommand({ Bucket: o.bucket, Key: o.key, Body: body,
            ContentType: o.contentType, ContentLength: o.sizeBytes, Metadata: metadata(o), IfNoneMatch: '*' }), { abortSignal: scope.signal });
        } catch (error) {
          if (status(error) !== 412) throw error;
          if (await inspect(o)) return { adopted: true };
          throw fail('OUTPUT_STORAGE_TRANSIENT', false);
        }
        if (!await inspect(o)) throw fail('OUTPUT_STORAGE_TRANSIENT', false);
        return { adopted: false };
      } catch (error) { throw safeError(error); }
      finally { scope.close(); body?.destroy(); await file?.close(); }
    },
    async read(o: RetainedVideoObject, options: { range?: string } = {}) {
      validate(o, maxBytes);
      const range = byteRange(options.range, o.sizeBytes);
      const head = await inspect(o); if (!head) throw fail('OUTPUT_NOT_FOUND', true, 410);
      const scope = deadline();
      try {
        const response = await client.send(new GetObjectCommand({ Bucket: o.bucket, Key: o.key, IfMatch: head.etag,
          ...(head.versionId ? { VersionId: head.versionId } : {}),
          ...(range ? { Range: `bytes=${range.start}-${range.end}` } : {}) }), { abortSignal: scope.signal });
        const length = range ? range.end - range.start + 1 : o.sizeBytes;
        const contentRange = range ? `bytes ${range.start}-${range.end}/${o.sizeBytes}` : undefined;
        if (!response.Body) throw fail('OUTPUT_STORAGE_TRANSIENT', false);
        const reader = response.Body.transformToWebStream().getReader();
        if (response.ContentLength !== length || response.ContentType !== o.contentType || response.ContentRange !== contentRange) {
          await reader.cancel(); throw fail('OUTPUT_INVALID_MEDIA');
        }
        let received = 0, closed = false;
        const close = () => { if (!closed) { closed = true; scope.close(); reader.releaseLock(); } };
        const stream = new ReadableStream<Uint8Array>({
          async pull(controller) {
            try {
              const result = await reader.read();
              if (result.done) {
                if (received !== length) throw fail('OUTPUT_INVALID_MEDIA');
                close(); controller.close(); return;
              }
              received += result.value.length;
              if (received > length) throw fail('OUTPUT_INVALID_MEDIA');
              controller.enqueue(result.value);
            } catch (error) {
              scope.abort(); await reader.cancel().catch(() => {}); close(); controller.error(safeError(error));
            }
          },
          async cancel() { scope.abort(); try { await reader.cancel(); } finally { close(); } },
        });
        return { stream, contentType: o.contentType, contentLength: length, contentRange, statusCode: range ? 206 as const : 200 as const };
      } catch (error) { scope.abort(); scope.close(); throw safeError(error); }
    },
    async remove(o: RetainedVideoObject): Promise<boolean> {
      const head = await inspect(o); if (!head) return false;
      const scope = deadline();
      try {
        // Keys are allocated once, and every writer uses create-only PUT. The caller
        // must also exclude shared DB identities before deletion; R2 has no assumed CAS delete.
        await client.send(new DeleteObjectCommand({ Bucket: o.bucket, Key: o.key,
          ...(head.versionId ? { VersionId: head.versionId } : {}) }), { abortSignal: scope.signal });
        return true;
      } catch (error) { throw safeError(error); }
      finally { scope.close(); }
    },
  };
}
