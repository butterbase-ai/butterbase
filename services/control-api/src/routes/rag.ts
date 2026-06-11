import type { FastifyInstance } from 'fastify';
import type { Pool, PoolClient } from 'pg';
import { z } from 'zod';
import { getAppPoolForApp } from '../services/app-pool.js';
import { AppResolver, AppNotFoundError } from '../services/app-resolver.js';
import { verifyEndUserJwt } from '../services/end-user-auth.js';
import { uploadObject } from '../services/s3.js';
import { isSupportedContentType } from '../services/rag-parsers.js';
import { proxyEmbedding } from '../services/openrouter-gateway.js';
import { proxyChatCompletion } from '../services/openrouter-gateway.js';
import { createAgentError, getDocUrl, agentErrorFromEndUserJwtVerification } from '../services/error-handler.js';
import { logAuditEvent } from '../services/audit/audit-events-service.js';
import { randomUUID } from 'crypto';
import { getRuntimeDbForApp } from '../services/region-resolver.js';

// --- Schemas ---

const createCollectionSchema = z.object({
  name: z.string().min(1).max(100).regex(/^[a-z0-9_-]+$/, 'Collection name must be lowercase alphanumeric with hyphens/underscores'),
  description: z.string().max(500).optional(),
  accessMode: z.enum(['private', 'shared', 'custom']).optional().default('private'),
  chunkSize: z.number().int().min(100).max(4000).optional().default(512),
  chunkOverlap: z.number().int().min(0).max(500).optional().default(50),
});

const ingestSchema = z.object({
  storage_object_id: z.string().uuid().optional(),
  text: z.string().min(1).optional(),
  filename: z.string().max(255).optional(),
  metadata: z.record(z.unknown()).optional(),
}).refine(data => data.storage_object_id || data.text, {
  message: 'Either storage_object_id or text must be provided',
});

const querySchema = z.object({
  query: z.string().min(1).max(10000),
  topK: z.number().int().min(1).max(50).optional().default(5),
  threshold: z.number().min(0).max(1).optional().default(0.0),
  synthesize: z.boolean().optional().default(false),
  model: z.string().optional(),
  filter: z.record(z.unknown()).optional(),
});

// --- Auth helper ---

interface ResolvedAuth {
  pool: Pool;
  role: 'butterbase_anon' | 'butterbase_user' | 'butterbase_service';
  userId: string | null;
}

/**
 * Thrown when an auth method that the auth plugin accepted is nonetheless not
 * valid for this route family. Specifically: function_key carries the owner
 * UUID for downstream attribution but is scoped to /integrations/execute —
 * RAG routes must not accept it (otherwise a leaked FSK would let a stranger
 * read/write the owner's vector store and burn embedding credits).
 *
 * Each catch in this file maps this to a 401 with code AUTH_NOT_ACCEPTED_HERE.
 */
class AuthNotAcceptedHereError extends Error {
  constructor(public readonly authMethod: string) {
    super(`auth method '${authMethod}' is not accepted on RAG routes`);
    this.name = 'AuthNotAcceptedHereError';
  }
}

async function resolveAuth(
  controlDb: Pool,
  appId: string,
  auth: any,
): Promise<ResolvedAuth> {
  // function_key is scoped to /integrations/execute only — reject explicitly
  // so callers get a clean 401 (not a 500 from the generic throw below).
  if (auth.authMethod === 'function_key') {
    throw new AuthNotAcceptedHereError('function_key');
  }
  if (auth.authMethod === 'end_user_jwt') {
    const endUserClaims = await verifyEndUserJwt(controlDb, appId, auth.rawToken!);
    const resolved = await AppResolver.resolveAppPublic(controlDb, appId);
    return {
      pool: await getAppPoolForApp(controlDb, resolved.id, resolved.db_name),
      role: 'butterbase_user',
      userId: endUserClaims.sub,
    };
  } else if (auth.authMethod === 'api_key' || auth.authMethod === 'jwt') {
    const resolved = await AppResolver.resolveApp(controlDb, appId, auth.userId!);
    return {
      pool: await getAppPoolForApp(controlDb, resolved.id, resolved.db_name),
      role: 'butterbase_service',
      userId: auth.userId,
    };
  }
  throw new Error('Authentication required');
}

async function executeWithRole<T>(
  pool: Pool,
  role: string,
  userId: string | null,
  fn: (client: PoolClient) => Promise<T>,
): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(`SET LOCAL ROLE ${role}`);
    await client.query(`SET LOCAL app.role = '${role}'`);
    if (role === 'butterbase_user' && userId) {
      await client.query(`SET LOCAL request.jwt.claim.sub = '${userId.replace(/'/g, "''")}'`);
    }
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

// --- Route registration ---

export async function ragRoutes(app: FastifyInstance) {
  // Resolve home region per-app: rag_ingestion_queue and per-app rows live
  // in the app's home runtime DB, which may differ from this machine's region.
  const runtimeDb = (appId: string) => getRuntimeDbForApp(app.controlDb, appId);
  // ==========================================
  // POST /v1/:appId/rag/collections — Create collection
  // ==========================================
  app.post<{ Params: { appId: string } }>(
    '/v1/:appId/rag/collections',
    { config: { requiresAppRegion: true, migrationGuard: true } },
    async (request, reply) => {
      const { appId } = request.params;
      const auth = request.auth;
      if (!auth?.userId) {
        return reply.status(401).send(createAgentError({
          code: 'AUTH_REQUIRED',
          message: 'Authentication required',
          remediation: 'Provide an API key or platform JWT.',
        }));
      }

      // Only service-level auth can create collections
      if (auth.authMethod === 'end_user_jwt') {
        return reply.status(403).send(createAgentError({
          code: 'AUTH_FORBIDDEN',
          message: 'Collection creation requires service-level authentication',
          remediation: 'Use an API key or platform JWT to create collections.',
        }));
      }

      const parseResult = createCollectionSchema.safeParse(request.body);
      if (!parseResult.success) {
        return reply.status(400).send(createAgentError({
          code: 'VALIDATION_INVALID_SCHEMA',
          message: 'Invalid collection parameters',
          remediation: 'Check name (lowercase alphanumeric), accessMode, chunkSize, chunkOverlap.',
          details: { validation_errors: parseResult.error.errors },
        }));
      }
      const body = parseResult.data;

      try {
        const { pool } = await resolveAuth(app.controlDb, appId, auth);

        // Insert the collection record using the role-switched transaction
        const result = await executeWithRole(pool, 'butterbase_service', null, async (client) => {
          // Check for duplicate
          const existing = await client.query(
            'SELECT id FROM _rag_collections WHERE name = $1',
            [body.name],
          );
          if (existing.rows.length > 0) {
            throw Object.assign(new Error(`Collection "${body.name}" already exists`), { code: 'DUPLICATE' });
          }

          // Create collection
          const res = await client.query(
            `INSERT INTO _rag_collections (name, description, access_mode, chunk_size, chunk_overlap, created_by)
             VALUES ($1, $2, $3, $4, $5, $6)
             RETURNING *`,
            [body.name, body.description || null, body.accessMode, body.chunkSize, body.chunkOverlap, auth.userId],
          );
          return res.rows[0];
        });

        // Apply RLS policies as the pool owner (DDL requires table ownership — not role-switched)
        const policyClient = await pool.connect();
        try {
          const colId = result.id.replace(/-/g, '');
          if (body.accessMode === 'private') {
            await policyClient.query(`
              CREATE POLICY rag_docs_private_${colId}
              ON _rag_documents FOR ALL TO butterbase_user
              USING (user_id = current_user_id() AND collection_id = '${result.id}')
              WITH CHECK (collection_id = '${result.id}')
            `);
            await policyClient.query(`
              CREATE POLICY rag_chunks_private_${colId}
              ON _rag_chunks FOR ALL TO butterbase_user
              USING (user_id = current_user_id() AND collection_id = '${result.id}')
            `);
          } else if (body.accessMode === 'shared') {
            await policyClient.query(`
              CREATE POLICY rag_docs_shared_${colId}
              ON _rag_documents FOR SELECT TO butterbase_user
              USING (collection_id = '${result.id}')
            `);
            await policyClient.query(`
              CREATE POLICY rag_docs_shared_insert_${colId}
              ON _rag_documents FOR INSERT TO butterbase_user
              WITH CHECK (collection_id = '${result.id}')
            `);
            await policyClient.query(`
              CREATE POLICY rag_chunks_shared_${colId}
              ON _rag_chunks FOR SELECT TO butterbase_user
              USING (collection_id = '${result.id}')
            `);
          }
          // custom: no auto-policies
        } finally {
          policyClient.release();
        }

        logAuditEvent(app.controlDb, {
          appId,
          category: 'admin',
          eventType: 'rag.collection.create',
          action: 'create',
          resourceType: 'rag_collection',
          resourceId: result.id,
          actorType: auth.authMethod === 'api_key' ? 'api_key' : 'platform_user',
          actorId: auth.userId,
          success: true,
          eventData: { name: body.name, accessMode: body.accessMode },
        }).catch(() => {});

        return reply.status(201).send(result);
      } catch (error: any) {
        if (error instanceof AuthNotAcceptedHereError) {
          return reply.status(401).send(createAgentError({
            code: 'AUTH_REQUIRED',
            message: `Auth method '${error.authMethod}' is not accepted on RAG routes`,
            remediation: 'Use an API key, platform JWT, or end-user JWT.',
          }));
        }
        if (error.code === 'DUPLICATE') {
          return reply.status(409).send(createAgentError({
            code: 'RESOURCE_CONFLICT',
            message: error.message,
            remediation: 'Choose a different collection name.',
          }));
        }
        if (error instanceof AppNotFoundError) {
          return reply.status(404).send(createAgentError({
            code: 'RESOURCE_NOT_FOUND',
            message: `App not found: ${appId}`,
            remediation: 'Verify the app_id is correct.',
          }));
        }
        request.log.error({ err: error }, 'Failed to create RAG collection');
        return reply.status(500).send(createAgentError({
          code: 'INTERNAL_ERROR',
          message: 'Failed to create collection',
          remediation: 'Check server logs.',
        }));
      }
    },
  );

  // ==========================================
  // GET /v1/:appId/rag/collections — List collections
  // ==========================================
  app.get<{ Params: { appId: string } }>(
    '/v1/:appId/rag/collections',
    { config: { requiresAppRegion: true, migrationGuard: true } },
    async (request, reply) => {
      const { appId } = request.params;
      const auth = request.auth;
      if (!auth?.userId && auth?.authMethod !== 'end_user_jwt') {
        return reply.status(401).send(createAgentError({ code: 'AUTH_REQUIRED', message: 'Authentication required', remediation: 'Provide an API key, platform JWT, or end-user JWT.' }));
      }

      try {
        const { pool, role, userId } = await resolveAuth(app.controlDb, appId, auth);
        const collections = await executeWithRole(pool, role, userId, async (client) => {
          const res = await client.query('SELECT * FROM _rag_collections ORDER BY created_at DESC');
          return res.rows;
        });
        return reply.send(collections);
      } catch (error: any) {
        if (error instanceof AuthNotAcceptedHereError) {
          return reply.status(401).send(createAgentError({
            code: 'AUTH_REQUIRED',
            message: `Auth method '${error.authMethod}' is not accepted on RAG routes`,
            remediation: 'Use an API key, platform JWT, or end-user JWT.',
          }));
        }
        if (error instanceof AppNotFoundError) {
          return reply.status(404).send(createAgentError({ code: 'RESOURCE_NOT_FOUND', message: `App not found: ${appId}`, remediation: 'Verify the app_id is correct.' }));
        }
        request.log.error({ err: error }, 'Failed to list RAG collections');
        return reply.status(500).send(createAgentError({ code: 'INTERNAL_ERROR', message: 'Failed to list collections', remediation: 'Check server logs.' }));
      }
    },
  );

  // ==========================================
  // GET /v1/:appId/rag/collections/:name — Get collection details
  // ==========================================
  app.get<{ Params: { appId: string; name: string } }>(
    '/v1/:appId/rag/collections/:name',
    { config: { requiresAppRegion: true, migrationGuard: true } },
    async (request, reply) => {
      const { appId, name } = request.params;
      const auth = request.auth;
      if (!auth?.userId && auth?.authMethod !== 'end_user_jwt') {
        return reply.status(401).send(createAgentError({ code: 'AUTH_REQUIRED', message: 'Authentication required', remediation: 'Provide an API key, platform JWT, or end-user JWT.' }));
      }

      try {
        const { pool, role, userId } = await resolveAuth(app.controlDb, appId, auth);
        const result = await executeWithRole(pool, role, userId, async (client) => {
          const collRes = await client.query('SELECT * FROM _rag_collections WHERE name = $1', [name]);
          if (collRes.rows.length === 0) return null;
          const collection = collRes.rows[0];

          // Get document counts by status
          const countRes = await client.query(
            `SELECT status, COUNT(*) as count FROM _rag_documents WHERE collection_id = $1 GROUP BY status`,
            [collection.id],
          );
          const counts: Record<string, number> = { total: 0, pending: 0, processing: 0, ready: 0, failed: 0 };
          for (const row of countRes.rows) {
            counts[row.status] = parseInt(row.count);
            counts.total += parseInt(row.count);
          }

          return { ...collection, document_counts: counts };
        });

        if (!result) {
          return reply.status(404).send(createAgentError({
            code: 'RESOURCE_NOT_FOUND',
            message: `Collection "${name}" not found`,
            remediation: 'Check the collection name and try again.',
          }));
        }
        return reply.send(result);
      } catch (error: any) {
        if (error instanceof AuthNotAcceptedHereError) {
          return reply.status(401).send(createAgentError({
            code: 'AUTH_REQUIRED',
            message: `Auth method '${error.authMethod}' is not accepted on RAG routes`,
            remediation: 'Use an API key, platform JWT, or end-user JWT.',
          }));
        }
        if (error instanceof AppNotFoundError) {
          return reply.status(404).send(createAgentError({ code: 'RESOURCE_NOT_FOUND', message: `App not found: ${appId}`, remediation: 'Verify the app_id is correct.' }));
        }
        request.log.error({ err: error }, 'Failed to get RAG collection');
        return reply.status(500).send(createAgentError({ code: 'INTERNAL_ERROR', message: 'Failed to get collection', remediation: 'Check server logs.' }));
      }
    },
  );

  // ==========================================
  // DELETE /v1/:appId/rag/collections/:name — Delete collection
  // ==========================================
  app.delete<{ Params: { appId: string; name: string } }>(
    '/v1/:appId/rag/collections/:name',
    { config: { requiresAppRegion: true, migrationGuard: true } },
    async (request, reply) => {
      const { appId, name } = request.params;
      const auth = request.auth;
      if (!auth?.userId || auth.authMethod === 'end_user_jwt') {
        return reply.status(403).send(createAgentError({
          code: 'AUTH_FORBIDDEN',
          message: 'Collection deletion requires service-level authentication',
          remediation: 'Use an API key or platform JWT.',
        }));
      }

      try {
        // Fetch collection info first
        const { pool } = await resolveAuth(app.controlDb, appId, auth);
        const collRes = await pool.query('SELECT id, access_mode FROM _rag_collections WHERE name = $1', [name]);
        if (collRes.rows.length === 0) {
          return reply.status(404).send(createAgentError({
            code: 'RESOURCE_NOT_FOUND',
            message: `Collection "${name}" not found`,
            remediation: 'Check the collection name and try again.',
          }));
        }
        const collectionId = collRes.rows[0].id;
        const idClean = collectionId.replace(/-/g, '');

        // Drop RLS policies as pool owner (DDL requires table ownership)
        const policyClient = await pool.connect();
        try {
          const accessMode = collRes.rows[0].access_mode;
          if (accessMode === 'private') {
            await policyClient.query(`DROP POLICY IF EXISTS rag_docs_private_${idClean} ON _rag_documents`);
            await policyClient.query(`DROP POLICY IF EXISTS rag_chunks_private_${idClean} ON _rag_chunks`);
          } else if (accessMode === 'shared') {
            await policyClient.query(`DROP POLICY IF EXISTS rag_docs_shared_${idClean} ON _rag_documents`);
            await policyClient.query(`DROP POLICY IF EXISTS rag_docs_shared_insert_${idClean} ON _rag_documents`);
            await policyClient.query(`DROP POLICY IF EXISTS rag_chunks_shared_${idClean} ON _rag_chunks`);
          }
        } finally {
          policyClient.release();
        }

        // Delete collection row (CASCADE removes documents and chunks)
        await executeWithRole(pool, 'butterbase_service', null, async (client) => {
          await client.query('DELETE FROM _rag_collections WHERE id = $1', [collectionId]);
        });

        // Clean up queue entries (rag_ingestion_queue is runtime-tier)
        await (await runtimeDb(appId)).query(
          `DELETE FROM rag_ingestion_queue WHERE app_id = $1 AND collection_id IN (
            SELECT id::text FROM (SELECT $2::uuid AS id) t
          )`,
          [appId, name],
        ).catch(() => {});

        logAuditEvent(app.controlDb, {
          appId,
          category: 'admin',
          eventType: 'rag.collection.delete',
          action: 'delete',
          resourceType: 'rag_collection',
          actorType: auth.authMethod === 'api_key' ? 'api_key' : 'platform_user',
          actorId: auth.userId,
          success: true,
          eventData: { name },
        }).catch(() => {});

        return reply.status(204).send();
      } catch (error: any) {
        if (error instanceof AuthNotAcceptedHereError) {
          return reply.status(401).send(createAgentError({
            code: 'AUTH_REQUIRED',
            message: `Auth method '${error.authMethod}' is not accepted on RAG routes`,
            remediation: 'Use an API key, platform JWT, or end-user JWT.',
          }));
        }
        if (error.code === 'NOT_FOUND') {
          return reply.status(404).send(createAgentError({
            code: 'RESOURCE_NOT_FOUND',
            message: `Collection "${name}" not found`,
            remediation: 'Check the collection name and try again.',
          }));
        }
        if (error instanceof AppNotFoundError) {
          return reply.status(404).send(createAgentError({ code: 'RESOURCE_NOT_FOUND', message: `App not found: ${appId}`, remediation: 'Verify the app_id is correct.' }));
        }
        request.log.error({ err: error }, 'Failed to delete RAG collection');
        return reply.status(500).send(createAgentError({ code: 'INTERNAL_ERROR', message: 'Failed to delete collection', remediation: 'Check server logs.' }));
      }
    },
  );

  // ==========================================
  // POST /v1/:appId/rag/collections/:name/ingest — Ingest file or text
  // ==========================================
  app.post<{ Params: { appId: string; name: string } }>(
    '/v1/:appId/rag/collections/:name/ingest',
    { config: { requiresAppRegion: true, migrationGuard: true } },
    async (request, reply) => {
      const { appId, name } = request.params;
      const auth = request.auth;
      if (!auth?.userId && auth?.authMethod !== 'end_user_jwt') {
        return reply.status(401).send(createAgentError({ code: 'AUTH_REQUIRED', message: 'Authentication required', remediation: 'Provide an API key, platform JWT, or end-user JWT.' }));
      }

      const parseResult = ingestSchema.safeParse(request.body);
      if (!parseResult.success) {
        return reply.status(400).send(createAgentError({
          code: 'VALIDATION_INVALID_SCHEMA',
          message: 'Invalid ingest request',
          remediation: 'Provide either storage_object_id (UUID of an uploaded file) or text (raw content).',
          details: { validation_errors: parseResult.error.errors },
        }));
      }
      const body = parseResult.data;

      try {
        const { pool, role, userId } = await resolveAuth(app.controlDb, appId, auth);

        // Resolve collection
        const collResult = await pool.query(
          'SELECT id, access_mode FROM _rag_collections WHERE name = $1',
          [name],
        );
        if (collResult.rows.length === 0) {
          return reply.status(404).send(createAgentError({
            code: 'RESOURCE_NOT_FOUND',
            message: `Collection "${name}" not found`,
            remediation: 'Check the collection name and try again.',
          }));
        }
        const collection = collResult.rows[0];

        let s3Key: string | null = null;
        let contentType: string = 'text/plain';
        let sourceType: string = 'text';
        let filename: string | null = body.filename || null;

        if (body.storage_object_id) {
          // Look up the storage object (storage_objects is a runtime-tier table)
          const objResult = await (await runtimeDb(appId)).query<{
            key: string;
            content_type: string;
            filename: string;
          }>(
            'SELECT key, content_type, filename FROM storage_objects WHERE id = $1 AND app_id = $2',
            [body.storage_object_id, appId],
          );

          if (objResult.rows.length === 0) {
            return reply.status(404).send(createAgentError({
              code: 'RESOURCE_NOT_FOUND',
              message: 'Storage object not found',
              remediation: 'Upload a file first using the storage upload endpoint, then pass the object_id.',
            }));
          }

          const obj = objResult.rows[0];
          s3Key = obj.key;
          contentType = obj.content_type;
          sourceType = 'file';
          filename = filename || obj.filename;

          if (!isSupportedContentType(contentType)) {
            return reply.status(400).send(createAgentError({
              code: 'VALIDATION_INVALID_TYPE',
              message: `Unsupported file type: ${contentType}`,
              remediation: 'Supported types: PDF, TXT, MD, CSV, HTML, DOCX, XLSX, PPTX.',
            }));
          }
        } else if (body.text) {
          // Store raw text in S3
          const docId = randomUUID();
          s3Key = `${appId}/rag/${docId}.txt`;
          await uploadObject(s3Key, Buffer.from(body.text, 'utf-8'), 'text/plain');
          contentType = 'text/plain';
          sourceType = 'text';
          filename = filename || 'inline-text.txt';
        }

        // Create document record
        const docId = randomUUID();
        await executeWithRole(pool, 'butterbase_service', null, async (client) => {
          await client.query(
            `INSERT INTO _rag_documents (id, collection_id, filename, content_type, source_type, status, s3_key, user_id, metadata)
             VALUES ($1, $2, $3, $4, $5, 'pending', $6, $7, $8)`,
            [docId, collection.id, filename, contentType, sourceType, s3Key, userId, JSON.stringify(body.metadata || {})],
          );
        });

        // Enqueue for processing (rag_ingestion_queue is runtime-tier)
        await (await runtimeDb(appId)).query(
          `INSERT INTO rag_ingestion_queue (app_id, document_id, collection_id)
           VALUES ($1, $2, $3)`,
          [appId, docId, collection.id],
        );

        logAuditEvent(app.controlDb, {
          appId,
          category: 'admin',
          eventType: 'rag.ingest',
          action: 'create',
          resourceType: 'rag_document',
          resourceId: docId,
          actorType: auth.authMethod === 'end_user_jwt' ? 'app_user' : (auth.authMethod === 'api_key' ? 'api_key' : 'platform_user'),
          actorId: userId,
          success: true,
          eventData: { collection: name, filename, sourceType },
        }).catch(() => {});

        return reply.status(202).send({
          documentId: docId,
          status: 'pending',
          collection: name,
        });
      } catch (error: any) {
        if (error instanceof AuthNotAcceptedHereError) {
          return reply.status(401).send(createAgentError({
            code: 'AUTH_REQUIRED',
            message: `Auth method '${error.authMethod}' is not accepted on RAG routes`,
            remediation: 'Use an API key, platform JWT, or end-user JWT.',
          }));
        }
        if (error instanceof AppNotFoundError) {
          return reply.status(404).send(createAgentError({ code: 'RESOURCE_NOT_FOUND', message: `App not found: ${appId}`, remediation: 'Verify the app_id is correct.' }));
        }
        request.log.error({ err: error }, 'Failed to ingest RAG document');
        return reply.status(500).send(createAgentError({ code: 'INTERNAL_ERROR', message: 'Failed to ingest document', remediation: 'Check server logs.' }));
      }
    },
  );

  // ==========================================
  // GET /v1/:appId/rag/collections/:name/documents — List documents
  // ==========================================
  app.get<{ Params: { appId: string; name: string } }>(
    '/v1/:appId/rag/collections/:name/documents',
    { config: { requiresAppRegion: true, migrationGuard: true } },
    async (request, reply) => {
      const { appId, name } = request.params;
      const auth = request.auth;
      if (!auth?.userId && auth?.authMethod !== 'end_user_jwt') {
        return reply.status(401).send(createAgentError({ code: 'AUTH_REQUIRED', message: 'Authentication required', remediation: 'Provide an API key, platform JWT, or end-user JWT.' }));
      }

      try {
        const { pool, role, userId } = await resolveAuth(app.controlDb, appId, auth);

        const documents = await executeWithRole(pool, role, userId, async (client) => {
          const collRes = await client.query('SELECT id FROM _rag_collections WHERE name = $1', [name]);
          if (collRes.rows.length === 0) {
            throw Object.assign(new Error('not_found'), { code: 'NOT_FOUND' });
          }

          const res = await client.query(
            `SELECT id, filename, content_type, source_type, status, error_message, chunk_count, metadata, created_at
             FROM _rag_documents WHERE collection_id = $1 ORDER BY created_at DESC`,
            [collRes.rows[0].id],
          );
          return res.rows;
        });

        return reply.send(documents);
      } catch (error: any) {
        if (error instanceof AuthNotAcceptedHereError) {
          return reply.status(401).send(createAgentError({
            code: 'AUTH_REQUIRED',
            message: `Auth method '${error.authMethod}' is not accepted on RAG routes`,
            remediation: 'Use an API key, platform JWT, or end-user JWT.',
          }));
        }
        if (error.code === 'NOT_FOUND') {
          return reply.status(404).send(createAgentError({ code: 'RESOURCE_NOT_FOUND', message: `Collection "${name}" not found`, remediation: 'Use rag_list_collections to see available collections.' }));
        }
        if (error instanceof AppNotFoundError) {
          return reply.status(404).send(createAgentError({ code: 'RESOURCE_NOT_FOUND', message: `App not found: ${appId}`, remediation: 'Verify the app_id is correct.' }));
        }
        request.log.error({ err: error }, 'Failed to list RAG documents');
        return reply.status(500).send(createAgentError({ code: 'INTERNAL_ERROR', message: 'Failed to list documents', remediation: 'Check server logs.' }));
      }
    },
  );

  // ==========================================
  // GET /v1/:appId/rag/collections/:name/documents/:id — Get document
  // ==========================================
  app.get<{ Params: { appId: string; name: string; id: string } }>(
    '/v1/:appId/rag/collections/:name/documents/:id',
    { config: { requiresAppRegion: true, migrationGuard: true } },
    async (request, reply) => {
      const { appId, name, id: docId } = request.params;
      const auth = request.auth;
      if (!auth?.userId && auth?.authMethod !== 'end_user_jwt') {
        return reply.status(401).send(createAgentError({ code: 'AUTH_REQUIRED', message: 'Authentication required', remediation: 'Provide an API key, platform JWT, or end-user JWT.' }));
      }

      try {
        const { pool, role, userId } = await resolveAuth(app.controlDb, appId, auth);

        const document = await executeWithRole(pool, role, userId, async (client) => {
          const res = await client.query(
            `SELECT d.id, d.filename, d.content_type, d.source_type, d.status, d.error_message,
                    d.chunk_count, d.metadata, d.created_at, c.name as collection_name
             FROM _rag_documents d
             JOIN _rag_collections c ON c.id = d.collection_id
             WHERE d.id = $1 AND c.name = $2`,
            [docId, name],
          );
          return res.rows[0] || null;
        });

        if (!document) {
          return reply.status(404).send(createAgentError({
            code: 'RESOURCE_NOT_FOUND',
            message: `Document not found`,
            remediation: 'Verify the document ID and collection name.',
          }));
        }
        return reply.send(document);
      } catch (error: any) {
        if (error instanceof AuthNotAcceptedHereError) {
          return reply.status(401).send(createAgentError({
            code: 'AUTH_REQUIRED',
            message: `Auth method '${error.authMethod}' is not accepted on RAG routes`,
            remediation: 'Use an API key, platform JWT, or end-user JWT.',
          }));
        }
        if (error instanceof AppNotFoundError) {
          return reply.status(404).send(createAgentError({ code: 'RESOURCE_NOT_FOUND', message: `App not found: ${appId}`, remediation: 'Verify the app_id is correct.' }));
        }
        request.log.error({ err: error }, 'Failed to get RAG document');
        return reply.status(500).send(createAgentError({ code: 'INTERNAL_ERROR', message: 'Failed to get document', remediation: 'Check server logs.' }));
      }
    },
  );

  // ==========================================
  // DELETE /v1/:appId/rag/collections/:name/documents/:id — Delete document
  // ==========================================
  app.delete<{ Params: { appId: string; name: string; id: string } }>(
    '/v1/:appId/rag/collections/:name/documents/:id',
    { config: { requiresAppRegion: true, migrationGuard: true } },
    async (request, reply) => {
      const { appId, name, id: docId } = request.params;
      const auth = request.auth;
      if (!auth?.userId && auth?.authMethod !== 'end_user_jwt') {
        return reply.status(401).send(createAgentError({ code: 'AUTH_REQUIRED', message: 'Authentication required', remediation: 'Provide an API key, platform JWT, or end-user JWT.' }));
      }

      try {
        const { pool, role, userId } = await resolveAuth(app.controlDb, appId, auth);

        await executeWithRole(pool, role, userId, async (client) => {
          const res = await client.query(
            `DELETE FROM _rag_documents d
             USING _rag_collections c
             WHERE d.id = $1 AND d.collection_id = c.id AND c.name = $2
             RETURNING d.id`,
            [docId, name],
          );
          if (res.rows.length === 0) {
            throw Object.assign(new Error('not_found'), { code: 'NOT_FOUND' });
          }
        });

        // Clean up queue entries (rag_ingestion_queue is runtime-tier)
        await (await runtimeDb(appId)).query(
          "DELETE FROM rag_ingestion_queue WHERE app_id = $1 AND document_id = $2",
          [appId, docId],
        ).catch(() => {});

        return reply.status(204).send();
      } catch (error: any) {
        if (error instanceof AuthNotAcceptedHereError) {
          return reply.status(401).send(createAgentError({
            code: 'AUTH_REQUIRED',
            message: `Auth method '${error.authMethod}' is not accepted on RAG routes`,
            remediation: 'Use an API key, platform JWT, or end-user JWT.',
          }));
        }
        if (error.code === 'NOT_FOUND') {
          return reply.status(404).send(createAgentError({ code: 'RESOURCE_NOT_FOUND', message: 'Document not found', remediation: 'Use rag_list_documents to see available documents.' }));
        }
        if (error instanceof AppNotFoundError) {
          return reply.status(404).send(createAgentError({ code: 'RESOURCE_NOT_FOUND', message: `App not found: ${appId}`, remediation: 'Verify the app_id is correct.' }));
        }
        request.log.error({ err: error }, 'Failed to delete RAG document');
        return reply.status(500).send(createAgentError({ code: 'INTERNAL_ERROR', message: 'Failed to delete document', remediation: 'Check server logs.' }));
      }
    },
  );

  // ==========================================
  // POST /v1/:appId/rag/collections/:name/query — Query collection
  // ==========================================
  app.post<{ Params: { appId: string; name: string } }>(
    '/v1/:appId/rag/collections/:name/query',
    { config: { requiresAppRegion: true, migrationGuard: true } },
    async (request, reply) => {
      const { appId, name } = request.params;
      const auth = request.auth;
      if (!auth?.userId && auth?.authMethod !== 'end_user_jwt') {
        return reply.status(401).send(createAgentError({ code: 'AUTH_REQUIRED', message: 'Authentication required', remediation: 'Provide an API key, platform JWT, or end-user JWT.' }));
      }

      const parseResult = querySchema.safeParse(request.body);
      if (!parseResult.success) {
        return reply.status(400).send(createAgentError({
          code: 'VALIDATION_INVALID_SCHEMA',
          message: 'Invalid query parameters',
          remediation: 'Provide a query string and valid optional parameters.',
          details: { validation_errors: parseResult.error.errors },
        }));
      }
      const body = parseResult.data;

      try {
        const { pool, role, userId } = await resolveAuth(app.controlDb, appId, auth);

        // Get collection
        const collResult = await pool.query(
          'SELECT id, embedding_model, embedding_dimensions FROM _rag_collections WHERE name = $1',
          [name],
        );
        if (collResult.rows.length === 0) {
          return reply.status(404).send(createAgentError({
            code: 'RESOURCE_NOT_FOUND',
            message: `Collection "${name}" not found`,
            remediation: 'Check the collection name and try again.',
          }));
        }
        const collection = collResult.rows[0];

        // Step 1: Embed the query
        const embeddingResponse = await proxyEmbedding(app.controlDb, appId, userId, {
          model: `openai/${collection.embedding_model}`,
          input: body.query,
        });
        const embeddingData = await embeddingResponse.json() as {
          data: Array<{ embedding: number[] }>;
        };
        const queryEmbedding = embeddingData.data[0].embedding;
        const vectorStr = `[${queryEmbedding.join(',')}]`;

        // Step 2: Similarity search with RLS
        const chunks = await executeWithRole(pool, role, userId, async (client) => {
          const params: any[] = [vectorStr, collection.id, body.threshold, body.topK];
          let filterClause = '';
          if (body.filter && Object.keys(body.filter).length > 0) {
            filterClause = 'AND c.metadata @> $5::jsonb';
            params.push(JSON.stringify(body.filter));
          }

          const res = await client.query(
            `SELECT c.id, c.content, c.metadata, c.chunk_index, c.document_id,
                    d.filename,
                    1 - (c.embedding <=> $1::vector) AS score
             FROM _rag_chunks c
             JOIN _rag_documents d ON d.id = c.document_id
             WHERE c.collection_id = $2
               AND 1 - (c.embedding <=> $1::vector) > $3
               ${filterClause}
             ORDER BY c.embedding <=> $1::vector
             LIMIT $4`,
            params,
          );
          return res.rows;
        });

        const responseChunks = chunks.map((c: any) => ({
          id: c.id,
          content: c.content,
          score: parseFloat(c.score),
          document: { id: c.document_id, filename: c.filename },
          metadata: c.metadata,
        }));

        // Step 3: Optional synthesis
        if (body.synthesize && responseChunks.length > 0) {
          const context = responseChunks
            .map((c: any, i: number) => `[Source ${i + 1}: ${c.document.filename}]\n${c.content}`)
            .join('\n\n');

          const chatResponse = await proxyChatCompletion(app.controlDb, appId, userId, {
            model: body.model || 'anthropic/claude-haiku-4.5',
            messages: [
              {
                role: 'system',
                content: `Answer the user's question based only on the following context. If the context doesn't contain enough information, say so. Cite your sources by referencing [Source N].\n\nContext:\n${context}`,
              },
              { role: 'user', content: body.query },
            ],
          });

          const chatData = await chatResponse.json() as {
            choices: Array<{ message: { content: string } }>;
            usage?: { prompt_tokens: number; completion_tokens: number };
          };

          logAuditEvent(app.controlDb, {
            appId,
            category: 'admin',
            eventType: 'rag.query',
            action: 'invoke',
            resourceType: 'rag_collection',
            resourceId: collection.id,
            actorType: auth.authMethod === 'end_user_jwt' ? 'app_user' : (auth.authMethod === 'api_key' ? 'api_key' : 'platform_user'),
            actorId: userId,
            success: true,
            eventData: { collection: name, synthesize: true, chunkCount: responseChunks.length },
          }).catch(() => {});

          return reply.send({
            answer: chatData.choices?.[0]?.message?.content || '',
            chunks: responseChunks,
            model: body.model || 'anthropic/claude-haiku-4.5',
            usage: chatData.usage || null,
          });
        }

        logAuditEvent(app.controlDb, {
          appId,
          category: 'admin',
          eventType: 'rag.query',
          action: 'invoke',
          resourceType: 'rag_collection',
          resourceId: collection.id,
          actorType: auth.authMethod === 'end_user_jwt' ? 'app_user' : (auth.authMethod === 'api_key' ? 'api_key' : 'platform_user'),
          actorId: userId,
          success: true,
          eventData: { collection: name, synthesize: false, chunkCount: responseChunks.length },
        }).catch(() => {});

        return reply.send({ chunks: responseChunks });
      } catch (error: any) {
        if (error instanceof AuthNotAcceptedHereError) {
          return reply.status(401).send(createAgentError({
            code: 'AUTH_REQUIRED',
            message: `Auth method '${error.authMethod}' is not accepted on RAG routes`,
            remediation: 'Use an API key, platform JWT, or end-user JWT.',
          }));
        }
        if (error instanceof AppNotFoundError) {
          return reply.status(404).send(createAgentError({ code: 'RESOURCE_NOT_FOUND', message: `App not found: ${appId}`, remediation: 'Verify the app_id is correct.' }));
        }
        // Check for AI credit limit
        if (error.code === 'RATE_LIMITED' || error.statusCode === 429) {
          return reply.status(402).send(createAgentError({
            code: 'QUOTA_EXCEEDED',
            message: 'AI credit limit reached. Cannot generate embeddings for query.',
            remediation: 'Upgrade your plan or wait for your billing period to reset.',
          }));
        }
        request.log.error({ err: error }, 'Failed to query RAG collection');
        return reply.status(500).send(createAgentError({ code: 'INTERNAL_ERROR', message: 'Failed to query collection', remediation: 'Check server logs.' }));
      }
    },
  );
}
