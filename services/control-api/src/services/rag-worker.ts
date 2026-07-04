import pg from 'pg';
import { config, assertRegionConfig } from '../config.js';
import { getRuntimeDbPool } from './runtime-db.js';
import { getRuntimeDbForApp } from './region-resolver.js';
import { getAppPoolForApp } from './app-pool.js';
import { downloadObject } from './s3.js';
import { parseDocument } from './rag-parsers.js';
import { chunkText } from './rag-chunker.js';
import { proxyEmbedding } from './openrouter-gateway.js';
import { NotFoundError } from './api-errors.js';

interface RagTask {
  id: string;
  app_id: string;
  document_id: string;
  collection_id: string;
  status: string;
  attempts: number;
  max_attempts: number;
}

interface Logger {
  info(obj: unknown, msg?: string): void;
  warn(obj: unknown, msg?: string): void;
  error(obj: unknown, msg?: string): void;
}

const POLL_INTERVAL_MS = 5000;
const STALE_THRESHOLD_MINUTES = 5;
const BACKOFF_SECONDS = [2, 4, 8, 16, 32];
const EMBEDDING_BATCH_SIZE = 100;

/**
 * Starts the RAG ingestion worker. Returns the interval handle for cleanup.
 */
export function startRagWorker(controlDb: pg.Pool, logger: Logger): NodeJS.Timeout {
  let running = false;

  const interval = setInterval(async () => {
    if (running) return;
    running = true;

    try {
      await recoverStaleTasks(controlDb, logger);
      await processNextTask(controlDb, logger);
    } catch (err) {
      logger.error({ err }, '[rag-worker] Unexpected error in poll loop');
    } finally {
      running = false;
    }
  }, POLL_INTERVAL_MS);

  logger.info('[rag-worker] Started (poll every 5s)');
  return interval;
}

async function recoverStaleTasks(controlDb: pg.Pool, logger: Logger): Promise<void> {
  // rag_ingestion_queue is a runtime-tier table (per-region queue)
  const runtimePool = getRuntimeDbPool(config.runtimeDb, assertRegionConfig().instanceRegion);

  const reset = await runtimePool.query(
    `UPDATE rag_ingestion_queue
     SET status = 'pending', locked_at = NULL, run_after = now()
     WHERE status = 'processing'
       AND locked_at < now() - interval '${STALE_THRESHOLD_MINUTES} minutes'
       AND attempts < max_attempts
     RETURNING id, app_id, document_id`,
  );

  if (reset.rowCount && reset.rowCount > 0) {
    logger.warn({ count: reset.rowCount }, '[rag-worker] Recovered stale tasks');
  }

  const failed = await runtimePool.query(
    `UPDATE rag_ingestion_queue
     SET status = 'failed',
         error_message = 'Stale: worker crashed or timed out',
         completed_at = now()
     WHERE status = 'processing'
       AND locked_at < now() - interval '${STALE_THRESHOLD_MINUTES} minutes'
       AND attempts >= max_attempts
     RETURNING id, app_id, document_id`,
  );

  for (const task of failed.rows) {
    logger.error({ task }, '[rag-worker] Task permanently failed (stale recovery)');
    await updateDocumentStatus(controlDb, task.app_id, task.document_id, 'failed', 'Worker crashed or timed out');
  }
}

async function processNextTask(controlDb: pg.Pool, logger: Logger): Promise<void> {
  // rag_ingestion_queue is a runtime-tier table (per-region queue)
  const runtimePool = getRuntimeDbPool(config.runtimeDb, assertRegionConfig().instanceRegion);

  const result = await runtimePool.query<RagTask>(
    `UPDATE rag_ingestion_queue
     SET status = 'processing', locked_at = now(), attempts = attempts + 1
     WHERE id = (
       SELECT id FROM rag_ingestion_queue
       WHERE status = 'pending' AND run_after <= now()
       ORDER BY created_at ASC
       LIMIT 1
       FOR UPDATE SKIP LOCKED
     )
     RETURNING *`,
  );

  if (result.rows.length === 0) return;

  const task = result.rows[0];
  const start = Date.now();
  logger.info({ taskId: task.id, appId: task.app_id, documentId: task.document_id, attempt: task.attempts }, '[rag-worker] Claimed task');

  try {
    await processDocument(controlDb, task, logger);

    await runtimePool.query(
      `UPDATE rag_ingestion_queue SET status = 'completed', completed_at = now() WHERE id = $1`,
      [task.id],
    );

    logger.info({ taskId: task.id, durationMs: Date.now() - start }, '[rag-worker] Task completed');
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.warn({ taskId: task.id, attempt: task.attempts, error: msg }, '[rag-worker] Task failed');

    if (task.attempts >= task.max_attempts) {
      await runtimePool.query(
        `UPDATE rag_ingestion_queue SET status = 'failed', error_message = $1, completed_at = now() WHERE id = $2`,
        [msg.slice(0, 2000), task.id],
      );
      await updateDocumentStatus(controlDb, task.app_id, task.document_id, 'failed', msg.slice(0, 2000));
      logger.error({ taskId: task.id, appId: task.app_id }, '[rag-worker] Task permanently failed');
    } else {
      const backoff = BACKOFF_SECONDS[Math.min(task.attempts - 1, BACKOFF_SECONDS.length - 1)];
      await runtimePool.query(
        `UPDATE rag_ingestion_queue SET status = 'pending', locked_at = NULL, error_message = $1, run_after = now() + interval '${backoff} seconds' WHERE id = $2`,
        [msg.slice(0, 2000), task.id],
      );
    }
  }
}

async function processDocument(controlDb: pg.Pool, task: RagTask, logger: Logger): Promise<void> {
  // Resolve the app's database pool — `apps` lives in the app's home region.
  const runtimePool = await getRuntimeDbForApp(controlDb, task.app_id);
  const appRow = await runtimePool.query<{ db_name: string }>(
    'SELECT db_name FROM apps WHERE id = $1',
    [task.app_id],
  );
  if (appRow.rows.length === 0) throw new NotFoundError('app', task.app_id);
  const appPool = await getAppPoolForApp(controlDb, task.app_id, appRow.rows[0].db_name);

  // Get the document details
  const docResult = await appPool.query<{
    id: string;
    collection_id: string;
    source_type: string;
    s3_key: string | null;
    content_type: string | null;
    user_id: string | null;
    metadata: Record<string, unknown>;
  }>(
    'SELECT id, collection_id, source_type, s3_key, content_type, user_id, metadata FROM _rag_documents WHERE id = $1',
    [task.document_id],
  );
  if (docResult.rows.length === 0) throw new NotFoundError('document', task.document_id);
  const doc = docResult.rows[0];

  // Update document status to processing
  await appPool.query(
    "UPDATE _rag_documents SET status = 'processing' WHERE id = $1",
    [doc.id],
  );

  // Get collection config for chunking params
  const collResult = await appPool.query<{
    embedding_model: string;
    embedding_dimensions: number;
    chunk_size: number;
    chunk_overlap: number;
  }>(
    'SELECT embedding_model, embedding_dimensions, chunk_size, chunk_overlap FROM _rag_collections WHERE id = $1',
    [doc.collection_id],
  );
  if (collResult.rows.length === 0) throw new NotFoundError('rag_collection', doc.collection_id);
  const collection = collResult.rows[0];

  // Step 1: Download and parse the document
  let text: string;
  if (doc.s3_key) {
    const buffer = await downloadObject(doc.s3_key);
    const contentType = doc.content_type || 'text/plain';
    text = await parseDocument(buffer, contentType);
  } else {
    throw new Error('Document has no S3 key');
  }

  if (!text || text.trim().length === 0) {
    // Mark as ready with 0 chunks — empty document
    await appPool.query(
      "UPDATE _rag_documents SET status = 'ready', chunk_count = 0 WHERE id = $1",
      [doc.id],
    );
    return;
  }

  // Step 2: Chunk the text
  const chunks = chunkText(text, {
    chunkSize: collection.chunk_size,
    chunkOverlap: collection.chunk_overlap,
  });

  if (chunks.length === 0) {
    await appPool.query(
      "UPDATE _rag_documents SET status = 'ready', chunk_count = 0 WHERE id = $1",
      [doc.id],
    );
    return;
  }

  logger.info({ documentId: doc.id, chunkCount: chunks.length }, '[rag-worker] Chunked document');

  // Step 3: Batch embed chunks
  const allEmbeddings: number[][] = [];
  for (let i = 0; i < chunks.length; i += EMBEDDING_BATCH_SIZE) {
    const batch = chunks.slice(i, i + EMBEDDING_BATCH_SIZE);
    const inputs = batch.map(c => c.content);

    const embeddingResponse = await proxyEmbedding(controlDb, task.app_id, null, {
      model: `openai/${collection.embedding_model}`,
      input: inputs,
    });

    const embeddingData = await embeddingResponse.json() as {
      data: Array<{ embedding: number[] }>;
    };

    for (const item of embeddingData.data) {
      allEmbeddings.push(item.embedding);
    }
  }

  logger.info({ documentId: doc.id, embeddingCount: allEmbeddings.length }, '[rag-worker] Generated embeddings');

  // Step 4: Insert chunks into app database
  const client = await appPool.connect();
  try {
    await client.query('BEGIN');
    // Use service role to bypass RLS
    await client.query("SET LOCAL ROLE butterbase_service");

    for (let i = 0; i < chunks.length; i++) {
      const chunk = chunks[i];
      const embedding = allEmbeddings[i];
      const vectorStr = `[${embedding.join(',')}]`;

      await client.query(
        `INSERT INTO _rag_chunks (document_id, collection_id, content, embedding, chunk_index, token_count, user_id, metadata)
         VALUES ($1, $2, $3, $4::vector, $5, $6, $7, $8)`,
        [
          doc.id,
          doc.collection_id,
          chunk.content,
          vectorStr,
          chunk.chunkIndex,
          chunk.tokenCount,
          doc.user_id,
          JSON.stringify(doc.metadata || {}),
        ],
      );
    }

    // Update document status
    await client.query(
      "UPDATE _rag_documents SET status = 'ready', chunk_count = $1 WHERE id = $2",
      [chunks.length, doc.id],
    );

    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }

  logger.info({ documentId: doc.id, chunkCount: chunks.length }, '[rag-worker] Document ingested');
}

/**
 * Update document status in the app's database.
 * Best-effort: won't throw if the update fails.
 */
async function updateDocumentStatus(
  controlDb: pg.Pool,
  appId: string,
  documentId: string,
  status: string,
  errorMessage?: string,
): Promise<void> {
  try {
    // `apps` lives in the app's home region's runtime DB.
    const runtimePool = await getRuntimeDbForApp(controlDb, appId);
    const appRow = await runtimePool.query<{ db_name: string }>(
      'SELECT db_name FROM apps WHERE id = $1',
      [appId],
    );
    if (appRow.rows.length === 0) return;

    const appPool = await getAppPoolForApp(controlDb, appId, appRow.rows[0].db_name);
    await appPool.query(
      'UPDATE _rag_documents SET status = $1, error_message = $2 WHERE id = $3',
      [status, errorMessage || null, documentId],
    );
  } catch {
    // Best-effort
  }
}
