// Admin CRUD for the special-customer pricing book + per-org flag toggle.
// The book maps canonical Redis catalog ids (vendor/model — they contain '/',
// so the id travels in the body / query string, never as a path param) to a
// replacement markup percentage used instead of the global AI_MARKUP_PERCENT.
import type { FastifyPluginAsync } from 'fastify';
import { requireAdmin } from '../../lib/admin-guard.js';

const specialPricingRoutes: FastifyPluginAsync = async (fastify) => {
  fastify.get('/admin/special-pricing', { config: { public: true } }, async (req, reply) => {
    const user = await requireAdmin(req, reply, (fastify as any).controlDb, (fastify as any).authProvider);
    if (!user) return;
    const ctrl = (fastify as any).controlDb;
    const res = await ctrl.query(
      `SELECT canonical_model_id, markup_pct::float8 AS markup_pct, updated_by, updated_at
         FROM special_model_markups ORDER BY canonical_model_id`,
    );
    return { entries: res.rows };
  });

  fastify.put('/admin/special-pricing', { config: { public: true } }, async (req, reply) => {
    const user = await requireAdmin(req, reply, (fastify as any).controlDb, (fastify as any).authProvider);
    if (!user) return;
    const ctrl = (fastify as any).controlDb;
    const { canonical_model_id, markup_pct } = (req.body ?? {}) as {
      canonical_model_id?: string; markup_pct?: number;
    };
    if (!canonical_model_id || typeof canonical_model_id !== 'string') {
      reply.code(400).send({ error: 'canonical_model_id_required' });
      return;
    }
    if (typeof markup_pct !== 'number' || !Number.isFinite(markup_pct) || markup_pct < 0 || markup_pct > 200) {
      reply.code(400).send({ error: 'invalid_markup_pct' });
      return;
    }
    const res = await ctrl.query(
      `INSERT INTO special_model_markups (canonical_model_id, markup_pct, updated_by, updated_at)
       VALUES ($1, $2, $3, now())
       ON CONFLICT (canonical_model_id)
       DO UPDATE SET markup_pct = EXCLUDED.markup_pct, updated_by = EXCLUDED.updated_by, updated_at = now()
       RETURNING canonical_model_id, markup_pct::float8 AS markup_pct, updated_by, updated_at`,
      [canonical_model_id, markup_pct, user.id],
    );
    return { entry: res.rows[0] };
  });

  fastify.delete('/admin/special-pricing', { config: { public: true } }, async (req, reply) => {
    const user = await requireAdmin(req, reply, (fastify as any).controlDb, (fastify as any).authProvider);
    if (!user) return;
    const ctrl = (fastify as any).controlDb;
    const { model } = req.query as { model?: string };
    if (!model) {
      reply.code(400).send({ error: 'model_required' });
      return;
    }
    const res = await ctrl.query(
      `DELETE FROM special_model_markups WHERE canonical_model_id = $1`,
      [model],
    );
    if ((res.rowCount ?? 0) === 0) {
      reply.code(404).send({ error: 'entry_not_found' });
      return;
    }
    reply.code(204).send();
  });

  fastify.patch('/admin/organizations/:id/special-pricing', { config: { public: true } }, async (req, reply) => {
    const user = await requireAdmin(req, reply, (fastify as any).controlDb, (fastify as any).authProvider);
    if (!user) return;
    const ctrl = (fastify as any).controlDb;
    const { id } = req.params as { id: string };
    const { special_pricing } = (req.body ?? {}) as { special_pricing?: boolean };
    if (typeof special_pricing !== 'boolean') {
      reply.code(400).send({ error: 'special_pricing_required' });
      return;
    }
    const res = await ctrl.query(
      `UPDATE organizations SET special_pricing = $1, updated_at = now()
        WHERE id = $2
       RETURNING id, special_pricing`,
      [special_pricing, id],
    );
    if (res.rows.length === 0) {
      reply.code(404).send({ error: 'organization_not_found' });
      return;
    }
    await ctrl.query(
      `INSERT INTO billing_events (user_id, organization_id, event_type, metadata, created_at)
       VALUES ($1, $2, $3, $4, now())`,
      [user.id, id, 'special_pricing_toggled', JSON.stringify({ special_pricing, admin: user.email })],
    );
    return res.rows[0];
  });
};

export default specialPricingRoutes;
