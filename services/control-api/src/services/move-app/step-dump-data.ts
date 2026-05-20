import { spawn } from 'node:child_process';
import { type Readable, PassThrough } from 'node:stream';
import { createGzip } from 'node:zlib';
import { S3Client, type S3ClientConfig } from '@aws-sdk/client-s3';
import { Upload } from '@aws-sdk/lib-storage';
import type { StepHandler } from './saga-executor.js';

export interface DumpUploadCtx {
  uploadDump?: (key: string, body: Readable) => Promise<{ key: string; bytes: number }>;
  readSourceConnectionUri?: (region: string, appId: string) => Promise<string>;
}

function bucketForRegion(region: string): string {
  const envKey = `MOVE_APP_DUMP_BUCKET_${region.toUpperCase().replace(/-/g, '_')}`;
  const val = process.env[envKey] ?? process.env.MOVE_APP_DUMP_BUCKET;
  if (!val) throw new Error(`Missing ${envKey} (or MOVE_APP_DUMP_BUCKET fallback) for region ${region}`);
  return val;
}

function defaultS3Client(region: string): S3Client {
  const cfg: S3ClientConfig = {
    region: process.env.MOVE_APP_DUMP_BUCKET_REGION ?? region,
  };
  if (process.env.R2_ENDPOINT) {
    cfg.endpoint = process.env.R2_ENDPOINT;
    cfg.forcePathStyle = true;
  }
  return new S3Client(cfg);
}

async function defaultUploadDump(region: string, key: string, body: Readable) {
  const client = defaultS3Client(region);
  const uploader = new Upload({
    client,
    params: { Bucket: bucketForRegion(region), Key: key, Body: body },
  });
  await uploader.done();
  return { key, bytes: 0 };
}

async function defaultReadSourceConnectionUri(_region: string, appId: string): Promise<string> {
  throw new Error(`readSourceConnectionUri not injected; cannot look up source DB for ${appId}`);
}

export const executeDumpData: StepHandler = async (ctx, m) => {
  if (m.dest_resources.dump_object_key) {
    return { next: 'restoring_data', patch: {} };
  }
  const cx = ctx as unknown as DumpUploadCtx & typeof ctx;
  const readUri = cx.readSourceConnectionUri ?? defaultReadSourceConnectionUri;
  const uploadFn = cx.uploadDump;

  const sourceUri = await readUri(m.source_region, m.app_id);
  const key = `move-app/${m.id}/dump.sql.gz`;

  let upResult: { key: string; bytes: number };

  if (uploadFn) {
    // Injected uploader (used in tests / custom deployments): caller owns the entire
    // dump-and-upload cycle; we hand it a key and an empty passthrough as placeholder.
    const stream = new PassThrough();
    stream.end();
    upResult = await uploadFn(key, stream);
  } else {
    // Production path: spawn pg_dump, gzip, stream to R2.
    const upload = (k: string, body: Readable) => defaultUploadDump(m.source_region, k, body);

    // --clean + --if-exists make the dump idempotent against a non-empty
    // dest. Required because: (a) Neon's default `realtime` schema exists
    // on the fresh dest DB, so a plain restore fails on CREATE SCHEMA
    // realtime; (b) a retry after a partial restore would re-fail
    // identically without DROP statements.
    const dump = spawn(
      'pg_dump',
      ['--no-owner', '--no-privileges', '--clean', '--if-exists', '--format=plain', sourceUri],
      { stdio: ['ignore', 'pipe', 'pipe'] },
    );
    const gz = createGzip();
    const stream = new PassThrough();
    dump.stdout.pipe(gz).pipe(stream);

    const dumpErrs: string[] = [];
    dump.stderr.on('data', (b) => dumpErrs.push(b.toString()));

    const dumpDone = new Promise<void>((resolve, reject) => {
      // ENOENT (pg_dump not installed) emits 'error', not 'exit' — without
      // this listener the saga handler would hang forever, holding the
      // FOR UPDATE row lock in driveOnce.
      dump.on('error', (err) => {
        stream.destroy(err);
        reject(new Error(`pg_dump spawn failed: ${err.message}`));
      });
      dump.on('exit', (code) => {
        if (code === 0) resolve();
        else reject(new Error(`pg_dump exit ${code}: ${dumpErrs.join('').slice(0, 1024)}`));
      });
    });

    [upResult] = await Promise.all([upload(key, stream), dumpDone]);
  }

  ctx.log.info({ migrationId: m.id, key: upResult.key, bytes: upResult.bytes }, 'dump uploaded');
  return { next: 'restoring_data', patch: { dump_object_key: upResult.key, dump_bytes: upResult.bytes } };
};
