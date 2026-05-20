// services/build-runner/container/r2.mjs
// Minimal R2 client over S3-compat. Receives session credentials at process
// start via env vars set by the build-runner Worker; never persisted.
import { S3Client, GetObjectCommand, PutObjectCommand, HeadObjectCommand } from '@aws-sdk/client-s3';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { createWriteStream, createReadStream, statSync } from 'node:fs';

export function makeClient() {
  const endpoint = process.env.R2_ENDPOINT;
  const region = process.env.R2_REGION ?? 'auto';
  const accessKeyId = process.env.R2_ACCESS_KEY_ID;
  const secretAccessKey = process.env.R2_SECRET_ACCESS_KEY;
  const sessionToken = process.env.R2_SESSION_TOKEN;
  if (!endpoint || !accessKeyId || !secretAccessKey) {
    throw new Error('R2 credentials missing in container env');
  }
  return new S3Client({
    endpoint, region, forcePathStyle: true,
    credentials: { accessKeyId, secretAccessKey, ...(sessionToken ? { sessionToken } : {}) },
  });
}

export async function downloadToFile(client, bucket, key, localPath) {
  const resp = await client.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
  await pipeline(resp.Body, createWriteStream(localPath));
}

export async function exists(client, bucket, key) {
  try {
    await client.send(new HeadObjectCommand({ Bucket: bucket, Key: key }));
    return true;
  } catch (e) {
    if (e?.$metadata?.httpStatusCode === 404 || e?.name === 'NotFound') return false;
    throw e;
  }
}

export async function head(client, bucket, key) {
  try {
    const resp = await client.send(new HeadObjectCommand({ Bucket: bucket, Key: key }));
    return { exists: true, contentLength: resp.ContentLength ?? 0, contentType: resp.ContentType };
  } catch (e) {
    if (e?.$metadata?.httpStatusCode === 404 || e?.name === 'NotFound') return { exists: false, contentLength: 0 };
    throw e;
  }
}

export async function uploadFile(client, bucket, key, localPath, contentType) {
  const stat = statSync(localPath);
  await client.send(new PutObjectCommand({
    Bucket: bucket, Key: key,
    Body: createReadStream(localPath),
    ContentLength: stat.size,
    ContentType: contentType,
  }));
}

export async function uploadBuffer(client, bucket, key, body, contentType) {
  await client.send(new PutObjectCommand({
    Bucket: bucket, Key: key, Body: body, ContentType: contentType,
  }));
}
