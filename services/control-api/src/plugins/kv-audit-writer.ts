import type { FastifyPluginAsync, FastifyReply } from 'fastify';
import fp from 'fastify-plugin';

const KV_PATH_RE = /^\/v1\/([^/]+)\/kv\//;

function extractErrorFields(reply: FastifyReply): { errorCode: string | null; errorMessage: string | null } {
  const captured = (reply as any)._kvAuditCapturedBody;
  if (!captured || typeof captured !== 'object') return { errorCode: null, errorMessage: null };
  return {
    errorCode: typeof captured.error === 'string' ? captured.error : null,
    errorMessage: typeof captured.message === 'string' ? captured.message : null,
  };
}

const kvAuditWriter: FastifyPluginAsync = async (fastify) => {
  fastify.addHook('onSend', async (request, reply, payload) => {
    if (reply.statusCode < 400) return payload;
    if (!KV_PATH_RE.test(request.url)) return payload;
    try {
      const raw = typeof payload === 'string' ? payload : (payload as any)?.toString?.() ?? '';
      const parsed = raw ? JSON.parse(raw) : null;
      (reply as any)._kvAuditCapturedBody = parsed;
    } catch { /* not JSON */ }
    return payload;
  });

  fastify.addHook('onResponse', async (request, reply) => {
    if (reply.statusCode < 400) return;
    const m = KV_PATH_RE.exec(request.url);
    if (!m) return;
    const appId = m[1];
    const { errorCode, errorMessage } = extractErrorFields(reply);
    const actorId = (request as any).kvActorId ?? null;
    try {
      await (fastify as any).controlDb.query(
        `INSERT INTO audit_logs (app_id, method, path, status_code, error_code, error_message, actor_id, at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, now())`,
        [appId, request.method, request.url.split('?')[0], reply.statusCode, errorCode, errorMessage, actorId],
      );
    } catch (err) {
      fastify.log.warn({ err: (err as Error).message, app_id: appId }, '[kv-audit] failed to insert');
    }
  });
};

export default fp(kvAuditWriter, { name: 'kv-audit-writer' });
