// services/control-api/src/services/r2.ts
import { S3Client, PutObjectCommand, GetObjectCommand, DeleteObjectCommand, HeadObjectCommand, CopyObjectCommand } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { config } from '../config.js';

// Constants for expiration times
const UPLOAD_URL_EXPIRATION_SECONDS = 900; // 15 minutes
const MAX_DEPLOYMENT_SIZE_BYTES = 104857600; // 100 MB

const r2Credentials = config.s3.accessKeyId && config.s3.secretAccessKey ? {
  accessKeyId: config.s3.accessKeyId,
  secretAccessKey: config.s3.secretAccessKey,
} : undefined;

// R2 client configuration (S3-compatible) - reuses S3 config and bucket.
// R2 does not fully support S3 flexible checksums; WHEN_REQUIRED prevents the
// SDK from auto-injecting CRC32 headers/query params that R2 may mishandle.
const r2Client = new S3Client({
  region: config.s3.region,
  endpoint: config.s3.endpoint,
  forcePathStyle: config.s3.forcePathStyle,
  requestChecksumCalculation: "WHEN_REQUIRED",
  responseChecksumValidation: "WHEN_REQUIRED",
  credentials: r2Credentials,
});

// Separate client for presigned URLs with public endpoint.
// requestChecksumCalculation is critical here: without it the SDK bakes
// CRC32-of-empty into the signed URL, causing uploads to ghost-write on R2.
const r2ClientForPresigning = config.s3.publicEndpoint ? new S3Client({
  region: config.s3.region,
  endpoint: config.s3.publicEndpoint,
  forcePathStyle: config.s3.forcePathStyle,
  requestChecksumCalculation: "WHEN_REQUIRED",
  responseChecksumValidation: "WHEN_REQUIRED",
  credentials: r2Credentials,
}) : r2Client;

console.log('[R2] Client config:', {
  bucket: config.s3.bucket,
  region: config.s3.region,
  endpoint: config.s3.endpoint ?? '(undefined — will use AWS default!)',
  publicEndpoint: config.s3.publicEndpoint ?? '(undefined — presign client = internal client)',
  forcePathStyle: config.s3.forcePathStyle,
  hasCredentials: !!r2Credentials,
});

export interface PresignedUploadUrl {
  uploadUrl: string;
  objectKey: string;
  expiresIn: number;
}

export class R2Error extends Error {
  constructor(message: string, public readonly code?: string) {
    super(message);
    this.name = 'R2Error';
  }
}

/**
 * Generate presigned upload URL for deployment zip
 * Key format: {appId}/_deployments/{deploymentId}.zip
 */
export async function generatePresignedUploadUrl(
  appId: string,
  deploymentId: string,
  maxSizeBytes: number = MAX_DEPLOYMENT_SIZE_BYTES
): Promise<PresignedUploadUrl> {
  // Input validation
  if (!appId || typeof appId !== 'string') {
    throw new R2Error('Invalid appId: must be a non-empty string', 'INVALID_APP_ID');
  }
  if (!deploymentId || typeof deploymentId !== 'string') {
    throw new R2Error('Invalid deploymentId: must be a non-empty string', 'INVALID_DEPLOYMENT_ID');
  }
  if (typeof maxSizeBytes !== 'number' || maxSizeBytes <= 0 || maxSizeBytes > MAX_DEPLOYMENT_SIZE_BYTES) {
    throw new R2Error(
      `Invalid maxSizeBytes: must be between 1 and ${MAX_DEPLOYMENT_SIZE_BYTES}`,
      'INVALID_SIZE'
    );
  }

  try {
    const key = `${appId}/_deployments/${deploymentId}.zip`;

    console.log(`[R2] Presigning PUT: bucket=${config.s3.bucket} key=${key}`);

    const command = new PutObjectCommand({
      Bucket: config.s3.bucket,
      Key: key,
      ContentType: 'application/zip',
      Metadata: {
        'x-butterbase-app-id': appId,
        'x-butterbase-deployment-id': deploymentId,
      },
    });

    const uploadUrl = await getSignedUrl(r2ClientForPresigning, command, {
      expiresIn: UPLOAD_URL_EXPIRATION_SECONDS,
      unsignableHeaders: new Set([
        'x-amz-checksum-crc32',
        'x-amz-sdk-checksum-algorithm',
        'x-amz-checksum-crc32c',
        'x-amz-checksum-sha1',
        'x-amz-checksum-sha256',
        'x-amz-checksum-crc64nvme',
      ]),
    });

    console.log(`[R2] Presigned URL generated for key=${key} (expires ${UPLOAD_URL_EXPIRATION_SECONDS}s)`);

    return {
      uploadUrl,
      objectKey: key,
      expiresIn: UPLOAD_URL_EXPIRATION_SECONDS,
    };
  } catch (error) {
    throw new R2Error(
      `Failed to generate presigned upload URL: ${error instanceof Error ? error.message : 'Unknown error'}`,
      'PRESIGN_FAILED'
    );
  }
}

/**
 * Download object from R2 as a stream
 */
export async function downloadObject(objectKey: string): Promise<ReadableStream> {
  if (!objectKey || typeof objectKey !== 'string') {
    throw new R2Error('Invalid object key: must be a non-empty string', 'INVALID_KEY');
  }

  try {
    const command = new GetObjectCommand({
      Bucket: config.s3.bucket,
      Key: objectKey,
    });

    const response = await r2Client.send(command);

    if (!response.Body) {
      throw new R2Error('Object body is empty', 'EMPTY_BODY');
    }

    // Convert SDK stream to web ReadableStream
    return response.Body.transformToWebStream();
  } catch (error) {
    throw new R2Error(
      `Failed to download object: ${error instanceof Error ? error.message : 'Unknown error'}`,
      'DOWNLOAD_FAILED'
    );
  }
}

/**
 * Check whether an object exists and return its size (bytes), or null.
 */
export async function headObject(objectKey: string): Promise<{ size: number } | null> {
  try {
    const res = await r2Client.send(new HeadObjectCommand({ Bucket: config.s3.bucket, Key: objectKey }));
    return { size: res.ContentLength ?? 0 };
  } catch {
    return null;
  }
}

/**
 * HEAD an R2 object and return { exists, contentLength }.
 * Used by from-source /start routes to verify the source zip was uploaded before
 * kicking off the build container.
 */
export async function head(key: string): Promise<{ exists: boolean; contentLength: number }> {
  try {
    const resp = await r2Client.send(new HeadObjectCommand({ Bucket: config.s3.bucket, Key: key }));
    return { exists: true, contentLength: resp.ContentLength ?? 0 };
  } catch (e: any) {
    if (e?.$metadata?.httpStatusCode === 404 || e?.name === 'NotFound') {
      return { exists: false, contentLength: 0 };
    }
    throw e;
  }
}

/**
 * Download object as buffer (for zip extraction)
 */
export async function downloadObjectAsBuffer(objectKey: string): Promise<Buffer> {
  if (!objectKey || typeof objectKey !== 'string') {
    throw new R2Error('Invalid object key: must be a non-empty string', 'INVALID_KEY');
  }

  console.log(`[R2] GET object: bucket=${config.s3.bucket} key=${objectKey} endpoint=${config.s3.endpoint ?? '(default)'}`);

  // Probe first so a missing object gives a clear diagnostic instead of a generic stream error
  const head = await headObject(objectKey);
  if (!head) {
    console.error(`[R2] HEAD returned 404 — object does not exist: bucket=${config.s3.bucket} key=${objectKey}`);
    throw new R2Error(
      `Object not found in R2: bucket=${config.s3.bucket} key=${objectKey}. ` +
      `Verify S3_ENDPOINT (${config.s3.endpoint ?? 'unset'}) matches S3_PUBLIC_ENDPOINT (${config.s3.publicEndpoint ?? 'unset'}).`,
      'NOT_FOUND'
    );
  }
  console.log(`[R2] HEAD OK — object exists, size=${head.size} bytes`);

  try {
    const command = new GetObjectCommand({
      Bucket: config.s3.bucket,
      Key: objectKey,
    });

    const response = await r2Client.send(command);

    if (!response.Body) {
      throw new R2Error('Object body is empty', 'EMPTY_BODY');
    }

    const bytes = await response.Body.transformToByteArray();
    console.log(`[R2] Downloaded ${bytes.length} bytes for key=${objectKey}`);
    return Buffer.from(bytes);
  } catch (error) {
    if (error instanceof R2Error) throw error;
    console.error(`[R2] Download failed: bucket=${config.s3.bucket} key=${objectKey}`, error);
    throw new R2Error(
      `Failed to download object as buffer: ${error instanceof Error ? error.message : 'Unknown error'}`,
      'DOWNLOAD_FAILED'
    );
  }
}

// ---------------------------------------------------------------------------
// Build-runner R2 helpers
// ---------------------------------------------------------------------------

const BUILD_KEY_PREFIXES = {
  source: (id: string) => `source/${id}.zip`,
  artifact: (id: string) => `artifact/${id}.zip`,
  log: (id: string) => `logs/${id}.txt`,
  status: (id: string) => `logs/${id}.status.json`,
  cache: (appId: string, lockHash: string) => `cache/${appId}/${lockHash}.tar`,
};

/**
 * Persistent per-app artifact slot. One key per app — overwritten on each
 * successful deploy. Used by the clone worker to byte-for-byte replay a
 * source app's most recent frontend onto the dest.
 */
export function appArtifactKey(appId: string): string {
  return `app-artifact/${appId}.zip`;
}

/**
 * The node_modules cache object for (app, lockfile hash).
 *
 * Deliberately NOT keyed on deployment id — that is what makes it persist
 * across deploys, and now across operator wakes too. The autonomous operator's
 * sandbox build (services/dashboard-agent/build-hydration.ts) reads and writes
 * this SAME object, so a deploy warms the cache for the operator and an
 * operator build warms it for the next deploy.
 *
 * Exported as its own function rather than left inline in `buildKeys` so there
 * is exactly ONE definition for both writers. If they ever disagreed nothing
 * would fail loudly — the sharing would just degrade into two half-warm
 * caches, each paying the cold install the other had already paid for.
 * `r2.test.ts` asserts the two agree.
 */
export function buildCacheKey(appId: string, lockfileHash: string): string {
  return BUILD_KEY_PREFIXES.cache(appId, lockfileHash);
}

export function buildKeys(deploymentId: string, appId: string, lockfileHash: string) {
  return {
    source: BUILD_KEY_PREFIXES.source(deploymentId),
    artifact: BUILD_KEY_PREFIXES.artifact(deploymentId),
    log: BUILD_KEY_PREFIXES.log(deploymentId),
    status: BUILD_KEY_PREFIXES.status(deploymentId),
    cache: buildCacheKey(appId, lockfileHash),
  };
}

/**
 * How long the operator's build-cache urls stay valid.
 *
 * GET is generous because a restore competes with everything else in a turn.
 * PUT is short and deliberately so: it is a WRITE url for an object the deploy
 * path also reads, so the window in which a leaked one could overwrite the
 * cache should be as small as the work allows. A cold install was measured at
 * 84.3s and the tar of that tree at 1.5s, so 600s is ample.
 */
const BUILD_CACHE_GET_SECONDS = 3600;
const BUILD_CACHE_PUT_SECONDS = 600;

/**
 * Presigned GET for the node_modules cache tar.
 *
 * Minted control-api side and handed to a CREDENTIAL-LESS sandbox — see
 * services/dashboard-agent/build-hydration.ts for why the operator's `bb_sk_*`
 * must never make that trip. Authorization for the app happens at the route
 * (routes/repo.ts), never here: this function, like everything else in this
 * module, takes `appId` as a plain parameter and authorizes nothing.
 */
export async function presignBuildCacheGet(appId: string, lockfileHash: string): Promise<string> {
  const cmd = new GetObjectCommand({
    Bucket: config.s3.bucket,
    Key: buildCacheKey(appId, lockfileHash),
  });
  return getSignedUrl(r2ClientForPresigning, cmd, { expiresIn: BUILD_CACHE_GET_SECONDS });
}

/**
 * Presigned PUT for the node_modules cache tar.
 *
 * CONCURRENT WRITERS ARE ACCEPTED, AND NOT LOCKED. The build-runner
 * (services/build-runner/container/entry.mjs:186-188) and the operator sandbox
 * can now both write this key. That is safe for three reasons, recorded here so
 * the next person does not add locking reflexively:
 *
 *  1. A PUT IS ATOMIC. S3/R2 has no partial-object visibility — a reader sees
 *     either the previous complete object or the new complete object, never a
 *     torn one. An upload that dies mid-flight leaves the old object intact.
 *     So a failed writer cannot poison a reader.
 *  2. THE WRITERS AGREE BY CONSTRUCTION. The key contains the lockfile hash,
 *     so every writer of a given key installed from the same dependency
 *     declaration. Last-writer-wins therefore swaps one valid tree for another
 *     valid tree, not a correct one for a wrong one.
 *  3. THE CACHE IS ADVISORY. Both consumers restore it and then run `npm
 *     install` anyway (entry.mjs:137-141 then :146, and the same order in the
 *     sandbox). A stale or partial-but-complete tree is reconciled by the
 *     install; it costs time, never correctness.
 *
 * Locking would add a distributed lock to a path whose worst failure is a slow
 * build. Revisit only if the key ever stops carrying the lockfile hash.
 */
export async function presignBuildCachePut(appId: string, lockfileHash: string): Promise<string> {
  const cmd = new PutObjectCommand({
    Bucket: config.s3.bucket,
    Key: buildCacheKey(appId, lockfileHash),
    ContentType: 'application/x-tar',
  });
  return getSignedUrl(r2ClientForPresigning, cmd, { expiresIn: BUILD_CACHE_PUT_SECONDS });
}

export async function getObjectAsBuffer(key: string): Promise<Buffer> {
  const resp = await r2Client.send(new GetObjectCommand({
    Bucket: config.s3.bucket,
    Key: key,
  }));
  const chunks: Buffer[] = [];
  for await (const chunk of resp.Body as any) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks);
}

export async function getObjectStream(key: string): Promise<NodeJS.ReadableStream> {
  const resp = await r2Client.send(new GetObjectCommand({
    Bucket: config.s3.bucket,
    Key: key,
  }));
  return resp.Body as NodeJS.ReadableStream;
}

export async function getObjectStreamRange(key: string, offset: number): Promise<NodeJS.ReadableStream> {
  const cmd = new GetObjectCommand({
    Bucket: config.s3.bucket,
    Key: key,
    Range: `bytes=${Math.max(0, Math.floor(offset))}-`,
  });
  const resp = await r2Client.send(cmd);
  return resp.Body as NodeJS.ReadableStream;
}

/**
 * Generate a presigned PUT URL for uploading a source zip.
 * Used by the edge-ssr from-source deployment flow.
 * Key should be in the form `source/{deploymentId}.zip`.
 */
export async function presignSourceUpload(key: string): Promise<string> {
  const cmd = new PutObjectCommand({
    Bucket: config.s3.bucket,
    Key: key,
    ContentType: 'application/zip',
  });
  return getSignedUrl(r2ClientForPresigning, cmd, { expiresIn: 600 });
}

/**
 * Delete object from R2
 */
export async function deleteObject(objectKey: string): Promise<void> {
  if (!objectKey || typeof objectKey !== 'string') {
    throw new R2Error('Invalid object key: must be a non-empty string', 'INVALID_KEY');
  }

  console.log(`[R2] DELETE object: bucket=${config.s3.bucket} key=${objectKey}`);

  try {
    const command = new DeleteObjectCommand({
      Bucket: config.s3.bucket,
      Key: objectKey,
    });

    await r2Client.send(command);
    console.log(`[R2] Deleted key=${objectKey}`);
  } catch (error) {
    console.error(`[R2] Delete failed: key=${objectKey}`, error);
    throw new R2Error(
      `Failed to delete object: ${error instanceof Error ? error.message : 'Unknown error'}`,
      'DELETE_FAILED'
    );
  }
}

/**
 * Write a buffer to R2 at the given key. Overwrites any existing object.
 * Used for the persistent per-app artifact slot (see appArtifactKey).
 */
export async function putObject(
  key: string,
  body: Buffer,
  contentType = 'application/octet-stream',
): Promise<void> {
  if (!key || typeof key !== 'string') {
    throw new R2Error('Invalid object key: must be a non-empty string', 'INVALID_KEY');
  }
  try {
    await r2Client.send(new PutObjectCommand({
      Bucket: config.s3.bucket,
      Key: key,
      Body: body,
      ContentType: contentType,
    }));
  } catch (error) {
    throw new R2Error(
      `Failed to put object ${key}: ${error instanceof Error ? error.message : 'Unknown error'}`,
      'PUT_FAILED',
    );
  }
}

/**
 * Server-side copy within the same R2 bucket. R2 is globally addressed, so
 * this also works across butterbase regions without re-fetching the bytes.
 */
export async function copyObject(srcKey: string, dstKey: string): Promise<void> {
  if (!srcKey || !dstKey) {
    throw new R2Error('copyObject requires non-empty source and destination keys', 'INVALID_KEY');
  }
  try {
    await r2Client.send(new CopyObjectCommand({
      Bucket: config.s3.bucket,
      // CopySource expects bucket-prefixed, URL-encoded path
      CopySource: `${config.s3.bucket}/${encodeURIComponent(srcKey)}`,
      Key: dstKey,
    }));
  } catch (error) {
    throw new R2Error(
      `Failed to copy ${srcKey} -> ${dstKey}: ${error instanceof Error ? error.message : 'Unknown error'}`,
      'COPY_FAILED',
    );
  }
}
