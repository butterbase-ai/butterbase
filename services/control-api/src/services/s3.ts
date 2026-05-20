// services/control-api/src/services/s3.ts
import { S3Client, PutObjectCommand, GetObjectCommand, DeleteObjectCommand, HeadObjectCommand } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { config } from '../config.js';
import { randomUUID } from 'crypto';

// Constants for expiration times
const UPLOAD_URL_EXPIRATION_SECONDS = 300; // 5 minutes
const DEFAULT_DOWNLOAD_URL_EXPIRATION_SECONDS = 3600; // 1 hour
const MAX_DOWNLOAD_URL_EXPIRATION_SECONDS = 604800; // 7 days

// Object key pattern: appId/userId/uuid_filename
const OBJECT_KEY_PATTERN = /^[a-zA-Z0-9_-]+\/[a-f0-9-]{36}\/[a-f0-9-]{36}_[a-zA-Z0-9._-]+$/;

const s3Credentials = config.s3.accessKeyId && config.s3.secretAccessKey ? {
  accessKeyId: config.s3.accessKeyId,
  secretAccessKey: config.s3.secretAccessKey,
} : undefined;

// R2 does not fully support S3 flexible checksums; WHEN_REQUIRED prevents the
// SDK from auto-injecting CRC32 headers/query params that R2 may mishandle.
const s3Client = new S3Client({
  region: config.s3.region,
  endpoint: config.s3.endpoint,
  forcePathStyle: config.s3.forcePathStyle,
  requestChecksumCalculation: "WHEN_REQUIRED",
  responseChecksumValidation: "WHEN_REQUIRED",
  credentials: s3Credentials,
});

// Separate client for presigned URLs with public endpoint.
// requestChecksumCalculation is critical here: without it the SDK bakes
// CRC32-of-empty into the signed URL, causing uploads to ghost-write on R2.
const s3ClientForPresigning = config.s3.publicEndpoint ? new S3Client({
  region: config.s3.region,
  endpoint: config.s3.publicEndpoint,
  forcePathStyle: config.s3.forcePathStyle,
  requestChecksumCalculation: "WHEN_REQUIRED",
  responseChecksumValidation: "WHEN_REQUIRED",
  credentials: s3Credentials,
}) : s3Client;

export interface PresignedUploadUrl {
  uploadUrl: string;
  objectKey: string;
  expiresIn: number;
}

export class S3Error extends Error {
  constructor(message: string, public readonly code?: string) {
    super(message);
    this.name = 'S3Error';
  }
}

function validateObjectKey(objectKey: string): void {
  if (!objectKey || typeof objectKey !== 'string') {
    throw new S3Error('Invalid object key: must be a non-empty string', 'INVALID_KEY');
  }
  if (!OBJECT_KEY_PATTERN.test(objectKey)) {
    throw new S3Error('Invalid object key format', 'INVALID_KEY_FORMAT');
  }
}

export async function generatePresignedUploadUrl(
  appId: string,
  userId: string,
  filename: string,
  contentType: string,
  sizeBytes: number
): Promise<PresignedUploadUrl> {
  // Input validation
  if (!appId || typeof appId !== 'string') {
    throw new S3Error('Invalid appId: must be a non-empty string', 'INVALID_APP_ID');
  }
  if (!userId || typeof userId !== 'string' || !/^[a-f0-9-]{36}$/.test(userId)) {
    throw new S3Error('Invalid userId: must be a valid UUID', 'INVALID_USER_ID');
  }
  if (!filename || typeof filename !== 'string') {
    throw new S3Error('Invalid filename: must be a non-empty string', 'INVALID_FILENAME');
  }
  if (!contentType || typeof contentType !== 'string') {
    throw new S3Error('Invalid contentType: must be a non-empty string', 'INVALID_CONTENT_TYPE');
  }
  if (typeof sizeBytes !== 'number' || sizeBytes <= 0) {
    throw new S3Error('Invalid sizeBytes: must be a positive number', 'INVALID_SIZE');
  }

  try {
    // Sanitize filename
    const sanitized = filename.replace(/[^a-zA-Z0-9._-]/g, '_');
    const uuid = randomUUID();
    const key = `${appId}/${userId}/${uuid}_${sanitized}`;

    const command = new PutObjectCommand({
      Bucket: config.s3.bucket,
      Key: key,
      ContentType: contentType,
      Metadata: {
        'x-butterbase-app-id': appId,
        'x-butterbase-user-id': userId,
        'x-butterbase-original-filename': filename,
      },
    });

    const uploadUrl = await getSignedUrl(s3ClientForPresigning, command, { expiresIn: UPLOAD_URL_EXPIRATION_SECONDS });

    return {
      uploadUrl,
      objectKey: key,
      expiresIn: UPLOAD_URL_EXPIRATION_SECONDS,
    };
  } catch (error) {
    if (error instanceof S3Error) {
      throw error;
    }
    throw new S3Error(
      `Failed to generate presigned upload URL: ${error instanceof Error ? error.message : 'Unknown error'}`,
      'PRESIGN_FAILED'
    );
  }
}

export async function generatePresignedDownloadUrl(
  objectKey: string,
  expiresIn: number = DEFAULT_DOWNLOAD_URL_EXPIRATION_SECONDS
): Promise<string> {
  // Input validation
  validateObjectKey(objectKey);

  if (typeof expiresIn !== 'number' || expiresIn <= 0 || expiresIn > MAX_DOWNLOAD_URL_EXPIRATION_SECONDS) {
    throw new S3Error(
      `Invalid expiresIn: must be between 1 and ${MAX_DOWNLOAD_URL_EXPIRATION_SECONDS} seconds`,
      'INVALID_EXPIRATION'
    );
  }

  try {
    const command = new GetObjectCommand({
      Bucket: config.s3.bucket,
      Key: objectKey,
    });

    return await getSignedUrl(s3ClientForPresigning, command, { expiresIn });
  } catch (error) {
    throw new S3Error(
      `Failed to generate presigned download URL: ${error instanceof Error ? error.message : 'Unknown error'}`,
      'PRESIGN_FAILED'
    );
  }
}

export async function deleteObject(objectKey: string): Promise<void> {
  // Input validation
  validateObjectKey(objectKey);

  try {
    const command = new DeleteObjectCommand({
      Bucket: config.s3.bucket,
      Key: objectKey,
    });

    await s3Client.send(command);
  } catch (error) {
    throw new S3Error(
      `Failed to delete object: ${error instanceof Error ? error.message : 'Unknown error'}`,
      'DELETE_FAILED'
    );
  }
}

/**
 * Upload a buffer directly to S3 (server-side upload, no presigned URL).
 * Used by RAG ingestion to store raw text content.
 */
export async function uploadObject(
  objectKey: string,
  body: Buffer,
  contentType: string
): Promise<void> {
  try {
    const command = new PutObjectCommand({
      Bucket: config.s3.bucket,
      Key: objectKey,
      Body: body,
      ContentType: contentType,
    });

    await s3Client.send(command);
  } catch (error) {
    throw new S3Error(
      `Failed to upload object: ${error instanceof Error ? error.message : 'Unknown error'}`,
      'UPLOAD_FAILED'
    );
  }
}

/**
 * Download an object's contents as a Buffer.
 * Used by the RAG ingestion worker to fetch uploaded files for parsing.
 */
export async function downloadObject(objectKey: string): Promise<Buffer> {
  try {
    const command = new GetObjectCommand({
      Bucket: config.s3.bucket,
      Key: objectKey,
    });

    const response = await s3Client.send(command);

    if (!response.Body) {
      throw new S3Error('Empty response body', 'EMPTY_BODY');
    }

    // Convert readable stream to Buffer
    const chunks: Uint8Array[] = [];
    for await (const chunk of response.Body as AsyncIterable<Uint8Array>) {
      chunks.push(chunk);
    }
    return Buffer.concat(chunks);
  } catch (error) {
    if (error instanceof S3Error) throw error;
    throw new S3Error(
      `Failed to download object: ${error instanceof Error ? error.message : 'Unknown error'}`,
      'DOWNLOAD_FAILED'
    );
  }
}

export async function getObjectMetadata(objectKey: string) {
  // Input validation
  validateObjectKey(objectKey);

  try {
    const command = new HeadObjectCommand({
      Bucket: config.s3.bucket,
      Key: objectKey,
    });

    return await s3Client.send(command);
  } catch (error) {
    throw new S3Error(
      `Failed to get object metadata: ${error instanceof Error ? error.message : 'Unknown error'}`,
      'METADATA_FAILED'
    );
  }
}
