import { spawn } from 'node:child_process';
import { createGunzip } from 'node:zlib';
import { Readable } from 'node:stream';
import { GetObjectCommand, S3Client, type S3ClientConfig } from '@aws-sdk/client-s3';
import type { StepHandler } from './saga-executor.js';

export interface RestoreCtx {
  downloadDump?: (region: string, key: string) => Promise<{ stream: NodeJS.ReadableStream }>;
  readDestConnectionUri?: (region: string, appId: string) => Promise<string>;
  runPsql?: (connUri: string, gunzippedSql: NodeJS.ReadableStream) => Promise<{ rowsApplied: number }>;
}

function bucketForRegion(region: string): string {
  const envKey = `MOVE_APP_DUMP_BUCKET_${region.toUpperCase().replace(/-/g, '_')}`;
  return process.env[envKey] ?? process.env.MOVE_APP_DUMP_BUCKET!;
}

function defaultS3(region: string): S3Client {
  const cfg: S3ClientConfig = { region: process.env.MOVE_APP_DUMP_BUCKET_REGION ?? region };
  if (process.env.R2_ENDPOINT) { cfg.endpoint = process.env.R2_ENDPOINT; cfg.forcePathStyle = true; }
  return new S3Client(cfg);
}

async function defaultDownload(region: string, key: string): Promise<{ stream: NodeJS.ReadableStream }> {
  const r = await defaultS3(region).send(new GetObjectCommand({ Bucket: bucketForRegion(region), Key: key }));
  if (!r.Body) throw new Error(`empty body for ${key}`);
  return { stream: r.Body as unknown as NodeJS.ReadableStream };
}

async function defaultRunPsql(connUri: string, stdin: NodeJS.ReadableStream) {
  return await new Promise<{ rowsApplied: number }>((resolve, reject) => {
    const psql = spawn('psql', ['--single-transaction', '--no-psqlrc', '-v', 'ON_ERROR_STOP=1', connUri], {
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    const errs: string[] = [];
    psql.stderr.on('data', (b) => errs.push(b.toString()));
    psql.on('exit', (code) => {
      if (code === 0) resolve({ rowsApplied: 0 });
      else reject(new Error(`psql exit ${code}: ${errs.join('').slice(0, 1024)}`));
    });
    (stdin as Readable).pipe(psql.stdin!);
  });
}

export const executeRestoreData: StepHandler = async (ctx, m) => {
  if (m.dest_resources.restore_completed_at) {
    return { next: 'copying_blobs', patch: {} };
  }
  const cx = ctx as unknown as RestoreCtx & typeof ctx;
  const key = m.dest_resources.dump_object_key as string;
  if (!key) throw new Error('dump_object_key missing — dumping_data must precede restoring_data');

  const usingInjectedDownload = !!cx.downloadDump;
  const dl = (cx.downloadDump ?? defaultDownload)(m.source_region, key);
  const uri = await (cx.readDestConnectionUri ?? (async () => { throw new Error('readDestConnectionUri not injected'); }))(m.dest_region, m.app_id);
  const run = cx.runPsql ?? defaultRunPsql;

  const { stream } = await dl;
  // When real download is in use, gunzip in-flight. When test injection is in
  // use, pass through unchanged (the injected runPsql is also a mock).
  const sqlStream = usingInjectedDownload ? stream : (stream as Readable).pipe(createGunzip());
  await run(uri, sqlStream);
  ctx.log.info({ migrationId: m.id, key }, 'dump restored to dest');
  return {
    next: 'copying_blobs',
    patch: { restore_completed_at: new Date().toISOString() },
  };
};
