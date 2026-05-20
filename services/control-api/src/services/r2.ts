// services/control-api/src/services/r2.ts
import { S3Client, PutObjectCommand, GetObjectCommand, DeleteObjectCommand, HeadObjectCommand } from '@aws-sdk/client-s3';
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

export function buildKeys(deploymentId: string, appId: string, lockfileHash: string) {
  return {
    source: BUILD_KEY_PREFIXES.source(deploymentId),
    artifact: BUILD_KEY_PREFIXES.artifact(deploymentId),
    log: BUILD_KEY_PREFIXES.log(deploymentId),
    status: BUILD_KEY_PREFIXES.status(deploymentId),
    cache: BUILD_KEY_PREFIXES.cache(appId, lockfileHash),
  };
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
