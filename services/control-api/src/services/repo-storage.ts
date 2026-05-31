import {
  PutObjectCommand,
  GetObjectCommand,
  DeleteObjectCommand,
  HeadObjectCommand,
  ListObjectsV2Command,
  S3Client,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { config } from '../config.js';
import { S3Error } from './s3.js';

const s3Credentials = config.s3.accessKeyId && config.s3.secretAccessKey ? {
  accessKeyId: config.s3.accessKeyId,
  secretAccessKey: config.s3.secretAccessKey,
} : undefined;

const internalClient = new S3Client({
  region: config.s3.region,
  endpoint: config.s3.endpoint,
  forcePathStyle: config.s3.forcePathStyle,
  requestChecksumCalculation: 'WHEN_REQUIRED',
  responseChecksumValidation: 'WHEN_REQUIRED',
  credentials: s3Credentials,
});

const presignClient = config.s3.publicEndpoint ? new S3Client({
  region: config.s3.region,
  endpoint: config.s3.publicEndpoint,
  forcePathStyle: config.s3.forcePathStyle,
  requestChecksumCalculation: 'WHEN_REQUIRED',
  responseChecksumValidation: 'WHEN_REQUIRED',
  credentials: s3Credentials,
}) : internalClient;

const REPO_PRESIGN_PUT_SECONDS = 600;
const REPO_PRESIGN_GET_SECONDS = 3600;

export function blobKey(appId: string, sha256: string): string {
  return `${appId}/_repo/blobs/${sha256}`;
}
export function manifestKey(appId: string, snapshotId: string): string {
  return `${appId}/_repo/snapshots/${snapshotId}/manifest.json`;
}
export function snapshotPrefix(appId: string, snapshotId: string): string {
  return `${appId}/_repo/snapshots/${snapshotId}/`;
}
export function latestKey(appId: string): string {
  return `${appId}/_repo/latest`;
}
export function repoPrefix(appId: string): string {
  return `${appId}/_repo/`;
}

export interface BlobHead {
  sha256: string;
  exists: boolean;
  size?: number;
}

export async function headBlob(appId: string, sha256: string): Promise<BlobHead> {
  try {
    const out = await internalClient.send(new HeadObjectCommand({
      Bucket: config.s3.bucket,
      Key: blobKey(appId, sha256),
    }));
    return { sha256, exists: true, size: out.ContentLength };
  } catch (e: any) {
    if (e?.$metadata?.httpStatusCode === 404 || e?.name === 'NotFound') return { sha256, exists: false };
    throw new S3Error(`headBlob failed: ${e?.message ?? e}`, 'S3_HEAD_BLOB_ERROR');
  }
}

export async function headBlobs(appId: string, shas: string[]): Promise<Map<string, BlobHead>> {
  const out = new Map<string, BlobHead>();
  const distinct = [...new Set(shas)];
  await Promise.all(distinct.map(async sha => out.set(sha, await headBlob(appId, sha))));
  return out;
}

export async function presignBlobPut(appId: string, sha256: string): Promise<string> {
  const cmd = new PutObjectCommand({
    Bucket: config.s3.bucket,
    Key: blobKey(appId, sha256),
    ContentType: 'application/octet-stream',
  });
  return await getSignedUrl(presignClient, cmd, { expiresIn: REPO_PRESIGN_PUT_SECONDS });
}

export async function presignBlobGet(appId: string, sha256: string): Promise<string> {
  const cmd = new GetObjectCommand({
    Bucket: config.s3.bucket,
    Key: blobKey(appId, sha256),
    ResponseContentType: 'application/octet-stream',
  });
  return await getSignedUrl(presignClient, cmd, { expiresIn: REPO_PRESIGN_GET_SECONDS });
}

export async function putManifest(appId: string, snapshotId: string, canonicalJson: string): Promise<void> {
  await internalClient.send(new PutObjectCommand({
    Bucket: config.s3.bucket,
    Key: manifestKey(appId, snapshotId),
    Body: canonicalJson,
    ContentType: 'application/json',
  }));
}

export async function getManifestJson(appId: string, snapshotId: string): Promise<string | null> {
  try {
    const out = await internalClient.send(new GetObjectCommand({
      Bucket: config.s3.bucket,
      Key: manifestKey(appId, snapshotId),
    }));
    const buf = await streamToBuffer(out.Body as NodeJS.ReadableStream);
    return buf.toString('utf8');
  } catch (e: any) {
    if (e?.$metadata?.httpStatusCode === 404 || e?.name === 'NoSuchKey') return null;
    throw new S3Error(`getManifestJson failed: ${e?.message ?? e}`, 'S3_GET_MANIFEST_ERROR');
  }
}

export async function setLatest(appId: string, snapshotId: string): Promise<void> {
  await internalClient.send(new PutObjectCommand({
    Bucket: config.s3.bucket,
    Key: latestKey(appId),
    Body: JSON.stringify({ snapshot_id: snapshotId }),
    ContentType: 'application/json',
  }));
}

export async function getLatestSnapshotId(appId: string): Promise<string | null> {
  try {
    const out = await internalClient.send(new GetObjectCommand({
      Bucket: config.s3.bucket,
      Key: latestKey(appId),
    }));
    const buf = await streamToBuffer(out.Body as NodeJS.ReadableStream);
    const parsed = JSON.parse(buf.toString('utf8'));
    return typeof parsed?.snapshot_id === 'string' ? parsed.snapshot_id : null;
  } catch (e: any) {
    if (e?.$metadata?.httpStatusCode === 404 || e?.name === 'NoSuchKey') return null;
    throw new S3Error(`getLatestSnapshotId failed: ${e?.message ?? e}`, 'S3_GET_LATEST_ERROR');
  }
}

export interface ListedSnapshot {
  snapshotId: string;
  lastModified: Date;
}

export async function listSnapshots(appId: string): Promise<ListedSnapshot[]> {
  const out: ListedSnapshot[] = [];
  const prefix = `${appId}/_repo/snapshots/`;
  let token: string | undefined;
  do {
    const res = await internalClient.send(new ListObjectsV2Command({
      Bucket: config.s3.bucket,
      Prefix: prefix,
      Delimiter: '/',
      ContinuationToken: token,
    }));
    for (const cp of res.CommonPrefixes ?? []) {
      if (!cp.Prefix) continue;
      const tail = cp.Prefix.slice(prefix.length).replace(/\/$/, '');
      if (!tail) continue;
      const mh = await internalClient.send(new HeadObjectCommand({
        Bucket: config.s3.bucket,
        Key: manifestKey(appId, tail),
      })).catch(() => null);
      if (mh) out.push({ snapshotId: tail, lastModified: mh.LastModified ?? new Date(0) });
    }
    token = res.IsTruncated ? res.NextContinuationToken : undefined;
  } while (token);
  return out;
}

export async function deleteSnapshot(appId: string, snapshotId: string): Promise<void> {
  const prefix = snapshotPrefix(appId, snapshotId);
  let token: string | undefined;
  do {
    const res = await internalClient.send(new ListObjectsV2Command({
      Bucket: config.s3.bucket,
      Prefix: prefix,
      ContinuationToken: token,
    }));
    for (const obj of res.Contents ?? []) {
      if (!obj.Key) continue;
      await internalClient.send(new DeleteObjectCommand({ Bucket: config.s3.bucket, Key: obj.Key }));
    }
    token = res.IsTruncated ? res.NextContinuationToken : undefined;
  } while (token);
}

export async function deleteBlob(appId: string, sha256: string): Promise<void> {
  await internalClient.send(new DeleteObjectCommand({
    Bucket: config.s3.bucket,
    Key: blobKey(appId, sha256),
  }));
}

export async function wipeRepo(appId: string): Promise<void> {
  const prefix = repoPrefix(appId);
  let token: string | undefined;
  do {
    const res = await internalClient.send(new ListObjectsV2Command({
      Bucket: config.s3.bucket,
      Prefix: prefix,
      ContinuationToken: token,
    }));
    for (const obj of res.Contents ?? []) {
      if (!obj.Key) continue;
      await internalClient.send(new DeleteObjectCommand({ Bucket: config.s3.bucket, Key: obj.Key }));
    }
    token = res.IsTruncated ? res.NextContinuationToken : undefined;
  } while (token);
}

async function streamToBuffer(stream: NodeJS.ReadableStream): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) {
    chunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}
