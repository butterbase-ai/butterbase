import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { requireAdmin } from './admin-auth.js';
import { encrypt } from '../services/crypto.js';
import { renderAuthTemplate } from '../services/partner-proxy/auth-template.js';
import { assertPublicHttpsUrl } from '../services/partner-proxy/url-guard.js';
import { createAgentError } from '../services/error-handler.js';
import { assertRegionConfig } from '../config.js';

const authTemplateSchema = z.object({
  location: z.enum(['header', 'query']),
  name: z.string().min(1).max(100),
  template: z.string().min(1).max(500),
});

const publicHttpsUrl = z.string().url().refine(
  (v) => {
    try {
      assertPublicHttpsUrl(v);
      return true;
    } catch {
      return false;
    }
  },
  {
    message: 'base_url must be a public https:// URL (no localhost, no private IPs)',
  }
);

const createPoolSchema = z.object({
  slug: z.string().regex(/^[a-z0-9_-]{2,50}$/),
  display_name: z.string().min(1).max(100),
  base_url: publicHttpsUrl,
  auth_template: authTemplateSchema,
  contact_message: z.string().max(500).optional(),
  docs_url: z.string().url().optional(),
  description: z.string().max(500).optional(),
});

const updatePoolSchema = createPoolSchema.partial().omit({ slug: true });

const addKeysSchema = z.object({
  keys: z.array(z.string().min(1)).min(1).max(100),
});

const updateKeySchema = z.object({
  status: z.enum(['active', 'exhausted', 'revoked']).optional(),
  label: z.string().max(100).nullable().optional(),
});

function getEncryptionKey(): string {
  const k = process.env.AUTH_ENCRYPTION_KEY;
  if (!k) throw new Error('AUTH_ENCRYPTION_KEY not set');
  return k;
}

function validateAuthTemplate(tpl: z.infer<typeof authTemplateSchema>): { ok: true } | { ok: false; reason: string } {
  try {
    renderAuthTemplate(tpl, 'probe');
    return { ok: true };
  } catch (err) {
    return { ok: false, reason: (err as Error).message };
  }
}

export async function partnerPoolsAdminRoutes(app: FastifyInstance) {
  const region = assertRegionConfig().instanceRegion;

  // Create pool
  app.post<{ Params: { hackathonId: string } }>(
    '/admin/hackathons/:hackathonId/partner-pools',
    async (request, reply) => {
      const adminId = await requireAdmin(app, request, reply);
      if (!adminId) return;
      const body = createPoolSchema.parse(request.body);
      const tplCheck = validateAuthTemplate(body.auth_template);
      if (!tplCheck.ok) {
        return reply.code(400).send(createAgentError({
          code: 'INVALID_AUTH_TEMPLATE',
          message: `auth_template invalid: ${tplCheck.reason}`,
          remediation: 'Ensure template includes the literal "{{key}}" placeholder.',
        }));
      }
      const { rows } = await app.runtimeDb(region).query(
        `INSERT INTO partner_pools (hackathon_id, slug, display_name, base_url, auth_template, contact_message, docs_url, description)
         VALUES ($1,$2,$3,$4,$5,COALESCE($6, 'Contact the hackathon host for additional access.'),$7,$8) RETURNING *`,
        [request.params.hackathonId, body.slug, body.display_name, body.base_url,
         JSON.stringify(body.auth_template), body.contact_message, body.docs_url, body.description]
      );
      return reply.code(201).send({ pool: rows[0] });
    }
  );

  // List pools
  app.get<{ Params: { hackathonId: string } }>(
    '/admin/hackathons/:hackathonId/partner-pools',
    async (request, reply) => {
      const adminId = await requireAdmin(app, request, reply);
      if (!adminId) return;
      const { rows } = await app.runtimeDb(region).query(
        `SELECT p.*,
                (SELECT count(*)::int FROM partner_keys k WHERE k.pool_id = p.id AND k.status='active') AS active_keys,
                (SELECT count(*)::int FROM partner_keys k WHERE k.pool_id = p.id AND k.status='exhausted') AS exhausted_keys,
                (SELECT count(*)::int FROM partner_keys k WHERE k.pool_id = p.id) AS total_keys
         FROM partner_pools p WHERE hackathon_id = $1 ORDER BY slug`,
        [request.params.hackathonId]
      );
      return { pools: rows };
    }
  );

  // Update pool
  app.patch<{ Params: { poolId: string } }>(
    '/admin/partner-pools/:poolId',
    async (request, reply) => {
      const adminId = await requireAdmin(app, request, reply);
      if (!adminId) return;
      const body = updatePoolSchema.parse(request.body);
      if (body.auth_template) {
        const c = validateAuthTemplate(body.auth_template);
        if (!c.ok) return reply.code(400).send(createAgentError({
          code: 'INVALID_AUTH_TEMPLATE',
          message: c.reason,
          remediation: 'Include literal "{{key}}" in the template.',
        }));
      }
      const fields: string[] = [];
      const values: unknown[] = [];
      let i = 1;
      for (const [k, v] of Object.entries(body)) {
        fields.push(`${k} = $${i++}`);
        values.push(k === 'auth_template' ? JSON.stringify(v) : v);
      }
      if (!fields.length) return reply.code(400).send(createAgentError({
        code: 'NO_FIELDS', message: 'No fields to update.', remediation: 'Provide at least one field.',
      }));
      values.push(request.params.poolId);
      const { rows } = await app.runtimeDb(region).query(
        `UPDATE partner_pools SET ${fields.join(', ')} WHERE id = $${i} RETURNING *`,
        values
      );
      if (!rows.length) return reply.code(404).send(createAgentError({
        code: 'POOL_NOT_FOUND', message: 'Pool not found.', remediation: 'Check the pool id.',
      }));
      return { pool: rows[0] };
    }
  );

  // Delete pool
  app.delete<{ Params: { poolId: string } }>(
    '/admin/partner-pools/:poolId',
    async (request, reply) => {
      const adminId = await requireAdmin(app, request, reply);
      if (!adminId) return;
      await app.runtimeDb(region).query(`DELETE FROM partner_pools WHERE id = $1`, [request.params.poolId]);
      return reply.code(204).send();
    }
  );

  // Bulk-add keys
  app.post<{ Params: { poolId: string } }>(
    '/admin/partner-pools/:poolId/keys',
    async (request, reply) => {
      const adminId = await requireAdmin(app, request, reply);
      if (!adminId) return;
      const body = addKeysSchema.parse(request.body);
      const ek = getEncryptionKey();
      let added = 0;
      for (const plaintext of body.keys) {
        const encrypted = encrypt(plaintext, ek);
        const prefix = plaintext.slice(0, 10);
        await app.runtimeDb(region).query(
          `INSERT INTO partner_keys (pool_id, encrypted_key, key_prefix) VALUES ($1, $2, $3)`,
          [request.params.poolId, encrypted, prefix]
        );
        added++;
      }
      return reply.code(201).send({ added });
    }
  );

  // List keys (no plaintext)
  app.get<{ Params: { poolId: string } }>(
    '/admin/partner-pools/:poolId/keys',
    async (request, reply) => {
      const adminId = await requireAdmin(app, request, reply);
      if (!adminId) return;
      const { rows } = await app.runtimeDb(region).query(
        `SELECT id, label, status, key_prefix, last_used_at, last_failed_at, last_failure_status,
                last_failure_body, failure_count, use_count, created_at
         FROM partner_keys WHERE pool_id = $1 ORDER BY created_at`,
        [request.params.poolId]
      );
      return { keys: rows };
    }
  );

  // Update key (status flip / label rename)
  app.patch<{ Params: { poolId: string; keyId: string } }>(
    '/admin/partner-pools/:poolId/keys/:keyId',
    async (request, reply) => {
      const adminId = await requireAdmin(app, request, reply);
      if (!adminId) return;
      const body = updateKeySchema.parse(request.body);
      const fields: string[] = [];
      const values: unknown[] = [];
      let i = 1;
      if (body.status !== undefined) { fields.push(`status = $${i++}`); values.push(body.status); }
      if (body.label !== undefined) { fields.push(`label = $${i++}`); values.push(body.label); }
      // Reset failure state when re-activating
      if (body.status === 'active') {
        fields.push(`last_failed_at = NULL`);
        fields.push(`last_failure_status = NULL`);
        fields.push(`last_failure_body = NULL`);
      }
      if (!fields.length) return reply.code(400).send(createAgentError({
        code: 'NO_FIELDS', message: 'No fields to update.', remediation: 'Provide status or label.',
      }));
      values.push(request.params.keyId);
      const { rows } = await app.runtimeDb(region).query(
        `UPDATE partner_keys SET ${fields.join(', ')} WHERE id = $${i} RETURNING id, status, label`,
        values
      );
      if (!rows.length) return reply.code(404).send(createAgentError({
        code: 'KEY_NOT_FOUND', message: 'Key not found.', remediation: 'Check the key id.',
      }));
      return { key: rows[0] };
    }
  );

  // Revoke a single key (idempotent shortcut)
  app.delete<{ Params: { poolId: string; keyId: string } }>(
    '/admin/partner-pools/:poolId/keys/:keyId',
    async (request, reply) => {
      const adminId = await requireAdmin(app, request, reply);
      if (!adminId) return;
      await app.runtimeDb(region).query(
        `UPDATE partner_keys SET status = 'revoked' WHERE id = $1`,
        [request.params.keyId]
      );
      return reply.code(204).send();
    }
  );
}
